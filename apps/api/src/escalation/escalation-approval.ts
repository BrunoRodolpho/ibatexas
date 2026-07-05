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
import type { ParkedEscalationIntent } from "./escalation-park-store.js";
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
        await executor(parked.payload, approver.id);
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
 *   - the projection carries `status === "approved"` + `resolvedBy` (the kernel
 *     receipt records no approver — provenance is the adopter projection +
 *     `Supersession.binding.approver`).
 *
 * `buildSupersessionChains` is run to surface the narrative chain (informational).
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

  buildSupersessionChains([...auditRecords]);

  return { ok: reasons.length === 0, reasons };
}
