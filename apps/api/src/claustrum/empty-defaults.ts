// Canonical empty MemorySnapshot / RetrievedDocs shapes (DEF-005).
//
// The degraded-but-safe empty results are produced in THREE places — the designed
// no-op providers (noop-memory-grounding.ts) and the last-resort failSafe wrappers
// (fail-safe-memory.ts / fail-safe-grounding.ts). Defining the shape once keeps
// them in lockstep: if MemorySnapshot/RetrievedDocs gains a required field, only
// this file changes (review finding 23).

import type { MemorySnapshot, RetrievedDocs } from "@claustrum/core";

/** An empty memory snapshot — the cognitive loop proceeds memory-less. */
export function emptyMemorySnapshot(customerId: string): MemorySnapshot {
  return {
    customerId,
    episodic: [],
    semantic: [],
    procedural: [],
    relational: [],
    assembledAt: new Date().toISOString(),
  };
}

/** Empty retrieved docs — fail-CLOSED (no proofs → kernel refuses grounding-required
 *  envelopes rather than executing unattested). */
export function emptyRetrievedDocs(modelId: string): RetrievedDocs {
  return { docs: [], retrievedAt: new Date().toISOString(), modelId };
}
