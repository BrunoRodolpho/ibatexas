/**
 * THE `perResourceKey` WIDENING (inv.18 v2 / R2-S2) — the guards for a facet whose
 * every failure mode is SILENT.
 *
 * A parameterized type whose compiled spec loses its `perResourceKey` flag, or whose
 * declared keys arrive pre-suffixed, produces NO error anywhere: `selectCandidateClaim`
 * skips `parameterizeKeysBySubject` (or double-suffixes), the kernel resolves a key the
 * ledger does not hold, the evidence reads ABSENT, and the claim degrades to a perfectly
 * honest UNKNOWN. Nothing throws, nothing goes red, and the customer just stops getting
 * an answer. So the two wire facts are asserted here directly, and the DIRECT CONTROL —
 * the published `compileClaimDefinition` run on the SAME source — is asserted to NOT
 * carry the flag, which is what makes these tests about the widening rather than about
 * an object literal that happens to have the right field.
 *
 * Deterministic + pure: no clock, no RNG, no IO, no model.
 */
import { describe, expect, it } from "vitest";
import { compileClaimDefinition } from "@adjudicate/core";
import {
  ownerScopedBaseKey,
  REGISTRY_SPECS,
  selectCandidateClaim,
} from "../../claim-registry.js";
import { publicPerItemBaseKey } from "../../classify-only-reads.js";
import { MENU_ITEM_PRICE_SOURCE } from "../menu-item-price.claim.js";
import {
  MENU_ITEM_PRICE_ID,
  MENU_ITEM_PRICE_REGISTRY_SPEC,
} from "../menu-item-price.generated.js";
import {
  compilePerResourceClaimDefinition,
  FLAG_ANCHOR_FIELD,
  PER_RESOURCE_DOC_LINE,
  widenRegistrySpec,
} from "../per-resource-claim.js";

/** The BASE keys the source declares — the keys the ledger is namespaced under. */
const BASE_EVIDENCE_KEY = "menu:item_price";
const BASE_FALSIFIER_KEY = "menu:item_unpublished";

describe("R2-S2 — the widening projects a facet the published compiler DROPS", () => {
  // The control. If this ever goes GREEN-in-reverse (i.e. the published compiler starts
  // emitting the flag), the whole repo-local widening is obsolete and should be deleted
  // rather than kept as a no-op wrapper — so the assertion is written to fail loudly in
  // that direction too, not merely to document today's gap.
  it("the PUBLISHED compileClaimDefinition on the SAME source emits NO perResourceKey", () => {
    const published = compileClaimDefinition(MENU_ITEM_PRICE_SOURCE);
    expect("perResourceKey" in published.registrySpec).toBe(false);
    // …and every other field is identical, so the widening's only effect is the facet.
    expect({ ...published.registrySpec, perResourceKey: true }).toEqual(
      MENU_ITEM_PRICE_REGISTRY_SPEC,
    );
  });

  it("the WIDENED compile emits perResourceKey: true", () => {
    const widened = compilePerResourceClaimDefinition(MENU_ITEM_PRICE_SOURCE);
    expect(widened.registrySpec.perResourceKey).toBe(true);
  });

  it("the flag lands immediately after the anchor field (the review position)", () => {
    const fields = Object.keys(MENU_ITEM_PRICE_REGISTRY_SPEC);
    expect(fields.indexOf("perResourceKey")).toBe(
      fields.indexOf(FLAG_ANCHOR_FIELD) + 1,
    );
  });

  // The fail-closed branch, REACHED rather than merely declared: `customerScoped` is
  // non-optional in the published `CompiledRegistrySpec`, so no real source can get here
  // through `compilePerResourceClaimDefinition` — an anchor-less spec is the only way to
  // prove the guard is not decorative.
  it("an anchor-less spec THROWS rather than drop or misplace the flag", () => {
    const anchorless = {
      kind: "read_claim",
      minSourceIntegrity: "structured",
      requiredEvidence: [],
    } as unknown as Parameters<typeof widenRegistrySpec>[0];
    expect(() => widenRegistrySpec(anchorless, true, "ANCHORLESS@1")).toThrow(
      /FAIL-CLOSED/,
    );
    expect(() => widenRegistrySpec(anchorless, true, "ANCHORLESS@1")).toThrow(
      new RegExp(FLAG_ANCHOR_FIELD),
    );
  });

  it("the doc card carries the facet (the keys it lists are NOT what the runtime resolves)", () => {
    const widened = compilePerResourceClaimDefinition(MENU_ITEM_PRICE_SOURCE);
    expect(widened.doc).toContain(PER_RESOURCE_DOC_LINE);
    // The published card lists the BASE key with no hint that it gets suffixed — which is
    // exactly why the line is appended.
    expect(compileClaimDefinition(MENU_ITEM_PRICE_SOURCE).doc).not.toContain(
      "per-resource key",
    );
  });

  it("only the registry spec + doc are widened — the validator wiring is untouched", () => {
    const published = compileClaimDefinition(MENU_ITEM_PRICE_SOURCE);
    const widened = compilePerResourceClaimDefinition(MENU_ITEM_PRICE_SOURCE);
    expect(widened.definition).toEqual(published.definition);
    expect(widened.renderTemplate).toEqual(published.renderTemplate);
    expect(widened.closure).toEqual(published.closure);
    expect(widened.fixtures).toEqual(published.fixtures);
    expect(widened.id).toBe(published.id);
    // `perResourceKey` is a REGISTRY-SPEC field; the generic ClaimDefinition has none.
    expect("perResourceKey" in widened.definition).toBe(false);
  });
});

