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
import {
  Prisma,
  type PrismaClient,
  type OrderFulfillmentStatus as PrismaFulfillmentStatus,
  type OrderActor as PrismaActor,
} from "../generated/prisma-client/client.js"
import { canTransition, type OrderFulfillmentStatus } from "@ibatexas/types"
import type { CreateOrderProjectionInput } from "../mappers/medusa-order.mapper.js"
import type { AuditSink, IntentEnvelope } from "@adjudicate/core"
import type { Guard } from "@adjudicate/core/kernel"
import {
  ordersPolicyBundle,
  type OrderState,
  type OrderNoteAddPayload,
  type OrderFiscalEmitPayload,
} from "@ibatexas/pack-orders"
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

/**
 * Author attribution for a note write. `author` is the service-facing actor
 * surface (mapped to the narrower Prisma `OrderActor` enum); `authorId` is the
 * optional staff/customer id recorded on the row. Shared by
 * `addNoteFromEnvelope` and {@link OrderCommandService.writeAdjudicatedNote}.
 */
export interface NoteAuthorExtras {
  readonly author: "customer" | "staff" | "system" | "llm"
  readonly authorId?: string
}

/**
 * The minimal transition target a caller passes to
 * {@link OrderCommandService.writeAdjudicatedStatusTransition}. `expectedVersion`
 * (when present) arms the executor-transactional optimistic-concurrency check.
 */
export interface StatusTransitionWrite {
  readonly orderId: string
  readonly newStatus: string
  readonly expectedVersion?: number
}

/**
 * Authoritative provenance for a status-transition write. On the ops plane the
 * caller stamps `actor: "admin"` + `actorId: <Capsule staffId>` — NEVER a
 * model-parsed payload field. Recorded on the `OrderStatusHistory` row.
 */
export interface StatusTransitionAttribution {
  readonly actor: "admin" | "system" | "customer"
  readonly actorId?: string
  readonly reason?: string
}

/**
 * Result of a committed status-transition write. `version`/`previousStatus`/
 * `newStatus` are the historical shape; `displayId`/`customerId` are read from
 * the SAME projection row inside the tx so a governed ops caller can publish an
 * accurate `order.status_changed` event without a second read or trusting the
 * model payload for those identifiers.
 */
export interface StatusTransitionResult {
  readonly version: number
  readonly previousStatus: string
  readonly newStatus: string
  readonly displayId: number
  readonly customerId: string | null
}

// ── Service ─────────────────────────────────────────────────────────────────

