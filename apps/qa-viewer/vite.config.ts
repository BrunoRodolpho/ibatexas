/// <reference types="vitest/config" />
// QA viewer (T2-5) — read-only Vite app over the journey-harness artifacts.
//
// STATIC FILE CONSUMPTION ONLY: the `qaArtifacts` plugin below serves the
// COMMITTED artifacts (the T2-4 graph JSONs, the coverage governance files,
// the sanitized run-trace fixture) under `/artifacts/*` in dev, and copies
// the same files into `dist/artifacts/` at build so the build output is a
// self-contained static site. There are NO write endpoints — GET only; any
// other method is rejected. Point the app at a different artifact tree with
// `VITE_QA_ARTIFACTS_BASE` (see src/lib/artifacts.ts).
import { copyFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

const here = dirname(new URL(import.meta.url).pathname)

/**
 * Committed artifact sources, keyed by their `/artifacts/<key>` URL path.
 * Graphs + governance come straight from the packages/journeys commits
 * (never copies maintained by hand); coverage-matrix.json is this app's
 * committed snapshot fixture (see fixtures/README note in ../README.md).
 */
const ARTIFACTS: Record<string, string> = {
  "graphs/capability.json": "../../packages/journeys/graphs/capability.json",
  "graphs/journeys.json": "../../packages/journeys/graphs/journeys.json",
  "graphs/run-fixture.json": "../../packages/journeys/graphs/run-fixture.json",
  "graphs/impact.json": "../../packages/journeys/graphs/impact.json",
  "governance/journey-coverage-baseline.json":
    "../../packages/journeys/governance/journey-coverage-baseline.json",
  "governance/price-table.json": "../../packages/journeys/governance/price-table.json",
  "coverage-matrix.json": "./fixtures/coverage-matrix.json",
  "runs/run-trace.jsonl": "../../packages/journeys/graphs/fixtures/run-trace.jsonl",
}

function contentType(urlPath: string): string {
  return urlPath.endsWith(".jsonl") ? "application/x-ndjson" : "application/json"
}

function qaArtifacts(): Plugin {
  return {
    name: "qa-artifacts",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? ""
        if (!url.startsWith("/artifacts/")) return next()
        // READ-ONLY surface: static artifact serving, GET/HEAD only.
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.statusCode = 405
          res.setHeader("Allow", "GET, HEAD")
          res.end("read-only artifact endpoint")
          return
        }
        const key = url.slice("/artifacts/".length)
        const source = ARTIFACTS[key]
        if (source === undefined) {
          res.statusCode = 404
          res.end(`unknown artifact: ${key}`)
          return
        }
        res.setHeader("Content-Type", contentType(key))
        res.end(readFileSync(resolve(here, source)))
      })
    },
    // Build output stays self-contained: dist/artifacts/* mirrors the
    // committed defaults so `vite preview` (or any static host) just works.
    closeBundle() {
      for (const [key, source] of Object.entries(ARTIFACTS)) {
        const dest = resolve(here, "dist/artifacts", key)
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(resolve(here, source), dest)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), qaArtifacts()],
  server: {
    port: 3010,
  },
  test: {
    globals: true,
    environment: "happy-dom",
    setupFiles: ["src/test/setup.ts"],
  },
})
