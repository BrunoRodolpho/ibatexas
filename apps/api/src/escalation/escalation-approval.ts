// AUT-017 — the ESCALATE→OWNER-approve→executable-resume engine.
//
// When an above-threshold staff refund ESCALATEs, the FULL envelope is parked in
// the escalation park store (single-use, Redis-backed). An OWNER later APPROVEs
// it from the escalações surface; this module resumes it:
//
//   1. peek the park (self-approve check must NOT burn the token);
//   2. single-use CONSUME (atomic GET+DEL — exactly one resume executes);
//   3. rebuild the IDENTICAL envelope (same kind/payload/actor/ROLE/taint/nonce →
//      same intentHash — so the confirmation receipt matches);
//   4. re-project the FRESH pack state (null ⇒ REFUSE fail-closed) and stamp the
//      `escalationApproval` marker on it (STATE, never payload → intentHash
//      unchanged, unforgeable from the wire);
//   5. re-adjudicate through the AUDITED kernel with a `confirmationReceipt`. The
//      pack's escalate-band overlay sees the marker and returns
//      REQUEST_CONFIRMATION; the kernel's 2a override then flips THAT to EXECUTE
//      with a `confirmation_resolved` supersession carrying the bound approver.
//      Every state/taint/auth guard re-runs on the fresh state (an ATTENDANT-forged
//      parked actor REFUSEs; a since-parked terminal/partial refund REFUSEs);
//   6. on EXECUTE, run the per-kind executor (the BKL-085 refund trio — author =
//      approver). An executor throw AFTER the audited EXECUTE is an HONEST failure
//      (502), never a fabricated success.
//
// Option 1 (docs/architecture/defer-resume-role-contract.md §3d): the parked
// PROPOSER stays the envelope actor; the approver is PROVENANCE only — the
// `Supersession.binding.approver` (kernel forensic record) + the projection's
// `resolvedBy`. The kernel never substitutes a new actor.
//
// This module is PURE: every side-effecting dep (`get`/`consume`/`rebuildState`/
// `policyFor`/`sink`/`executors`/`markIntentResolved`/`now`) is injected, so it is
// unit-testable and NOT gated by IBX_AGENTS_ENABLED (it works with the agent plane
// OFF; the park store survives restarts).

import {
  buildEnvelope,
  type AuditRecord,
  type Decision,
  type IntentEnvelope,
  type Ledger,
} from "@adjudicate/core";
import { adjudicateAndAudit, type PolicyBundle } from "@adjudicate/core/kernel";
import { buildSupersessionChains } from "@adjudicate/audit";
import {
  isEscalationResumableKind,
  type EscalationResumableKind,
  type ParkedEscalationIntent,
} from "./escalation-park-store.js";
import type { PendingEscalationIntent } from "./escalation-store.js";

/** Audit sink slice `adjudicateAndAudit` needs (structural; AuditSink-compatible). */
export interface ApprovalAuditSink {
  emit(record: AuditRecord): Promise<void>;
}

/**
 * The per-kind POST-EXECUTE side-effect executor. `payload` is the parked
 * envelope's payload; `approverStaffId` becomes the write's author (Option 1
 * provenance). Throws on failure — the engine surfaces `execute_failed` (502).
 */
export type EscalationExecutor = (
  payload: unknown,
  approverStaffId: string,
  /**
   * BKL-103 — the approver's ROLE, threaded from the resolve surface. Additive
   * third parameter: existing executors that ignore it are unaffected. An executor
   * that composes a further ADJUDICATED step needs it, because the pack overlays
   * hard-gate on `"OWNER"` and defaulting a role would be inventing authority (the
   * approved-cancel executor refuses when it is absent).
   */
  approverRole: string,
) => Promise<void>;

export type EscalationApprovalStatus =
  | "missing"
  | "self_approve"
  | "rejected"
  | "approved"
  | "denied_by_kernel"
  | "execute_failed";

export interface EscalationApprovalResult {
  readonly status: EscalationApprovalStatus;
  readonly intentKind?: string;
  readonly intentHash?: string;
  readonly decision?: Decision;
  /** pt-BR operator-facing text for a `denied_by_kernel` / `execute_failed` outcome. */
  readonly refusalPtBr?: string;
}

