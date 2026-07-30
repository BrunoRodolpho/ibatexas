// regen-intent-kinds-freshness.test.ts — FE-4 CONTRACT (FE-T26): the
// codegen-freshness CI gate FE-4.3 calls for ("regenerate in a clean tree;
// fail on any diff").
//
// Reads the COMMITTED packages/intent-kinds/src/index.ts (via a plain
// relative filesystem path — see ../../scripts/build-generated-region.ts's
// own doc for why this lives in packs-composed rather than intent-kinds),
// extracts its GENERATED region (between the sentinel markers), and asserts
// it is BYTE-IDENTICAL to a fresh `buildGeneratedRegion()` call — the exact
// same function `scripts/regenerate-intent-kinds.ts` uses to WRITE the
// file. A stale hand-edit (or a definitions.ts change nobody re-ran
// `pnpm run regen:intent-kinds` for) fails this test immediately, in CI, on
// every commit — a hand-edit is no longer merely discouraged, it is
// IMPOSSIBLE to land un-noticed.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  buildGeneratedRegion,
  extractGeneratedRegion,
  GENERATED_BEGIN,
  GENERATED_END,
} from "../codegen/build-generated-region.js"

// This test file: packages/packs-composed/src/__tests__ → up 3 → packages/
// packs-composed → sibling packages/intent-kinds/src/index.ts.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const INTENT_KINDS_INDEX_PATH = path.join(HERE, "../../../intent-kinds/src/index.ts")
const LABEL = "intent-kinds/src/index.ts"

// R6 leg 1a moved this file's private extractor into build-generated-region.ts
// so this gate, the six pack `intents[]` gates
// (regen-pack-intents-freshness.test.ts) and the write-side script all agree on
// what "the region" is.

describe("packages/intent-kinds/src/index.ts — codegen-freshness gate (FE-4.3 / FE-T26)", () => {
  it("the committed GENERATED region is byte-identical to a fresh regeneration", () => {
    const committed = fs.readFileSync(INTENT_KINDS_INDEX_PATH, "utf8")
    const committedRegion = extractGeneratedRegion(committed, LABEL)
    const fresh = buildGeneratedRegion()
    expect(committedRegion).toBe(fresh)
  })

  it("the markers exist exactly once each (guards against a hand-edit that duplicates or removes a marker)", () => {
    const committed = fs.readFileSync(INTENT_KINDS_INDEX_PATH, "utf8")
    const beginCount = committed.split(GENERATED_BEGIN).length - 1
    const endCount = committed.split(GENERATED_END).length - 1
    expect(beginCount).toBe(1)
    expect(endCount).toBe(1)
  })

  it("PIX_INTENT_KINDS and LOYALTY_INTENT_KINDS are declared OUTSIDE the generated region (the two permanent hand-authored exceptions)", () => {
    const committed = fs.readFileSync(INTENT_KINDS_INDEX_PATH, "utf8")
    const beginIdx = committed.indexOf(GENERATED_BEGIN)
    const beforeRegion = committed.slice(0, beginIdx)
    expect(beforeRegion).toContain("export const PIX_INTENT_KINDS")
    expect(beforeRegion).toContain("export const LOYALTY_INTENT_KINDS")
    const region = extractGeneratedRegion(committed, LABEL)
    expect(region).not.toContain("export const PIX_INTENT_KINDS")
    expect(region).not.toContain("export const LOYALTY_INTENT_KINDS")
  })
})
