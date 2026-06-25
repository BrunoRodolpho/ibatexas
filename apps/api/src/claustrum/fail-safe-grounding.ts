// Fail-safe GroundingPort wrapper.
//
// `handleTurn` awaits `grounding.retrieve(perception)` with no catch
// (@claustrum/core handle-turn.js, the UNDERSTAND Promise.all), and the
// composed provider chain throws on every call today: pgvector's retrieve()
// calls `modelProvider.embed()`, and AnthropicProvider.embed() throws
// CompletionError("not_implemented") unless constructed with an embedding
// proxy — which the bootstrap does not configure (no embedding vendor is
// wired; ANTHROPIC_MODEL has no embeddings API). Without this wrapper every
// conversational turn rejects before the planner runs.
//
// Failure semantics mirror the audit read paths (P0-2): a grounding outage
// DEGRADES (empty retrieval — the planner simply gets no docs), it never
// crashes a turn. The money path stays fail-closed: attestGrounding failure
// yields zero proofs, and the kernel REFUSEs any envelope whose policy
// requires a grounding proof it doesn't have.
//
// This is containment, not the fix. The product gap (no embedding vendor →
// pgvector grounding is dead weight at runtime) is recorded in
// docs/agents/decisions.md (D-009); wiring a real embedding proxy is a
// vendor decision deliberately not made here.

import type { GroundingPort } from "@claustrum/core";
import { emptyRetrievedDocs } from "./empty-defaults.js";

type GroundingOp = "retrieve" | "attestGrounding";

export function failSafeGrounding(
  inner: GroundingPort,
  opts: {
    /** Stamped on the empty RetrievedDocs when retrieve() degrades. */
    readonly modelId: string;
    readonly onError: (op: GroundingOp, err: unknown) => void;
  },
): GroundingPort {
  return {
    async retrieve(perception, spec) {
      try {
        return await inner.retrieve(perception, spec);
      } catch (err) {
        opts.onError("retrieve", err);
        return emptyRetrievedDocs(opts.modelId);
      }
    },
    async attestGrounding(docs, claims) {
      try {
        return await inner.attestGrounding(docs, claims);
      } catch (err) {
        opts.onError("attestGrounding", err);
        // No proof is the fail-CLOSED direction: the kernel refuses
        // grounding-required envelopes rather than executing unattested.
        return [];
      }
    },
  };
}
