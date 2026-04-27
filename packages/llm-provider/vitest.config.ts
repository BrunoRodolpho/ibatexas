import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  resolve: {
    // Alias workspace @adjudicate/* packages to source files so tests
    // run without a built dist/. Most-specific aliases first.
    alias: {
      "@adjudicate/core/kernel": fileURLToPath(
        new URL("../core/src/kernel/index.ts", import.meta.url),
      ),
      "@adjudicate/core/llm": fileURLToPath(
        new URL("../core/src/llm/index.ts", import.meta.url),
      ),
      "@adjudicate/core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url),
      ),
      "@adjudicate/audit": fileURLToPath(
        new URL("../audit/src/index.ts", import.meta.url),
      ),
      "@adjudicate/runtime": fileURLToPath(
        new URL("../runtime/src/index.ts", import.meta.url),
      ),
      "@adjudicate/pack-payments-pix": fileURLToPath(
        new URL("../pack-payments-pix/src/index.ts", import.meta.url),
      ),
    },
  },
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