export interface EscalationApprovalEngineDeps {
  /** Peek the parked intent WITHOUT consuming (the self-approve check). */
  readonly get: (token: string) => Promise<ParkedEscalationIntent | null>;
  /** Single-use consume (atomic GET+DEL). */
  readonly consume: (token: string) => Promise<ParkedEscalationIntent | null>;
  /**
   * Re-project the FRESH pack state for the rebuilt envelope (production wires
   * this to `enrichResumeState` → `buildOpsRefundResumeState`, a live DB read).
   * A not-found state ⇒ the kernel REFUSEs (fail-closed).
   */
  readonly rebuildState: (envelope: IntentEnvelope) => Promise<unknown>;
  /** Resolve the kind's COMPOSED PolicyBundle (carries `staffRoleGuard`). */
  readonly policyFor: (intentKind: string) => PolicyBundle<string, unknown, unknown>;
  /** Audit sink the resume's `adjudicateAndAudit` emits through (fail-closed). */
  readonly sink: ApprovalAuditSink;
  /** Per-kind POST-EXECUTE executors (`payment.refund.issue` → the BKL-085 trio). */
  readonly executors: Record<string, EscalationExecutor>;
  /** Update the escalation record projection (approved / rejected / denied_by_kernel / execute_failed). */
  readonly markIntentResolved: (
    sessionId: string,
    intentHash: string,
    status: PendingEscalationIntent["status"],
    resolvedBy: string,
    at: string,
  ) => Promise<unknown>;
  /**
   * FIX 5 — the always-on execution ledger (Hard Rule 9). Threaded into
   * `adjudicateAndAudit` so a duplicate `intentHash` is REPLAY_SUPPRESSED even if
   * the atomic park-consume is somehow bypassed (defense-in-depth: the ledger is
   * NOT the sole guard, but Hard Rule 9 requires it always-on). Production wires
   * the same `createRedisLedger` the conductor resume path uses.
   */
  readonly ledger?: Ledger;
  /** ISO clock — injected, never read here. */
  readonly now: () => string;
  /** The channel recorded in the confirmation binding (default "admin-dashboard"). */
  readonly channelLabel?: string;
  /**
   * FIX 4 — structured log for the honesty paths (executor throw error binding;
   * a projection-write failure AFTER a committed refund). Optional; production
   * wires the shared `logger`, tests may omit it.
   */
  readonly log?: {
    error: (obj: Record<string, unknown>, msg: string) => void;
    warn?: (obj: Record<string, unknown>, msg: string) => void;
  };
}

export interface EscalationApprovalGateway {
  resolve(input: {
    token: string;
    accept: boolean;
    approver: { id: string; role: string };
    /**
     * FIX 6 — the escalação session the resolve route nests under
     * (`/escalations/:sessionId/intents/:token/resolve`). When supplied, the
     * parked record's `sessionId` MUST match it — a token used against the wrong
     * session path is an IDOR probe (404, no token burn). Optional for callers
     * (unit tests) that address the token directly.
     */
    expectedSessionId?: string;
  }): Promise<EscalationApprovalResult>;
}

function injectMarker(
  baseState: unknown,
  marker: {
    intentHash: string;
    approverId: string;
    approverRole: string;
    at: string;
  },
): unknown {
  const s = (baseState ?? {}) as { ctx?: Record<string, unknown> };
  return { ...s, ctx: { ...(s.ctx ?? {}), escalationApproval: marker } };
}

function refusalTextFor(decision: Decision): string {
  if (decision.kind === "REFUSE") {
    return decision.refusal.userFacing ?? "Não foi possível concluir esta ação.";
  }
  if (decision.kind === "ESCALATE") {
    return "Esta ação ainda requer escalação — a aprovação não pôde ser aplicada.";
  }
  return "Não foi possível concluir esta ação.";
}

/**
 * BKL-116 — per-resumable-kind, the `business` basis reason the marker branch
 * emits when (and ONLY when) it converts THIS escalated intent's ESCALATE into a
 * REQUEST_CONFIRMATION with the OWNER-role + separation-of-duty gate satisfied
 * (pack-payments policies.ts: `refund_escalation_approved`). The engine's resume
 * `confirmationReceipt` is UNCONDITIONAL — it flips ANY REQUEST_CONFIRMATION for
 * the matching `intentHash` to EXECUTE — so we pin WHICH band was allowed to be
 * the converting factor. A resumable kind ABSENT from this map fails the check
 * below (fail-closed): adding a resumable money verb
 * (escalation-park-store.ts `ESCALATION_RESUMABLE_KINDS`) is a deliberate
 * governance decision and MUST name its intended marker basis here.
 *
 * BKL-113 — this map is now typed EXHAUSTIVE over `EscalationResumableKind`, so
 * the "MUST name its intended marker basis here" above is a COMPILE error rather
 * than a runtime fail-closed only. The runtime `undefined` fallback below is
 * retained as defense-in-depth (the lookup key is a `string` off the parked
 * record, which a cast could have widened past the type).
 */
