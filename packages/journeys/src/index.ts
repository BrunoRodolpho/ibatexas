// @ibatexas/journeys — Journey Registry + deterministic oracle kit.
//
// TEST PLANE ONLY: apps/* and non-test packages/* never import this package
// (check-bypass leg 6); this package never reaches into apps/api internals
// (leg 7). Dependency direction: journeys→tools, cli→journeys, cli→tools.
//
// This root barrel re-exports the per-directory barrels ONCE. Concurrent
// Phase-1a tasks own disjoint subdirectories and edit ONLY their own
// barrel — never this file:
//
//   schema/  — journey file schema v1 + YAML loader        (T1a-1, done)
//   runner/  — sequential act runner skeleton              (T1a-1, done)
//   gates/   — registry gates: lint / coverage             (T1a-2, done / T1a-3)
//   oracle/  — ProjectionBarrier, AuditReader/Matcher      (T1a-6 / T1a-7)
//   clients/ — authFixture, ChatClient                     (T1a-4 / T1a-5)
//   driver/  — LLM test-driver agent                       (T1a-8)
//   harness/ — env handshake + invariant harness           (T1a-10)
//   graphs/  — four derived graphs + export/check engine   (T2-4)

export * from "./schema/index.js"
export * from "./runner/index.js"
export * from "./gates/index.js"
export * from "./oracle/index.js"
export * from "./clients/index.js"
export * from "./driver/index.js"
export * from "./harness/index.js"
export * from "./graphs/index.js"
