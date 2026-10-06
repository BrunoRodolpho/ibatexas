// F-23 — the premise behind a DELIBERATELY OMITTED guard.
//
// `packages/tools/src/redis/key.ts` fails fast at import when
// `NODE_ENV === "production" && !APP_ENV`, so a production process without
// APP_ENV cannot boot and bleed keys across environments. The `rk` copy
// inlined in `redis-spill-storage.ts` does NOT mirror that guard — it falls
// back to `"development"` silently. Measured, that divergence is real at the
// module level and unreachable at the process level:
//
//   $ NODE_ENV=production, APP_ENV unset, import @ibatexas/audit-sink alone
//     → no throw; spill key written as "development:audit:spill:queue"
//   $ NODE_ENV=production, APP_ENV unset, import @ibatexas/tools
//     → throws "APP_ENV is required in production to prevent cross-
//       environment data bleed"
//
// The gap closes because nothing loads this leaf alone: every dependent of
// `@ibatexas/audit-sink` also pulls in `@ibatexas/tools`, whose barrel
// re-exports `./redis/key.js` and therefore evaluates the guard during
// module-graph evaluation — before the leaf can build a single key. We chose
// to document that rather than duplicate a throw nothing can reach (a leaf
// whose value is being inert at import should not gain the power to abort a
// process, and the abort already happens one package up).
//
// That choice is only sound while the premise holds. This file is the pin: it
// fails the day a workspace package depends on `@ibatexas/audit-sink` without
// `@ibatexas/tools` in its dependency closure — the day the guard stops being
// process-wide and the omission has to be revisited.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
// src/__tests__ → src → packages/audit-sink → packages → <repo root>
const REPO_ROOT = resolve(HERE, "../../../..")

const LEAF = "@ibatexas/audit-sink"
const GUARD_OWNER = "@ibatexas/tools"

interface Pkg {
  readonly name: string
  readonly dir: string
  readonly deps: readonly string[]
  readonly devDeps: readonly string[]
}

/**
 * Every workspace package on disk. The population is the FILESYSTEM, not a
 * hand-maintained list — a new package is in scope the moment it exists, and
 * deleting a row from any list in this file cannot delete its coverage.
 */
function readWorkspace(): Pkg[] {
  const out: Pkg[] = []
  for (const group of ["packages", "apps"]) {
    const groupDir = join(REPO_ROOT, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(groupDir, entry.name)
      const manifest = join(dir, "package.json")
      if (!existsSync(manifest)) continue
      const json = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      if (!json.name) continue
      out.push({
        name: json.name,
        dir: `${group}/${entry.name}`,
        deps: Object.keys(json.dependencies ?? {}),
        devDeps: Object.keys(json.devDependencies ?? {}),
      })
    }
  }
  return out
}

const WORKSPACE = readWorkspace()
const BY_NAME = new Map(WORKSPACE.map((p) => [p.name, p]))

/** Transitive RUNTIME dependency closure — what a process actually evaluates. */
function runtimeClosure(root: string): Set<string> {
  const seen = new Set<string>()
  const stack = [root]
  while (stack.length > 0) {
    const name = stack.pop()!
    const pkg = BY_NAME.get(name)
    if (!pkg) continue
    for (const dep of pkg.deps) {
      if (seen.has(dep)) continue
      seen.add(dep)
      stack.push(dep)
    }
  }
  return seen
}

/** Packages that pull the leaf in at RUNTIME, directly or transitively. */
const DEPENDENTS = WORKSPACE.filter(
  (p) => p.name !== LEAF && runtimeClosure(p.name).has(LEAF),
)

describe("F-23 — the omitted production guard is unreachable, not merely absent", () => {
  it("the workspace scan actually found the packages it is supposed to police", () => {
    // Vacuity guard. Every assertion below quantifies over DEPENDENTS; if the
    // scan silently returned nothing (wrong REPO_ROOT, renamed dirs), those
    // assertions pass over an empty set and this file becomes decoration.
    // A NAME roll call, not a count — a count drifts every time a package is
    // added and gets "fixed" by bumping the number.
    expect(WORKSPACE.length).toBeGreaterThan(5)
    expect(BY_NAME.has(LEAF)).toBe(true)
    expect(BY_NAME.has(GUARD_OWNER)).toBe(true)
    const names = DEPENDENTS.map((p) => p.name)
    expect(names).toContain(GUARD_OWNER)
    expect(names).toContain("@ibatexas/api")
  })

  it("the guard owner really does depend on the leaf (so the cycle claim holds)", () => {
    // This is what makes importing the canonical `rk` here impossible — even
    // as a devDependency. If it ever stops being true, the honest fix for the
    // whole F-23 class changes: the leaf could cross-check by import instead
    // of pinning the property. Fail loudly so that gets reconsidered.
    expect(BY_NAME.get(GUARD_OWNER)!.deps).toContain(LEAF)
  })

  it("every package that loads @ibatexas/audit-sink also arms the @ibatexas/tools guard", () => {
    const unguarded = DEPENDENTS.filter((p) => {
      // `@ibatexas/tools` owns the guard: loading it IS arming it.
      if (p.name === GUARD_OWNER) return false
      return !runtimeClosure(p.name).has(GUARD_OWNER)
    }).map((p) => `${p.name} (${p.dir})`)

    expect(
      unguarded,
      unguarded.length === 0
        ? ""
        : `\n\nF-23 premise broken.\n\n` +
            `These packages pull in ${LEAF} WITHOUT ${GUARD_OWNER} in their runtime\n` +
            `dependency closure:\n\n  ${unguarded.join("\n  ")}\n\n` +
            `${LEAF}'s inlined rk() deliberately omits the production fail-fast\n` +
            `(NODE_ENV=production && !APP_ENV => throw) that lives in\n` +
            `packages/tools/src/redis/key.ts, on the measured premise that no\n` +
            `process can reach the leaf without evaluating that guard first.\n` +
            `A package above defeats that premise: in production without APP_ENV\n` +
            `it would silently write "development:"-prefixed audit spill keys.\n\n` +
            `Fix by EITHER giving that package a dependency path to\n` +
            `${GUARD_OWNER}, OR mirroring the guard into\n` +
            `packages/audit-sink/src/redis-spill-storage.ts and rewriting the\n` +
            `"DELIBERATELY NOT MIRRORED" paragraph in its header — do not\n` +
            `simply delete this test.\n`,
    ).toEqual([])
  })
})