export interface OrderCommandService {
  // ── R1-DELETE (W1 correctness remediation) ──────────────────────────
  //
  // The bare-arg @deprecated entry points (`create`, `transitionStatus`,
  // `reconcileStatus`) have been DELETED from the interface. All
  // production callers were migrated to the `*FromEnvelope` path; the
  // type system now structurally prevents reintroducing the bypass.
  //
  // Per the audit (deep-audit/09-code-quality-debt.md #1), this closes
  // the chokepoint claim in CLAUDE.md rule #9.

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
    extras: NoteAuthorExtras,
  ): Promise<AdjudicatedResult<AddNoteResult>>

  /**
   * NEW-014 — envelope-typed entry point for the SYSTEM-only
   * `order.fiscal.emit` intent. Adjudicates against `ordersPolicyBundle`
   * (which carries `requireFiscalEligibleState` — delivered-only — and
   * `fiscalEmitRetryCapGuard` reading `orderState.ctx.fiscalEmitAttempts`,
   * both landed in NEW-014 PR1), mirroring {@link addNoteFromEnvelope}'s
   * caller-supplied-state shape — NEVER `transitionStatusFromEnvelope`'s
   * domain-internal bundle (order.fiscal.emit is not a member of it).
   *
   * The EXECUTOR is caller-supplied: the fiscal-emitter subscriber owns the
   * provider call (`FiscalProviderPort.emit`) + the record persistence
   * (fiscal-document.service). The domain method contributes exactly the
   * adjudication + audit chokepoint.
   */
  emitFiscalFromEnvelope<T>(
    envelope: IntentEnvelope<"order.fiscal.emit", OrderFiscalEmitPayload>,
    orderState: OrderState,
    executor: (payload: OrderFiscalEmitPayload) => Promise<T>,
  ): Promise<AdjudicatedResult<T>>

  /**
   * Persist an OrderNote for an `order.note.add` the caller has ALREADY
   * adjudicated. THE CALLER MUST HOLD A POSITIVE (EXECUTE/REWRITE) composed-
   * router `Decision` for `order.note.add` — this method performs NO
   * adjudication; it is the raw post-decision persistence body extracted from
   * `addNoteFromEnvelope` (BKL-083 fork resolution, option b).
   *
   * The ops-plane note path adjudicates through the COMPOSED policy router
   * (`policyForKind` — which carries `staffRoleGuard` + the staff-role
   * matrix). Re-running `addNoteFromEnvelope` there would double-adjudicate
   * against the RAW `ordersPolicyBundle` (which does NOT carry those adopter
   * guards), so a governed ops caller uses this method to persist without a
   * second, weaker adjudication. The direct `prisma.orderNote.create` stays
   * inside `packages/domain/src/services/` — the sanctioned owner path per the
   * bypass-detection gate.
   */
  writeAdjudicatedNote(
    payload: OrderNoteAddPayload,
    extras: NoteAuthorExtras,
  ): Promise<AddNoteResult>

  /**
   * Persist an `order.status.transition` the caller has ALREADY adjudicated
   * through the COMPOSED policy router (the ops-plane kitchen-advance path,
   * BKL-090). THE CALLER MUST HOLD A POSITIVE (EXECUTE/REWRITE) `Decision` —
   * this performs NO adjudication; it is the post-decision persistence body
   * extracted from `executeTransition` and shared, exactly like
   * {@link OrderCommandService.writeAdjudicatedNote}.
   *
   * The ops path adjudicates through `composePolicyRouter` (carrying
   * `staffRoleGuard` + the BKL-090 legality guard). Re-running
   * `transitionStatusFromEnvelope` there would double-adjudicate against the
   * DOMAIN `orderProjectionPolicyBundle` (which does NOT carry those adopter/
   * legality guards), so a governed ops caller uses this method to persist
   * without a second, weaker adjudication. The optimistic-concurrency version
   * check + the `canTransition` throw REMAIN as the last transactional line
   * (kernel = legality/terminality, executor = concurrency/atomicity).
   * `actor`/`actorId` come from `extras` (ops stamps admin + Capsule staffId,
   * NEVER a model payload field). The direct Prisma writes stay inside
   * `packages/domain/src/services/` — the sanctioned owner path per the
   * bypass-detection gate.
   */
  writeAdjudicatedStatusTransition(
    payload: StatusTransitionWrite,
    extras: StatusTransitionAttribution,
  ): Promise<StatusTransitionResult>

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
  /**
   * WS7 / BKL-074 — adopter AUTH guards (e.g. `staffRoleGuard`) injected into
   * EVERY `withAdjudicate` call this service makes. The HTTP admin routes pass
   * `[staffRoleGuard]` so a mis-scoped staff role is REFUSED at the kernel on
   * the command-service adjudication path (which uses RAW pack bundles), not
   * only by the Fastify preHandler. Inert for non-`admin:` envelopes, so this
   * is a no-op for the SYSTEM-actor create/reconcile and customer/LLM note
   * paths. Threaded through `adjudicateOptions` so per-method calls are
   * unchanged.
   */
  readonly authGuards?: readonly Guard<string, unknown, unknown>[]
}

/**
 * Map the service-facing note author surface to the narrower Prisma
 * `OrderActor` enum. `staff` acts via the admin path; `llm` proposals are
 * attributed to `system` on the projection row (the envelope's
 * `actor.principal` remains the authoritative provenance for audit/replay).
 */
function mapNoteAuthorToActor(
  author: "customer" | "staff" | "system" | "llm",
): PrismaActor {
  if (author === "staff") return "admin" as PrismaActor
  if (author === "llm") return "system" as PrismaActor
  return author as PrismaActor
}

