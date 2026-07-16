// FE-T23 — FE-4 MIGRATE 4a: admin-label freshness gate (presentation family,
// target 1).
//
// `intentKindLabel()` (../agent-approvals.mappers.ts) is the production read
// path — this gate diffs `generateAdminLabels`'s projection against it (an
// independent runtime materialization, not a re-derivation of the same
// source — FE-4.3's "tautological gate" trap): it is the live code path
// `AgentApprovalCard.tsx` actually calls, so a regression here (a
// stale/renamed committed label) would fail exactly where the real
// rendering behavior would also be wrong.
//
// Review fix: a per-key value check against `intentKindLabel()` alone is
// ONE-DIRECTIONAL — it can only see keys `generateAdminLabels` already
// produced; a NEW label added to the committed `INTENT_KIND_LABELS` without
// a matching registry `adminLabel` would pass silently (nothing iterates the
// real map's OWN keys). `INTENT_KIND_LABELS` is now exported for exactly
// this: the key-set/size pins below read the real map directly, making the
// gate bidirectional — a real map addition with no registry counterpart now
// fails loudly (see the negative-direction test at the bottom, which proves
// this by construction rather than asserting it).
//
// `@ibatexas/packs-composed` is a devDependency (test-only consumption) —
// this ticket does NOT repoint `agent-approvals.mappers.ts` itself; the hand-
// maintained `INTENT_KIND_LABELS` remains the production source (FE-4 is
// MIGRATE, not CONTRACT).

import { describe, expect, it } from "vitest"

import {
  CAPABILITY_DEFINITIONS,
  generateAdminLabels,
} from "@ibatexas/packs-composed/capability-definitions"

import { INTENT_KIND_LABELS, intentKindLabel } from "../agent-approvals.mappers.js"

describe("generateAdminLabels — byte-identical to the real intentKindLabel() (FE-T23)", () => {
  // Grounded FROM the committed apps/admin/src/domains/admin/
  // agent-approvals.mappers.ts INTENT_KIND_LABELS entry — the ONE kind
  // genuinely outside this 66-kind registry (owned by the external, FROZEN
  // @adjudicate/pack-payments-pix pack).
  const generated = generateAdminLabels(CAPABILITY_DEFINITIONS, {
    pixChargeRefundLabel: "Reembolso PIX",
  })

  it("projects exactly 9 admin labels, matching INTENT_KIND_LABELS's real committed size", () => {
    expect(Object.keys(generated)).toHaveLength(9)
  })

  it("the real INTENT_KIND_LABELS map's key set is EXACTLY the generated key set (bidirectional — catches a real-map addition with no registry counterpart, not just a registry/real value mismatch)", () => {
    expect(new Set(Object.keys(INTENT_KIND_LABELS))).toEqual(new Set(Object.keys(generated)))
    expect(Object.keys(INTENT_KIND_LABELS)).toHaveLength(Object.keys(generated).length)
  })

  it("every real INTENT_KIND_LABELS value is byte-identical to the generated projection (the reverse direction of the per-kind loop below)", () => {
    for (const [kind, label] of Object.entries(INTENT_KIND_LABELS)) {
      expect(generated[kind], `real key "${kind}" must be generated too`).toBe(label)
    }
  })

  it("REGRESSION PROOF: a synthetic committed map with one EXTRA key (no registry counterpart) FAILS the key-set pin — proving the bidirectional gate is load-bearing, not vacuous", () => {
    const withExtraKey: Record<string, string> = {
      ...INTENT_KIND_LABELS,
      "some.new.kind.never.registered": "Rótulo novo sem adminLabel",
    }
    expect(new Set(Object.keys(withExtraKey))).not.toEqual(new Set(Object.keys(generated)))
  })

  for (const kind of Object.keys(generated)) {
    it(`"${kind}": generated admin label is byte-identical to the real intentKindLabel()`, () => {
      expect(generated[kind]).toBe(intentKindLabel(kind))
    })
  }

  it("a kind with no committed admin label falls back to the raw kind string via the real intentKindLabel() (not a mapped value)", () => {
    // order.item.add is a real, mutating, chat-tier capability with no
    // adminLabel — proves the fallback path is honest, not a silent mapping.
    expect(generated["order.item.add"]).toBeUndefined()
    expect(intentKindLabel("order.item.add")).toBe("order.item.add")
  })

  it("an entirely unknown kind also falls back to the raw string (never throws, never invents a label)", () => {
    expect(intentKindLabel("no.such.kind.exists")).toBe("no.such.kind.exists")
  })

  it("hand-corrupt one definition's adminLabel → diverges from the real intentKindLabel() (required negative direction)", () => {
    const corrupted = CAPABILITY_DEFINITIONS.map((def) =>
      def.kind === "order.cancel" ? { ...def, adminLabel: "WRONG LABEL" } : def,
    )
    const corruptedGenerated = generateAdminLabels(corrupted, {
      pixChargeRefundLabel: "Reembolso PIX",
    })
    expect(corruptedGenerated["order.cancel"]).not.toBe(intentKindLabel("order.cancel"))
  })
})
