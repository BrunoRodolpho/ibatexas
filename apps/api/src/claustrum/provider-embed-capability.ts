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

/** Default boot-probe timeout (ms). A hung embedding endpoint must not stall
 *  readiness — degrade to no-op grounding instead. Override via
 *  CLAUSTRUM_EMBED_PROBE_TIMEOUT_MS. */
const DEFAULT_PROBE_TIMEOUT_MS = 3000;

function probeTimeoutMs(): number {
  const raw = process.env.CLAUSTRUM_EMBED_PROBE_TIMEOUT_MS;
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PROBE_TIMEOUT_MS;
}

/**
 * Probe whether `modelProvider` can actually embed, with a single guarded
 * embed() call. Returns false on any throw (not_implemented, missing proxy,
 * transient boot-time error), an empty vector, OR if the probe does not resolve
 * within the timeout (finding 34: an un-timed live embed on the boot path lets a
 * slow/hung endpoint stall readiness). Callers then run grounding as a designed
 * no-op rather than letting pgvector throw per turn. Intended to be called once
 * at boot.
 */
export async function providerCanEmbed(modelProvider: ModelProvider): Promise<boolean> {
  const timeout = new Promise<false>((resolve) =>
    setTimeout(() => resolve(false), probeTimeoutMs()).unref?.(),
  );
  const probe = (async () => {
    try {
      const vec = await modelProvider.embed("capability probe");
      return Array.isArray(vec) && vec.length > 0;
    } catch {
      return false;
    }
  })();
  return Promise.race([probe, timeout]);
}
