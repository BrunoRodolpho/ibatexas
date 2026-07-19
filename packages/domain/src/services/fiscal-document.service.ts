// NEW-014 — the fiscal document (NFC-e) record service. ONE row per order
// (unique order_id), written ONLY from the fiscal-emitter subscriber's
// POST-adjudication executor (an `order.fiscal.emit` EXECUTE). The direct
// Prisma writes stay inside `packages/domain/src/services/` — the sanctioned
// owner path per the bypass-detection gate.
//
// Lifecycle: `beginAttempt` upserts the row (provider stamped, attempts+1,
// status back to `pending`) BEFORE the provider call; `recordOutcome` persists
// the provider result. `attempts` feeds the pack's `fiscalEmitRetryCapGuard`
// via `ctx.fiscalEmitAttempts` (read by the SUBSCRIBER before adjudication).
// A `rejected` outcome is TERMINAL for automation (never auto-retried — the
// subscriber's pre-check + TERMINAL_FISCAL_STATUSES); `timeout`/`error` stay
// retriable under the cap.

import type { FiscalStatus as PrismaFiscalStatus } from "../generated/prisma-client/client.js"
import { prisma } from "../client.js"

export interface FiscalOutcomeInput {
  readonly status: "approved" | "rejected" | "timeout" | "error"
  readonly accessKey?: string
  readonly xmlUrl?: string
  readonly pdfUrl?: string
  readonly rejectionReason?: string
}

export interface FiscalDocumentRecord {
  readonly id: string
  readonly orderId: string
  readonly status: PrismaFiscalStatus
  readonly provider: string
  readonly attempts: number
  readonly accessKey: string | null
  readonly xmlUrl: string | null
  readonly pdfUrl: string | null
  readonly rejectionReason: string | null
}

export interface FiscalDocumentService {
  /** The order's fiscal record, or null when no emission was ever attempted. */
  getByOrderId(orderId: string): Promise<FiscalDocumentRecord | null>
  /**
   * Upsert the record for a NEW emission attempt: stamps the provider,
   * increments `attempts`, resets status to `pending`. Called ONLY after a
   * positive kernel decision, immediately BEFORE the provider call.
   */
  beginAttempt(orderId: string, provider: string): Promise<FiscalDocumentRecord>
  /** Persist the provider outcome onto the order's record. */
  recordOutcome(orderId: string, outcome: FiscalOutcomeInput): Promise<FiscalDocumentRecord>
}

export function createFiscalDocumentService(): FiscalDocumentService {
  return {
    async getByOrderId(orderId) {
      return prisma.fiscalDocument.findUnique({ where: { orderId } })
    },

    async beginAttempt(orderId, provider) {
      return prisma.fiscalDocument.upsert({
        where: { orderId },
        create: { orderId, provider, attempts: 1, status: "pending" },
        update: { provider, attempts: { increment: 1 }, status: "pending" },
      })
    },

    async recordOutcome(orderId, outcome) {
      return prisma.fiscalDocument.update({
        where: { orderId },
        data: {
          status: outcome.status,
          accessKey: outcome.accessKey ?? null,
          xmlUrl: outcome.xmlUrl ?? null,
          pdfUrl: outcome.pdfUrl ?? null,
          rejectionReason: outcome.rejectionReason ?? null,
        },
      })
    },
  }
}
