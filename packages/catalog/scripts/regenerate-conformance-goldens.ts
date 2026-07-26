#!/usr/bin/env -S npx tsx
// regenerate-conformance-goldens.ts — the conformance suite's golden-regen
// entry point (LE2-017).
//
//   pnpm --filter @ibatexas/catalog run conformance:regen
//
// All the logic lives in `../src/conformance/regenerate.ts` (type-checked by
// this package's `lint`). This file is only the process boundary: run, report.
// Mirrors `check-catalog.ts`, the package's established shape for a tsx-run
// script that reaches INWARD into `src/`.

import { regenerateConformanceGoldens } from "../src/conformance/regenerate.js"

function main(): void {
  const { written, removed } = regenerateConformanceGoldens()
  for (const name of removed) console.log(`[conformance] removed  ${name}`)
  console.log(
    `[conformance] wrote ${written.length} golden(s) to ` +
      "src/conformance/__golden__/" +
      (removed.length > 0 ? `, removed ${removed.length} orphan(s)` : "") +
      ". Review the diff before committing.",
  )
}

main()
