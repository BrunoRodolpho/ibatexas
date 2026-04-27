import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@adjudicate/core/kernel": fileURLToPath(
        new URL("../../packages/core/src/kernel/index.ts", import.meta.url),
      ),
      "@adjudicate/core/llm": fileURLToPath(
        new URL("../../packages/core/src/llm/index.ts", import.meta.url),
      ),
      "@adjudicate/core": fileURLToPath(
        new URL("../../packages/core/src/index.ts", import.meta.url),
      ),
      "@adjudicate/runtime": fileURLToPath(
        new URL("../../packages/runtime/src/index.ts", import.meta.url),
      ),
    },
  },
});
