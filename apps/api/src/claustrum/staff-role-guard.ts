/**
 * Staff-plane per-role capability guard (WS7 / BKL-069 Part C) — the AUTH-phase
 * adopter guard that enforces {@link STAFF_ROLE_CAPABILITY_MATRIX} over any
 * staff-plane (`admin:`) envelope THAT REACHES IT. It is prepended to every
 * pack's AUTH phase by `buildIbatexasPolicyPacks` (compose-policy-packs.ts),
 * alongside the managed-agent scope/kill/budget guards.
 *
 * ── Exactly where this guard is LIVE (no overstatement) ──────────────────────
 * `buildIbatexasPolicyPacks` feeds the COMPOSED bundles into exactly two seams:
 * the conductor's per-kind router (`composePolicyRouter` → `policyForKind` in
 * claustrum-bootstrap.ts) and the pure policy-manifest exporter. So this guard
 * runs whenever an envelope is adjudicated through `policyForKind` /
 * `composePolicyRouter`:
 *   - the conductor turn (customer / LLM sessions — inert here, no `admin:`);
 *   - the agent-approvals gateway resume (`getAgentApprovalGateway().resolve`,
 *     `policyFor: policyForKind`), whose only executing kind today is the
 *     agent-plane `payment.pix.regenerate` (`agent:` session — also inert);
 *   - any FUTURE ops-actor surface that routes an `admin:` envelope through
 *     `policyForKind`. The WS6 / NEW-032 governed ops plane this build unblocks
 *     is exactly that seam, and is the case for which this guard exists.
 * The guard is a REAL, active AUTH gate at the composed-router seam; it simply
 * is not exercised yet because no `admin:`-session envelope reaches that seam
 * today.
 *
 * ── Where this guard is NOT (today's HTTP admin routes) ──────────────────────
 * The admin HTTP routes for the seven staff-plane kinds do NOT adjudicate
 * through the composed router. Each builds its `admin:` envelope and calls a
 * domain command service (`order-command` / `payment-command` / the reservation
 * command service), which adjudicates against the RAW pack bundle directly
 * (`ordersPolicyBundle` / `orderProjectionPolicyBundle` /
 * `paymentProjectionPolicyBundle` / `reservationsPolicyBundle`). Those raw
 * bundles do NOT carry the adopter auth guards, so this guard does NOT run on
 * the HTTP admin adjudication path. There, role enforcement is the Fastify
 * preHandler chain (`requireStaff` / `requireManager` / `requireManagerRole` /
 * `requireOwnerRole` in middleware/staff-auth.ts) — the PRIMARY gate. Adding a
 * kernel-level role backstop to the HTTP command-service path (so role is
 * enforced in the adjudication itself, not only the preHandler) is tracked as
 * follow-up BKL-074.
 *
 * ALTITUDE — AUTH, never business (same trap `agent-guards.ts` documents): the
 * kernel evaluates state → taint → auth → business, and
 * `confirmOnAutoResolveGuard` is prepended to the business phase. A role guard
 * in the business phase could let a staff-plane money kind short-circuit into
 * REQUEST_CONFIRMATION before it could REFUSE. This guard adds AUTHORIZATION
 * FRICTION ONLY: it returns `null` (inert / authorized) or REFUSE — never
 * EXECUTE/CONFIRM/ESCALATE.
 *
 * Engagement predicate: `actor.sessionId.startsWith("admin:")`. All `admin:`
 * sessionIds are minted by `principalFor` / the mirrored inline builders under
 * `routes/admin/` (`admin:${staffId}` | `admin:api-key`); customer, LLM,
 * managed-agent (`agent:`) and system-subscriber (`${sourceSubject}:${eventId}`)
 * envelopes never carry that prefix, so the guard is inert for them.
 *
 * Fail-closed everywhere on the staff plane: an `admin:` envelope is authorized
 * ONLY when its kind is a known staff-plane verb AND its `actor.role` is a known
 * role AND that role is permitted for that kind. Every other case REFUSEs:
 *   - kind outside the matrix       → de-vacuum (the matrix IS the staff verb surface);
 *   - `actor.role` absent           → a staff verb cannot be role-authorized;
 *   - `actor.role` an unknown value → unrecognized identity;
 *   - role known but not permitted  → insufficient scope.
 * The single userFacing message is role-opaque (SCN-125 — zero info leak: it
 * never reveals which roles WOULD be allowed); machine detail rides the
 * (non-user-facing) refusal `detail` + basis for audit/replay.
 */