/**
 * The post-adjudication OrderNote persistence body — the author-mapping +
 * `prisma.orderNote.create` extracted from `addNoteFromEnvelope` so it can be
 * shared with governed ops callers that already adjudicated `order.note.add`
 * through the composed router (BKL-083 option b).
 *
 * PRECONDITION: the caller holds a positive (EXECUTE/REWRITE) `Decision`.
 * Performs NO adjudication. Pure persistence: same write, same result mapping
 * as the previous inline executor. Module-scoped (uses only the module `prisma`
 * client + `mapNoteAuthorToActor`), referenced by BOTH the exposed service
 * method and `addNoteFromEnvelope`'s post-EXECUTE executor.
 */
async function writeAdjudicatedNote(
  payload: OrderNoteAddPayload,
  extras: NoteAuthorExtras,
): Promise<AddNoteResult> {
  const noteActor: PrismaActor = mapNoteAuthorToActor(extras.author)
  const note = await prisma.orderNote.create({
    data: {
      orderId: payload.orderId,
      author: noteActor,
      authorId: extras.authorId,
      content: payload.body,
      ...(payload.isInternal === undefined
        ? {}
        : { isInternal: payload.isInternal }),
    },
  })
  return { noteId: note.id, orderId: payload.orderId }
}

/**
 * The post-adjudication `order.status.transition` persistence body — the EXACT
 * body previously inlined in the `executeTransition` closure, extracted so it
 * can be shared with governed OPS callers that adjudicated the transition
 * through the COMPOSED policy router (BKL-090; the ops kitchen-advance verb).
 *
 * PRECONDITION: the caller holds a positive (EXECUTE/REWRITE) `Decision` for
 * `order.status.transition`. Performs NO adjudication. It PRESERVES, EXACTLY:
 *   - the optimistic-CONCURRENCY check (`expectedVersion` vs the read version)
 *     → `ConcurrencyError`;
 *   - the state-machine `canTransition` throw as the LAST TRANSACTIONAL LINE
 *     → `InvalidTransitionError` (defense-in-depth against a resolve→execute
 *     race; the kernel legality guard is the primary gate, this is the backstop);
 *   - the version bump + `OrderStatusHistory` audit row.
 * Module-scoped (uses only the module `prisma` client + the shared error
 * classes), referenced by BOTH the `executeTransition` closure (the
 * `transitionStatusFromEnvelope` path) and the ops kitchen-advance executor.
 *
 * The return additionally carries `displayId` + `customerId` read from the SAME
 * projection row (one read, inside the tx) so a governed ops caller can publish
 * an accurate `order.status_changed` event WITHOUT a second read and WITHOUT
 * trusting the model payload for those identifiers. The
 * `transitionStatusFromEnvelope` path narrows the result back to its historical
 * `{ version, previousStatus, newStatus }` shape (see `executeTransition`), so
 * that public surface is unchanged.
 */
async function writeAdjudicatedStatusTransition(
  payload: StatusTransitionWrite,
  extras: StatusTransitionAttribution,
): Promise<StatusTransitionResult> {
  return prisma.$transaction(async (tx: TxClient) => {
    const projection = await tx.orderProjection.findUnique({
      where: { id: payload.orderId },
    })

    if (!projection) {
      throw new ProjectionNotFoundError(payload.orderId)
    }

    if (
      payload.expectedVersion !== undefined &&
      projection.version !== payload.expectedVersion
    ) {
      throw new ConcurrencyError(
        payload.orderId,
        payload.expectedVersion,
        projection.version,
      )
    }

    const from = projection.fulfillmentStatus as OrderFulfillmentStatus
    const to = payload.newStatus as OrderFulfillmentStatus
    if (!canTransition(from, to)) {
      throw new InvalidTransitionError(payload.orderId, from, to)
    }

    const newVersion = projection.version + 1

    await tx.orderProjection.update({
      where: { id: payload.orderId },
      data: {
        fulfillmentStatus: to as PrismaFulfillmentStatus,
        version: newVersion,
      },
    })

    await tx.orderStatusHistory.create({
      data: {
        orderId: payload.orderId,
        fromStatus: from as PrismaFulfillmentStatus,
        toStatus: to as PrismaFulfillmentStatus,
        actor: extras.actor as PrismaActor,
        actorId: extras.actorId,
        reason: extras.reason,
        version: newVersion,
      },
    })

    return {
      version: newVersion,
      previousStatus: from,
      newStatus: to,
      displayId: projection.displayId,
      customerId: projection.customerId,
    }
  })
}

