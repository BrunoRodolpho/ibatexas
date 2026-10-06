// BKL-151 (local half) — the build-packages path must fail CLOSED when the
// installed dependency tree does not match the lockfile, so a stale build never
// surfaces downstream as the opaque claims-validate TypeError ghost.
// depsSkewReason() is the pure detector behind that fail-closed guard.
//
// The detector's signal is CONTENT (pnpm-lock.yaml vs the lockfile pnpm actually
// installed at node_modules/.pnpm/lock.yaml), never mtimes. The original mtime
// heuristic was wrong in BOTH directions, so every case below deliberately sets
// mtimes that would make the OLD implementation answer the opposite — a mtime
// regression cannot pass this file.

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { depsSkewReason } from "../commands/dev.js"

let dir: string

const OLD = 1_000_000_000_000 // an "old" wall clock, ms
const NEW = 2_000_000_000_000 // a "new" wall clock, ms

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibx-skew-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, body: string): string {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}

function setMtime(rel: string, mtimeMs: number): void {
  const t = mtimeMs / 1000
  fs.utimesSync(path.join(dir, rel), t, t)
}

/** A workspace whose installed tree matches the lockfile. */
function installed(lock: string, installedLock: string = lock): void {
  write("pnpm-lock.yaml", lock)
  write("node_modules/.pnpm/lock.yaml", installedLock)
}

describe("depsSkewReason (BKL-151)", () => {
  it("flags skew when the lockfile differs from the one pnpm installed", () => {
    installed("lockfileVersion: '9'\nfoo: 1\n", "lockfileVersion: '9'\nfoo: 0\n")
    expect(depsSkewReason(dir)).toMatch(/differs from the lockfile pnpm last installed/)
  })

  it("returns null when the installed lockfile is byte-identical (in sync)", () => {
    installed("lockfileVersion: '9'\nfoo: 1\n")
    expect(depsSkewReason(dir)).toBeNull()
  })

  // ── The two directions the mtime heuristic got wrong (measured 2026-07-26) ──

  it("does NOT fire after a correct install that left node_modules' mtime stale", () => {
    // pnpm rewrites .modules.yaml / .pnpm/ / .bin/ IN PLACE, so the root
    // node_modules DIRECTORY mtime does not advance across an install — and
    // `pnpm install` rewrites pnpm-lock.yaml as its last act. Real measurement:
    // install succeeded, tree matched the lock, lock mtime 2d newer than the dir.
    installed("lockfileVersion: '9'\nfoo: 1\n")
    setMtime("node_modules", OLD)
    setMtime("pnpm-lock.yaml", NEW) // lock NEWER than node_modules ⇒ old impl fired
    expect(depsSkewReason(dir)).toBeNull()
  })

  it("DOES fire on a stale tree even when node_modules' mtime is newer", () => {
    // Any tool creating a top-level entry (vite's `.vite-temp`) advances the
    // directory mtime and silenced the old guard while the tree was stale.
    installed("lockfileVersion: '9'\nfoo: 1\n", "lockfileVersion: '9'\nfoo: 0\n")
    setMtime("pnpm-lock.yaml", OLD)
    fs.mkdirSync(path.join(dir, "node_modules", ".vite-temp"))
    setMtime("node_modules", NEW) // node_modules NEWER than lock ⇒ old impl passed
    expect(depsSkewReason(dir)).toMatch(/differs from the lockfile pnpm last installed/)
  })

  // ── Fallback: pnpm's own validation clock, when there is no installed lock ──

  it("falls back to lastValidatedTimestamp and flags a lock changed since", () => {
    write("pnpm-lock.yaml", "lockfileVersion: '9'\n")
    write("node_modules/.pnpm-workspace-state-v1.json", JSON.stringify({ lastValidatedTimestamp: OLD }))
    setMtime("pnpm-lock.yaml", NEW)
    expect(depsSkewReason(dir)).toMatch(/changed after pnpm last validated node_modules/)
  })

  it("falls back to lastValidatedTimestamp and passes a lock validated since", () => {
    write("pnpm-lock.yaml", "lockfileVersion: '9'\n")
    write("node_modules/.pnpm-workspace-state-v1.json", JSON.stringify({ lastValidatedTimestamp: NEW }))
    setMtime("pnpm-lock.yaml", OLD)
    expect(depsSkewReason(dir)).toBeNull()
  })

  it("prefers the installed lockfile over the validation clock", () => {
    // A stale timestamp must not veto a tree that demonstrably matches.
    installed("lockfileVersion: '9'\nfoo: 1\n")
    write("node_modules/.pnpm-workspace-state-v1.json", JSON.stringify({ lastValidatedTimestamp: OLD }))
    setMtime("pnpm-lock.yaml", NEW)
    expect(depsSkewReason(dir)).toBeNull()
  })

  // ── Indeterminate states fail OPEN — let pnpm/the build surface the truth ──

  it("returns null (indeterminate) when node_modules is missing — a fresh clone", () => {
    write("pnpm-lock.yaml", "lockfileVersion: '9'\n")
    expect(depsSkewReason(dir)).toBeNull()
  })

  it("returns null when the lockfile is missing", () => {
    write("node_modules/.pnpm/lock.yaml", "lockfileVersion: '9'\n")
    expect(depsSkewReason(dir)).toBeNull()
  })

  it("returns null (does not throw) on an unreadable workspace state", () => {
    write("pnpm-lock.yaml", "lockfileVersion: '9'\n")
    write("node_modules/.pnpm-workspace-state-v1.json", "{not json")
    expect(depsSkewReason(dir)).toBeNull()
  })
})
