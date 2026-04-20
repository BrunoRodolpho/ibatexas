// OrderCommandService — write operations for order projections.
//
// Implements optimistic concurrency control via version field.
// All status transitions are validated against the canonical state machine
// and recorded in OrderStatusHistory for full audit trail.
//
// INVARIANT: No event without version is allowed past the command layer.

import { prisma } from "../client.js"
import { Prisma } from "../generated/prisma-client/client.js"
import type { PrismaClient } from "../generated/prisma-client/client.js"
import type { OrderFulfillmentStatus as PrismaFulfillmentStatus, OrderActor as PrismaActor } from "../generated/prisma-client/client.js"
import { canTransition, type OrderFulfillmentStatus } from "@ibatexas/types"
import type { CreateOrderProjectionInput } from "../mappers/medusa-order.mapper.js"

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

// ── Service ─────────────────────────────────────────────────────────────────

export interface OrderCommandService {
  /** Create a new order projection (called on order.placed). */
  create(data: CreateOrderProjectionInput): Promise<{ id: string; version: number }>

  /**
   * Transition order status with validation and optimistic concurrency.
   * Used by the PATCH endpoint (admin action).
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
   * Reconcile status from an event (subscriber safety net).
   * Ignores stale events (eventVersion <= projection.version).
   * Returns null if skipped (already applied or stale).
   *
   * @throws MissingEventVersionError if eventVersion is missing
   */
  reconcileStatus(orderId: string, input: ReconcileStatusInput): Promise<{ version: number } | null>
}

type Logger = { warn?: (...args: unknown[]) => void }

export function createOrderCommandService(log?: Logger): OrderCommandService {
  return {
    async create(data) {
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
            // OrderEventItem[] is JSON-serializable; bridge the nominal type gap
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

        // Record initial status in history
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
    },

    async transitionStatus(orderId, input) {
      return prisma.$transaction(async (tx: TxClient) => {
        const projection = await tx.orderProjection.findUnique({
          where: { id: orderId },
        })

        if (!projection) {
          throw new ProjectionNotFoundError(orderId)
        }

        // Optimistic concurrency check
        if (input.expectedVersion !== undefined && projection.version !== input.expectedVersion) {
          throw new ConcurrencyError(orderId, input.expectedVersion, projection.version)
        }

        // Validate transition
        const from = projection.fulfillmentStatus as OrderFulfillmentStatus
        const to = input.newStatus
        if (!canTransition(from, to)) {
          throw new InvalidTransitionError(orderId, from, to)
        }

        const newVersion = projection.version + 1

        // Update projection
        await tx.orderProjection.update({
          where: { id: orderId },
          data: {
            fulfillmentStatus: to as PrismaFulfillmentStatus,
            version: newVersion,
          },
        })

        // Record in audit history
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

        return {
          version: newVersion,
          previousStatus: from,
          newStatus: to,
        }
      })
    },

    async reconcileStatus(orderId, input) {
      // INVARIANT: no event without version
      if (input.eventVersion == null) {
        throw new MissingEventVersionError(orderId)
      }

      const projection = await prisma.orderProjection.findUnique({
        where: { id: orderId },
      })

      if (!projection) {
        // Projection doesn't exist yet — possible ordering issue.
        // Let the order.placed subscriber create it first.
        return null
      }

      // Stale event — already applied or superseded
      if (input.eventVersion <= projection.version) {
        return null
      }

      // Already at the target status — no-op
      if (projection.fulfillmentStatus === input.newStatus) {
        return null
      }

      // Validate transition (even for reconciliation)
      const from = projection.fulfillmentStatus as OrderFulfillmentStatus
      if (!canTransition(from, input.newStatus)) {
        log?.warn?.(
          { orderId, from, to: input.newStatus, eventVersion: input.eventVersion, projectionVersion: projection.version },
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
    },
  }
}
