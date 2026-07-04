// ops-alert-policy.ts — domain-internal PolicyBundle for the OpsAlertService
// chokepoint (NEW-025 ops-alert plane, detection half).
//
// Scope (intent kinds covered):
//   - ops.alert.open    — SYSTEM. Raised by a deterministic ops watchdog job
//                         (dlq-depth / stuck-order / pix-expiry-backlog /
//                         stale-defer scanners) when a global operational
//                         condition is detected.
//   - ops.alert.resolve — SYSTEM/STAFF. Closed when the watchdog observes the
//                         condition cleared (AUTO) or a staff member resolves it
//                         from the ops inbox (STAFF).
//
// Mirrors `incident-policy.ts`: a small SYSTEM-only bundle that lets the
// OpsAlertService route through the kernel via `withAdjudicate` without minting
// an LLM-proposable intent vocabulary. The LLM has no business raising or
// resolving ops alerts — these are system/staff-driven mutations (CLAUDE.md
// rule #9). Deliberately SEPARATE from the conversation `incident.ticket.*`
// plane so the frozen no-reply cause taxonomy stays untouched (owner decision,
// 2026-07-03: parallel ops-alert plane).
//
// `ops.alert.*` are deliberately ABSENT from `KNOWN_INTENT_KINDS`
// (`@ibatexas/intent-kinds`) and are not installed as a Pack — `assertPackCoverage`
// runs over `PACK_REGISTERED_INTENT_KINDS`, so a kind absent from `KNOWN` is
// never checked and cannot throw `PackCoverageError` (the `incident.ticket.*`
// situation this mirrors).

import {
  basis,
  BASIS_CODES,
  decisionExecute,
  decisionRefuse,
  refuse,
} from "@adjudicate/core"
import { type Guard, type PolicyBundle } from "@adjudicate/core/kernel"
import { createSystemTaintPolicy } from "@adjudicate/primitives"
import type {
  OpsAlertCause,
  OpsAlertResolutionType,
  OpsAlertSeverity,
} from "../../generated/prisma-client/client.js"

// ── Intent kinds + payloads ────────────────────────────────────────────────

export type OpsAlertIntentKind = "ops.alert.open" | "ops.alert.resolve"

/**
 * The FROZEN ops-cause taxonomy. A defensive kernel guard
 * (`rejectUnknownOpsCause`) REFUSEs any `ops.alert.open` whose `cause` is
 * outside this set, so even a buggy watchdog fails CLOSED at the chokepoint (the
 * job-built payload is otherwise cast with no runtime validation). Pinned to the
 * `OpsAlertCause` enum via `satisfies` — a schema enum member added without a
 * taxonomy entry is a compile error.
 */
export const FROZEN_OPS_CAUSES = [
  "ops_stuck_order",
  "ops_pix_expiry_backlog",
  "ops_stale_defer",
  "ops_dlq_depth",
  "ops_ingredient_underflow",
  "ops_staff_auth_infra",
] as const satisfies readonly OpsAlertCause[]

/**
 * CANONICAL pt-BR labels for the ops-cause taxonomy — the single server-side
 * source of truth (staff pings, digests, the ops inbox, the future ops agent).
 * Typed as an EXHAUSTIVE `Record<OpsAlertCause, string>`: adding a member to the
 * `OpsAlertCause` enum fails the BUILD until it is labeled here, so a cause can
 * never silently fall back to its raw enum key. Mirrors the `satisfies` pin on
 * `FROZEN_OPS_CAUSES`.
 */
export const OPS_ALERT_CAUSE_LABELS_PT: Record<OpsAlertCause, string> = {
  ops_stuck_order: "pedidos travados (não pagos além do limite)",
  ops_pix_expiry_backlog: "acúmulo de PIX expirados",
  ops_stale_defer: "confirmações pendentes vencidas",
  ops_dlq_depth: "fila de mensagens mortas acumulando (DLQ)",
  ops_ingredient_underflow: "estoque de insumo abaixo do necessário (baixa de pedido)",
  ops_staff_auth_infra: "falha de infraestrutura na autenticação de funcionários (logins de staff caindo)",
}

/** CANONICAL pt-BR severity labels — exhaustive over `OpsAlertSeverity`. */
export const OPS_ALERT_SEVERITY_LABELS_PT: Record<OpsAlertSeverity, string> = {
  low: "baixa",
  medium: "média",
  high: "alta",
}

