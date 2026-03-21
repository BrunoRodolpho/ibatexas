import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Use process-level isolation (forks) to prevent module-level
    // singleton leakage (e.g., Anthropic client cached in agent.ts).
    // Required because agent.test.ts and agent-edge-cases.test.ts both
    // mock @anthropic-ai/sdk and share the same _client singleton.
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
})
