// FE-T01 (spec D3) — the extraction-wire temperature pin.
//
// `@claustrum/openai`'s `OpenAIProvider.toCreateBody()` forwards `temperature`
// on the outbound `/v1/chat/completions` body ONLY when the caller sets it on
// the `CompletionRequest` (`...(req.temperature !== undefined ? {
// temperature: req.temperature } : {})`). Every planner/responder `.complete()`
// call site left it unset, so Ollama silently applied its own default
// (~0.8) — an unpinned, non-deterministic extraction wire. Every call site
// now pins this SAME named constant so a wire capture / replay is
// deterministic and the audit trace (llm-trace.ts) can record the value
// actually sent instead of a fictional hardcoded one.
export const PINNED_COMPLETION_TEMPERATURE = 0;

/**
 * FE-T01 (D3/D4) — sentinel intent kind for an extraction-wire FAILURE (a
 * malformed tool-call JSON that survived the frozen provider's `{raw}`
 * passthrough, or a genuinely empty completion that survived a bounded
 * repair attempt). No installed pack owns this kind, so
 * `composePolicyRouter`'s documented unowned-kind fail-closed path (SYSTEM
 * taint floor + `default: "REFUSE"` — capability-policy.ts) REFUSEs it
 * through the SAME audited kernel `adjudicate()` call every real envelope
 * goes through: an explicit, AUDITED REFUSE turn — never a silent drop to a
 * respond-only reply. See `ibatexas-planner.ts` (producer; re-exports this
 * for backward-compatible import sites) and `kernel-metrics-sink.ts` (which
 * allowlists it out of the taxonomy-drift counter — a deliberate sentinel
 * REFUSE is not a registry/packaging bug).
 *
 * Lives in this dependency-light module (rather than `ibatexas-planner.ts`,
 * which pulls in the whole claim-registry/prompts import graph) so
 * `kernel-metrics-sink.ts` can reference it without importing the planner.
 */
export const EXTRACTION_FAILURE_KIND = "system.extraction_failure";
