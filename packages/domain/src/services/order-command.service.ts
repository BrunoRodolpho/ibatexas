// OrderCommandService — write operations for order projections.
//
// Implements optimistic concurrency control via version field.
// All status transitions are validated against the canonical state machine
// and recorded in OrderStatusHistory for full audit trail.
//
// INVARIANT: No event without version is allowed past the command layer.
//
// ── Task 15 (M3) — envelope-typed entry points ───────────────────────────
//
// Every command-service method now has an envelope-typed entry point that
// flows through the adjudicate kernel via `withAdjudicate` (the
// service-method-level chokepoint helper in `__shared__/with-adjudicate.ts`).
//
// Decision D8 (decisions-log.md): backwards-compatible parallel surface.
// The legacy bare-arg methods (`create(data)`, `transitionStatus(id, input)`,
// `reconcileStatus(id, input)`) are kept and marked `@deprecated`. New
// envelope-typed entry points (`createFromEnvelope(envelope)`,
// `transitionStatusFromEnvelope(envelope)`, etc.) live alongside them.
// Tasks 12-14, 16, 17 migrate their callers incrementally; once all
// callers move, the legacy methods are removed in a follow-up sweep.
//
// Also new in Task 15: consolidation of three "rogue" cart writers
// (`packages/tools/src/cart/{add-order-note,switch-order-type,change-delivery-address}.ts`)
// per investigation 03 P0 #2. Those tools previously wrote
// `prisma.orderProjection.update` directly, bypassing the version counter
// and audit trail. They now go through:
//
//   - `addNoteFromEnvelope(envelope)`  — replaces direct prisma.orderNote.create
//   - `switchTypeFromEnvelope(envelope)` — bumps version + history
//   - `changeAddressFromEnvelope(envelope)` — bumps version + history
//
// Note-add goes through `@ibatexas/pack-orders` (the LLM-facing canonical
// Pack). The other four kinds go through the domain-internal
// `orderProjectionPolicyBundle` since they're projection-lifecycle ops
// that the LLM never proposes directly.

import { prisma } from "../client.js"
import { Prisma } from "../generated/prisma-client/client.js"
import type { PrismaClient } from "../generated/prisma-client/client.js"
import type {
  OrderFulfillmentStatus as PrismaFulfillmentStatus,
  OrderActor as PrismaActor,
} from "../generated/prisma-client/client.js"
import { canTransition, type OrderFulfillmentStatus } from "@ibatexas/types"
import type { CreateOrderProjectionInput } from "../mappers/medusa-order.mapper.js"
import type { AuditSink, IntentEnvelope } from "@adjudicate/core"
import { ordersPolicyBundle, type OrderState } from "@ibatexas/pack-orders"
import type { OrderNoteAddPayload } from "@ibatexas/pack-orders"
import {
  withAdjudicate,
  type AdjudicatedResult,
} from "./__shared__/with-adjudicate.js"
import {
  orderProjectionPolicyBundle,
  type OrderProjectionState,
  type OrderProjectionCreatePayload,
  type OrderStatusTransitionPayload,
  type OrderStatusReconcilePayload,
  type OrderTypeSwitchPayload,
  type OrderAddressChangePayload,
} from "./__shared__/order-projection-policy.js"

// Transaction client type
type TxClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">

// ── Error types ─────────────────────────────────────────────────────────────

export class ConcurrencyError extends Error {
  constructor(orderId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Concurrency conflict on order ${orderId}: expected version ${expectedVersion}, found ${actualVersion}`,
    )
    this.name = "ConcurrencyError"
  }
}

export class ProjectionNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Order projection not found: ${orderId}`)
    this.name = "ProjectionNotFoundError"
  }
}

export class InvalidTransitionError extends Error {
  public readonly from: string
  public readonly to: string
  constructor(orderId: string, from: string, to: string) {
    super(`Invalid transition on order ${orderId}: ${from} → ${to}`)
    this.name = "InvalidTransitionError"
    this.from = from
    this.to = to
  }
}

export class MissingEventVersionError extends Error {
  constructor(orderId: string) {
    super(`Missing event version for order ${orderId} — no event without version allowed past command layer`)
    this.name = "MissingEventVersionError"
  }
}

// ── Input types ─────────────────────────────────────────────────────────────

