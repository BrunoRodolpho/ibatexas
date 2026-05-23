// Kernel bootstrap plugin — installs first-party Packs at API boot.
//
// CONFLICT NOTE FOR ORCHESTRATOR / MERGER OF TASK 01:
// =====================================================
// Task 01 (kernel-bootstrap-plugin) is the canonical home of this file.
// This task (08 — pack-orders) introduces the FIRST `installPack(...)`
// call so the Pack lands with a working integration point even before
// task 01 merges. When task 01 lands, the orchestrator MUST merge the
// two versions so:
//
//   1. The full task-01 plugin scaffold wins (Fastify plugin shape,
//      env-driven enable flags, learning/metrics sink wiring, kill
//      switch hooks, etc.).
//   2. The `installPack(ordersPack, ...)` call below is preserved
//      inside whatever boot sequence task 01 establishes. The Pack
//      assertion (conformance + default-deny default) MUST run before
//      the API accepts any inbound HTTP traffic — installPack throws
//      `PackConformanceError` synchronously and aborts boot.
//
// If task 01 has already merged and this file exists with a different
// structure, REPLACE the stub `installPack(...)` call (if any) inside
// task 01's bootstrap function body with the call below; do not
// overwrite task 01's plugin shape with this file's contents.
//
// Per CLAUDE.md rule #9 (LLM authority / IBX-IGE v2.0) and the
// adjudicate-migration master plan (docs/adjudicate-migration/
// MASTER_PLAN.md §"WS4 — Pack architecture"), every first-party Pack
// MUST be installed via `installPack(...)` from `@adjudicate/core` so
// its conformance is asserted at boot. The Pack's policy default
// (REFUSE — master plan #4) is verified by the assertion and the
// boot fails-loud if drift is introduced.

import { installPack } from "@adjudicate/core"
import { ordersPack } from "@ibatexas/pack-orders"

/**
 * Install IbateXas's first-party Packs against the kernel. Idempotent
 * at the global-sink level — `installPack` no-ops the default
 * console-sink wiring on second invocation. Throws
 * `PackConformanceError` synchronously if any Pack drifts from
 * `PackV0`.
 *
 * Returns the list of installed wrapped Packs so a future task-01
 * bootstrap can re-export them under a typed module-level surface
 * (the Pack.policy reference is what callers will adjudicate
 * against).
 */
export function installFirstPartyPacks() {
  const orders = installPack(ordersPack)
  // Future Packs land here as tasks 09 / 10 / 21 merge:
  //   const reservations = installPack(reservationsPack)
  //   const whatsapp     = installPack(whatsappPack)
  //   const customerOnb  = installPack(customerOnboardingPack)
  return {
    orders,
  }
}
