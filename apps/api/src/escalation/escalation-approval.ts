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
  /** Update the escalation record projection (approved / rejected / denied_by_kernel). */
  readonly markIntentResolved: (
    sessionId: string,
    intentHash: string,
    status: PendingEscalationIntent["status"],
    resolvedBy: string,
    at: string,
  ) => Promise<unknown>;
  /** ISO clock — injected, never read here. */
  readonly now: () => string;
  /** The channel recorded in the confirmation binding (default "admin-dashboard"). */
  readonly channelLabel?: string;
}

export interface EscalationApprovalGateway {
  resolve(input: {
    token: string;
    accept: boolean;
    approver: { id: string; role: string };
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
    async resolve({ token, accept, approver }) {
      // 1) Peek — the self-approve refusal must NOT burn the token (a different
      //    owner can still approve within the TTL).
      const peeked = await deps.get(token);
      if (peeked === null) return { status: "missing" };

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
        await deps.markIntentResolved(
          parked.sessionId,
          parked.intentHash,
          "rejected",
          resolvedBy,
          at,
        );
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
      const policy = deps.policyFor(parked.intentKind);
      const { decision } = await adjudicateAndAudit(envelope, state, policy, {
        sink: deps.sink,
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
        // Non-EXECUTE ⇒ NOTHING executes. A since-parked terminal/partial state or
        // a role failure surfaced honestly; the approval is recorded as denied.
        await deps.markIntentResolved(
          parked.sessionId,
          parked.intentHash,
          "denied_by_kernel",
          resolvedBy,
          at,
        );
        return {
          status: "denied_by_kernel",
          decision,
          intentKind: parked.intentKind,
          intentHash: parked.intentHash,
          refusalPtBr: refusalTextFor(decision),
        };
      }

      // 6) EXECUTE → run the per-kind executor (author = approver). A throw AFTER
      //    the audited EXECUTE is HONEST failure: 502, never fabricated success.
      const executor = deps.executors[parked.intentKind];
      if (executor === undefined) {
        await deps.markIntentResolved(
          parked.sessionId,
          parked.intentHash,
          "approved",
          resolvedBy,
          at,
        );
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
      } catch {
        await deps.markIntentResolved(
          parked.sessionId,
          parked.intentHash,
          "approved",
          resolvedBy,
          at,
        );
        return {
          status: "execute_failed",
          decision,
          intentKind: parked.intentKind,
          intentHash: parked.intentHash,
          refusalPtBr:
            "A aprovação foi autorizada, mas a execução falhou. Tente novamente.",
        };
      }

      await deps.markIntentResolved(
        parked.sessionId,
        parked.intentHash,
        "approved",
        resolvedBy,
        at,
      );
      return {
        status: "approved",
        decision,
        intentKind: parked.intentKind,
        intentHash: parked.intentHash,
      };
    },
  };
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
