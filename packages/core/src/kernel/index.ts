// @adjudicate/core/kernel — adjudicate, PolicyBundle, combinators
//                          + shadow-mode rollout, metrics, enforce-config.

export { adjudicate } from "./adjudicate.js";
export { allOf, constant, firstMatch } from "./combinators.js";
export type { Guard, PolicyBundle } from "./policy.js";

// Migrated from @ibatexas/llm-provider during consolidation — these are
// framework-generic kernel-adjacent concerns.
export * from "./shadow.js";
export * from "./metrics.js";
export * from "./enforce-config.js";
