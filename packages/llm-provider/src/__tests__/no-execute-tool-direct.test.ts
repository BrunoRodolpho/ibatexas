// Bypass-detection test (Task 06).
//
// Asserts that `executeToolDirect` is NOT in the public export surface of
// `@ibatexas/llm-provider`. Per investigation 01 §"P2 #5", the symbol was a
// foot-gun: any future caller could mutate state via the direct path without
// passing through `adjudicate()`. Task 06 removed it; this test fails the
// build if anyone re-introduces a public re-export.
//
// We also explicitly check the source files (tool-registry.ts, index.ts) to
// make sure no `export function executeToolDirect` declaration sneaks back
// in via a different module path.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolve(here, "..")

describe("executeToolDirect removal (Task 06 bypass-detection)", () => {
  it("is NOT in the public exports of @ibatexas/llm-provider", async () => {
    const mod = (await import("../index.js")) as Record<string, unknown>
    expect(mod).not.toHaveProperty("executeToolDirect")
    // Sanity: the safe entry points are still present.
    expect(mod).toHaveProperty("executeTool")
    expect(mod).toHaveProperty("executeKernel")
  })

  it("is NOT declared anywhere in tool-registry.ts source", () => {
    const source = readFileSync(resolve(srcRoot, "tool-registry.ts"), "utf8")
    // Only comments / removal notices may mention the name; an actual
    // `export function executeToolDirect` or `export { executeToolDirect`
    // is forbidden.
    expect(source).not.toMatch(/export\s+(async\s+)?function\s+executeToolDirect\b/)
    expect(source).not.toMatch(/export\s*\{[^}]*\bexecuteToolDirect\b[^}]*\}/)
  })

  it("is NOT re-exported via index.ts", () => {
    const source = readFileSync(resolve(srcRoot, "index.ts"), "utf8")
    expect(source).not.toMatch(/\bexport\s*\{[^}]*\bexecuteToolDirect\b[^}]*\}/)
  })
})
