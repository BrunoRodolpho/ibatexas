// regen-pack-unions-freshness.test.ts — R6 leg 1b: the codegen-freshness CI
// gate for the SIX packs' own kind TYPE UNIONS (`OrderIntentKind` et al. in
// packages/pack-*/src/types.ts), the exact counterpart of
// regen-pack-intents-freshness.test.ts for the `intents[]` arrays and of
// regen-intent-kinds-freshness.test.ts for the intent-kinds mirror region.
//
// Reads each COMMITTED packages/pack-*/src/types.ts (via a plain relative
// filesystem path — never a package import; see build-pack-kind-union-region.ts's
// own doc for why that keeps the turbo build graph acyclic), extracts its
// GENERATED region, and asserts it is BYTE-IDENTICAL to a fresh
// `buildPackKindUnionRegion()` call — the same function
// scripts/regenerate-intent-kinds.ts uses to WRITE it.
//
// ── Why the tail assertions are stronger here than in leg 1a ────────────────
// Leg 1a's region sits inside an array literal, so `],` pins its end. A type
// union has NO closing token: it ends where its members stop. "END marker is
// followed by a blank line" alone would leave a real hole, because blank lines
// are whitespace to TypeScript — a member hand-added BELOW the blank line would
// still be part of the union and the gate would stay green. So the tail is
// pinned twice: blank line immediately after the END marker, AND the first
// non-blank line after it does not continue the union with another `|`.
//
// It does NOT replace the TS2820 compile-time leg. `intent-kinds/src/index.ts`
// closes each of its six generated arrays with
// `as const satisfies readonly OrderIntentKind[]`, so a union member that
// disappears or is misspelled fails `tsc` across the workspace. That leg proves
// the TYPE the application compiles against; this one proves the committed
// SOURCE TEXT is what the generator would write. Neither subsumes the other —
// see this file's last describe block for the concrete gap each one alone would
// leave.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  CUSTOMER_ONBOARDING_INTENT_KINDS,
  OPS_INTENT_KINDS,
  ORDER_INTENT_KINDS,
  PAYMENT_INTENT_KINDS,
  RESERVATION_INTENT_KINDS,
  WHATSAPP_INTENT_KINDS,
} from "@ibatexas/intent-kinds"

import { CAPABILITY_DEFINITIONS } from "@ibatexas/catalog"
import type { CapabilityDefinition, CapabilityPackId } from "@ibatexas/catalog"

import {
  extractGeneratedRegion,
  GENERATED_BEGIN,
  GENERATED_END,
} from "../codegen/build-generated-region.js"
import {
  buildPackKindUnionRegion,
  PACK_KIND_UNION_DRIFT_GUIDANCE,
  PACK_KIND_UNION_TARGETS,
  unionDeclarationLine,
} from "../codegen/build-pack-kind-union-region.js"

// This test file: packages/packs-composed/src/__tests__ → up 3 → packages/.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGES_DIR = path.join(HERE, "../../..")

/** Indentation the region's own lines carry (a union member, one level in).
 *  The BEGIN marker line is indented by the committed file, not by the
 *  generator — see buildPackKindUnionRegion's doc. */
const MEMBER_INDENT = "  "

function packTypesPath(packageDir: string): string {
  return path.join(PACKAGES_DIR, packageDir, "src/types.ts")
}

/** The kinds a region's member lines name, in order. */
function regionMembers(region: string): readonly string[] {
  return region
    .split("\n")
    .map((line) => /^\s*\| "([^"]+)"$/.exec(line)?.[1])
    .filter((kind): kind is string => kind !== undefined)
}

