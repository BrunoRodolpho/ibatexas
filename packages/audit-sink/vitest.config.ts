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
    // redis-spill-storage.ts inlines `rk` as `${APP_ENV}:${key}` (the
    // leaf-purity invariant — it must not import `@ibatexas/tools`), and
    // captures `process.env.APP_ENV` at module-import time. Pin it to "test"
    // for this package's runs so the inlined `rk` produces the `test:`
    // prefix the spill tests assert, matching how the rest of the codebase
    // uses APP_ENV=test under vitest.
    env: { APP_ENV: "test" },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
})
