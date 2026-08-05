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
    // leaf-purity invariant — it must not import `@ibatexas/tools`), reading
    // `process.env.APP_ENV` at CALL time. Pin it to "test" for this
    // package's runs so the inlined `rk` produces the `test:` prefix the
    // spill tests assert, matching how the rest of the codebase uses
    // APP_ENV=test under vitest.
    //
    // Pre-F-23 this const was captured at module IMPORT and this comment said
    // so. The value pinned here is unchanged, and so are the keys — with
    // APP_ENV stable for the whole run, import-time and call-time reads agree
    // (pinned by "produces the SAME key as the module-load capture when
    // APP_ENV is stable" in __tests__/redis-spill-storage.test.ts).
    env: { APP_ENV: "test" },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
})
