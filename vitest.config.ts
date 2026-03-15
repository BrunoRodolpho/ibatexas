import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      // Required for web app tests that transitively load @/ modules
      "@/": path.resolve(__dirname, "apps/web/src") + "/",
    },
  },
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
})
