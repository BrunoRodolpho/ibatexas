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
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
})