describe("R2-S2 wire fact 1 — the emitted keys are UNSUFFIXED BASES, suffixed at RUNTIME", () => {
  it("the generated spec declares BARE base keys on all three key-bearing fields", () => {
    expect(MENU_ITEM_PRICE_REGISTRY_SPEC.requiredEvidence.map((e) => e.key)).toEqual([
      BASE_EVIDENCE_KEY,
    ]);
    expect(MENU_ITEM_PRICE_REGISTRY_SPEC.falsifiers.map((f) => f.key)).toEqual([
      BASE_FALSIFIER_KEY,
    ]);
    expect(MENU_ITEM_PRICE_REGISTRY_SPEC.valueBinding.key).toBe(BASE_EVIDENCE_KEY);
  });

  it("selectCandidateClaim suffixes evidence + falsifiers + valueBinding in LOCKSTEP", () => {
    const candidate = selectCandidateClaim({
      type: "MENU_ITEM_PRICE",
      subject: "prod_costela",
      actor: { principal: "customer" },
      value: undefined,
    });
    expect(candidate).toBeDefined();
    const s = candidate!.soundness;
    // The keys the kernel will hand to `ledger.resolve` — byte-equal to the
    // investigator's `MENU_ITEM_PRICE_KEY(productId)` (ibatexas-investigator.ts).
    expect(s.requiredEvidence.map((e) => e.key)).toEqual([
      "menu:item_price:prod_costela",
    ]);
    expect(s.falsifiers?.map((f) => f.key)).toEqual([
      "menu:item_unpublished:prod_costela",
    ]);
    expect(s.valueBinding?.key).toBe("menu:item_price:prod_costela");
    // C6 structural guard (the kernel hard-throws otherwise): the SUFFIXED binding key
    // is still a member of the SUFFIXED requiredEvidence key set. A base key that
    // arrived pre-suffixed would double-suffix on one side and break this.
    expect(s.requiredEvidence.map((e) => e.key)).toContain(s.valueBinding?.key);
  });
});

describe("R2-S2 wire fact 2 — base-key readers see the BASE key off the generated spec", () => {
  it("publicPerItemBaseKey resolves the public per-item subject namespace", () => {
    // Reads `requiredEvidence[0].key` directly (classify-only-reads.ts), and is what
    // `presentPublicItemIds` strips the `${base}:` prefix from to name the admissible
    // item off the ledger. A pre-suffixed key here would make every present entry
    // unmatchable.
    expect(publicPerItemBaseKey("MENU_ITEM_PRICE")).toBe(BASE_EVIDENCE_KEY);
  });

  it("ownerScopedBaseKey stays undefined — this type is PUBLIC, not owner-scoped", () => {
    // The complement of `publicPerItemBaseKey` over the per-resource types: exactly one
    // of the two is defined for any parameterized member. Public here means no C1
    // ownership surface is in play, which is why this type was chosen as the first proof.
    expect(ownerScopedBaseKey("MENU_ITEM_PRICE")).toBeUndefined();
    expect(
      MENU_ITEM_PRICE_REGISTRY_SPEC.requiredEvidence.every(
        (e) => e.ownershipPolicy === "not_applicable",
      ),
    ).toBe(true);
  });

  it("the REGISTRY_SPECS row is the generated spec + the spliced owner posture, nothing else", () => {
    // Guards the adoption itself: the runtime row must be the GENERATED shape (so it
    // cannot drift from the source) with exactly ONE hand-added field — the BKL-270
    // ruling the compiler cannot honestly produce.
    expect(REGISTRY_SPECS.MENU_ITEM_PRICE).toEqual({
      ...MENU_ITEM_PRICE_REGISTRY_SPEC,
      dietaryPosture: "abstain",
    });
    expect(MENU_ITEM_PRICE_ID).toBe("MENU_ITEM_PRICE@1");
  });
});
