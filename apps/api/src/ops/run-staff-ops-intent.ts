// run-staff-ops-intent.ts — the OPS-ACTOR intent seam (NEW-032 first slice).
//
// BKL-069 made the staff actor kernel-governed (actor.role on the 7 staff-plane
// kinds) and installed `staffRoleGuard` into every pack's AUTH phase via the
// composed router (compose-policy-packs.ts). But that guard is DORMANT: it fires
// only on an `admin:`-namespaced session (staff-role-guard.ts), and today's admin
// HTTP routes adjudicate against RAW command-service bundles (which do NOT carry
// the adopter auth guards), while the LLM planner stamps `principal:"llm"` +
// conversation sessionId. So no surface routes an `admin:`+role envelope through
// the COMPOSED bundle — the guard never engages.
//
// This helper is the surface that closes that gap: it builds the `admin:${staffId}`
// + `actor.role` staff envelope (reusing the `routes/admin/_shared-actions.ts`
// derivation) and adjudicates it through the caller-supplied COMPOSED policy
// (`policyForKind` — the bundle that carries `staffRoleGuard`), so the guard
// actually gates the mutation. On EXECUTE it runs a post-adjudication executor
// (governed — the kernel already ran). Deps are INJECTED so the guard behaviour is
// unit-testable against the real composed bundle + real kernel `adjudicate` without
// pulling the whole composition root into the test.
//
// Governance (CLAUDE.md #9): every ops mutation is a governed IntentEnvelope
// adjudicated by the composed router. The executor runs ONLY on EXECUTE/REWRITE —
// a REFUSE (wrong/absent role, or a business/state guard) never executes.

import { randomUUID } from "node:crypto";
import {
  buildEnvelope,
  decisionRefuse,
  refuse,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core";
import type { PolicyBundle } from "@adjudicate/core/kernel";
import {
  actorFor,
  principalFor,
  type StaffActorRole,
} from "../routes/admin/_shared-actions.js";

/**
 * Build the `admin:${staffId}` + `actor.role` staff envelope — the exact shape
 * `staffRoleGuard` gates (its engagement predicate is `sessionId.startsWith("admin:")`).
 * `role` is canonical-drop-safe (absent stays absent) via `actorFor`. Pure.
 */
export function buildStaffOpsEnvelope(
  kind: string,
  payload: Record<string, unknown>,
  staffId: string | null,
  actorRole?: StaffActorRole,
): IntentEnvelope {
  const { actorPrincipal, taint, sessionId, actorRole: role } = principalFor(
    staffId,
    actorRole,
  );
  return buildEnvelope({
    kind,
    payload,
    nonce: randomUUID(),
    actor: actorFor({ principal: actorPrincipal, sessionId, role }),
    taint,
  }) as IntentEnvelope;
}

export interface StaffOpsIntentDeps<R> {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  /** Authenticated staff id (from the JWT/session). `null` ⇒ admin:api-key actor. */
  readonly staffId: string | null;
  /** The staff's adopter role (OWNER/MANAGER/ATTENDANT). Absent ⇒ guard REFUSEs. */
  readonly actorRole?: StaffActorRole;
  /** The per-kind SystemState the pack's state/business guards read. */
  readonly state: unknown;
  /**
   * `policyForKind` — resolves the COMPOSED bundle (with the prepended
   * `staffRoleGuard`) that OWNS `kind`. `null` (no installed pack owns it) ⇒
   * fail-closed REFUSE.
   */
  readonly resolvePolicy: (
    kind: string,
  ) => PolicyBundle<string, unknown, unknown> | null;
  /** The audited kernel adjudication (`buildAdjudicator().adjudicate`). */
  readonly adjudicate: (
    envelope: IntentEnvelope,
    state: unknown,
    policy: PolicyBundle<string, unknown, unknown>,
  ) => Promise<Decision>;
  /** POST-adjudication side effect — runs ONLY on EXECUTE/REWRITE. */
  readonly executor: (payload: Record<string, unknown>) => Promise<R>;
}

export interface StaffOpsIntentResult<R> {
  readonly decision: Decision;
  readonly executed: boolean;
  readonly result?: R;
}

/**
 * Route a staff/ops intent through the COMPOSED policy router so the AUTH-phase
 * `staffRoleGuard` gates it (NEW-032). Returns the kernel `Decision`; the executor
 * runs (and `executed` is true) ONLY on EXECUTE/REWRITE. Fail-closed: an unrouted
 * kind REFUSEs and the executor never runs.
 */
export async function runStaffOpsIntent<R>(
  deps: StaffOpsIntentDeps<R>,
): Promise<StaffOpsIntentResult<R>> {
  const policy = deps.resolvePolicy(deps.kind);
  if (policy === null) {
    // Fail-closed: no installed pack owns this kind → no authority to mutate.
    return {
      decision: decisionRefuse(
        refuse(
          "SECURITY",
          "ops_kind_unrouted",
          "Ação não disponível.",
          `no composed policy routes ops kind '${deps.kind}'`,
        ),
        [],
      ),
      executed: false,
    };
  }

  const envelope = buildStaffOpsEnvelope(
    deps.kind,
    deps.payload,
    deps.staffId,
    deps.actorRole,
  );
  const decision = await deps.adjudicate(envelope, deps.state, policy);

  if (decision.kind === "EXECUTE" || decision.kind === "REWRITE") {
    const payload =
      decision.kind === "REWRITE"
        ? (decision.rewritten.payload as Record<string, unknown>)
        : deps.payload;
    const result = await deps.executor(payload);
    return { decision, executed: true, result };
  }
  return { decision, executed: false };
}
