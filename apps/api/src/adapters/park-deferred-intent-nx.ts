// P0-7-TRUE / audit-2026-05-24 P0-1 — adapter re-export shim.
//
// The NX-guarded park wrapper used to live here, then briefly in
// `@ibatexas/llm-provider`'s `park-nx.ts` so packages-side callers could
// share it. WS5 (claustrum-on-dev) relocated the implementation back into
// `apps/api` — its only consumers (me.ts, defer-resolver, this seam) are all
// in apps/api — to take dev's DEFER/park/resume governance OFF the WS8-doomed
// `@ibatexas/llm-provider`. This file remains as a thin re-export so existing
// imports (apps/api routes, adapters, tests) keep working unchanged.
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
} from "./park-nx.js"
