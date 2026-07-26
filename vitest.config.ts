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
    // BKL-245: match the 60s budget CI already runs with
    // (ci.yml `turbo test -- --testTimeout=60000`) so local full-suite
    // runs have the same headroom instead of flaking at the 5s default.
    // This file governs only the packages that do NOT carry their own
    // vitest config (admin, commerce, web, cli, domain, nats-client, types);
    // a package-level config shadows it entirely, so the same key is
    // repeated in each of the 14 own-config packages.
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
})
