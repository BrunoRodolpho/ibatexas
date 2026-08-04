// regen-pack-intents-freshness.test.ts — R6 leg 1a: the codegen-freshness CI
// gate for the SIX packs' own `intents[]` arrays, the exact counterpart of
// regen-intent-kinds-freshness.test.ts for the intent-kinds mirror region.
//
// Reads each COMMITTED packages/pack-*/src/index.ts (via a plain relative
// filesystem path — never a package import; see build-pack-intents-region.ts's
// own doc for why that keeps the turbo build graph acyclic), extracts its
// GENERATED region, and asserts it is BYTE-IDENTICAL to a fresh
// `buildPackIntentsRegion()` call — the same function
// scripts/regenerate-intent-kinds.ts uses to WRITE it.
//
// This gate is deliberately STRUCTURAL as well as textual. The region is
// spliced INSIDE a live object literal, next to hand-maintained members
// (`basisCodes`, `policy`, `planner`), so "byte-identical region" alone would
// not prove the region still covers the RIGHT bytes: a marker that drifted a
// few lines up or down would keep passing while quietly putting
// hand-maintained code under machine authorship — or machine-written kinds
// outside it. The bracket-adjacency assertions below pin the region to exactly
// the array contents.
//
// It does NOT replace the family-3 array-equality test in
// capability-definitions.intent-identity-family.test.ts. That one compares the
// projection against each pack's RUNTIME-LOADED `xxxPack.intents` value; this
// one compares committed SOURCE TEXT. Neither subsumes the other — see this
// file's last describe block for the concrete gap each one alone would leave.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS } from "@ibatexas/catalog"
import type { CapabilityDefinition, CapabilityPackId } from "@ibatexas/catalog"

import {
  extractGeneratedRegion,
  GENERATED_BEGIN,
  GENERATED_END,
} from "../codegen/build-generated-region.js"
import {
  buildPackIntentsRegion,
  PACK_INTENTS_DRIFT_GUIDANCE,
  PACK_INTENTS_TARGETS,
} from "../codegen/build-pack-intents-region.js"

// This test file: packages/packs-composed/src/__tests__ → up 3 → packages/.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGES_DIR = path.join(HERE, "../../..")

const ARRAY_OPEN = "\n  intents: [\n"
const ARRAY_CLOSE = "\n  ],"
/** Indentation the region's own lines carry (an array element inside a
 *  top-level object literal). The BEGIN marker line is indented by the
 *  committed file, not by the generator — see buildPackIntentsRegion's doc. */
const ELEMENT_INDENT = "    "

function packIndexPath(packageDir: string): string {
  return path.join(PACKAGES_DIR, packageDir, "src/index.ts")
}

