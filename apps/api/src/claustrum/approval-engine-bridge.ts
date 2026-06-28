// Agent-approval → adjudicate Redis registry mirror (H2 / ERDS-062).
//
// ibatexas runs its OWN in-memory agent-approval engine (agent-approvals.ts):
// that engine is, and stays, the source of truth for the managed-agent runtime
// (it owns the single-use parked envelope + the audited confirm→EXECUTE resume).
// The adjudicate console / adjutant operator UIs, however, read agent approvals
// from the @adjudicate/approval-engine Redis registry (the same
// `adjudicate:approval:req:*` keys the customer-checkout approval projections
// land in). This bridge mirrors the ibatexas engine's lifecycle into that
// registry so the operator UIs see agent approvals too — WITHOUT changing any
// ibatexas behavior or types.
//
// HARD CONSTRAINTS (fail-open, best-effort):
//   - The bridge DELEGATES every call to the inner engine and returns the inner
//     engine's value VERBATIM (ibatexas types unchanged).
//   - The Redis mirror is a SIDE EFFECT wrapped in try/catch that SWALLOWS every
//     error. A registry write failure must NEVER affect the parked approval, the
//     turn, or the caller. The mirror is a read-model, not a gate.
//
// Field mapping (ibatexas → adjudicate ApprovalRequest):
//   - agentNamespace        → sessionId   (the agent's unhashed `agent:` namespace)
//   - taint                 → "UNTRUSTED" (DISPLAY-ONLY; the operator UI shows the
//                             approval as agent-originated; it gates nothing)
//   - channel               → "agent-approval"
//   - status pending        → "pending"
//   - status rejected       → "declined"
//   - status approved       → "approved"

import type {
  ApprovalRegistry,
  ApprovalRequest as AdjudicateApprovalRequest,
  ApprovalStatus as AdjudicateApprovalStatus,
} from "@adjudicate/approval-engine";
import type {
  AgentApprovalEngine,
  AgentApprovalRequest,
  AgentApprovalStatus,
} from "./agent-approvals.js";

/** TTL (seconds) for the mirrored projection. Defaults to 24h (matches the
 *  ConfirmationStore default the adjudicate registry mirrors). Env-overridable.
 *  Exported so the bootstrap can compute it ONCE and thread the SAME value into
 *  both the registry and the bridge (#92-2). */
export function mirrorTtlSeconds(): number {
  const raw = process.env.AGENT_APPROVAL_MIRROR_TTL_SECONDS;
  // #92-3: Number() (not parseInt) so trailing garbage like "60s" → NaN → the
  // 24h default, instead of parseInt silently accepting it as 60.
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 24 * 60 * 60;
}

/**
 * Map the ibatexas resolved status to the adjudicate registry's resolved
 * status. ibatexas's runtime expresses only `pending|approved|rejected`;
 * `rejected` is the staff-declined case, so it maps to `declined`. (The
 * registry also has `expired`, used when a single-use token is consumed/aged
 * out — the in-memory engine does not surface that as a status today, so there
 * is nothing to map to it; left here as the documented target if it ever is.)
 */
function mapResolvedStatus(
  status: AgentApprovalStatus,
): "approved" | "declined" | "expired" {
  switch (status) {
    case "approved":
      return "approved";
    case "rejected":
      return "declined";
    case "pending":
      // Should never reach markResolved with a still-pending status; treat as
      // declined defensively rather than throwing (this is best-effort mirror).
      return "declined";
    default: {
      // Exhaustiveness guard — a new ibatexas status must be mapped explicitly.
      const _exhaustive: never = status;
      void _exhaustive;
      return "declined";
    }
  }
}

/** Build the adjudicate display projection from an ibatexas approval request. */
function toAdjudicateRequest(req: AgentApprovalRequest): AdjudicateApprovalRequest {
  const status: AdjudicateApprovalStatus = "pending";
  return {
    token: req.token,
    sessionId: req.agentNamespace, // agent's unhashed `agent:` namespace
    intentHash: req.intentHash,
    intentKind: req.intentKind,
    prompt: req.prompt,
    taint: "UNTRUSTED", // display-only: marks the approval as agent-originated
    channel: "agent-approval",
    status,
    requestedAt: req.requestedAt,
  };
}

export interface AgentApprovalEngineBridgeDeps {
  /** The authoritative ibatexas in-memory engine — every call delegates here. */
  readonly inner: AgentApprovalEngine;
  /** The adjudicate Redis-backed display registry to mirror into. */
  readonly registry: ApprovalRegistry;
  /**
   * Mirror TTL (seconds). Default: AGENT_APPROVAL_MIRROR_TTL_SECONDS env or 24h.
   * Injectable for deterministic tests.
   */
  readonly ttlSeconds?: number;
  /** Optional structured logger for swallowed-mirror diagnostics. */
  readonly onMirrorError?: (stage: "request" | "resolve", err: unknown) => void;
}

/**
 * Wrap an ibatexas `AgentApprovalEngine` so every approval lifecycle event is
 * ALSO mirrored (best-effort, fail-open) into the adjudicate Redis registry.
 * Returns the SAME `AgentApprovalEngine` interface; callers are unaffected.
 */
export function createAgentApprovalEngineBridge(
  deps: AgentApprovalEngineBridgeDeps,
): AgentApprovalEngine {
  const { inner, registry } = deps;
  const ttlSeconds = deps.ttlSeconds ?? mirrorTtlSeconds();
  const onError =
    deps.onMirrorError ??
    (() => {
      /* swallow by default — mirror is best-effort */
    });

  return {
    async request(input) {
      // Inner engine is authoritative: run it first, capture its projection.
      const projection = await inner.request(input);
      // Best-effort mirror — NEVER let a registry fault touch the return value.
      try {
        await registry.put(toAdjudicateRequest(projection), ttlSeconds);
      } catch (err) {
        onError("request", err);
      }
      return projection;
    },

    async resolve(rd) {
      const result = await inner.resolve(rd);
      // #92-5: fire-and-forget the resolve mirror so a stalled Redis can't gate
      // the resolve hot path (node-redis has no per-command timeout). Safe from
      // the put()/markResolved reorder hazard because request()'s put() is still
      // AWAITED and the approval lifecycle (request → act → resolve) guarantees
      // the pending row was flushed long before this resolve runs.
      const mapped = mapResolvedStatus(result.request.status);
      void registry
        .markResolved(
          result.request.token,
          mapped,
          result.request.resolvedBy,
          result.request.resolvedAt,
        )
        .catch((err) => onError("resolve", err));
      return result;
    },

    // Reads delegate unchanged — the operator UIs read the registry directly,
    // and the in-memory engine stays the runtime source of truth.
    list(filter) {
      return inner.list(filter);
    },
    get(token) {
      return inner.get(token);
    },
  };
}
