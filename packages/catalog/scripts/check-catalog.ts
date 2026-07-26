#!/usr/bin/env -S npx tsx
// check-catalog.ts — the CATALOG COMPILER build gate (LE2-016). Runs as the
// second half of this package's `build`:
//
//   "build": "tsc --outDir dist && tsx scripts/check-catalog.ts"
//
// Run manually: `pnpm --filter @ibatexas/catalog run check` — or, from
// anywhere in the monorepo, `ibx catalog check` (same passes, same
// diagnostics, plus `--json`).
//
// Every static pass must be satisfied by the authored catalog. A rejection
// exits non-zero, which fails the build — so a catalog with a dangling
// reference, a malformed slot, an allergen claim edge, or an uncovered
// terminal cannot produce a `dist/` for any downstream package to consume.
//
// This SUBSUMES the LE2-014 cross-reference check that used to run here
// (`check-claim-references.ts`): its edge table is now the referential pass's,
// and its rejections are reported as `referential-integrity` diagnostics. The
// v0 runner remains available as `run check:claim-refs` for the narrow check
// alone — nothing was weakened, only widened.
//
// All the logic lives in `../src/compiler/` (pure, unit-tested). This file is
// only the process boundary: read, report, exit. Mirrors
// `packages/packs-composed/scripts/regenerate-intent-kinds.ts`, the repo's
// established shape for a tsx-run package script that reaches INWARD into
// `src/` (the direction `rootDir` permits).

import { CAPABILITY_DEFINITIONS } from "../src/capability-definitions/definitions.js"
import {
  assertCatalogCompiles,
  CatalogCompileError,
  formatCatalogReport,
} from "../src/compiler/index.js"

function main(): void {
  try {
    console.log(formatCatalogReport(assertCatalogCompiles(CAPABILITY_DEFINITIONS)))
  } catch (err) {
    if (err instanceof CatalogCompileError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
}

main()