const REQUIRED_ESCALATION_APPROVAL_BASIS: Readonly<
  Record<EscalationResumableKind, string>
> = {
  "payment.refund.issue": "refund_escalation_approved",
  // BKL-103 — the basis reason `gatePaidCancel`'s escalate-band overlay
  // (@ibatexas/pack-orders policies.ts) emits when the OWNER-approval marker
  // converts its OWN ESCALATE. Pins WHICH band was allowed to be the converting
  // factor: the unconditional resume receipt flips ANY REQUEST_CONFIRMATION for
  // the matching intentHash to EXECUTE, so a cancel that reached CONFIRM through
  // any OTHER band (e.g. a lowered escalate threshold routing it through
  // `paid_cancel_requires_confirmation`, which carries NO owner/self-approve
  // assertion) must NOT be blessed as an approved escalation.
  "order.cancel": "paid_cancel_escalation_approved",
};

/**
 * BKL-116 — defense-in-depth against escalate-threshold DRIFT. If the escalate
 * threshold is RAISED across a deploy so a parked amount no longer exceeds it, the
 * escalate band (and its OWNER-role marker gate) is SKIPPED at resume; the
 * BKL-085 UNTRUSTED-taint band fires a REQUEST_CONFIRMATION instead — with NO
 * owner/self-approve assertion — which the unconditional receipt would then flip
 * to EXECUTE, side-stepping the pack's OWNER gate. Assert the EXECUTE actually
 * carries the marker branch's OWN basis; if it was reached via any OTHER band,
 * the caller REFUSEs (fail-closed). The route JWT-OWNER gate + the engine
 * self-approve check still ran, so this is defense-in-depth, not the sole gate.
 */
function executeReachedViaEscalationMarker(
  decision: Decision,
  intentKind: string,
): boolean {
  const requiredReason = isEscalationResumableKind(intentKind)
    ? REQUIRED_ESCALATION_APPROVAL_BASIS[intentKind]
    : undefined;
  if (requiredReason === undefined) return false; // unmapped resumable kind → fail closed
  return decision.basis.some(
    (b) =>
      b.category === "business" &&
      (b.detail as { reason?: string } | undefined)?.reason === requiredReason,
  );
}

/**
 * Adopter-side escalation-approval engine. Mirrors the agent-approvals resolve
 * mechanics (park-rebuild → identical intentHash → audited receipt override) but
 * (a) is backed by the RESTART-SURVIVING Redis park store (not in-memory), and
 * (b) OWNS the post-EXECUTE executor (there is no agent runner to run it).
 */