describe("packages/pack-*/src/types.ts — kind-union codegen-freshness gate (R6 leg 1b)", () => {
  for (const target of PACK_KIND_UNION_TARGETS) {
    const label = `${target.packageDir}/src/types.ts`

    it(`${target.packId}: the committed ${target.typeName} union region is byte-identical to a fresh regeneration`, () => {
      const committed = fs.readFileSync(packTypesPath(target.packageDir), "utf8")
      const committedRegion = extractGeneratedRegion(committed, label)
      const fresh = buildPackKindUnionRegion(target)
      // The FILE and the guidance both ride along on failure: a maintainer who
      // hand-edited the union needs to be told which file drifted and where the
      // real source is, not just that two strings differ.
      expect(committedRegion, `packages/${label} — ${PACK_KIND_UNION_DRIFT_GUIDANCE}`).toBe(fresh)
    })

    it(`${target.packId}: both markers appear exactly once (guards a hand-edit that duplicates or drops a marker)`, () => {
      const committed = fs.readFileSync(packTypesPath(target.packageDir), "utf8")
      expect(committed.split(GENERATED_BEGIN).length - 1, `packages/${label}`).toBe(1)
      expect(committed.split(GENERATED_END).length - 1, `packages/${label}`).toBe(1)
    })

    it(`${target.packId}: the region covers EXACTLY the union's members — BEGIN is the first line after \`${unionDeclarationLine(target)}\`, and nothing extends the union after END`, () => {
      const committed = fs.readFileSync(packTypesPath(target.packageDir), "utf8")

      const decl = `${unionDeclarationLine(target)}\n`
      const declIdx = committed.indexOf(decl)
      expect(declIdx, `\`${unionDeclarationLine(target)}\` not found in ${label}`).toBeGreaterThan(-1)
      const afterDecl = committed.slice(declIdx + decl.length)
      // Nothing hand-written may sit between the declaration and the marker:
      // any comment a maintainer adds there belongs either in the annotations
      // table or in the doc block ABOVE the type.
      expect(
        afterDecl.startsWith(`${MEMBER_INDENT}${GENERATED_BEGIN}\n`),
        `packages/${label}: hand-written content sits between the union declaration and the GENERATED marker. ${PACK_KIND_UNION_DRIFT_GUIDANCE}`,
      ).toBe(true)

      const endIdx = committed.indexOf(GENERATED_END)
      const afterRegion = committed.slice(endIdx + GENERATED_END.length)
      // The declaration must END at the marker — blank line immediately after…
      expect(
        afterRegion.startsWith("\n\n"),
        `packages/${label}: the END marker is not the union's last line. ${PACK_KIND_UNION_DRIFT_GUIDANCE}`,
      ).toBe(true)
      // …and, because blank lines are whitespace to TypeScript, the next
      // non-blank line must not be another `|` member smuggled past the marker.
      const firstLiveLine = afterRegion.replace(/^\n+/, "").split("\n")[0] ?? ""
      expect(
        /^\s*\|/.test(firstLiveLine),
        `packages/${label}: a union member sits BELOW the END marker (still part of ${target.typeName}). ${PACK_KIND_UNION_DRIFT_GUIDANCE}`,
      ).toBe(false)
    })
  }

  it("the target table covers every pack that OWNS capabilities — a pack silently dropped from PACK_KIND_UNION_TARGETS would revert to hand authorship with nothing complaining", () => {
    const owningPacks = new Set<CapabilityPackId>(CAPABILITY_DEFINITIONS.map((def) => def.pack))
    const covered = new Set<CapabilityPackId>(PACK_KIND_UNION_TARGETS.map((t) => t.packId))
    expect([...covered].sort()).toEqual([...owningPacks].sort())
    expect(covered.size).toBe(6)
  })

  it("every target names a DISTINCT package directory AND a distinct type (guards a copy-paste pointing two packs at one file or one type, which would make both regions pass vacuously)", () => {
    const dirs = PACK_KIND_UNION_TARGETS.map((t) => t.packageDir)
    const types = PACK_KIND_UNION_TARGETS.map((t) => t.typeName)
    expect(new Set(dirs).size).toBe(dirs.length)
    expect(new Set(types).size).toBe(types.length)
    for (const dir of dirs) expect(fs.existsSync(packTypesPath(dir))).toBe(true)
  })
})

