// Agent approvals glue — Stage-1 confirm-gated managed agents (plan-v2 T3-7).
//
// When a managed agent's turn adjudicates to REQUEST_CONFIRMATION (the kernel
// parks the envelope), a human must approve before it executes. The upstream
// @adjudicate/approval-engine is NOT a dependency here (unpublished; D-017's
// no-publish constraint), and it expects an `AdjudicatedAgent` while ibatexas
// runs the claustrum Conductor — so this is the adopter-side equivalent, built
// on the proven HTTP-receipt round-trip the customer checkout path uses
// (routes/cart.ts checkout/confirm): a single-use token parks the agent
// envelope; a staff resolve re-adjudicates the IDENTICAL envelope through the
// AUDITED kernel verb `adjudicateAndAudit` carrying a `confirmationReceipt`, so
// the kernel substitutes EXECUTE for the matching intentHash while still
// enforcing every state/taint/auth guard.
//
// Provenance (DR-6, projection-grade): the resolving staff identity rides
// `AgentApprovalRequest.resolvedBy` (a TTL'd projection, NOT a kernel-receipt
// field — the kernel receipt records no approver), and the agent's own identity
// rides the unhashed `agent:` sessionId namespace. INV-AGENT-CONFIRM-LINEAGE
// (`verifyAgentConfirmLineage`) ties them: over the audit rows for the parked
// intentHash, the resumed EXECUTE supersedes the awaiting REQUEST_CONFIRMATION
// (via the @adjudicate/audit supersession-chain walker), and the projection
// carries the approver.
//
// The parked store + projection here are in-memory with a single producer; the
// production wiring backs them with Redis (atomic single-use consume, mirroring
// checkout-confirmation-store) and `notify` with the staff NATS notification —
// both injected so this module stays pure + testable.