export function createEscalationApprovalEngine(
  deps: EscalationApprovalEngineDeps,
): EscalationApprovalGateway {
  const channelLabel = deps.channelLabel ?? "admin-dashboard";
  return {
    async resolve({ token, accept, approver, expectedSessionId }) {
      // 1) Peek — the self-approve refusal + the session-binding check must NOT
      //    burn the token (a different owner / the right session can still act).
      const peeked = await deps.get(token);
      if (peeked === null) return { status: "missing" };

      // FIX 6 — session binding (IDOR hardening): the token is the capability, but
      // the resolve route nests it under a session path; a token used against the
      // WRONG session's path is a probe. Refuse as `missing` (do not leak that the
      // token exists for another session) WITHOUT consuming, and log for forensics.
      if (
        expectedSessionId !== undefined &&
        peeked.sessionId !== expectedSessionId
      ) {
        deps.log?.warn?.(
          {
            component: "escalation-approval",
            expectedSessionId,
            parkedSessionId: peeked.sessionId,
          },
          "escalation resolve: token/session mismatch (possible IDOR probe) — refused as missing, token not consumed",
        );
        return { status: "missing" };
      }

      // Separation of duty: the approver may not be the proposer. This is a fast
      // early refusal; the pack overlay is the deepest structural gate (an
      // approverId === payload.actorId marker never converts the ESCALATE).
      if (peeked.proposerId !== null && peeked.proposerId === approver.id) {
        return { status: "self_approve", intentKind: peeked.intentKind };
      }

      // 2) Single-use consume — a raced second approver (or TTL) gets null.
      const parked = await deps.consume(token);
      if (parked === null) return { status: "missing" };
      const at = deps.now();
      const resolvedBy = `staff:${approver.id}`;

      if (!accept) {
        await markResolvedSafe(deps, parked, "rejected", resolvedBy, at);
        return {
          status: "rejected",
          intentKind: parked.intentKind,
          intentHash: parked.intentHash,
        };
      }

      // 3) Rebuild the IDENTICAL envelope → same intentHash → receipt matches. The
      //    parked `actor.role` MUST round-trip so `staffRoleGuard` re-runs on resume.
      const envelope = buildEnvelope({
        kind: parked.envelopeKind,
        payload: parked.payload,
        actor: {
          principal: parked.actorPrincipal,
          sessionId: parked.actorSessionId,
          ...(parked.actorRole !== undefined ? { role: parked.actorRole } : {}),
        },
        taint: parked.taint,
        nonce: parked.nonce,
        // BKL-103 — `resourceRefs` are part of the intentHash pre-image, and the
        // CUSTOMER plane's resolver stamps them on every ownership-gated order kind
        // (034-F1). Restoring them is what lets the rebuilt envelope hash to the
        // parked `intentHash` and pass the FIX 3 integrity check below; omitted when
        // absent, so an ops refund rebuild is byte-identical to pre-BKL-103.
        ...(parked.resourceRefs !== undefined
          ? { resourceRefs: parked.resourceRefs }
          : {}),
      }) as IntentEnvelope;

      // FIX 3 — ENFORCE the core integrity claim: the rebuilt envelope MUST hash
      // to the parked `intentHash`. The marker + receipt are self-referential to
      // this rebuilt envelope, so without this check "identical envelope" is
      // assumed, not proven — a park record whose stored payload/nonce/actor no
      // longer hashes to its own `intentHash` (corruption / tamper) would resume a
      // DIFFERENT intent that its receipt happens to authorize. Fail closed:
      // REFUSE, never execute (the token was already consumed above).
      if (envelope.intentHash !== parked.intentHash) {
        deps.log?.error(
          {
            component: "escalation-approval",
            parkedIntentHash: parked.intentHash,
            rebuiltIntentHash: envelope.intentHash,
          },
          "escalation resolve: rebuilt intentHash != parked intentHash (integrity failure) — REFUSE, no execute",
        );
        await markResolvedSafe(deps, parked, "denied_by_kernel", resolvedBy, at);
        return {
          status: "denied_by_kernel",
          intentKind: parked.intentKind,
          intentHash: parked.intentHash,
          refusalPtBr:
            "Falha de integridade: a solicitação não pôde ser verificada e não foi executada.",
        };
      }

      // 4) FRESH state (null ⇒ REFUSE fail-closed) + the escalationApproval marker.
      const baseState = await deps.rebuildState(envelope);
      const state = injectMarker(baseState, {
        intentHash: envelope.intentHash,
        approverId: approver.id,
        approverRole: approver.role,
        at,
      });

      // 5) AUDITED resume. The receipt flips the marker-induced REQUEST_CONFIRMATION
      //    to EXECUTE; every state/taint/auth guard still runs on the fresh state.
      //    FIX 5 — the execution ledger rides along (Hard Rule 9, always-on): a
      //    duplicate intentHash is REPLAY_SUPPRESSED even if the park-consume is
      //    bypassed (defense-in-depth, not the sole double-execute guard).
      const policy = deps.policyFor(parked.intentKind);
      const { decision } = await adjudicateAndAudit(envelope, state, policy, {
        sink: deps.sink,
        ...(deps.ledger ? { ledger: deps.ledger } : {}),
        confirmationReceipt: {
          intentHash: envelope.intentHash,
          at,
          // BKL-115 — bind the resumed EXECUTE's `supersedes.predecessorAt` to the
          // ESCALATE row (via the parked ESCALATE-time timestamp) instead of the
          // resume row's OWN `at`. The kernel derives predecessorAt =
          // `originalAt ?? at`, so `buildSupersessionChains` can JOIN the resumed
          // EXECUTE back to its ESCALATE row (see verifyEscalationApprovalLineage).
          // Additive: an absent `escalatedAt` leaves the receipt byte-identical.
          ...(parked.escalatedAt !== undefined
            ? { originalAt: parked.escalatedAt }
            : {}),
          token,
          binding: {
            approver: { confirmed: resolvedBy },
            channel: { confirmed: channelLabel },
          },
        },
      });

      if (decision.kind !== "EXECUTE") {
        // Non-EXECUTE ⇒ NOTHING executes. A since-parked terminal/partial state, a
        // role failure, or a REPLAY_SUPPRESSED duplicate surfaced honestly; the
        // approval is recorded as denied.
        await markResolvedSafe(deps, parked, "denied_by_kernel", resolvedBy, at);
        return {
          status: "denied_by_kernel",
          decision,
          intentKind: parked.intentKind,
          intentHash: parked.intentHash,
          refusalPtBr: refusalTextFor(decision),
        };
      }

      // BKL-116 — threshold-drift defense-in-depth. The receipt is unconditional,
      // so a raised escalate threshold could route this EXECUTE through the
      // BKL-085 taint-CONFIRM band (no OWNER gate) instead of the escalate marker
      // branch. Require the EXECUTE to carry the marker branch's OWN basis; a
      // conversion via any other band did NOT pass the pack's OWNER/self-approve
      // gate → REFUSE, no money moves (the EXECUTE was audited above — the trail
      // honestly records the kernel verdict; the executor simply never runs).
      if (!executeReachedViaEscalationMarker(decision, parked.intentKind)) {
        deps.log?.error(
          {
            component: "escalation-approval",
            intentKind: parked.intentKind,
            intentHash: parked.intentHash,
            basisCategories: decision.basis.map((b) => b.category),
          },
          "escalation approval: EXECUTE reached WITHOUT the escalation-approval marker basis (escalate-threshold drift?) — REFUSE, no execute",
        );
        await markResolvedSafe(deps, parked, "denied_by_kernel", resolvedBy, at);
        return {
          status: "denied_by_kernel",
          decision,
          intentKind: parked.intentKind,
          intentHash: parked.intentHash,
          refusalPtBr:
            "Esta aprovação não pôde ser aplicada com segurança e não foi executada.",
        };
      }

      // 6) EXECUTE → run the per-kind executor (author = approver). FIX 4 — a
      //    missing executor or an executor THROW means NO money moved: record
      //    `execute_failed` (NOT `approved`), so the projection + the lineage
      //    invariant never bless a refund that did not run.
      const executor = deps.executors[parked.intentKind];
      if (executor === undefined) {
        deps.log?.error(
          { component: "escalation-approval", intentKind: parked.intentKind },
          "escalation approval: no executor registered for kind — audited EXECUTE but nothing ran (execute_failed)",
        );
        await markResolvedSafe(deps, parked, "execute_failed", resolvedBy, at);
        return {
          status: "execute_failed",
          decision,
          intentKind: parked.intentKind,
          intentHash: parked.intentHash,
          refusalPtBr:
            "Aprovação autorizada, mas nenhum executor está configurado para esta ação.",
        };
      }
      try {
        await executor(parked.payload, approver.id, approver.role);
      } catch (err) {
        // FIX 4c — bind + log the executor error (was silently discarded).
        deps.log?.error(
          {
            component: "escalation-approval",
            intentKind: parked.intentKind,
            intentHash: parked.intentHash,
            err: err instanceof Error ? err.message : String(err),
          },
          "escalation approval: executor threw AFTER the audited EXECUTE — NO money moved (execute_failed)",
        );
        await markResolvedSafe(deps, parked, "execute_failed", resolvedBy, at);
        return {
          status: "execute_failed",
          decision,
          intentKind: parked.intentKind,
          intentHash: parked.intentHash,
          refusalPtBr:
            "A aprovação foi autorizada, mas a execução falhou. Tente novamente.",
        };
      }

      // SUCCESS — the money MOVED. FIX 4b — a projection-write failure now must NOT
      // turn a committed refund into a bare error with a re-runnable button: the
      // refund committed + the token is consumed (+ the ledger claimed the key), so
      // a re-click can only 404. Report success-with-warning (log loudly), 200.
      try {
        await deps.markIntentResolved(
          parked.sessionId,
          parked.intentHash,
          "approved",
          resolvedBy,
          at,
        );
      } catch (projErr) {
        deps.log?.error(
          {
            component: "escalation-approval",
            intentHash: parked.intentHash,
            err: projErr instanceof Error ? projErr.message : String(projErr),
          },
          "escalation approval: refund COMMITTED but the projection write failed — success-with-warning (money moved; the pending row reads stale until reconciled)",
        );
      }
      return {
        status: "approved",
        decision,
        intentKind: parked.intentKind,
        intentHash: parked.intentHash,
      };
    },
  };
}

