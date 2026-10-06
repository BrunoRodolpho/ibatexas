import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // BKL-245: match the 60s budget CI already runs with
    // (ci.yml `turbo test -- --testTimeout=60000`) so local full-suite
    // runs have the same headroom instead of flaking at the 5s default.
    testTimeout: 60_000,
    pool: "forks",
    // audit-2026-05-24 H2 (A1): every cart-tool / whatsapp-client test
    // now constructs wrapper meta with `auditSink: getAuditSink()`. The
    // leaf's `getAuditSink()` is fail-closed and throws if called before
    // `__setAuditSinkDependencies(...)`. We wire a no-op sink in
    // `src/__tests__/setup.ts` so every test file gets a usable sink at
    // module load.
    setupFiles: ["./src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
})
