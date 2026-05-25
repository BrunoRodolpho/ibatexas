// P0-7-TRUE / audit-2026-05-24 P0-1 — adapter re-export shim.
//
// The NX-guarded park wrapper used to live here. To let
// `packages/llm-provider/` (which cannot import from `apps/api/`) share the
// same hot-path, the implementation moved to
// `@ibatexas/llm-provider`'s `park-nx.ts`. This file remains as a thin
// re-export so existing imports (apps/api routes, adapters, tests) keep
// working unchanged.
//
// The kernel-metrics integration (`kernel_defer_quota_exceeded_total{kind}`)
// is wired separately: `apps/api/src/plugins/kernel-bootstrap.ts` calls
// `setDeferQuotaExceededHook(recorder.recordDeferQuotaExceeded.bind(recorder))`
// once at boot, so the wrapper records the metric without an apps/api
// import dependency.

export {
  parkDeferredIntentWithNxGuard,
  setDeferQuotaExceededHook,
  ParkVerificationFieldsMissingError,
  PARK_COLLISION_REFUSAL_PT_BR,
  type ParkDeferredIntentNxResult,
} from "@ibatexas/llm-provider"
