// Designed no-op MemoryPort / GroundingPort (DEF-005).
//
// The degraded memory/grounding path used to be "safe because failSafeMemory /
// failSafeGrounding CATCH a known TypeError" — the @ibatexas/domain Prisma client
// generates no `claustrum_memory_*` delegates (so the postgres memory provider
// throws on every cache-cold turn), and the configured model provider has no
// embedding capability (the local 4B's `embed()` throws not_implemented; Anthropic
// has no embedding proxy wired), so pgvector `retrieve()` throws on every turn.
//
// "Safe because a wrapper swallows a known throw" is fragile — one refactor of the
// wrappers flips it open, and it spams a per-turn warn. These designed no-ops make
// the unavailable-capability path an INTENTIONAL empty result. The bootstrap detects
// the missing capability UPFRONT and injects these; the failSafe wrappers remain only
// as a last-resort guard for genuinely UNEXPECTED provider errors.

import type { GroundingPort, MemoryPort } from "@claustrum/core";
import { emptyMemorySnapshot, emptyRetrievedDocs } from "./empty-defaults.js";

/** Memory port that never throws and stores nothing — the cognitive loop runs
 *  without long-term memory (advisory context only; every mutation still flows
 *  through the kernel). Returned shapes are identical to failSafeMemory's
 *  degraded returns, but by design rather than by catch. */
export function noopMemoryProvider(): MemoryPort {
  return {
    async recall(customerId) {
      return emptyMemorySnapshot(customerId);
    },
    async observe() {
      /* no long-term memory store — intentional no-op */
    },
    async search() {
      return [];
    },
    async recentActions() {
      return [];
    },
  };
}

/** Grounding port that never throws and retrieves nothing. Empty proofs is the
 *  fail-CLOSED direction (the kernel refuses grounding-required envelopes rather
 *  than executing unattested), identical to failSafeGrounding's degradation but
 *  by design. */
export function noopGroundingProvider(modelId: string): GroundingPort {
  return {
    async retrieve() {
      return emptyRetrievedDocs(modelId);
    },
    async attestGrounding() {
      return [];
    },
  };
}