import { basis, BASIS_CODES, decisionRefuse, refuse } from "@adjudicate/core";
import { nameGuard, type Guard } from "@adjudicate/core/kernel";
import type { StaffActorRole } from "../routes/admin/_shared-actions.js";
import { STAFF_ROLE_CAPABILITY_MATRIX } from "./staff-role-matrix.js";

/** The staff-plane sessionId namespace this guard engages on. */
export const STAFF_SESSION_NAMESPACE = "admin:";

/**
 * Stable machine-readable refusal code for EVERY staff-role refusal (unmatrixed
 * kind, absent role, unknown role, role-not-permitted). Oracles + audit assert
 * this exact string.
 */
export const STAFF_ROLE_REFUSAL_CODE = "staff_role_violation";

/**
 * Role-opaque pt-BR user-facing copy (CLAUDE.md hard rule #4; SCN-125 zero
 * info leak). Identical for every refusal branch so the reply never discloses
 * whether the block was the kind, the missing/unknown role, or the permission.
 */
export const STAFF_ROLE_REFUSAL_PT_BR =
  "Seu nível de acesso não permite executar esta ação.";

const refuseStaffRole = (detail: string) =>
  refuse("AUTH", STAFF_ROLE_REFUSAL_CODE, STAFF_ROLE_REFUSAL_PT_BR, detail);

/**
 * AUTH-phase staff capability guard over `matrix` (role → allowed staff-plane
 * kinds). See module header for semantics. Pure (no I/O) — composable by the
 * conductor router AND the pure policy-manifest exporter / CLI, same constraint
 * as the agent guards.
 */
export function createStaffRoleGuard(
  matrix: Record<StaffActorRole, ReadonlySet<string>>,
): Guard<string, unknown, unknown> {
  // The authoritative staff-plane verb surface = the union of every role's
  // allowed kinds, derived from the matrix so it cannot drift from it.
  const staffPlaneKinds = new Set<string>();
  for (const kinds of Object.values(matrix)) {
    for (const kind of kinds) staffPlaneKinds.add(kind);
  }

  const guard: Guard<string, unknown, unknown> = (envelope, _state) => {
    const { sessionId, role } = envelope.actor;

    // Engage ONLY on the staff plane. Customer / LLM / managed-agent / system
    // traffic passes through untouched.
    if (!sessionId.startsWith(STAFF_SESSION_NAMESPACE)) return null;

    const kind = envelope.kind;

    // De-vacuum: the matrix IS the authoritative staff-plane verb surface. An
    // `admin:` envelope whose kind is outside the seven is a forged / drifted
    // staff-plane verb — fail closed.
    if (!staffPlaneKinds.has(kind)) {
      return decisionRefuse(
        refuseStaffRole(`staff-plane kind "${kind}" is outside the role matrix`),
        [
          basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, {
            sessionId,
            kind,
            reason: "kind_not_in_staff_matrix",
          }),
        ],
      );
    }

    // A staff-plane verb must be role-authorized — an absent role cannot be
    // checked against a per-role matrix.
    if (role === undefined) {
      return decisionRefuse(
        refuseStaffRole(`staff-plane envelope for "${kind}" carries no actor.role`),
        [
          basis("auth", BASIS_CODES.auth.IDENTITY_MISSING, {
            sessionId,
            kind,
            reason: "staff_role_absent",
          }),
        ],
      );
    }

    // Unknown role value ⇒ unrecognized identity ⇒ fail closed.
    const allowed = (matrix as Record<string, ReadonlySet<string>>)[role];
    if (allowed === undefined) {
      return decisionRefuse(
        refuseStaffRole(`unknown staff role "${role}" for kind "${kind}"`),
        [
          basis("auth", BASIS_CODES.auth.IDENTITY_MISSING, {
            sessionId,
            kind,
            role,
            reason: "staff_role_unknown",
          }),
        ],
      );
    }

    // Known role permitted for this kind ⇒ authorized (add no friction).
    if (allowed.has(kind)) return null;

    // Known role NOT permitted for this kind ⇒ REFUSE (insufficient scope).
    return decisionRefuse(
      refuseStaffRole(`role "${role}" not permitted for kind "${kind}"`),
      [
        basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, {
          sessionId,
          kind,
          role,
          reason: "staff_role_not_permitted",
        }),
      ],
    );
  };

  return nameGuard("staffRole", guard);
}

/** The production staff-role guard over the code-truth capability matrix. */
export const staffRoleGuard = createStaffRoleGuard(STAFF_ROLE_CAPABILITY_MATRIX);
