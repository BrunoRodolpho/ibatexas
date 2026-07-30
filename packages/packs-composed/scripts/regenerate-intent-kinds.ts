#!/usr/bin/env -S npx tsx
// regenerate-intent-kinds.ts — FE-4 CONTRACT (FE-T26) + R6 leg 1a: writes
// every GENERATED intent-kind region in the workspace from
// CAPABILITY_DEFINITIONS.
//
// Run: `pnpm --filter @ibatexas/packs-composed run regen:intent-kinds`
// After: editing packages/catalog/src/capability-definitions/definitions.ts
//        (add/remove/reorder a capability) — that file moved out of this
//        package in LE2-014/015 — or editing the per-kind annotations table in
//        src/codegen/build-pack-intents-region.ts.
//
// SEVEN target files, one marker pair, one command:
//   1. ../../intent-kinds/src/index.ts — the 6 per-pack `*_INTENT_KINDS`
//      mirror arrays + `KNOWN_INTENT_KINDS` (FE-T26).
//   2-7. ../../pack-*/src/index.ts — each Pack's OWN `xxxPack.intents` array
//      (R6 leg 1a). Same splice, same sentinels; the region sits nested inside
//      a live object literal, so it covers EXACTLY the array contents and
//      leaves `basisCodes`, `policy`, `planner` and every other
//      hand-maintained member untouched.
//
// Every target is reached by a plain relative FILESYSTEM path (never a package
// import) — see build-generated-region.ts's own doc for why this script lives
// in packs-composed rather than in the packages it writes, and why that keeps
// the turbo build graph acyclic.
//
// Idempotent: running it twice in a row with no CAPABILITY_DEFINITIONS change
// rewrites byte-identical files (a no-op diff) — exactly what
// regen-intent-kinds-freshness.test.ts and regen-pack-intents-freshness.test.ts
// assert in CI.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildGeneratedRegion,
  GENERATED_BEGIN,
  GENERATED_END,
} from "../src/codegen/build-generated-region.js"
import {
  buildPackIntentsRegion,
  PACK_INTENTS_TARGETS,
} from "../src/codegen/build-pack-intents-region.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** packages/packs-composed/scripts → packages/ */
const PACKAGES_DIR = path.join(HERE, "../..")
const INDEX_PATH = path.join(PACKAGES_DIR, "intent-kinds/src/index.ts")

/** Splice `region` between the sentinel markers already present in `filePath`,
 *  leaving every byte outside them untouched. Returns whether the file's
 *  contents changed. */
function spliceRegion(filePath: string, region: string): boolean {
  const current = fs.readFileSync(filePath, "utf8")
  const beginIdx = current.indexOf(GENERATED_BEGIN)
  const endIdx = current.indexOf(GENERATED_END)
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(
      `[regenerate-intent-kinds] GENERATED_BEGIN/GENERATED_END markers not found in ${filePath} — ` +
        "has the sentinel-comment structure been edited by hand? Restore the markers before regenerating.",
    )
  }
  const before = current.slice(0, beginIdx)
  const after = current.slice(endIdx + GENERATED_END.length)
  const next = before + region + after
  fs.writeFileSync(filePath, next, "utf8")
  return next !== current
}

function report(filePath: string, changed: boolean): void {
  console.log(
    changed
      ? `[regenerate-intent-kinds] wrote ${filePath} (content changed)`
      : `[regenerate-intent-kinds] ${filePath} already up to date (no-op)`,
  )
}

function main(): void {
  report(INDEX_PATH, spliceRegion(INDEX_PATH, buildGeneratedRegion()))

  for (const target of PACK_INTENTS_TARGETS) {
    const packIndexPath = path.join(PACKAGES_DIR, target.packageDir, "src/index.ts")
    report(packIndexPath, spliceRegion(packIndexPath, buildPackIntentsRegion(target)))
  }
}

main()