interface TransitionStatusInput {
  newStatus: OrderFulfillmentStatus
  actor: "admin" | "system" | "customer"
  actorId?: string
  reason?: string
  /** If provided, checks for optimistic concurrency conflict. */
  expectedVersion?: number
}

interface ReconcileStatusInput {
  newStatus: OrderFulfillmentStatus
  /** REQUIRED — enforced at runtime. */
  eventVersion: number | undefined | null
  actor?: "admin" | "system" | "customer"
  actorId?: string
}

// ── New envelope-typed result types ────────────────────────────────────────

export interface AddNoteResult {
  readonly noteId: string
  readonly orderId: string
}

export interface SwitchTypeResult {
  readonly orderId: string
  readonly version: number
  readonly previousType: string
  readonly newType: string
}

export interface ChangeAddressResult {
  readonly orderId: string
  readonly version: number
}

// ── Service ─────────────────────────────────────────────────────────────────

export interface OrderCommandService {
  /**
   * @deprecated Use `createFromEnvelope(envelope)` instead. The bare-arg
   * surface is retained for backwards compatibility with un-migrated
   * callers (tasks 12-14, 16, 17 own those callers' migrations).
   *
   * Create a new order projection (called on order.placed).
   */
  create(data: CreateOrderProjectionInput): Promise<{ id: string; version: number }>

  /**
   * Envelope-typed entry point for the `order.projection.create` system
   * intent. Adjudicates via `orderProjectionPolicyBundle`. SYSTEM-only
   * (taint: SYSTEM). Returns the same shape as the legacy `create()`.
   *
   * Payload carries a minimal view of the projection — the full
   * `CreateOrderProjectionInput` is passed via the helper closure on the
   * caller side so the mapper output (which includes serializable JSON
   * fields) doesn't need to round-trip through the envelope.
   */
  createFromEnvelope(
    envelope: IntentEnvelope<"order.projection.create", OrderProjectionCreatePayload>,
    fullInput: CreateOrderProjectionInput,
  ): Promise<AdjudicatedResult<{ id: string; version: number }>>

  /**
   * @deprecated Use `transitionStatusFromEnvelope(envelope)` instead.
   * Transition order status with validation and optimistic concurrency.
   *
   * @throws ConcurrencyError if expectedVersion doesn't match
   * @throws ProjectionNotFoundError if order not in projection
   * @throws InvalidTransitionError if transition is not allowed
   */
  transitionStatus(
    orderId: string,
    input: TransitionStatusInput,
  ): Promise<{ version: number; previousStatus: string; newStatus: string }>

  /**
   * Envelope-typed entry point for the `order.status.transition` intent.
   * Adjudicates via `orderProjectionPolicyBundle`. Tolerates UNTRUSTED
   * (admin/customer/system actors all accepted at taint).
   */
  transitionStatusFromEnvelope(
    envelope: IntentEnvelope<"order.status.transition", OrderStatusTransitionPayload>,
  ): Promise<
    AdjudicatedResult<{ version: number; previousStatus: string; newStatus: string }>
  >

  /**
   * @deprecated Use `reconcileStatusFromEnvelope(envelope)` instead.
   * Reconcile status from an event (subscriber safety net).
   *
   * @throws MissingEventVersionError if eventVersion is missing
   */
  reconcileStatus(orderId: string, input: ReconcileStatusInput): Promise<{ version: number } | null>

  /**
   * Envelope-typed entry point for the `order.status.reconcile` intent.
   * SYSTEM-only. The kernel adjudication is mostly a recordkeeping pass —
   * the imperative reconcile-from-event semantics (stale skip, terminal
   * skip, ownership) are preserved inside the executor.
   */
  reconcileStatusFromEnvelope(
    envelope: IntentEnvelope<"order.status.reconcile", OrderStatusReconcilePayload>,
  ): Promise<AdjudicatedResult<{ version: number } | null>>

  /**
   * Add an order note. Replaces the rogue `prisma.orderNote.create` site
   * in `packages/tools/src/cart/add-order-note.ts`. Adjudicates via
   * `@ibatexas/pack-orders` (`order.note.add` is part of the canonical
   * Pack — the LLM may propose this kind through the dispatcher).
   *
   * NOTE: a note add does NOT bump the projection version (notes are a
   * sibling table; the projection is unchanged). Audit is captured by
   * `withAdjudicate`.
   */
  addNoteFromEnvelope(
    envelope: IntentEnvelope<"order.note.add", OrderNoteAddPayload>,
    orderState: OrderState,
    extras: {
      readonly author: "customer" | "staff" | "system" | "llm"
      readonly authorId?: string
    },
  ): Promise<AdjudicatedResult<AddNoteResult>>