describe("packages/pack-*/src/index.ts — intents[] codegen-freshness gate (R6 leg 1a)", () => {
  for (const target of PACK_INTENTS_TARGETS) {
    const label = `${target.packageDir}/src/index.ts`

    it(`${target.packId}: the committed ${target.constName}.intents region is byte-identical to a fresh regeneration`, () => {
      const committed = fs.readFileSync(packIndexPath(target.packageDir), "utf8")
      const committedRegion = extractGeneratedRegion(committed, label)
      const fresh = buildPackIntentsRegion(target)
      // The FILE and the guidance both ride along on failure: a maintainer who
      // hand-edited the array needs to be told which file drifted and where
      // the real source is, not just that two strings differ.
      expect(committedRegion, `packages/${label} — ${PACK_INTENTS_DRIFT_GUIDANCE}`).toBe(fresh)
    })

    it(`${target.packId}: both markers appear exactly once (guards a hand-edit that duplicates or drops a marker)`, () => {
      const committed = fs.readFileSync(packIndexPath(target.packageDir), "utf8")
      expect(committed.split(GENERATED_BEGIN).length - 1, `packages/${label}`).toBe(1)
      expect(committed.split(GENERATED_END).length - 1, `packages/${label}`).toBe(1)
    })

    it(`${target.packId}: the region covers EXACTLY the intents[] contents — BEGIN is the first line after \`intents: [\`, END the last before \`],\``, () => {
      const committed = fs.readFileSync(packIndexPath(target.packageDir), "utf8")

      const openIdx = committed.indexOf(ARRAY_OPEN)
      expect(openIdx, `\`intents: [\` not found in ${label}`).toBeGreaterThan(-1)
      const afterOpen = committed.slice(openIdx + ARRAY_OPEN.length)
      // Nothing hand-written may sit between the bracket and the marker: any
      // comment a maintainer adds there belongs in the annotations table.
      expect(
        afterOpen.startsWith(`${ELEMENT_INDENT}${GENERATED_BEGIN}\n`),
        `packages/${label}: hand-written content sits between \`intents: [\` and the GENERATED marker. ${PACK_INTENTS_DRIFT_GUIDANCE}`,
      ).toBe(true)

      const endIdx = committed.indexOf(GENERATED_END)
      const afterRegion = committed.slice(endIdx + GENERATED_END.length)
      // ...and nothing between the END marker and the closing bracket, which is
      // what makes "the region is the array" true rather than merely intended.
      expect(
        afterRegion.startsWith(ARRAY_CLOSE),
        `packages/${label}: hand-written content sits between the END marker and \`],\`. ${PACK_INTENTS_DRIFT_GUIDANCE}`,
      ).toBe(true)
    })
  }

  it("the target table covers every pack that OWNS capabilities — a pack silently dropped from PACK_INTENTS_TARGETS would revert to hand authorship with nothing complaining", () => {
    const owningPacks = new Set<CapabilityPackId>(CAPABILITY_DEFINITIONS.map((def) => def.pack))
    const covered = new Set<CapabilityPackId>(PACK_INTENTS_TARGETS.map((t) => t.packId))
    expect([...covered].sort()).toEqual([...owningPacks].sort())
    expect(covered.size).toBe(6)
  })

  it("every target names a DISTINCT package directory (guards a copy-paste pointing two packs at one file, which would make both regions pass vacuously)", () => {
    const dirs = PACK_INTENTS_TARGETS.map((t) => t.packageDir)
    expect(new Set(dirs).size).toBe(dirs.length)
    for (const dir of dirs) expect(fs.existsSync(packIndexPath(dir))).toBe(true)
  })
})