import { randomUUID } from "node:crypto";
import {
  buildEnvelope,
  type AuditRecord,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core";
import { adjudicateAndAudit, type PolicyBundle } from "@adjudicate/core/kernel";
import { buildSupersessionChains } from "@adjudicate/audit";
import { parseAgentSessionNamespace } from "./agent-guards.js";

/** Audit sink slice `adjudicateAndAudit` needs (structural; AuditSink-compatible). */
export interface ApprovalAuditSink {
  emit(record: AuditRecord): Promise<void>;
}

/** Single-use parked agent envelope (the inputs to rebuild the IDENTICAL envelope). */
interface ParkedAgentApproval {
  readonly token: string;
  readonly agentNamespace: string;
  readonly intentKind: string;
  readonly intentHash: string;
  readonly prompt: string;
  // Envelope rebuild inputs — same kind/payload/nonce/actor → same intentHash
  // (schema v2: createdAt is NOT hashed), so the receipt matches on resolve.
  readonly envelopeKind: string;
  readonly payload: unknown;
  readonly nonce: string;
  readonly actorSessionId: string;
  readonly actorPrincipal: IntentEnvelope["actor"]["principal"];
  readonly taint: IntentEnvelope["taint"];
  readonly requestedAt: string;
}

export type AgentApprovalStatus = "pending" | "approved" | "rejected";

/** Operator-facing projection of an approval (DR-6: carries `resolvedBy`). */
export interface AgentApprovalRequest {
  readonly token: string;
  readonly agentNamespace: string;
  readonly intentKind: string;
  readonly intentHash: string;
  readonly prompt: string;
  readonly status: AgentApprovalStatus;
  readonly requestedAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: { readonly id: string; readonly displayName?: string };
}

export interface AgentApprovalEngineDeps {
  /** Staff notification on a new approval request (publishNatsEvent in prod). */
  readonly notify: (request: AgentApprovalRequest) => Promise<void>;
  /** ISO clock — injected, never read here. */
  readonly now: () => string;
  /** Token factory (single-use). Default randomUUID. */
  readonly tokenFactory?: () => string;
}

export interface AgentApprovalResolveDeps {
  readonly token: string;
  readonly accepted: boolean;
  readonly resolvedBy: { readonly id: string; readonly displayName?: string };
  /** Rebuild the FRESH pack state for re-adjudication (entity state may have moved). */
  readonly rebuildState: (intentKind: string, payload: unknown) => unknown;
  /** Resolve the kind's PolicyBundle (e.g. resolveCapabilityPolicy(packs, kind)). */
  readonly policyFor: (intentKind: string) => PolicyBundle<string, unknown, unknown>;
  /** Audit sink the resume's `adjudicateAndAudit` emits through (fail-closed). */
  readonly sink: ApprovalAuditSink;
}

export interface AgentApprovalEngine {
  request(input: {
    envelope: IntentEnvelope;
    prompt: string;
  }): Promise<AgentApprovalRequest>;
  resolve(
    deps: AgentApprovalResolveDeps,
  ): Promise<{ request: AgentApprovalRequest; decision?: Decision }>;
  list(filter?: { status?: AgentApprovalStatus }): ReadonlyArray<AgentApprovalRequest>;
  get(token: string): AgentApprovalRequest | null;
}

export class ApprovalNotAgentEnvelopeError extends Error {
  constructor(sessionId: string) {
    super(`agent approval: envelope sessionId "${sessionId}" is not agent-namespaced`);
    this.name = "ApprovalNotAgentEnvelopeError";
  }
}

// ── BKL-104 — structured resolved-outcome contract ───────────────────────────
//
// A `resolve(accept:true)` re-adjudicates the IDENTICAL parked envelope through
// the AUDITED kernel, so an HTTP 200 is NOT proof the action ran: the kernel can
// legitimately return a NON-EXECUTE decision on stale/moved state (REFUSE / a
// fresh REQUEST_CONFIRMATION / ESCALATE). The AUT-024 inbox used to INFER the
// outcome from `decision.kind` + generic honest copy and could not say WHY it
// was not executed. This derives a structured, honest outcome so the UI can.
//
// The states below are exactly the ones THIS engine can DISTINGUISH — nothing
// invented. Note the asymmetry with the escalation-approval engine
// (escalation-approval.ts), which OWNS a post-EXECUTE executor and can therefore
// tell `approved` (money moved) from `execute_failed` (the audited EXECUTE
// happened but the executor threw / was missing). The agent-approvals engine, by
// design, adjudicates+audits and carries NO executor — the downstream side
// effect is the agent runner's concern (see getAgentApprovalGateway) — so there
// is no post-audit step that can fail here, and `execute_failed` is NOT a state
// this engine can produce. We do not fabricate it. What IS guaranteed (the
// anti-confabulation mirror): ONLY an EXECUTE/REWRITE decision earns `executed`;
// every non-EXECUTE re-adjudication is reported honestly with its kernel reason.

export type AgentApprovalOutcomeStatus =
  /** EXECUTE / REWRITE — the kernel authorized + AUDITED the resume. */
  | "executed"
  /** accept:false — the manager declined; nothing was re-adjudicated. */
  | "rejected"
  /** REFUSE — the kernel refused on the fresh (re-adjudicated) state. */
  | "refused"
  /** REQUEST_CONFIRMATION — the fresh state needs a NEW confirmation (state moved). */
  | "reparked"
  /** ESCALATE — the fresh state is above-threshold; needs escalation now. */
  | "escalated"
  /** DEFER / any other non-EXECUTE kind — not executed (honest umbrella, fail-closed). */
  | "denied_by_kernel";

/**
 * The structured resolved outcome the resolve route surfaces. `decisionKind` is
 * the raw kernel `Decision.kind` (absent only for `rejected` — no adjudication
 * ran). `reasonCode`/`refusalPtBr` are sourced from the KERNEL decision (the
 * refusal code/text or a decision basis code), NEVER from model output.
 */
export interface AgentApprovalOutcome {
  readonly status: AgentApprovalOutcomeStatus;
  readonly decisionKind?: Decision["kind"];
  /** Machine-readable kernel reason (refusal.code / first decision basis code). */
  readonly reasonCode?: string;
  /** Operator-facing pt-BR reason for a non-executed outcome (kernel refusal or fixed copy). */
  readonly refusalPtBr?: string;
}

// pt-BR reasons for the non-REFUSE non-executed outcomes (the kernel authors no
// user-facing text for those kinds; REFUSE carries its own `refusal.userFacing`).
const REPARKED_PT_BR =
  "Requer nova confirmação — o estado do pedido mudou desde a solicitação.";
const ESCALATED_PT_BR =
  "Requer escalação para um responsável — o estado mudou desde a solicitação.";
const NOT_EXECUTED_PT_BR = "A ação não pôde ser executada com segurança.";

function firstBasisCode(basis: Decision["basis"]): string | undefined {
  return basis.length > 0 ? basis[0]!.code : undefined;
}

/**
 * Pure map from `(accepted, decision)` to the honest structured outcome. Shared
 * by the resolve route (HTTP response) and the gateway (the remediation-proposal
 * mark), so both report the SAME truth. Total over `Decision["kind"]`; an
 * unexpected/`accepted`-but-undefined decision fails CLOSED to `denied_by_kernel`
 * (never `executed`).
 */
export function deriveAgentApprovalOutcome(
  accepted: boolean,
  decision: Decision | undefined,
): AgentApprovalOutcome {
  if (!accepted) return { status: "rejected" };
  if (decision === undefined) {
    // accept:true always yields a decision in the engine; a missing one is an
    // invariant break — report NOT executed, never a fabricated success.
    return { status: "denied_by_kernel", refusalPtBr: NOT_EXECUTED_PT_BR };
  }
  switch (decision.kind) {
    case "EXECUTE":
    case "REWRITE":
      return { status: "executed", decisionKind: decision.kind };
    case "REFUSE":
      return {
        status: "refused",
        decisionKind: decision.kind,
        reasonCode: decision.refusal.code,
        refusalPtBr: decision.refusal.userFacing,
      };
    case "REQUEST_CONFIRMATION":
      return {
        status: "reparked",
        decisionKind: decision.kind,
        reasonCode: firstBasisCode(decision.basis),
        refusalPtBr: REPARKED_PT_BR,
      };
    case "ESCALATE":
      return {
        status: "escalated",
        decisionKind: decision.kind,
        reasonCode: firstBasisCode(decision.basis),
        refusalPtBr: ESCALATED_PT_BR,
      };
    default:
      // DEFER or any future kind — not an authorization; fail closed to honest.
      return {
        status: "denied_by_kernel",
        decisionKind: decision.kind,
        reasonCode: firstBasisCode(decision.basis),
        refusalPtBr: NOT_EXECUTED_PT_BR,
      };
  }
}

/**
 * Adopter-side agent approval engine. In-memory parked store + projection
 * (single producer); production backs both with Redis. `notify` + the resolve
 * `sink`/`rebuildState`/`policyFor` are injected so the engine is pure.
 */
export function createAgentApprovalEngine(
  deps: AgentApprovalEngineDeps,
): AgentApprovalEngine {
  const parked = new Map<string, ParkedAgentApproval>();
  const projections = new Map<string, AgentApprovalRequest>();
  const tokenFactory = deps.tokenFactory ?? (() => randomUUID());

  return {
    async request({ envelope, prompt }) {
      const agentNamespace = parseAgentSessionNamespace(envelope.actor.sessionId);
      if (agentNamespace === null) {
        // Only managed-agent envelopes route through this surface.
        throw new ApprovalNotAgentEnvelopeError(envelope.actor.sessionId);
      }
      const token = tokenFactory();
      const requestedAt = deps.now();
      parked.set(token, {
        token,
        agentNamespace,
        intentKind: envelope.kind,
        intentHash: envelope.intentHash,
        prompt,
        envelopeKind: envelope.kind,
        payload: envelope.payload,
        nonce: envelope.nonce,
        actorSessionId: envelope.actor.sessionId,
        actorPrincipal: envelope.actor.principal,
        taint: envelope.taint,
        requestedAt,
      });
      const projection: AgentApprovalRequest = {
        token,
        agentNamespace,
        intentKind: envelope.kind,
        intentHash: envelope.intentHash,
        prompt,
        status: "pending",
        requestedAt,
      };
      projections.set(token, projection);
      await deps.notify(projection);
      return projection;
    },

    async resolve(rd) {
      // Single-use consume — a second resolve of the same token finds nothing.
      const p = parked.get(rd.token);
      if (p === undefined) {
        throw new Error(`agent approval: token "${rd.token}" unknown, expired, or already resolved`);
      }
      parked.delete(rd.token);
      const resolvedAt = deps.now();

      if (!rd.accepted) {
        const rejected: AgentApprovalRequest = {
          ...projections.get(rd.token)!,
          status: "rejected",
          resolvedAt,
          resolvedBy: rd.resolvedBy,
        };
        projections.set(rd.token, rejected);
        return { request: rejected };
      }

      // Rebuild the IDENTICAL envelope → same intentHash → the receipt matches.
      const envelope = buildEnvelope({
        kind: p.envelopeKind,
        payload: p.payload,
        actor: { principal: p.actorPrincipal, sessionId: p.actorSessionId },
        taint: p.taint,
        nonce: p.nonce,
      });
      const state = await rd.rebuildState(p.intentKind, p.payload);
      const policy = rd.policyFor(p.intentKind);

      // AUDITED resume: the kernel honors the receipt only via adjudicateAndAudit,
      // substituting EXECUTE for the matching intentHash while still enforcing
      // every guard; it emits the supersession-linked AuditRecord itself.
      const { decision } = await adjudicateAndAudit(envelope, state, policy, {
        sink: rd.sink,
        confirmationReceipt: {
          intentHash: envelope.intentHash,
          at: resolvedAt,
          token: rd.token,
        },
      });

      const approved: AgentApprovalRequest = {
        ...projections.get(rd.token)!,
        status: "approved",
        resolvedAt,
        resolvedBy: rd.resolvedBy,
      };
      projections.set(rd.token, approved);
      return { request: approved, decision };
    },

    list(filter) {
      const all = [...projections.values()];
      return filter?.status ? all.filter((r) => r.status === filter.status) : all;
    },

    get(token) {
      return projections.get(token) ?? null;
    },
  };
}

// ── INV-AGENT-CONFIRM-LINEAGE ────────────────────────────────────────────────

export interface AgentConfirmLineageResult {
  readonly ok: boolean;
  readonly reasons: ReadonlyArray<string>;
}

/**
 * INV-AGENT-CONFIRM-LINEAGE (DR-6, projection-grade): verify that an approved
 * agent action has an intact confirm→execute lineage over the audit rows.
 *
 * Requires, for the parked `intentHash`:
 *   - an awaiting REQUEST_CONFIRMATION record AND a later resumed EXECUTE record
 *     (the resume the receipt licensed) — the trail the supersession-chain
 *     walker reconstructs;
 *   - the approval projection carries `resolvedBy` (the kernel receipt records
 *     no approver — provenance is the adopter projection).
 *
 * `buildSupersessionChains` is run to surface the narrative chain (the kernel
 * links the resume to the awaiting record); the hard gate is the
 * RC→EXECUTE presence + the approver projection, so the check is robust to the
 * kernel's exact supersedes wiring.
 */
export function verifyAgentConfirmLineage(
  auditRecords: ReadonlyArray<AuditRecord>,
  intentHash: string,
  approval: AgentApprovalRequest | null,
): AgentConfirmLineageResult {
  const reasons: string[] = [];
  const forHash = auditRecords.filter((r) => r.envelope.intentHash === intentHash);
  const hasAwaiting = forHash.some((r) => r.decision.kind === "REQUEST_CONFIRMATION");
  const hasResume = forHash.some(
    (r) => r.decision.kind === "EXECUTE" || r.decision.kind === "REWRITE",
  );
  if (!hasAwaiting) reasons.push("no REQUEST_CONFIRMATION (awaiting) record for intentHash");
  if (!hasResume) reasons.push("no EXECUTE/REWRITE (resumed) record for intentHash");
  if (approval === null) reasons.push("no approval projection");
  else if (approval.status !== "approved") reasons.push(`approval status is "${approval.status}", not approved`);
  else if (approval.resolvedBy === undefined) reasons.push("approval projection missing resolvedBy (approver)");

  // Surface the supersession chain (informational — the kernel links resume→awaiting).
  buildSupersessionChains([...auditRecords]);

  return { ok: reasons.length === 0, reasons };
}
