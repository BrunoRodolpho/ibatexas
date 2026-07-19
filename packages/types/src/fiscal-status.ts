// NEW-014 — fiscal document (NFC-e) emission status. Mirrors BOTH:
//   - the Prisma `FiscalStatus` enum (packages/domain/prisma/schema.prisma) —
//     kept in sync by fiscal-status-enum-sync.test.ts in packages/domain, and
//   - the provider port's `FiscalEmitStatus` (@ibatexas/tools fiscal/port.ts)
//     plus the `pending` initial state (a record exists before the first
//     provider outcome lands).
//
// `rejected` is TERMINAL for automation (NEW-014 gate: a SEFAZ rejection is
// never auto-retried — human review only); `timeout`/`error` are the retriable
// outcomes, bounded by FISCAL_EMIT_MAX_ATTEMPTS in @ibatexas/pack-orders.

export const FiscalStatus = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  TIMEOUT: "timeout",
  ERROR: "error",
} as const

export type FiscalStatus = (typeof FiscalStatus)[keyof typeof FiscalStatus]

/** Statuses automation must NEVER retry from (approved = done; rejected = human review). */
export const TERMINAL_FISCAL_STATUSES = [
  FiscalStatus.APPROVED,
  FiscalStatus.REJECTED,
] as const

export type TerminalFiscalStatus = (typeof TERMINAL_FISCAL_STATUSES)[number]
