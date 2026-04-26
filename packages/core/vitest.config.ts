import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Tests inside packages/core/ reference the package via its npm name
// (`@adjudicate/core`, `@adjudicate/core/kernel`, `@adjudicate/core/llm`)
// so they read the way an adopter's tests would. Vite/Vitest can't
// resolve the self-reference at runtime (no `dist/` exists in source),
// so we alias the package name back to its source files. Most-specific
// aliases first — order matters.
export default defineConfig({
  resolve: {
    alias: {
      "@adjudicate/core/kernel": fileURLToPath(
        new URL("./src/kernel/index.ts", import.meta.url),
      ),
      "@adjudicate/core/llm": fileURLToPath(
        new URL("./src/llm/index.ts", import.meta.url),
      ),
      "@adjudicate/core": fileURLToPath(
        new URL("./src/index.ts", import.meta.url),
      ),
    },
  },
});
