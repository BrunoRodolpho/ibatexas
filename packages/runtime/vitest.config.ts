import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Alias @adjudicate/core (and subpaths) to their source files so tests
// that import the framework via its npm name resolve at workspace level
// without needing dist/ to be built first. Most-specific aliases first.
export default defineConfig({
  resolve: {
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
    },
  },
});