export interface OpsAlertOpenPayload {
  /** Must be one of `FROZEN_OPS_CAUSES` — the guard REFUSEs anything else. */
  readonly cause: OpsAlertCause
  /** Detector-assigned severity band. Increments take the MAX of open + incoming. */
  readonly severity: OpsAlertSeverity
  /** The job/subsystem that raised it (e.g. "dlq-depth-checker"). */
  readonly source: string
  /** The specific resource in scope (queue name, order id…), or null when global. */
  readonly scope?: string | null
  /** pt-BR one-line summary shown in the ops inbox. */
  readonly title: string
  /** Non-PII diagnostic string. */
  readonly detail?: string | null
  /** Structured, JSON-safe payload the ops agent consumes (thresholds, counts…). */
  readonly context?: Record<string, unknown> | null
  /**
   * The CONDITION identity — one OPEN alert per dedupeKey (partial-unique WHILE
   * non-terminal). Repeat detections of the same condition fold in (occurrences++)
   * rather than duplicating. Typically `<cause>:<scope>`.
   */
  readonly dedupeKey: string
}

export interface OpsAlertResolvePayload {
  readonly id: string
  /** `"system"` (watchdog observed the condition cleared) or `"staff:<id>"`. */
  readonly resolvedBy: string
  /** AUTO → AUTO_RESOLVED; STAFF → RESOLVED. */
  readonly resolutionType: OpsAlertResolutionType
}

export type OpsAlertPayload = OpsAlertOpenPayload | OpsAlertResolvePayload

/**
 * Per-call state snapshot. The ops-alert policy relies entirely on the SYSTEM
 * taint floor + the frozen-cause check; it reads no projected state (the
 * imperative service body owns dedup / state-machine logic). Kept as an optional
 * bag so callers can pass `{}`.
 */
export interface OpsAlertState {
  readonly ctx?: Record<string, unknown>
}

// ── Taint policy ───────────────────────────────────────────────────────────

/**
 * Both kinds are SYSTEM-only. Ops alerts are minted by deterministic watchdog
 * jobs / staff routes, never by the LLM. The taint gate REFUSEs any UNTRUSTED
 * proposal before the business guards run.
 */
export const opsAlertTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: ["ops.alert.open", "ops.alert.resolve"],
  userMinimum: "UNTRUSTED",
})

// ── Guards ────────────────────────────────────────────────────────────────

type OpsAlertGuard = Guard<OpsAlertIntentKind, OpsAlertPayload, OpsAlertState>

/**
 * Defensive frozen-cause check. REFUSEs an `ops.alert.open` whose `cause` is
 * outside `FROZEN_OPS_CAUSES` so even a buggy watchdog fails CLOSED. The kernel
 * evaluates business guards first-match in array order, so this MUST precede
 * `executeAll` in the bundle for the REFUSE to win on a bad cause.
 */
const rejectUnknownOpsCause: OpsAlertGuard = (envelope) => {
  if (envelope.kind !== "ops.alert.open") return null
  const payload = envelope.payload as OpsAlertOpenPayload
  if (FROZEN_OPS_CAUSES.includes(payload.cause)) return null
  return decisionRefuse(
    refuse(
      "BUSINESS_RULE",
      "ops_alert.cause_out_of_taxonomy",
      "Não foi possível registrar o alerta operacional: causa inválida.",
      `cause '${String(payload.cause)}' is not in the frozen ops-alert taxonomy`,
    ),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "frozen_ops_cause",
        cause: String(payload.cause),
      }),
    ],
  )
}

/**
 * Single EXECUTE producer for both kinds. Ops alerts move no money → plain
 * EXECUTE, no threshold bands. The bundle default is REFUSE so any uncovered
 * kind is denied by construction; the SYSTEM taint floor already rejected
 * UNTRUSTED proposals before this point.
 */
const executeAll: OpsAlertGuard = (envelope) => {
  switch (envelope.kind) {
    case "ops.alert.open":
    case "ops.alert.resolve":
      return decisionExecute([
        basis("business", BASIS_CODES.business.RULE_SATISFIED, {
          kind: envelope.kind,
        }),
      ])
    default:
      return null
  }
}

// ── PolicyBundle ──────────────────────────────────────────────────────────

export const opsAlertPolicyBundle: PolicyBundle<
  OpsAlertIntentKind,
  OpsAlertPayload,
  OpsAlertState
> = {
  stateGuards: [],
  authGuards: [],
  taint: opsAlertTaintPolicy,
  business: [rejectUnknownOpsCause, executeAll],
  default: "REFUSE",
}