describe("kind-union regions — the generated text is a real projection, not a copy (R6 leg 1b negative direction)", () => {
  it("dropping a definition changes the region it belonged to", () => {
    const ordersTarget = PACK_KIND_UNION_TARGETS.find((t) => t.packId === "ibatexas/pack-orders")
    if (ordersTarget === undefined) throw new Error("fixture assumption violated: no pack-orders target")
    const committed = fs.readFileSync(packTypesPath(ordersTarget.packageDir), "utf8")
    const committedRegion = extractGeneratedRegion(committed, "pack-orders/src/types.ts")
    const firstOrderKind = CAPABILITY_DEFINITIONS.find(
      (def: CapabilityDefinition) => def.pack === "ibatexas/pack-orders",
    )
    if (firstOrderKind === undefined) throw new Error("fixture assumption violated: pack-orders owns no kinds")
    expect(committedRegion).toContain(`| "${firstOrderKind.kind}"`)
    const withoutIt = committedRegion.replace(`${MEMBER_INDENT}| "${firstOrderKind.kind}"\n`, "")
    expect(withoutIt).not.toBe(committedRegion)
    expect(withoutIt).not.toBe(buildPackKindUnionRegion(ordersTarget))
  })

  it("pack-whatsapp's two INTERLEAVED rationale blocks survive generation, each still immediately preceding its own kind", () => {
    // The whole reason the union annotations table exists — and the reason it
    // is a SEPARATE table from the `intents[]` one: these 8 lines exist in
    // neither CAPABILITY_DEFINITIONS nor pack-whatsapp/src/index.ts, so a
    // generator emitting bare `| "kind"` lines would delete them and this suite
    // would still be green on byte-identity alone, because the committed file
    // would have been rewritten to match.
    const whatsappTarget = PACK_KIND_UNION_TARGETS.find((t) => t.packId === "ibatexas/pack-whatsapp")
    if (whatsappTarget === undefined) throw new Error("fixture assumption violated: no pack-whatsapp target")
    const region = buildPackKindUnionRegion(whatsappTarget)
    const PAIRS: ReadonlyArray<readonly [string, string]> = [
      ["W5-6", "conversation.message.append"],
      ["BKL-030", "whatsapp.handoff.request"],
    ]
    for (const [ticket, kind] of PAIRS) {
      const lines = region.split("\n")
      const kindIdx = lines.indexOf(`${MEMBER_INDENT}| "${kind}"`)
      expect(kindIdx, `${kind} missing from the pack-whatsapp region`).toBeGreaterThan(-1)
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

  it("no union member is UNDECLARED — every committed member is a CAPABILITY_DEFINITIONS kind of that same pack, all 62 of them", () => {
    // The derivability pre-check of R6 leg 1b, kept executable. A union may not
    // legitimately outlive the definitions: pack-payments' own BKL-176 note
    // documents 5 RETIRED `payment.charge.*` kinds, so a union carrying history
    // the registry dropped was a live possibility, and absorbing such a member
    // into a generated region would silently DELETE it on the next regen. It
    // was measured false for all six packs before this slice was written; this
    // asserts it stays false rather than trusting the module comment.
    let total = 0
    for (const target of PACK_KIND_UNION_TARGETS) {
      const committed = fs.readFileSync(packTypesPath(target.packageDir), "utf8")
      const members = regionMembers(extractGeneratedRegion(committed, `${target.packageDir}/src/types.ts`))
      const declared = CAPABILITY_DEFINITIONS.filter((def) => def.pack === target.packId).map((def) => def.kind)
      // Both directions, IN ORDER: no member the registry does not declare, and
      // no declared kind the union omits (which is what TS2820 would catch, one
      // package later and with a far worse message).
      expect(members, `${target.packageDir}/src/types.ts`).toEqual(declared)
      total += members.length
    }
    expect(total).toBe(CAPABILITY_DEFINITIONS.length)
    expect(total).toBe(62)
  })
})

describe("why the union SOURCE gate and the TS2820 type gate both stay (R6 leg 1b coverage decision)", () => {
  // Recorded as an executable note, not prose in a PR description: each leg
  // catches a drift the other cannot, so neither is redundant belt-and-braces.
  it("this SOURCE-TEXT gate reads the committed types.ts; the compile-time leg checks the TYPE via intent-kinds' `satisfies` — the two sources are genuinely different", () => {
    const MIRRORS: ReadonlyArray<readonly [CapabilityPackId, readonly string[]]> = [
      ["ibatexas/pack-orders", ORDER_INTENT_KINDS],
      ["ibatexas/pack-reservations", RESERVATION_INTENT_KINDS],
      ["ibatexas/pack-whatsapp", WHATSAPP_INTENT_KINDS],
      ["ibatexas/pack-payments", PAYMENT_INTENT_KINDS],
      ["ibatexas/pack-customer-onboarding", CUSTOMER_ONBOARDING_INTENT_KINDS],
      ["ibatexas/pack-ops", OPS_INTENT_KINDS],
    ]
    for (const [packId, mirror] of MIRRORS) {
      const target = PACK_KIND_UNION_TARGETS.find((t) => t.packId === packId)
      if (target === undefined) throw new Error(`fixture assumption violated: no target for ${packId}`)
      const region = buildPackKindUnionRegion(target)
      // The array `... satisfies readonly XIntentKind[]` type-checks against is
      // exactly this region's member list — so this states, at runtime and
      // per-pack, the invariant `tsc` enforces workspace-wide as TS2820.
      expect(regionMembers(region), `${target.typeName}`).toEqual([...mirror])
    }

    // What the type leg CANNOT see: the region's markers and its rationale
    // comments are type-invisible, so a corrupted marker or a deleted note
    // compiles perfectly and is caught only here…
    const whatsappTarget = PACK_KIND_UNION_TARGETS.find((t) => t.packId === "ibatexas/pack-whatsapp")
    if (whatsappTarget === undefined) throw new Error("fixture assumption violated: no pack-whatsapp target")
    const whatsappRegion = buildPackKindUnionRegion(whatsappTarget)
    expect(whatsappRegion).toContain(GENERATED_BEGIN)
    expect(whatsappRegion).toContain("W5-6")
    // …and, in the other direction, an ADDED union member type-checks fine (the
    // `satisfies` clause only requires the array to be a SUBSET of the union),
    // so the type leg cannot notice a hand-widened union at all. This gate can.
    expect(regionMembers(whatsappRegion)).not.toContain("whatsapp.HAND_WIDENED")
  })
})