describe("intents[] regions — the generated text is a real projection, not a copy (R6 leg 1a negative direction)", () => {
  it("dropping a definition changes the region it belonged to", () => {
    const ordersTarget = PACK_INTENTS_TARGETS.find((t) => t.packId === "ibatexas/pack-orders")
    if (ordersTarget === undefined) throw new Error("fixture assumption violated: no pack-orders target")
    const committed = fs.readFileSync(packIndexPath(ordersTarget.packageDir), "utf8")
    const committedRegion = extractGeneratedRegion(committed, "pack-orders/src/index.ts")
    // Same projection the generator performs, minus one authored kind. Rebuilt
    // through the pure catalog projection rather than the module-scope
    // CAPABILITY_DEFINITIONS the renderer closes over, so the assertion is that
    // the CONTENT drives the text.
    const firstOrderKind = CAPABILITY_DEFINITIONS.find(
      (def: CapabilityDefinition) => def.pack === "ibatexas/pack-orders",
    )
    if (firstOrderKind === undefined) throw new Error("fixture assumption violated: pack-orders owns no kinds")
    expect(committedRegion).toContain(`"${firstOrderKind.kind}",`)
    const withoutIt = committedRegion.replace(`${ELEMENT_INDENT}"${firstOrderKind.kind}",\n`, "")
    expect(withoutIt).not.toBe(committedRegion)
    expect(withoutIt).not.toBe(buildPackIntentsRegion(ordersTarget))
  })

  it("pack-ops' four INTERLEAVED rationale comments survive generation, each still immediately preceding its own kind", () => {
    // The whole reason the annotations table exists. A generator that emitted
    // bare `"kind",` lines would delete these five blocks (four here, one in
    // pack-payments) and this suite would still be green on byte-identity
    // alone, because the committed file would have been rewritten to match.
    const opsTarget = PACK_INTENTS_TARGETS.find((t) => t.packId === "ibatexas/pack-ops")
    if (opsTarget === undefined) throw new Error("fixture assumption violated: no pack-ops target")
    const region = buildPackIntentsRegion(opsTarget)
    const PAIRS: ReadonlyArray<readonly [string, string]> = [
      ["NEW-004", "product.price.set"],
      ["SCN-114", "menu.special.set"],
      ["BKL-088", "ops.alert.resolve.staff"],
      ["SCN-127", "schedule.override.set"],
    ]
    for (const [ticket, kind] of PAIRS) {
      const lines = region.split("\n")
      const kindIdx = lines.indexOf(`${ELEMENT_INDENT}"${kind}",`)
      expect(kindIdx, `${kind} missing from the pack-ops region`).toBeGreaterThan(-1)
      // Walk back over this kind's contiguous comment block and require the
      // ticket reference inside it — position, not mere presence.
      let cursor = kindIdx - 1
      const block: string[] = []
      while (cursor >= 0 && lines[cursor]?.trim().startsWith("//")) {
        block.unshift(lines[cursor] as string)
        cursor -= 1
      }
      expect(block.join("\n"), `${ticket} note is no longer attached to ${kind}`).toContain(ticket)
    }
  })

  it("pack-payments' BKL-176 retirement note survives, still inside the region and above payment.create", () => {
    const paymentsTarget = PACK_INTENTS_TARGETS.find((t) => t.packId === "ibatexas/pack-payments")
    if (paymentsTarget === undefined) throw new Error("fixture assumption violated: no pack-payments target")
    const region = buildPackIntentsRegion(paymentsTarget)
    const noteIdx = region.indexOf("BKL-176")
    const kindIdx = region.indexOf(`"payment.create",`)
    expect(noteIdx).toBeGreaterThan(-1)
    expect(noteIdx).toBeLessThan(kindIdx)
  })
})

describe("why BOTH intents[] gates stay (R6 leg 1a coverage decision)", () => {
  // Recorded as an executable note, not prose in a PR description: each gate
  // catches a drift the other cannot, so neither is redundant belt-and-braces.
  it("this SOURCE-TEXT gate reads the committed file; the family-3 RUNTIME gate reads the imported value — the two sources are genuinely different", async () => {
    const { opsPack } = await import("@ibatexas/pack-ops")
    const opsTarget = PACK_INTENTS_TARGETS.find((t) => t.packId === "ibatexas/pack-ops")
    if (opsTarget === undefined) throw new Error("fixture assumption violated: no pack-ops target")
    const region = buildPackIntentsRegion(opsTarget)

    // Runtime value: kinds only, no comments, no markers, no source syntax.
    for (const kind of opsPack.intents) expect(region).toContain(`"${kind}",`)
    // Source text: carries the markers and the rationale comments the runtime
    // value cannot express. A gate reading only `opsPack.intents` therefore
    // cannot notice a marker or a comment block going missing...
    expect(region).toContain(GENERATED_BEGIN)
    expect(region).toContain("NEW-004")
    // ...and a gate reading only source text cannot notice that the value the
    // application actually imports came from somewhere else (a stale dist, a
    // re-export, a filtered copy). Both directions stay covered.
    expect([...opsPack.intents]).toEqual(
      region
        .split("\n")
        .map((line) => /^\s*"([^"]+)",$/.exec(line)?.[1])
        .filter((kind): kind is string => kind !== undefined),
    )
  })
})
