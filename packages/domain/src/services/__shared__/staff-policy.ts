// staff-policy.ts — domain-internal PolicyBundle for the StaffCommandService
// chokepoint (AUT-038 + AUT-007 — the OWNER-gated staff-CRUD plane).
//
// Scope (intent kinds covered):
//   - staff.create        — OWNER. Register (or reactivate) a staff member.
//   - staff.update        — OWNER. Edit name / phone / hourly rate. NEVER role.
//   - staff.deactivate    — OWNER. Soft-deactivate (active = false); no delete.
//   - staff.role.assign   — OWNER. Change a staff member's role (privilege
//                           escalation ⇒ its OWN audit kind, split from update).
//
// Mirrors `ops-alert-policy.ts` / `incident-policy.ts`: a small domain-internal
// bundle that lets the StaffCommandService route through the kernel via
// `withAdjudicate` WITHOUT minting an LLM-proposable intent vocabulary. Staff
// records are PII + privilege-granting; the LLM has no business creating,
// editing, deactivating or re-roling staff — these are OWNER-driven HTTP-plane
// mutations (CLAUDE.md rule #9).
//
// `staff.*` are deliberately ABSENT from `KNOWN_INTENT_KINDS`
// (`@ibatexas/intent-kinds`) and are not installed as a Pack — `assertPackCoverage`
// runs over `PACK_REGISTERED_INTENT_KINDS`, so a kind absent from `KNOWN` is
// never checked and cannot throw `PackCoverageError` (the `ops.alert.*` /
// `incident.ticket.*` situation this mirrors). They are equally absent from every
// capability planner / tool roster, `SUCCESS_CLAIM_CLASSES` and the claim
// registry: HTTP-only staff-plane verbs, invisible to the LLM.
//
// ── Taint floor: TRUSTED (NOT the SYSTEM-only floor of ops-alerts) ────────────
//
// Ordering is `SYSTEM > TRUSTED > UNTRUSTED` (@adjudicate/core taint lattice).
// The admin staff routes build the envelope actor from the authenticated caller:
//   - staff JWT (OWNER)  → principal "user",   taint TRUSTED
//   - admin API key      → principal "system", taint SYSTEM
// A `TRUSTED` floor admits BOTH (SYSTEM outranks TRUSTED) and REFUSEs the only
// remaining provenance — `UNTRUSTED` (an LLM proposal) — at the taint phase
// BEFORE the auth / business guards run. This is the correct floor for the
// staff plane:
//   - NOT the SYSTEM-only floor `ops-alert-policy` / `incident-policy` use
//     (which would REJECT an OWNER's own JWT-TRUSTED create — a staff OWNER
//     legitimately administers staff); and
//   - NOT the `UNTRUSTED` floor the reservations pack uses (reservation
//     checkin/complete/cancel ARE customer/LLM-reachable and lean on auth/state
//     guards to catch abuse) — no LLM path may ever build a staff-CRUD verb.
//
// ── Role authorization is INJECTED at the API layer (BKL-074 idiom) ───────────
//
// `authGuards` is intentionally EMPTY here. The OWNER-only role gate is the
// `staffRoleGuard` (staff-role-matrix.ts lists all four kinds as ["OWNER"]),
// injected into every `withAdjudicate` call the StaffCommandService makes via
// `WithAdjudicateOptions.authGuards` — the same seam the admin reservation
// routes use (BKL-074). The guard is inert for non-`admin:` sessions, so the
// bundle stays composable. The PRIMARY route gate is `requireOwnerRole`
// (Fastify preHandler); the injected guard is the kernel-level backstop.

import {
  basis,
  BASIS_CODES,
  decisionExecute,
  type Taint,
  type TaintPolicy,
} from "@adjudicate/core"
import { type Guard, type PolicyBundle } from "@adjudicate/core/kernel"
import type { StaffRole } from "../../generated/prisma-client/client.js"

// ── Intent kinds + payloads ────────────────────────────────────────────────

export type StaffCommandIntentKind =
  | "staff.create"
  | "staff.update"
  | "staff.deactivate"
  | "staff.role.assign"

/**
 * The closed set of staff roles — GENUINELY exhaustive over the Prisma
 * `StaffRole` enum (FIX 6c): the `Record<StaffRole, true>` key set must cover
 * every enum member, so ADDING a member to the schema enum fails the BUILD here
 * until it is listed. (The previous `satisfies readonly StaffRole[]` pin did
 * NOT guarantee that — a SUBSET of the enum also satisfies an array-of-enum
 * type.) The single runtime source of truth for the service's role validation.
 */
