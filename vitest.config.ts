import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  esbuild: {
    // Use the automatic JSX runtime so .tsx/.ts files compiling JSX
    // don't need `import React from 'react'` in scope.
    jsx: "automatic",
    jsxImportSource: "react",
  },
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
