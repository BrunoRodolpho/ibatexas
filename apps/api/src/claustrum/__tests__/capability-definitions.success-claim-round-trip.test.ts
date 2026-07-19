// FE-T22 — FE-4 MIGRATE 3, "SUCCESS_CLAIM_CLASSES links" family, round-trip
// fidelity against the REAL export.
//
// `CapabilityDefinition.successClaimLinks` (FE-T19) is the FORWARD inversion
// of `SUCCESS_CLAIM_CLASSES[i].justifiedBy` (ibatexas-responder.ts): for each
// capability, which claim-class ids its EXECUTE can justify.
// `generateJustifiedByForClaim` (this ticket) goes the OTHER direction — for
// a claim id, which capability kinds justify it — RECONSTRUCTED from
// `successClaimLinks`, never re-typed from the real export. This test is the
// freshness proof: for every one of the real 11 `SUCCESS_CLAIM_CLASSES`
// entries, the reverse-mirror generator's output must equal (as a SET —
// order carries no contract, see the generator's own doc) the real
// `justifiedBy` array. `SUCCESS_CLAIM_CLASSES` is apps/api-owned
// (ibatexas-responder.ts), so this test lives here, not in packages/
// packs-composed (packages cannot import apps/api).
//
// This test caught a real grounding gap during authoring: identity-tier
// CapabilityDefinition entries (payment.cash.confirm — payment.charge.confirm
// was retired in BKL-176 —,
// payment.refund.issue, payment.refund.confirm, reservation.checkin,
// reservation.complete, order.amend.add_item, order.amend.update_qty,
// order.amend.remove_item) are real justifiedBy members of a claim class but
// had no successClaimLinks at all — T19 only fully populated the 18 chat-tier
// definitions. Fixed by adding successClaimLinks to those 9 definitions,
// grounded FROM SUCCESS_CLAIM_CLASSES's own justifiedBy arrays (never
// invented) — see packages/packs-composed/src/capability-definitions/
// definitions.ts.

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_DEFINITIONS,
  generateJustifiedByForClaim,
} from "@ibatexas/packs-composed/capability-definitions";

import { SUCCESS_CLAIM_CLASSES } from "../ibatexas-responder.js";

describe("generateJustifiedByForClaim — round-trip fidelity against the REAL SUCCESS_CLAIM_CLASSES (FE-T22 family 4)", () => {
  it("SUCCESS_CLAIM_CLASSES has exactly the 19 documented classes — 11 §K seed + 8 BKL-194 (guards a hollowed probe)", () => {
    expect(SUCCESS_CLAIM_CLASSES).toHaveLength(19);
  });

  for (const cls of SUCCESS_CLAIM_CLASSES) {
    it(`"${cls.id}": generateJustifiedByForClaim reproduces the real justifiedBy set exactly`, () => {
      const generated = generateJustifiedByForClaim(CAPABILITY_DEFINITIONS, cls.id);
      expect(new Set(generated)).toEqual(new Set(cls.justifiedBy));
    });
  }

  it("fulfillment-claimed's justifiedBy is permanently empty (anti-confabulation floor) — the generator agrees", () => {
    expect(SUCCESS_CLAIM_CLASSES.find((c) => c.id === "fulfillment-claimed")?.justifiedBy).toEqual(
      [],
    );
    expect(generateJustifiedByForClaim(CAPABILITY_DEFINITIONS, "fulfillment-claimed")).toEqual([]);
  });

  it("payment-settled excludes payment.refund.confirm (opposite money direction) — the generator agrees", () => {
    const generated = generateJustifiedByForClaim(CAPABILITY_DEFINITIONS, "payment-settled");
    expect(generated).not.toContain("payment.refund.confirm");
    // BKL-176 — payment.charge.confirm retired; payment.cash.confirm is the
    // sole remaining inbound-settlement justifier.
    expect(generated).toEqual(
      expect.arrayContaining(["payment.cash.confirm"]),
    );
    expect(generated).not.toContain("payment.charge.confirm");
  });

  it("no CapabilityDefinition links to a claim id SUCCESS_CLAIM_CLASSES does not define (no orphaned forward link)", () => {
    const realIds = new Set(SUCCESS_CLAIM_CLASSES.map((c) => c.id));
    for (const def of CAPABILITY_DEFINITIONS) {
      for (const claimId of def.successClaimLinks ?? []) {
        expect(realIds.has(claimId), `"${def.kind}" links to undefined claim id "${claimId}"`).toBe(
          true,
        );
      }
    }
  });
});