export function createOrderCommandService(
  log?: Logger,
  options?: OrderCommandServiceOptions,
): OrderCommandService {
  const adjudicateOptions = {
    ...(options?.auditSink ? { auditSink: options.auditSink } : {}),
    ...(options?.authGuards ? { authGuards: options.authGuards } : {}),
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
  // Behaviour-preserving delegation to the module-scoped
  // `writeAdjudicatedStatusTransition` (BKL-090 extraction). The body is
  // unchanged — the `transitionStatusFromEnvelope` path adjudicates via
  // `orderProjectionPolicyBundle` FIRST, then this executor runs.
  const executeTransition = async (
    orderId: string,
    input: TransitionStatusInput,
  ): Promise<{ version: number; previousStatus: string; newStatus: string }> => {
    // Narrow the shared result back to the historical shape so the
    // `transitionStatusFromEnvelope` public surface is byte-identical (the
    // extra displayId/customerId are only for the governed ops emit path).
    const r = await writeAdjudicatedStatusTransition(
      {
        orderId,
        newStatus: input.newStatus,
        ...(input.expectedVersion === undefined
          ? {}
          : { expectedVersion: input.expectedVersion }),
      },
      { actor: input.actor, actorId: input.actorId, reason: input.reason },
    )
    return {
      version: r.version,
      previousStatus: r.previousStatus,
      newStatus: r.newStatus,
    }
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

    const readVersion = projection.version
    const newVersion = readVersion + 1

    const applied = await prisma.$transaction(async (tx: TxClient) => {
      const { count } = await tx.orderProjection.updateMany({
        where: { id: orderId, version: readVersion },
        data: {
          fulfillmentStatus: input.newStatus as PrismaFulfillmentStatus,
          version: newVersion,
        },
      })

      if (count === 0) return false

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

      return true
    })

    if (!applied) return null

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
    // ── R1-DELETE: bare-arg @deprecated methods removed ─────────────────
    // The executor helpers (executeCreate, executeTransition,
    // executeReconcile) remain — they're invoked from the envelope-typed
    // entry points below.
    //
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

    writeAdjudicatedNote,

    writeAdjudicatedStatusTransition,

    async addNoteFromEnvelope(envelope, orderState, extras) {
      // Note-add goes through @ibatexas/pack-orders (the LLM-facing Pack).
      // The orderState is the same shape the Pack's policies expect — the
      // caller (cart tool) projects it from the order projection.
      //
      // The POST-adjudication write (author mapping + prisma.orderNote.create)
      // is `writeAdjudicatedNote` — shared with governed ops callers that
      // adjudicated through the COMPOSED router (BKL-083 option b). Here the
      // note is adjudicated against the RAW ordersPolicyBundle FIRST, then the
      // executor persists via the same shared body — behavior-preserving.
      return withAdjudicate(
        envelope,
        orderState,
        ordersPolicyBundle,
        (payload) => writeAdjudicatedNote(payload, extras),
        adjudicateOptions,
      )
    },

    async emitFiscalFromEnvelope(envelope, orderState, executor) {
      // NEW-014 — the fiscal emit adjudicates against the PACK bundle (the
      // eligibility + retry-cap guards live there); the caller-supplied
      // executor performs the provider emission + record write POST-decision.
      return withAdjudicate(
        envelope,
        orderState,
        ordersPolicyBundle,
        (payload) => executor(payload),
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