  /**
   * Switch the projection's `deliveryType`. Replaces the rogue
   * `prisma.orderProjection.update` site in
   * `packages/tools/src/cart/switch-order-type.ts`. **Bumps version** to
   * preserve optimistic concurrency invariants (investigation 03 P0 #2).
   */
  switchTypeFromEnvelope(
    envelope: IntentEnvelope<"order.type.switch", OrderTypeSwitchPayload>,
  ): Promise<AdjudicatedResult<SwitchTypeResult>>

  /**
   * Replace the projection's `shippingAddressJson`. Replaces the rogue
   * `prisma.orderProjection.update` site in
   * `packages/tools/src/cart/change-delivery-address.ts`. **Bumps version**
   * to preserve optimistic concurrency invariants.
   */
  changeAddressFromEnvelope(
    envelope: IntentEnvelope<"order.address.change", OrderAddressChangePayload>,
  ): Promise<AdjudicatedResult<ChangeAddressResult>>
}

type Logger = { warn?: (...args: unknown[]) => void }

/**
 * Optional adjudicate wiring for the service. Callers may pass an audit
 * sink and a logger. When omitted, audit records are silently dropped —
 * preserves the no-extra-config posture for existing tests that don't
 * exercise the envelope-typed entry points.
 */
export interface OrderCommandServiceOptions {
  readonly auditSink?: AuditSink
  readonly log?: Logger
}

