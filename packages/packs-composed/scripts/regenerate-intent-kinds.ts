#!/usr/bin/env -S npx tsx
// regenerate-intent-kinds.ts — FE-4 CONTRACT (FE-T26): writes the GENERATED
// region of packages/intent-kinds/src/index.ts from CAPABILITY_DEFINITIONS.
//
// Run: `pnpm --filter @ibatexas/packs-composed run regen:intent-kinds`
// After: editing packages/catalog/src/capability-definitions/definitions.ts
//        (add/remove/reorder a capability) — that file moved out of this
//        package in LE2-014/015.
//
// Splices `buildGeneratedRegion()`'s output between the GENERATED_BEGIN /
// GENERATED_END sentinel markers already present in ../../intent-kinds/src/
// index.ts (reached by a plain relative filesystem path — see build-
// generated-region.ts's own doc for why this script lives here, not in
// intent-kinds itself). Leaves everything above and below (imports, the
// package doc comment, PIX_INTENT_KINDS, LOYALTY_INTENT_KINDS) untouched.
// Idempotent: running it twice in a row with no CAPABILITY_DEFINITIONS
// change produces a byte-identical file (a no-op diff) — exactly what
// regen-intent-kinds-freshness.test.ts asserts in CI.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildGeneratedRegion,
  GENERATED_BEGIN,
  GENERATED_END,
} from "../src/codegen/build-generated-region.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = path.join(HERE, "../../intent-kinds/src/index.ts")

function main(): void {
  const current = fs.readFileSync(INDEX_PATH, "utf8")
  const beginIdx = current.indexOf(GENERATED_BEGIN)
  const endIdx = current.indexOf(GENERATED_END)
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(
      `[regenerate-intent-kinds] GENERATED_BEGIN/GENERATED_END markers not found in ${INDEX_PATH} — ` +
        "has the sentinel-comment structure been edited by hand? Restore the markers before regenerating.",
    )
  }
  const before = current.slice(0, beginIdx)
  const after = current.slice(endIdx + GENERATED_END.length)
  const next = before + buildGeneratedRegion() + after
  fs.writeFileSync(INDEX_PATH, next, "utf8")
  const changed = next !== current
  console.log(
    changed
      ? `[regenerate-intent-kinds] wrote ${INDEX_PATH} (content changed)`
      : `[regenerate-intent-kinds] ${INDEX_PATH} already up to date (no-op)`,
  )
}

main()
