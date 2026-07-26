#!/usr/bin/env -S npx tsx
// check-claim-references.ts — the CROSS-REFERENCE CHECK v0 build gate
// (LE2-014). Runs as the second half of this package's `build`:
//
//   "build": "tsc --outDir dist && tsx scripts/check-claim-references.ts"
//
// Run manually: `pnpm --filter @ibatexas/catalog run check:claim-refs`
//
// Every claim reference carried by a `CapabilityDefinition` must resolve
// against the catalog's claim-reference vocabulary. A dangler exits non-zero,
// which fails the build — so a catalog with a broken reference cannot produce
// a `dist/` for any downstream package to consume.
//
// All the logic lives in `../src/build-gates/check-claim-references.ts` (pure,
// unit-tested). This file is only the process boundary: read, report, exit.
// Mirrors `packages/packs-composed/scripts/regenerate-intent-kinds.ts`, the
// repo's established shape for a tsx-run package script that reaches INWARD
// into `src/` (the direction `rootDir` permits).

import { CAPABILITY_DEFINITIONS } from "../src/capability-definitions/definitions.js"
import {
  assertClaimReferencesResolve,
  CatalogCrossReferenceError,
} from "../src/build-gates/check-claim-references.js"
import { CATALOG_VERSION } from "../src/version.js"

function main(): void {
  try {
    const checked = assertClaimReferencesResolve(CAPABILITY_DEFINITIONS)
    console.log(
      `[catalog] cross-reference check OK — catalog v${CATALOG_VERSION}: ` +
        `${checked} claim reference(s) across ${CAPABILITY_DEFINITIONS.length} capability definition(s) all resolve.`,
    )
  } catch (err) {
    if (err instanceof CatalogCrossReferenceError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
}

main()