/**
 * FIX 4 — mark a resolution status, swallowing a projection-write failure (the
 * governance decision already happened; a Redis blip on the read-model must not
 * mask the real outcome). Logs loudly so the stale projection is visible.
 */
async function markResolvedSafe(
  deps: EscalationApprovalEngineDeps,
  parked: ParkedEscalationIntent,
  status: PendingEscalationIntent["status"],
  resolvedBy: string,
  at: string,
): Promise<void> {
  try {
    await deps.markIntentResolved(
      parked.sessionId,
      parked.intentHash,
      status,
      resolvedBy,
      at,
    );
  } catch (err) {
    deps.log?.error(
      {
        component: "escalation-approval",
        intentHash: parked.intentHash,
        status,
        err: err instanceof Error ? err.message : String(err),
      },
      "escalation approval: projection write failed while recording resolution status",
    );
  }
}

// ── INV-ESCALATION-APPROVAL-LINEAGE ──────────────────────────────────────────

export interface EscalationApprovalLineageResult {
  readonly ok: boolean;
  readonly reasons: ReadonlyArray<string>;
}

/**
 * INV-ESCALATION-APPROVAL-LINEAGE (Option 1, projection-grade). Verify that an
 * approved escalated money intent has an intact ESCALATE→resumed-EXECUTE lineage
 * over the audit rows for `intentHash`, plus the approver on the projection.
 *
 * Requires, for the parked `intentHash`:
 *   - an ESCALATE record (the original above-threshold verdict) AND a later
 *     resumed EXECUTE record (the resume the receipt licensed);
 *   - BKL-115: the two JOIN — `buildSupersessionChains` reconstructs a chain
 *     whose head is the resumed EXECUTE (`confirmation_resolved`) and whose tail
 *     reaches the ESCALATE row for this `intentHash`. Before BKL-115 the receipt
 *     omitted `originalAt`, so `supersedes.predecessorAt` was the resume row's
 *     OWN `at` and the chain builder produced a false cycle/singleton instead of
 *     the join. This assertion (previously a discarded call) now makes the lineage
 *     invariant actually check the ESCALATE→EXECUTE link. It expects records in
 *     emission (chronological) order — how the audit sink captures them and how a
 *     replay window is read.
 *   - the projection carries `status === "approved"` + `resolvedBy` (the kernel
 *     receipt records no approver — provenance is the adopter projection +
 *     `Supersession.binding.approver`).
 */
