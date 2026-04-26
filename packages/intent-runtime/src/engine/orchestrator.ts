/**
 * engine/orchestrator — the public API surface preserved through v1.0.
 *
 * `runOrchestrator()` is THE contract apps/api depends on. Signature is frozen;
 * internals may evolve across the 14 IBX-IGE phases. Today this file re-exports
 * from `@ibatexas/llm-provider` — Phase J's documented plan keeps the shim
 * until the v2.0 split physically relocates the implementation into this
 * package without changing the surface.
 */

export { runOrchestrator, getRemainingBudget } from "@ibatexas/llm-provider"
