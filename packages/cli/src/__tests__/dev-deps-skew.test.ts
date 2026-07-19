// BKL-151 (local half) — the build-packages path must fail CLOSED when the
// lockfile is newer than node_modules (deps changed but not installed), so a
// stale build never surfaces downstream as the opaque claims-validate TypeError
// ghost. depsSkewReason() is the pure detector behind that fail-closed guard.

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { depsSkewReason } from "../commands/dev.js"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibx-skew-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function touch(rel: string, mtimeMs: number): void {
  const p = path.join(dir, rel)
  if (rel.endsWith("/")) fs.mkdirSync(p, { recursive: true })
  else fs.writeFileSync(p, "")
  const t = mtimeMs / 1000
  fs.utimesSync(p, t, t)
}

describe("depsSkewReason (BKL-151)", () => {
  it("flags skew when pnpm-lock.yaml is NEWER than node_modules", () => {
    touch("node_modules/", 1_000_000)
    touch("pnpm-lock.yaml", 2_000_000) // newer ⇒ deps changed, not installed
    expect(depsSkewReason(dir)).toMatch(/newer than node_modules/)
  })

  it("returns null when node_modules is newer than the lockfile (in sync)", () => {
    touch("pnpm-lock.yaml", 1_000_000)
    touch("node_modules/", 2_000_000)
    expect(depsSkewReason(dir)).toBeNull()
  })

  it("returns null (indeterminate) when node_modules is missing — a fresh clone", () => {
    touch("pnpm-lock.yaml", 1_000_000)
    expect(depsSkewReason(dir)).toBeNull()
  })

  it("returns null when the lockfile is missing", () => {
    touch("node_modules/", 1_000_000)
    expect(depsSkewReason(dir)).toBeNull()
  })
})
