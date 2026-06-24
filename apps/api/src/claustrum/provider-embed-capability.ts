// DEF-005 — upfront embedding-capability detection.
//
// The grounding port (pgvector) calls modelProvider.embed() on every turn. A
// provider with no embedding capability (the local 4B's embed() throws
// not_implemented; an Anthropic provider built with no embedding proxy) would
// make retrieve() throw each turn, falling into the failSafeGrounding swallow.
// CLAUSTRUM_GROUNDING_ENABLED gates grounding on intent, but the flag alone does
// not prove the provider can embed — so we probe once at boot and run grounding
// as a designed no-op when embeddings are genuinely unavailable.

import type { ModelProvider } from "@claustrum/core";

/**
 * Probe whether `modelProvider` can actually embed, with a single guarded
 * embed() call. Returns false on any throw (not_implemented, missing proxy,
 * transient boot-time error) or an empty vector — callers then run grounding as
 * a designed no-op rather than letting pgvector throw per turn. Intended to be
 * called once at boot.
 */
export async function providerCanEmbed(modelProvider: ModelProvider): Promise<boolean> {
  try {
    const vec = await modelProvider.embed("capability probe");
    return Array.isArray(vec) && vec.length > 0;
  } catch {
    return false;
  }
}
