// GOLDEN REGENERATION for the conformance corpus (LE2-017).
//
// The repo's golden-regen idiom, as a first-class script rather than a
// commented-out `npx tsx -e "…"` recipe: with twenty-odd goldens, a recipe
// nobody can run without editing it is a suite people stop extending.
//
//   pnpm --filter @ibatexas/catalog run conformance:regen
//
// Regeneration is DESTRUCTIVE and unconditional by design — it rewrites every
// golden from a fresh compile and deletes any golden no fixture claims, which
// is what makes "regenerate in a clean tree; fail on any diff" a meaningful
// gate. Read the resulting diff; a golden diff you cannot explain is the
// finding, not an inconvenience.
//
// The only module in `src/conformance/` that writes. The compiler itself
// remains IO-free.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"

import { CONFORMANCE_FIXTURES } from "./fixtures/index.js"
import {
  canonicalize,
  computeGolden,
  computeInventoryGolden,
  goldenFileName,
  goldenPath,
  GOLDEN_DIR,
  INVENTORY_GOLDEN_NAME,
} from "./golden.js"

/** What one regeneration did. */
export interface GoldenRegenerationReport {
  readonly written: readonly string[]
  /** Goldens deleted because no fixture claims them any more. */
  readonly removed: readonly string[]
}

/** Every golden file name the corpus currently claims. */
export function expectedGoldenFiles(): ReadonlySet<string> {
  return new Set([
    ...CONFORMANCE_FIXTURES.map((fixture) => goldenFileName(fixture.name)),
    goldenFileName(INVENTORY_GOLDEN_NAME),
  ])
}

/** Rewrite every golden from a fresh compile. */
export function regenerateConformanceGoldens(): GoldenRegenerationReport {
  mkdirSync(GOLDEN_DIR, { recursive: true })
  const expected = expectedGoldenFiles()

  const removed = readdirSync(GOLDEN_DIR)
    .filter((name) => name.endsWith(".json") && !expected.has(name))
    .sort()
  for (const name of removed) rmSync(`${GOLDEN_DIR}${name}`)

  const written: string[] = []
  for (const fixture of CONFORMANCE_FIXTURES) {
    writeFileSync(goldenPath(fixture.name), canonicalize(computeGolden(fixture)), "utf8")
    written.push(goldenFileName(fixture.name))
  }
  writeFileSync(
    goldenPath(INVENTORY_GOLDEN_NAME),
    canonicalize(computeInventoryGolden()),
    "utf8",
  )
  written.push(goldenFileName(INVENTORY_GOLDEN_NAME))

  return { written, removed }
}
