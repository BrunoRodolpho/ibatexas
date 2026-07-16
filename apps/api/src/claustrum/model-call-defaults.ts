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