const STAFF_ROLE_EXHAUSTIVE: Record<StaffRole, true> = {
  OWNER: true,
  MANAGER: true,
  ATTENDANT: true,
}

export const STAFF_ROLE_VALUES = Object.keys(
  STAFF_ROLE_EXHAUSTIVE,
) as readonly StaffRole[]

export interface StaffCreatePayload {
  /** E.164 phone (`@unique`). Reactivates an existing INACTIVE row (CLI idiom). */
  readonly phone: string
  readonly name: string
  /** Closed set — validated against {@link STAFF_ROLE_VALUES}. */
  readonly role: StaffRole
  /** Integer centavos/hour ≥ 0, or null (excluded from labor cost). */
  readonly hourlyRateCentavos?: number | null
}

/**
 * Edit a staff member's non-privilege fields. DELIBERATELY carries NO `role`
 * field — a role change is privilege escalation and rides `staff.role.assign`
 * (its own audit kind). The route's zod body is `.strict()`, and the service
 * REFUSEs a stray `role` key defensively.
 */
export interface StaffUpdatePayload {
  readonly staffId: string
  readonly name?: string
  readonly phone?: string
  readonly hourlyRateCentavos?: number | null
}

export interface StaffDeactivatePayload {
  readonly staffId: string
}

export interface StaffRoleAssignPayload {
  readonly staffId: string
  readonly role: StaffRole
}

export type StaffCommandPayload =
  | StaffCreatePayload
  | StaffUpdatePayload
  | StaffDeactivatePayload
  | StaffRoleAssignPayload

/**
 * Per-call state snapshot. The staff-command policy relies entirely on the
 * TRUSTED taint floor + the injected `staffRoleGuard`; it reads no projected
 * state (the imperative service body owns the last-owner / self-mutation /
 * duplicate-phone invariants). Kept as an optional bag so callers pass `{}`.
 */
export interface StaffCommandState {
  readonly ctx?: Record<string, unknown>
}

// ── Taint policy ───────────────────────────────────────────────────────────

/**
 * TRUSTED floor for every staff-command kind. See the module header for why
 * TRUSTED (admits staff-JWT TRUSTED + API-key SYSTEM; REFUSEs LLM UNTRUSTED)
 * rather than the SYSTEM-only floor of ops-alerts or the UNTRUSTED floor of
 * reservations. Written explicitly (not via `createSystemTaintPolicy`) because
 * a uniform TRUSTED minimum is clearer as a one-line policy — exactly the case
 * the `createSystemTaintPolicy` doc flags as "usually clearer" as a custom
 * TaintPolicy.
 */
const STAFF_COMMAND_TAINT_FLOOR: Taint = "TRUSTED"

export const staffCommandTaintPolicy: TaintPolicy = {
  minimumFor(_intentKind: string): Taint {
    return STAFF_COMMAND_TAINT_FLOOR
  },
}

// ── Guards ────────────────────────────────────────────────────────────────

type StaffCommandGuard = Guard<
  StaffCommandIntentKind,
  StaffCommandPayload,
  StaffCommandState
>

/**
 * Single EXECUTE producer for the four staff-command kinds. Staff CRUD moves no
 * money → plain EXECUTE, no threshold bands. The bundle default is REFUSE so any
 * uncovered kind is denied by construction; the TRUSTED taint floor already
 * rejected UNTRUSTED (LLM) proposals and the injected `staffRoleGuard` already
 * enforced OWNER before this point. The business INVARIANTS (last-owner,
 * self-mutation, duplicate-phone, not-found, field validation) live in the
 * StaffCommandService executors as typed errors, NOT here — the kernel gate is
 * authorization + provenance only.
 */
const executeAll: StaffCommandGuard = (envelope) => {
  switch (envelope.kind) {
    case "staff.create":
    case "staff.update":
    case "staff.deactivate":
    case "staff.role.assign":
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

export const staffCommandPolicyBundle: PolicyBundle<
  StaffCommandIntentKind,
  StaffCommandPayload,
  StaffCommandState
> = {
  stateGuards: [],
  // Role authorization (`staffRoleGuard`) is INJECTED at the API layer via
  // `WithAdjudicateOptions.authGuards` (BKL-074), not baked into the bundle —
  // see the module header.
  authGuards: [],
  taint: staffCommandTaintPolicy,
  business: [executeAll],
  default: "REFUSE",
}