export function verifyEscalationApprovalLineage(
  auditRecords: ReadonlyArray<AuditRecord>,
  intentHash: string,
  intent: PendingEscalationIntent | null,
): EscalationApprovalLineageResult {
  const reasons: string[] = [];
  const forHash = auditRecords.filter(
    (r) => r.envelope.intentHash === intentHash,
  );
  const hasEscalate = forHash.some((r) => r.decision.kind === "ESCALATE");
  const hasResume = forHash.some((r) => r.decision.kind === "EXECUTE");
  if (!hasEscalate) reasons.push("no ESCALATE record for intentHash");
  if (!hasResume) reasons.push("no EXECUTE (resumed) record for intentHash");
  if (intent === null) reasons.push("no pending-intent projection");
  else if (intent.status !== "approved")
    reasons.push(`projection status is "${intent.status}", not approved`);
  else if (intent.resolvedBy === undefined)
    reasons.push("projection missing resolvedBy (approver)");

  // BKL-115 — ASSERT the ESCALATE→resumed-EXECUTE join (was a discarded call).
  // Only meaningful once both rows exist; the head is the confirmation_resolved
  // EXECUTE and its tail must reach the ESCALATE row for this intentHash.
  if (hasEscalate && hasResume) {
    const report = buildSupersessionChains([...auditRecords]);
    const joined = report.chains.some(
      (c) =>
        c.head.intentHash === intentHash &&
        c.head.decisionKind === "EXECUTE" &&
        c.head.reason === "confirmation_resolved" &&
        c.tail.some(
          (t) =>
            t.intentHash === intentHash && t.decisionKind === "ESCALATE",
        ),
    );
    if (!joined)
      reasons.push(
        "resumed EXECUTE does not join to the ESCALATE row (supersession lineage broken)",
      );
  }

  return { ok: reasons.length === 0, reasons };
}
