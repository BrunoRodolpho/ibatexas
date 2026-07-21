// FE-T22 — FE-4 MIGRATE 3: surface/claims/prompt family.
//
// Four named targets:
//   1. Surface/plane membership — reuses generateChatDrivableToolKinds
//      (FE-T19); this ticket's own consumer is the ADVERTISED_NOT_
//      REGISTERED_WHITELIST retirement (apps/api — see
//      apps/api/src/__tests__/tool-roster-integrity.test.ts for the
//      pinned-pre-deletion-set safety net).
//   2. Prompt hints — reuses generateCapabilityDescriptions (FE-T21);
//      that generator already feeds apps/api's
//      `ibatexasPromptFragments()` (transitively, via
//      IBATEXAS_CAPABILITY_DESCRIPTIONS) — see
//      apps/api/src/claustrum/prompts/__tests__/ for the prompt-fragment
//      -level test closing that loop.
//   3. basisCodes refusal mirror — generateRefusalCodes, grounded against
//      each pack's real, exported `basisCodes`.
//   4. SUCCESS_CLAIM_CLASSES links — generateJustifiedByForClaim, the
//      REVERSE of successClaimLinks; round-trip fidelity against the
//      REAL SUCCESS_CLAIM_CLASSES export is verified in apps/api (that
//      export is apps/api-owned).

import { describe, expect, it } from "vitest"

import { customerOnboardingPack } from "@ibatexas/pack-customer-onboarding"
import { ordersPack } from "@ibatexas/pack-orders"
import { paymentsPack } from "@ibatexas/pack-payments"
import { reservationsPack } from "@ibatexas/pack-reservations"
import { whatsappPack } from "@ibatexas/pack-whatsapp"

import {
  CAPABILITY_DEFINITIONS,
  generateJustifiedByForClaim,
  generateRefusalCodes,
} from "../capability-definitions/index.js"
import type { CapabilityDefinition } from "../capability-definitions/index.js"

// ── basisCodes refusal mirror (family 3) ─────────────────────────────────

describe("generateRefusalCodes — grounded against each pack's real basisCodes (FE-T22 family 3)", () => {
  const PACKS = [
    { pack: ordersPack, name: "ibatexas/pack-orders" as const },
    { pack: reservationsPack, name: "ibatexas/pack-reservations" as const },
    { pack: customerOnboardingPack, name: "ibatexas/pack-customer-onboarding" as const },
    { pack: paymentsPack, name: "ibatexas/pack-payments" as const },
    { pack: whatsappPack, name: "ibatexas/pack-whatsapp" as const },
  ]

  it("projects exactly 20 refusal codes, one per chat-tier capability (post-FE-T09 D-a: 18→20)", () => {
    const generated = generateRefusalCodes(CAPABILITY_DEFINITIONS)
    expect(Object.keys(generated)).toHaveLength(20)
  })

  for (const { pack, name } of PACKS) {
    it(`${name}: every generated refusalCode for its capabilities is a REAL member of ${name}'s basisCodes`, () => {
      const generated = generateRefusalCodes(CAPABILITY_DEFINITIONS)
      for (const def of CAPABILITY_DEFINITIONS) {
        if (def.tier !== "chat") continue
        if (def.pack !== name) continue
        const code = generated[def.kind]
        expect(code).toBeDefined()
        expect(pack.basisCodes).toContain(code)
      }
    })
  }

  it("every chat-tier capability's refusalCode is that pack's own <domain>.default.deny floor code (verified, not invented)", () => {
    const expectedByPack: Record<string, string> = {
      "ibatexas/pack-orders": "order.default.deny",
      "ibatexas/pack-reservations": "reservation.default.deny",
      "ibatexas/pack-customer-onboarding": "customer.default.deny",
      "ibatexas/pack-payments": "payment.default.deny",
      "ibatexas/pack-whatsapp": "whatsapp.default.deny",
    }
    for (const def of CAPABILITY_DEFINITIONS) {
      if (def.tier !== "chat") continue
      expect(def.refusalCode).toBe(expectedByPack[def.pack])
    }
  })

  it("hand-corrupt one definition's refusalCode → it is no longer a member of its pack's real basisCodes (the required negative direction)", () => {
    const corrupted: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def) =>
      def.kind === "order.cancel" && def.tier === "chat"
        ? { ...def, refusalCode: "order.THIS_CODE_DOES_NOT_EXIST" }
        : def,
    )
    const generated = generateRefusalCodes(corrupted)
    expect(ordersPack.basisCodes).not.toContain(generated["order.cancel"])
  })
})

// ── SUCCESS_CLAIM_CLASSES links, reverse direction (family 4) ────────────

describe("generateJustifiedByForClaim — reverse mirror, self-consistency (FE-T22 family 4)", () => {
  it("round-trips against the FORWARD successClaimLinks data: every kind a claim's justifiedBy lists actually links back to that claim", () => {
    // Build the expected reverse index directly from successClaimLinks
    // (the forward data FE-T19/T20 authored) and compare against the
    // generator's output — a self-consistency check independent of the
    // generator's own implementation detail (loop order, etc.).
    const expectedByClaimId = new Map<string, string[]>()
    for (const def of CAPABILITY_DEFINITIONS) {
      for (const claimId of def.successClaimLinks ?? []) {
        const existing = expectedByClaimId.get(claimId) ?? []
        existing.push(def.kind)
        expectedByClaimId.set(claimId, existing)
      }
    }
    for (const [claimId, expectedKinds] of expectedByClaimId) {
      const generated = generateJustifiedByForClaim(CAPABILITY_DEFINITIONS, claimId)
      expect(new Set(generated)).toEqual(new Set(expectedKinds))
    }
  })

  it("order.checkout.create's 3-link case round-trips correctly for all three claims", () => {
    expect(generateJustifiedByForClaim(CAPABILITY_DEFINITIONS, "order-placed")).toContain(
      "order.checkout.create",
    )
    expect(
      generateJustifiedByForClaim(CAPABILITY_DEFINITIONS, "purchase-completed"),
    ).toContain("order.checkout.create")
    expect(generateJustifiedByForClaim(CAPABILITY_DEFINITIONS, "pix-generated")).toEqual(
      expect.arrayContaining(["order.checkout.create", "payment.pix.regenerate"]),
    )
  })

  it("a claim id no capability links to projects an empty array (not an error)", () => {
    expect(generateJustifiedByForClaim(CAPABILITY_DEFINITIONS, "no-such-claim-id-exists")).toEqual([])
  })

  // Round-trip fidelity against the REAL SUCCESS_CLAIM_CLASSES export
  // (all 11 classes, byte-for-byte set equality) lives in apps/api —
  // that export is apps/api-owned (apps/api/src/claustrum/
  // ibatexas-responder.ts) and packages cannot import apps/api.
})
