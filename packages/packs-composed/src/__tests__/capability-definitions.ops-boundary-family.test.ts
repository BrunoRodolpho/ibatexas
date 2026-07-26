// FE-T24 — FE-4 MIGRATE 4b (the FINAL migrate batch): ops-boundary family
// (foreign/forbidden constants).
//
// Family inventory (full sweep of packages/pack-ops + apps/api/src/ops,
// re-grounded fresh for this ticket — see generate-ops-boundary-kinds.ts's
// own doc for the complete disposition):
//   1. OPS_FOREIGN_ADVERTISED_KIND / _TRANSITION_KIND / _REFUND_KIND
//      (packages/pack-ops/src/capabilities.ts) — FOREIGN-advertised trio.
//      Already modeled by `plannerAdvertisedBy`; no new field. Byte-identity
//      against the REAL exported constants (this file — @ibatexas/pack-ops
//      is a package, so packages/packs-composed can import it directly).
//   2. FORBIDDEN_OPS_DESTRUCTIVE_KINDS (apps/api/src/ops/ops-verb-scope.ts)
//      — the BKL-096 NO-PLANE-EVER forbid. Needed a NEW field
//      (`opsForbiddenDestructive`), grounded from the real constant.
//      Byte-identity against the real export, PLUS the boot-gate
//      equivalence proof, lives in apps/api (ops-verb-scope.ts is
//      apps/api-owned; packages cannot import apps/*) — see
//      apps/api/src/ops/__tests__/ops-boundary-generator-freshness.test.ts.
//   3. WA_EXCLUDED_OPS_KINDS (same file) — traced, NOT generated (a genuine
//      business-policy judgment, not a structural registry fact — see the
//      generator module's own doc for the full rationale).

import { describe, expect, it } from "vitest"

import {
  OPS_FOREIGN_ADVERTISED_KIND,
  OPS_FOREIGN_ADVERTISED_REFUND_KIND,
  OPS_FOREIGN_ADVERTISED_TRANSITION_KIND,
} from "@ibatexas/pack-ops"

import {
  CAPABILITY_DEFINITIONS,
  generateForeignAdvertisedKinds,
  generateOpsForbiddenDestructiveKinds,
} from "@ibatexas/catalog"
import type { CapabilityDefinition } from "@ibatexas/catalog"

describe("generateForeignAdvertisedKinds — byte-identical to the real OPS_FOREIGN_ADVERTISED_* constants (FE-T24 target 1)", () => {
  const generated = generateForeignAdvertisedKinds(CAPABILITY_DEFINITIONS, "ibatexas/pack-ops")

  it("projects exactly the 3 real foreign-advertised kinds", () => {
    expect(generated).toEqual(
      new Set([
        OPS_FOREIGN_ADVERTISED_KIND,
        OPS_FOREIGN_ADVERTISED_TRANSITION_KIND,
        OPS_FOREIGN_ADVERTISED_REFUND_KIND,
      ]),
    )
    expect(generated.size).toBe(3)
  })

  it("every generated kind is genuinely FOREIGN — owned by a pack other than ibatexas/pack-ops (a real subtraction, not vacuous)", () => {
    for (const kind of generated) {
      const def = CAPABILITY_DEFINITIONS.find((d) => d.kind === kind)
      expect(def, `"${kind}" must exist in the registry`).toBeDefined()
      expect(def!.pack).not.toBe("ibatexas/pack-ops")
    }
  })

  it("pack-ops's own 6 OWNED kinds are correctly EXCLUDED (foreign-ness is about pack ownership, not mere ops-advertisement)", () => {
    const opsOwnedKinds = CAPABILITY_DEFINITIONS.filter(
      (d) => d.pack === "ibatexas/pack-ops",
    ).map((d) => d.kind)
    expect(opsOwnedKinds.length).toBeGreaterThan(0)
    for (const kind of opsOwnedKinds) {
      expect(generated.has(kind)).toBe(false)
    }
  })

  it("hand-corrupt one definition's plannerAdvertisedBy → the corrupted kind drops out (required negative direction)", () => {
    const corrupted: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def) =>
      def.kind === "order.note.add" ? { ...def, plannerAdvertisedBy: ["ibatexas/pack-orders"] } : def,
    )
    const corruptedGenerated = generateForeignAdvertisedKinds(corrupted, "ibatexas/pack-ops")
    expect(corruptedGenerated.has("order.note.add")).toBe(false)
    expect(corruptedGenerated.size).toBe(2)
  })

  it("is pack-agnostic — a synthetic non-ops pack id projects a different (empty, today) foreign set, proving the function isn't ops-hardcoded", () => {
    expect(generateForeignAdvertisedKinds(CAPABILITY_DEFINITIONS, "ibatexas/pack-whatsapp").size).toBe(
      0,
    )
  })
})

describe("generateOpsForbiddenDestructiveKinds — pure projection (FE-T24 target 2)", () => {
  it("projects exactly the 3 authored opsForbiddenDestructive kinds", () => {
    const generated = generateOpsForbiddenDestructiveKinds(CAPABILITY_DEFINITIONS)
    expect(generated).toEqual(new Set(["order.cancel", "payment.waive", "payment.status.force"]))
  })

  it("hand-corrupt one definition's opsForbiddenDestructive → the corrupted kind drops out (required negative direction)", () => {
    const corrupted: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def) =>
      def.kind === "payment.waive" ? { ...def, opsForbiddenDestructive: undefined } : def,
    )
    const corruptedGenerated = generateOpsForbiddenDestructiveKinds(corrupted)
    expect(corruptedGenerated.has("payment.waive")).toBe(false)
    expect(corruptedGenerated.size).toBe(2)
  })

  it("spans both tiers — order.cancel is tier:\"chat\", payment.waive/payment.status.force are tier:\"identity\" (the forbid is orthogonal to chat-drivability)", () => {
    const orderCancel = CAPABILITY_DEFINITIONS.find((d) => d.kind === "order.cancel")
    const paymentWaive = CAPABILITY_DEFINITIONS.find((d) => d.kind === "payment.waive")
    expect(orderCancel?.tier).toBe("chat")
    expect(paymentWaive?.tier).toBe("identity")
  })
})