export function createOrderCommandService(
  log?: Logger,
  options?: OrderCommandServiceOptions,
): OrderCommandService {
  const adjudicateOptions = {
    ...(options?.auditSink ? { auditSink: options.auditSink } : {}),
    log: log ?? options?.log,
  } as const

  // ── Legacy executor: create projection ────────────────────────────────
  const executeCreate = async (
    data: CreateOrderProjectionInput,
  ): Promise<{ id: string; version: number }> => {
    return prisma.$transaction(async (tx: TxClient) => {
      const projection = await tx.orderProjection.create({
        data: {
          id: data.id,
          displayId: data.displayId,
          customerId: data.customerId,
          customerEmail: data.customerEmail,
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          fulfillmentStatus: data.fulfillmentStatus as PrismaFulfillmentStatus,
          paymentStatus: data.paymentStatus,
          totalInCentavos: data.totalInCentavos,
          subtotalInCentavos: data.subtotalInCentavos,
          shippingInCentavos: data.shippingInCentavos,
          itemCount: data.itemCount,
          itemsJson: data.itemsJson as unknown as Prisma.InputJsonArray,
          itemsSchemaVersion: data.itemsSchemaVersion,
          shippingAddressJson: data.shippingAddressJson
            ? (data.shippingAddressJson as unknown as Prisma.InputJsonObject)
            : Prisma.JsonNull,
          deliveryType: data.deliveryType,
          paymentMethod: data.paymentMethod,
          tipInCentavos: data.tipInCentavos,
          version: 1,
          medusaCreatedAt: data.medusaCreatedAt,
        },
      })

      await tx.orderStatusHistory.create({
        data: {
          orderId: projection.id,
          fromStatus: data.fulfillmentStatus as PrismaFulfillmentStatus,
          toStatus: data.fulfillmentStatus as PrismaFulfillmentStatus,
          actor: "system" as PrismaActor,
          version: 1,
        },
      })

      return { id: projection.id, version: 1 }
    })
  }

  // ── Legacy executor: transition status ────────────────────────────────
  const executeTransition = async (
    orderId: string,
    input: TransitionStatusInput,
  ): Promise<{ version: number; previousStatus: string; newStatus: string }> => {
    return prisma.$transaction(async (tx: TxClient) => {
      const projection = await tx.orderProjection.findUnique({
        where: { id: orderId },
      })

      if (!projection) {
        throw new ProjectionNotFoundError(orderId)
      }

      if (input.expectedVersion !== undefined && projection.version !== input.expectedVersion) {
        throw new ConcurrencyError(orderId, input.expectedVersion, projection.version)
      }

      const from = projection.fulfillmentStatus as OrderFulfillmentStatus
      const to = input.newStatus
      if (!canTransition(from, to)) {
        throw new InvalidTransitionError(orderId, from, to)
      }

      const newVersion = projection.version + 1

      await tx.orderProjection.update({
        where: { id: orderId },
        data: {
          fulfillmentStatus: to as PrismaFulfillmentStatus,
          version: newVersion,
        },
      })

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: from as PrismaFulfillmentStatus,
          toStatus: to as PrismaFulfillmentStatus,
          actor: input.actor as PrismaActor,
          actorId: input.actorId,
          reason: input.reason,
          version: newVersion,
        },
      })

      return { version: newVersion, previousStatus: from, newStatus: to }
    })
  }

  // ── Legacy executor: reconcile status ────────────────────────────────
  const executeReconcile = async (
    orderId: string,
    input: ReconcileStatusInput,
  ): Promise<{ version: number } | null> => {
    if (input.eventVersion == null) {
      throw new MissingEventVersionError(orderId)
    }

    const projection = await prisma.orderProjection.findUnique({
      where: { id: orderId },
    })

    if (!projection) {
      return null
    }

    if (input.eventVersion <= projection.version) {
      return null
    }

    if (projection.fulfillmentStatus === input.newStatus) {
      return null
    }

    const from = projection.fulfillmentStatus as OrderFulfillmentStatus
    if (!canTransition(from, input.newStatus)) {
      log?.warn?.(
        {
          orderId,
          from,
          to: input.newStatus,
          eventVersion: input.eventVersion,
          projectionVersion: projection.version,
        },
        "[order-command] reconcileStatus: invalid transition from event — skipping (likely reordered)",
      )
      return null
    }

    const newVersion = projection.version + 1

    await prisma.$transaction(async (tx: TxClient) => {
      await tx.orderProjection.update({
        where: { id: orderId },
        data: {
          fulfillmentStatus: input.newStatus as PrismaFulfillmentStatus,
          version: newVersion,
        },
      })

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: from as PrismaFulfillmentStatus,
          toStatus: input.newStatus as PrismaFulfillmentStatus,
          actor: (input.actor ?? "system") as PrismaActor,
          actorId: input.actorId,
          version: newVersion,
        },
      })
    })

    return { version: newVersion }
  }

  // ── Helper: snapshot the projection for kernel state ─────────────────
  const snapshotProjection = async (
    orderId: string,
  ): Promise<OrderProjectionState> => {
    const row = await prisma.orderProjection.findUnique({
      where: { id: orderId },
    })
    if (!row) {
      return { ctx: { exists: false } }
    }
    return {
      ctx: {
        exists: true,
        currentStatus: row.fulfillmentStatus,
        version: row.version,
        customerId: row.customerId,
        currentDeliveryType: row.deliveryType ?? null,
      },
    }
  }

  return {
    // ── Legacy bare-arg methods ─────────────────────────────────────────

    async create(data) {
      return executeCreate(data)
    },

    async transitionStatus(orderId, input) {
      return executeTransition(orderId, input)
    },

    async reconcileStatus(orderId, input) {
      return executeReconcile(orderId, input)
    },

    // ── Envelope-typed entry points ─────────────────────────────────────

    async createFromEnvelope(envelope, fullInput) {
      // System-side create: no row exists yet.
      const state: OrderProjectionState = { ctx: { exists: false } }
      return withAdjudicate(
        envelope,
        state,
        orderProjectionPolicyBundle,
        async () => executeCreate(fullInput),
        adjudicateOptions,
      )
    },

    async transitionStatusFromEnvelope(envelope) {
      const state = await snapshotProjection(envelope.payload.orderId)
      return withAdjudicate(
        envelope,
        state,
        orderProjectionPolicyBundle,
        async (payload) => {
          const input: TransitionStatusInput = {
            newStatus: payload.newStatus as OrderFulfillmentStatus,
            actor: payload.actor,
            actorId: payload.actorId,
            reason: payload.reason,
            expectedVersion: payload.expectedVersion,
          }
          return executeTransition(payload.orderId, input)
        },
        adjudicateOptions,
      )
    },

    async reconcileStatusFromEnvelope(envelope) {
      const state = await snapshotProjection(envelope.payload.orderId)
      return withAdjudicate(
        envelope,
        state,
        orderProjectionPolicyBundle,
        async (payload) => {
          const input: ReconcileStatusInput = {
            newStatus: payload.newStatus as OrderFulfillmentStatus,
            eventVersion: payload.eventVersion,
            actor: payload.actor,
            actorId: payload.actorId,
          }
          return executeReconcile(payload.orderId, input)
        },
        adjudicateOptions,
      )
    },

    async addNoteFromEnvelope(envelope, orderState, extras) {
      // Note-add goes through @ibatexas/pack-orders (the LLM-facing Pack).
      // The orderState is the same shape the Pack's policies expect — the
      // caller (cart tool) projects it from the order projection.
      //
      // Author mapping — the Prisma OrderActor enum is narrower than the
      // service-facing actor surface (it has no `staff` or `llm` variant);
      // we map `staff`→`admin` (staff acting via admin path) and
      // `llm`→`system` (LLM proposals on behalf of system actions). The
      // envelope's `actor.principal` is the authoritative provenance for
      // audit / replay; the OrderActor enum value is the projection-row
      // attribution.
      const noteActor: PrismaActor =
        extras.author === "staff"
          ? ("admin" as PrismaActor)
          : extras.author === "llm"
            ? ("system" as PrismaActor)
            : (extras.author as PrismaActor)
      return withAdjudicate(
        envelope,
        orderState,
        ordersPolicyBundle,
        async (payload) => {
          const note = await prisma.orderNote.create({
            data: {
              orderId: payload.orderId,
              author: noteActor,
              authorId: extras.authorId,
              content: payload.body,
              ...(payload.isInternal !== undefined
                ? { isInternal: payload.isInternal }
                : {}),
            },
          })
          return { noteId: note.id, orderId: payload.orderId }
        },
        adjudicateOptions,
      )
    },

    async switchTypeFromEnvelope(envelope) {
      const state = await snapshotProjection(envelope.payload.orderId)
      return withAdjudicate(
        envelope,
        state,
        orderProjectionPolicyBundle,
        async (payload) => {
          return prisma.$transaction(async (tx: TxClient) => {
            const projection = await tx.orderProjection.findUnique({
              where: { id: payload.orderId },
            })
            if (!projection) {
              throw new ProjectionNotFoundError(payload.orderId)
            }
            const previousType = projection.deliveryType ?? "delivery"
            const newVersion = projection.version + 1

            await tx.orderProjection.update({
              where: { id: payload.orderId },
              data: {
                deliveryType: payload.newType,
                version: newVersion,
                ...(payload.newType !== "delivery" && previousType === "delivery"
                  ? { shippingInCentavos: 0 }
                  : {}),
              },
            })

            // Record in audit history — type changes do not change
            // fulfillmentStatus but we record a same-status row to keep
            // the version timeline contiguous.
            const status = projection.fulfillmentStatus as PrismaFulfillmentStatus
            await tx.orderStatusHistory.create({
              data: {
                orderId: payload.orderId,
                fromStatus: status,
                toStatus: status,
                actor: "customer" as PrismaActor,
                actorId: payload.customerId,
                reason: `type:${previousType}→${payload.newType}`,
                version: newVersion,
              },
            })

            return {
              orderId: payload.orderId,
              version: newVersion,
              previousType,
              newType: payload.newType,
            }
          })
        },
        adjudicateOptions,
      )
    },

    async changeAddressFromEnvelope(envelope) {
      const state = await snapshotProjection(envelope.payload.orderId)
      return withAdjudicate(
        envelope,
        state,
        orderProjectionPolicyBundle,
        async (payload) => {
          return prisma.$transaction(async (tx: TxClient) => {
            const projection = await tx.orderProjection.findUnique({
              where: { id: payload.orderId },
            })
            if (!projection) {
              throw new ProjectionNotFoundError(payload.orderId)
            }
            const newVersion = projection.version + 1

            await tx.orderProjection.update({
              where: { id: payload.orderId },
              data: {
                shippingAddressJson: payload.address as unknown as Prisma.InputJsonObject,
                version: newVersion,
              },
            })

            // History row for address changes too — keep the version
            // timeline contiguous.
            const status = projection.fulfillmentStatus as PrismaFulfillmentStatus
            await tx.orderStatusHistory.create({
              data: {
                orderId: payload.orderId,
                fromStatus: status,
                toStatus: status,
                actor: "customer" as PrismaActor,
                actorId: payload.customerId,
                reason: "address_changed",
                version: newVersion,
              },
            })

            return { orderId: payload.orderId, version: newVersion }
          })
        },
        adjudicateOptions,
      )
    },
  }
}
