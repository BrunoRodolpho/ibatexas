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
import {
  compileClaimDefinition,
  EvidenceLedger,
  runClaimsKernel,
  validateClaimDefinitions,
} from "@adjudicate/core";
import {
  assertClaimDefinitionRegistryValid,
  validateClaimDefinitionRegistry,
} from "../../claim-definition-registry.js";
import {
  CLAIM_REGISTRY,
  ownerScopedBaseKey,
  REGISTRY_SPECS,
  selectCandidateClaim,
} from "../../claim-registry.js";
import { publicPerItemBaseKey } from "../../classify-only-reads.js";
import {
  createPerTurnClaimsKernelDeps,
  OWNER_SCOPED_KEY_PREFIXES,
} from "../../ibatexas-claims-kernel-deps.js";
import { REQUIRED_CLAIM_CLOSURE } from "../../required-claim-decomposer.js";
import { CART_CONTENTS_SOURCE } from "../cart-contents.claim.js";
import * as cartContentsGenerated from "../cart-contents.generated.js";
import {
  CART_CONTENTS_CLOSURE,
  CART_CONTENTS_ID,
  CART_CONTENTS_REGISTRY_SPEC,
} from "../cart-contents.generated.js";
import { CART_EMPTY_SOURCE } from "../cart-empty.claim.js";
import * as cartEmptyGenerated from "../cart-empty.generated.js";
import { CART_EMPTY_ID, CART_EMPTY_REGISTRY_SPEC } from "../cart-empty.generated.js";
import { MENU_ITEM_PRICE_SOURCE } from "../menu-item-price.claim.js";
import {
  MENU_ITEM_PRICE_ID,
  MENU_ITEM_PRICE_REGISTRY_SPEC,
} from "../menu-item-price.generated.js";
import { ORDER_FULFILLMENT_STAGE_SOURCE } from "../order-fulfillment-stage.claim.js";
import {
  ORDER_FULFILLMENT_STAGE_ID,
  ORDER_FULFILLMENT_STAGE_REGISTRY_SPEC,
} from "../order-fulfillment-stage.generated.js";
import { ORDER_HISTORY_SOURCE } from "../order-history.claim.js";
import {
  ORDER_HISTORY_ID,
  ORDER_HISTORY_REGISTRY_SPEC,
} from "../order-history.generated.js";
import { PAYMENT_HISTORY_SOURCE } from "../payment-history.claim.js";
import {
  PAYMENT_HISTORY_ID,
  PAYMENT_HISTORY_REGISTRY_SPEC,
} from "../payment-history.generated.js";
import { PAYMENT_STATUS_SOURCE } from "../payment-status.claim.js";
import {
  PAYMENT_STATUS_ID,
  PAYMENT_STATUS_REGISTRY_SPEC,
} from "../payment-status.generated.js";
import { RESERVATION_STATUS_SOURCE } from "../reservation-status.claim.js";
import {
  RESERVATION_STATUS_ID,
  RESERVATION_STATUS_REGISTRY_SPEC,
} from "../reservation-status.generated.js";
// R2-S7 — STORE_OPEN_NOW is the OTHER member of the hand-written PICKUP_Q row, so the two-row
// INV-4 measurements need a real second definition to build a well-formed world with.
import { STORE_OPEN_NOW_SOURCE } from "../store-open-now.claim.js";
import {
  compilePerResourceClaimDefinition,
  FLAG_ANCHOR_FIELD,
  PER_RESOURCE_DOC_LINE,
  widenRegistrySpec,
} from "../per-resource-claim.js";

/** A fixed per-turn clock — every freshness window this file exercises is
 *  `must_read_this_turn` or a ttl far wider than one turn, so the value only needs to be
 *  stable, never realistic. */
const NOW = 1_780_000_000_000;

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

// ── R2-S4 — THE OWNERSHIP AXIS. ────────────────────────────────────────────────────
//
// R2-S2 proved the widening on a PUBLIC per-item type, where `ownerScopedBaseKey` is
// `undefined` and no C1 surface is in play. RESERVATION_STATUS is the first adoption on
// the other side of that complement, and the axis it exercises is silent in exactly the
// same way the flag is: `ownerScopedBaseKey` reads the BASE key of the FIRST
// `ownershipPolicy: "required"` evidence row off the SPEC. If a compiled spec dropped
// that policy, reordered the rows, or emitted a suffixed key, the derivation returns
// `undefined` (or the wrong base) — and then the claim planner treats an owner-scoped
// type as public: it stops re-resolving the subject from the authenticated owner-scoped
// reads and starts accepting the model's extraction, which is the IDOR this wiring
// exists to close. Nothing throws; `publicPerItemBaseKey` would simply start answering
// for a customer-scoped type.
const OWNER_BASE_KEY = "reservation_status";
const OWNER_FALSIFIER_KEY = "reservation_cancelled";

describe("R2-S4 — the generated spec preserves the OWNERSHIP axis", () => {
  it("ownershipPolicy: required survives the compile, on evidence AND falsifiers", () => {
    // The published `toRegistrySpec` projects `requiredEvidence` VERBATIM (whole rows,
    // by reference), which is WHY this axis needed no second widening — but "by
    // construction" is only worth asserting if something would notice a regression.
    expect(RESERVATION_STATUS_REGISTRY_SPEC.requiredEvidence.map((e) => e.ownershipPolicy)).toEqual(
      ["required"],
    );
    expect(RESERVATION_STATUS_REGISTRY_SPEC.falsifiers.map((f) => f.ownershipPolicy)).toEqual([
      "required",
    ]);
    // WHY the axis needs no widening, asserted at the seam where it is true: in the
    // COMPILER's output the spec's evidence array IS the source's array (reference
    // identity — `toRegistrySpec` does `requiredEvidence: def.requiredEvidence`, not a
    // field-by-field rebuild), so there is no copy step in which `ownershipPolicy` could
    // be dropped the way `perResourceKey` is.
    const compiled = compilePerResourceClaimDefinition(RESERVATION_STATUS_SOURCE);
    expect(compiled.registrySpec.requiredEvidence).toBe(
      RESERVATION_STATUS_SOURCE.requiredEvidence,
    );
    expect(compiled.registrySpec.falsifiers).toBe(RESERVATION_STATUS_SOURCE.falsifiers);
    // The EMITTED module is a re-serialization of that object, so reference identity
    // cannot survive the file boundary — byte-identity (the drift guard) is what carries
    // it there. Deep equality is the strongest statement available on this side, and it
    // is what proves the serializer did not silently narrow a row.
    expect(RESERVATION_STATUS_REGISTRY_SPEC.requiredEvidence).toEqual(
      RESERVATION_STATUS_SOURCE.requiredEvidence,
    );
    expect(RESERVATION_STATUS_REGISTRY_SPEC.falsifiers).toEqual(
      RESERVATION_STATUS_SOURCE.falsifiers,
    );
  });

  it("ownerScopedBaseKey resolves the BASE key off the generated spec", () => {
    expect(ownerScopedBaseKey("RESERVATION_STATUS")).toBe(OWNER_BASE_KEY);
    // The base key must be UNSUFFIXED — `ownerScopedBaseKey` feeds
    // `ownedResourceIdsByBaseKey`, which strips a `${base}:` prefix off ledger keys. A
    // pre-suffixed base would make every present owner-scoped read unmatchable, so the
    // planner would find NO admissible subject and the legit owner would get UNKNOWN.
    expect(OWNER_BASE_KEY).not.toContain(":");
    // …and the JOIN to the ledger half: the derived base must be a DECLARED owner-scope
    // prefix, or a present read never attributes ownership at all.
    expect(OWNER_SCOPED_KEY_PREFIXES).toContain(`${OWNER_BASE_KEY}:`);
  });

  it("publicPerItemBaseKey stays undefined — the complement holds after adoption", () => {
    // Exactly one of the two is defined for any per-resource type. This is the assertion
    // that would catch a lost `ownershipPolicy`: `publicPerItemBaseKey` returns
    // `requiredEvidence[0].key` for ANY perResourceKey type whose rows are all
    // `not_applicable`, so a dropped policy flips this from `undefined` to
    // `"reservation_status"` — a customer-scoped type silently answering as public.
    expect(publicPerItemBaseKey("RESERVATION_STATUS")).toBeUndefined();
    expect(REGISTRY_SPECS.RESERVATION_STATUS.customerScoped).toBe(true);
  });

  it("the two derivations stay EXHAUSTIVE and DISJOINT over all 11 per-resource types", () => {
    // The property the pair is supposed to have, quantified rather than spot-checked —
    // so a future adoption cannot satisfy its own case while breaking the invariant.
    const perResource = CLAIM_REGISTRY.filter(
      (t) => (REGISTRY_SPECS[t] as { perResourceKey?: boolean }).perResourceKey === true,
    );
    expect(perResource).toHaveLength(11);
    for (const type of perResource) {
      const owner = ownerScopedBaseKey(type);
      const publicItem = publicPerItemBaseKey(type);
      // Exactly one defined (XOR), never both, never neither.
      expect([owner, publicItem].filter((v) => v !== undefined)).toHaveLength(1);
      // And the one that IS defined agrees with the spec's own ownership rows.
      const anyRequired = REGISTRY_SPECS[type].requiredEvidence.some(
        (e) => e.ownershipPolicy === "required",
      );
      expect(owner !== undefined).toBe(anyRequired);
    }
    // A type with NO perResourceKey is outside both derivations regardless of ownership —
    // PURCHASE_COMPLETED is customer-scoped with `required` evidence and must still be
    // `undefined` on both, or the planner would try to suffix an unparameterized key.
    expect(ownerScopedBaseKey("PURCHASE_COMPLETED")).toBeUndefined();
    expect(publicPerItemBaseKey("PURCHASE_COMPLETED")).toBeUndefined();
  });

  it("selectCandidateClaim suffixes the owner-scoped keys AND derives the C1 resource binding", () => {
    const candidate = selectCandidateClaim({
      type: "RESERVATION_STATUS",
      subject: "res_42",
      actor: { principal: "cus_1" },
      value: undefined,
    });
    expect(candidate).toBeDefined();
    const s = candidate!.soundness;
    expect(s.requiredEvidence.map((e) => e.key)).toEqual([`${OWNER_BASE_KEY}:res_42`]);
    expect(s.falsifiers?.map((f) => f.key)).toEqual([`${OWNER_FALSIFIER_KEY}:res_42`]);
    expect(s.valueBinding?.key).toBe(`${OWNER_BASE_KEY}:res_42`);
    // C6 structural guard (the kernel hard-throws otherwise).
    expect(s.requiredEvidence.map((e) => e.key)).toContain(s.valueBinding?.key);
    // fix 2 — the owner-attribution C1 binding, keyed by each SUFFIXED `required` key.
    // This is derived FROM the `ownershipPolicy: "required"` filter, so it is the second
    // consumer that silently degrades if the policy is lost: with no binding,
    // `claim.resources?.[key]` is undefined and the kernel REFUSES ownership even for
    // the legitimate owner (the pre-fix-2 defect).
    expect(s.resources).toEqual({ [`${OWNER_BASE_KEY}:res_42`]: "res_42" });
  });

  it("the REGISTRY_SPECS row is the generated spec + the spliced owner posture, nothing else", () => {
    expect(REGISTRY_SPECS.RESERVATION_STATUS).toEqual({
      ...RESERVATION_STATUS_REGISTRY_SPEC,
      dietaryPosture: "answer-anyway",
    });
    expect(RESERVATION_STATUS_ID).toBe("RESERVATION_STATUS@1");
    // triadScoped is source-declared on this one (the first generated `true`), and it is
    // NOT a registry-spec field — so it must NOT have leaked into the spec row.
    expect("triadScoped" in REGISTRY_SPECS.RESERVATION_STATUS).toBe(false);
  });

  // THE C1 CONJUNCT ITSELF, non-vacuously. This is the assertion the ownership-axis
  // revert-to-red probe (source `ownershipPolicy: "required"` → `"not_applicable"`, then
  // REGENERATE) has to move, and getting it to move requires care: the pre-existing
  // IDOR case in `../../__tests__/reservation-status-claim.test.ts` ("present value but
  // owns=false → not VALIDATED") does NOT move, because its candidate value is
  // `{ status: "confirmed" }` while the C6 binding is `["statusLine"]` — the claim fails
  // the VALUE-BINDING conjunct before ownership is ever reached, so it stays green with
  // the ownership enforcement deleted. It is the access-class vacuity shape: a negative
  // test that names one wall and is actually held up by another.
  //
  // The fix is a CONTROL/TREATMENT pair over one correctly-bound value. The owns=TRUE arm
  // must VALIDATE, which proves C6/freshness/integrity/provenance are all satisfied and
  // therefore cannot be what fails the owns=FALSE arm. The two arms differ in exactly one
  // input: whether the resource is in `ownedResources`.
  it("C1 is the ONLY difference between a VALIDATED owner and a REFUSED non-owner", () => {
    const RES_ID = "res_c1_probe";
    const SUFFIXED = `${OWNER_BASE_KEY}:${RES_ID}`;
    const STATUS_LINE = "confirmada — 20/07 às 19:30, para 4 pessoas";

    const candidate = selectCandidateClaim({
      type: "RESERVATION_STATUS",
      subject: RES_ID,
      actor: "cus_owner",
      // Bound to the C6 path the GENERATED spec declares, so value-binding PASSES and
      // ownership is the live conjunct. Deriving the key from the spec (rather than
      // hardcoding it) is what keeps this aligned if the binding ever moves.
      value: { statusLine: STATUS_LINE },
    })!;

    const ledgerFor = (): EvidenceLedger => {
      const l = new EvidenceLedger("turn-c1");
      l.record({
        key: SUFFIXED,
        value: { reservationId: RES_ID, status: "confirmed", partySize: 4, statusLine: STATUS_LINE },
        source: "reservation.getById",
        fetchedAt: NOW,
        sourceMode: "live",
        taint: "TRUSTED",
        originProvenance: "FIRST_PARTY",
      });
      return l;
    };
    const depsWith = (owned: readonly string[]) =>
      createPerTurnClaimsKernelDeps({
        now: NOW,
        ownership: { principal: "cus_owner", ownedResources: new Set(owned) },
        outcomes: [],
      });

    // CONTROL — the legitimate owner. MUST validate, or the treatment arm proves nothing.
    const owner = runClaimsKernel(ledgerFor(), [candidate], depsWith([RES_ID]));
    expect(owner.perClaim[0]?.verdict).toBe("VALIDATED");
    expect(owner.renderable).toHaveLength(1);

    // TREATMENT — identical ledger, identical candidate, identical value; the resource is
    // simply not owned. "No owner" ≠ "any owner" (Inv 2).
    const nonOwner = runClaimsKernel(ledgerFor(), [candidate], depsWith(["res_someone_else"]));
    expect(nonOwner.perClaim[0]?.verdict).not.toBe("VALIDATED");
    expect(nonOwner.renderable).toHaveLength(0);

    // And the wall is reached through the GENERATED spec's own row, not a hand-built one:
    // neuter that row to `not_applicable` and the C1 conjunct stops applying, at which
    // point the treatment arm validates and this case goes red.
    expect(
      candidate.soundness.requiredEvidence.map((e) => e.ownershipPolicy),
    ).toEqual(["required"]);
  });

  it("the PUBLISHED compiler on the SAME source still drops only perResourceKey", () => {
    // The R2-S2 control, re-run on an OWNER-SCOPED source: the published projection must
    // differ from the widened one in EXACTLY the flag — which is what proves the
    // ownership rows are the published compiler's own output and not something the
    // repo-local wrapper is quietly supplying.
    const published = compileClaimDefinition(RESERVATION_STATUS_SOURCE);
    expect("perResourceKey" in published.registrySpec).toBe(false);
    expect({ ...published.registrySpec, perResourceKey: true }).toEqual(
      RESERVATION_STATUS_REGISTRY_SPEC,
    );
    expect(published.registrySpec.requiredEvidence.map((e) => e.ownershipPolicy)).toEqual([
      "required",
    ]);
  });
});

// ── R2-S5 — THE HISTORIES PAIR: the owner-scoped axis, quantified over BOTH. ──────────
//
// R2-S4 proved the ownership axis on ONE type. Written as a per-type table so the two
// histories cannot diverge and so neither can pass on its sibling's evidence — the shape
// R2-S1 established with `describe.each` over UNITS and the reason the reference-identity
// table upstairs is a table too.
//
// WHAT IS NEW HERE relative to RESERVATION_STATUS, and why it needs its own assertions:
// these two types' SUBJECT is the AUTHENTICATED customerId, not a resource id. There is
// exactly ONE history per customer, so the `:{subject}` suffix partitions the ledger BY
// CUSTOMER rather than by resource — which means a dropped `perResourceKey` flag does not
// merely fail to find one entry, it COLLAPSES EVERY CUSTOMER'S HISTORY ONTO ONE BARE KEY.
// That is the cross-customer leak shape, and it is why the turn-seam proof for these two
// drives two distinct customers rather than two resources of one owner.
const HISTORY_CASES = [
  {
    type: "ORDER_HISTORY",
    source: ORDER_HISTORY_SOURCE,
    spec: ORDER_HISTORY_REGISTRY_SPEC,
    id: ORDER_HISTORY_ID,
    baseKey: "order_history",
    falsifierKey: "order_history_changed",
    spanClass: "ORDER_HISTORY_Q",
    armCount: 3,
  },
  {
    type: "PAYMENT_HISTORY",
    source: PAYMENT_HISTORY_SOURCE,
    spec: PAYMENT_HISTORY_REGISTRY_SPEC,
    id: PAYMENT_HISTORY_ID,
    baseKey: "payment_history",
    falsifierKey: "payment_history_changed",
    spanClass: "PAYMENT_HISTORY_Q",
    armCount: 2,
  },
] as const;

describe.each(HISTORY_CASES)(
  "R2-S5 — the generated $type spec preserves the OWNERSHIP axis",
  ({ type, source, spec, id, baseKey, falsifierKey, armCount }) => {
    it("ownershipPolicy: required survives the compile, on evidence AND falsifiers", () => {
      expect(spec.requiredEvidence.map((e) => e.ownershipPolicy)).toEqual(["required"]);
      expect(spec.falsifiers.map((f) => f.ownershipPolicy)).toEqual(["required"]);
      // The R2-S4 mechanism assertion, re-made per type: in the COMPILER's output the
      // spec's evidence array IS the source's array (`toRegistrySpec` does
      // `requiredEvidence: def.requiredEvidence`, not a field-by-field rebuild), so there
      // is no copy step in which `ownershipPolicy` could be dropped the way
      // `perResourceKey` is. This is what makes "no second widening needed" a measured
      // fact rather than an inference from the published type.
      const compiled = compilePerResourceClaimDefinition(source);
      expect(compiled.registrySpec.requiredEvidence).toBe(source.requiredEvidence);
      expect(compiled.registrySpec.falsifiers).toBe(source.falsifiers);
      // Reference identity cannot survive the file boundary (the emitted module is a
      // re-serialization), so deep equality is the strongest statement on this side and
      // byte-identity via the drift guard carries it the rest of the way.
      expect(spec.requiredEvidence).toEqual(source.requiredEvidence);
      expect(spec.falsifiers).toEqual(source.falsifiers);
    });

    it("ownerScopedBaseKey resolves the UNSUFFIXED base key, joined to a DECLARED ledger prefix", () => {
      expect(ownerScopedBaseKey(type)).toBe(baseKey);
      // An unsuffixed base is load-bearing: `ownerScopedBaseKey` feeds
      // `ownedResourceIdsByBaseKey`, which strips a `${base}:` prefix off ledger keys, so
      // a pre-suffixed base makes every present owner-scoped read unmatchable and the
      // legitimate owner gets UNKNOWN.
      expect(baseKey).not.toContain(":");
      expect(OWNER_SCOPED_KEY_PREFIXES).toContain(`${baseKey}:`);
    });

    it("publicPerItemBaseKey stays undefined — the complement holds after adoption", () => {
      // The assertion that catches a lost `ownershipPolicy`: `publicPerItemBaseKey`
      // answers for ANY perResourceKey type whose rows are all `not_applicable`, so a
      // dropped policy flips this from `undefined` to the base key — a customer-scoped
      // type silently answering as public, which is the IDOR-reopening shape.
      expect(publicPerItemBaseKey(type)).toBeUndefined();
      expect(REGISTRY_SPECS[type].customerScoped).toBe(true);
      expect((REGISTRY_SPECS[type] as { perResourceKey?: boolean }).perResourceKey).toBe(true);
    });

    it("selectCandidateClaim suffixes by CUSTOMER id AND derives the C1 resource binding", () => {
      const candidate = selectCandidateClaim({
        type,
        subject: "cus_owner_1",
        actor: { principal: "cus_owner_1" },
        value: undefined,
      });
      expect(candidate).toBeDefined();
      const s = candidate!.soundness;
      expect(s.requiredEvidence.map((e) => e.key)).toEqual([`${baseKey}:cus_owner_1`]);
      expect(s.falsifiers?.map((f) => f.key)).toEqual([`${falsifierKey}:cus_owner_1`]);
      expect(s.valueBinding?.key).toBe(`${baseKey}:cus_owner_1`);
      // C6 structural guard (the kernel hard-throws otherwise).
      expect(s.requiredEvidence.map((e) => e.key)).toContain(s.valueBinding?.key);
      // fix 2 — the C1 binding, keyed by each SUFFIXED `required` key. Derived FROM the
      // `ownershipPolicy: "required"` filter, so it is the second consumer that silently
      // degrades if the policy is lost: with no binding the kernel REFUSES ownership even
      // for the legitimate owner.
      expect(s.resources).toEqual({ [`${baseKey}:cus_owner_1`]: "cus_owner_1" });
    });

    it("TWO customers get DISJOINT suffixed keys — the per-customer partition", () => {
      // The failure this pins is specific to a customerId-subjected type: a dropped flag
      // leaves BOTH customers resolving the SAME bare key, so whichever history was read
      // last answers for everyone. Two candidates, every key distinct.
      const a = selectCandidateClaim({
        type,
        subject: "cus_a",
        actor: { principal: "cus_a" },
        value: undefined,
      })!;
      const b = selectCandidateClaim({
        type,
        subject: "cus_b",
        actor: { principal: "cus_b" },
        value: undefined,
      })!;
      expect(a.soundness.requiredEvidence[0]!.key).toBe(`${baseKey}:cus_a`);
      expect(b.soundness.requiredEvidence[0]!.key).toBe(`${baseKey}:cus_b`);
      expect(a.soundness.requiredEvidence[0]!.key).not.toBe(b.soundness.requiredEvidence[0]!.key);
      expect(a.soundness.valueBinding?.key).not.toBe(b.soundness.valueBinding?.key);
      // …and neither is the BARE key, which is what a dropped flag would produce for both.
      for (const c of [a, b]) {
        expect(c.soundness.requiredEvidence[0]!.key).not.toBe(baseKey);
      }
    });

    it("the REGISTRY_SPECS row is the generated spec + the spliced owner posture, nothing else", () => {
      expect(REGISTRY_SPECS[type]).toEqual({ ...spec, dietaryPosture: "answer-anyway" });
      expect(id).toBe(`${type}@1`);
      // triadScoped is source-declared and is NOT a registry-spec field — it must not
      // have leaked into the spec row.
      expect("triadScoped" in REGISTRY_SPECS[type]).toBe(false);
    });

    it("C1 is the ONLY difference between a VALIDATED owner and a REFUSED non-owner", () => {
      // The R2-S4 CONTROL/TREATMENT pair, per type. The owns=TRUE arm must VALIDATE,
      // which proves C6/freshness/integrity/provenance are all satisfied and therefore
      // cannot be what fails the owns=FALSE arm — without that control this is the
      // access-class vacuity shape (a negative held up by a different wall than the one
      // it names).
      const CUST = "cus_c1_probe";
      const SUFFIXED = `${baseKey}:${CUST}`;
      const SUMMARY = "Pedido #1042 (entregue, R$89,00) — mostrando os 1 mais recentes";

      const candidate = selectCandidateClaim({
        type,
        subject: CUST,
        actor: CUST,
        // Bound to the C6 path the GENERATED spec declares, so value-binding PASSES and
        // ownership is the live conjunct.
        value: { historySummaryText: SUMMARY },
      })!;

      const ledgerFor = (): EvidenceLedger => {
        const l = new EvidenceLedger("turn-c1-history");
        l.record({
          key: SUFFIXED,
          value: { historySummaryText: SUMMARY },
          source: "history.listByCustomer",
          fetchedAt: NOW,
          sourceMode: "live",
          taint: "TRUSTED",
          originProvenance: "FIRST_PARTY",
        });
        return l;
      };
      const depsWith = (owned: readonly string[]) =>
        createPerTurnClaimsKernelDeps({
          now: NOW,
          ownership: { principal: CUST, ownedResources: new Set(owned) },
          outcomes: [],
        });

      // CONTROL — the legitimate owner. MUST validate, or the treatment proves nothing.
      const owner = runClaimsKernel(ledgerFor(), [candidate], depsWith([CUST]));
      expect(owner.perClaim[0]?.verdict).toBe("VALIDATED");
      expect(owner.renderable).toHaveLength(1);

      // TREATMENT — identical ledger, identical candidate, identical value; the resource
      // is simply not owned. "No owner" ≠ "any owner" (Inv 2).
      const nonOwner = runClaimsKernel(ledgerFor(), [candidate], depsWith(["cus_someone_else"]));
      expect(nonOwner.perClaim[0]?.verdict).not.toBe("VALIDATED");
      expect(nonOwner.renderable).toHaveLength(0);

      // And the wall is reached through the GENERATED spec's own row.
      expect(candidate.soundness.requiredEvidence.map((e) => e.ownershipPolicy)).toEqual([
        "required",
      ]);
    });

    it("the PUBLISHED compiler on the SAME source still drops only perResourceKey", () => {
      const published = compileClaimDefinition(source);
      expect("perResourceKey" in published.registrySpec).toBe(false);
      expect({ ...published.registrySpec, perResourceKey: true }).toEqual(spec);
      expect(published.registrySpec.requiredEvidence.map((e) => e.ownershipPolicy)).toEqual([
        "required",
      ]);
    });

    it("the compiled closure contributes its OWN span class and required set, and NOTHING about the splice", () => {
      // The SPLICE FINDING, asserted rather than only argued: a def source's closure
      // contribution is `spanClass` + `requires` + `markers` — three fields, none of
      // which can express "remove ORDER_STATUS_Q from the accumulated list". So the
      // sequencing half provably CANNOT live here, which is why it stays hand-written in
      // `classifyRequestSpans` and why the two halves compose without either constraining
      // the other.
      const compiled = compilePerResourceClaimDefinition(source);
      expect(compiled.closure).toBeDefined();
      expect(Object.keys(compiled.closure!).sort()).toEqual([
        "markers",
        "requires",
        "spanClass",
      ]);
      expect(compiled.closure!.requires).toEqual([type]);
      expect(compiled.closure!.markers).toHaveLength(armCount);
    });
  },
);

// The two histories are STRUCTURALLY IDENTICAL on every compiler-modelled facet except
// the marker arm count — asserted directly, because that sameness is the whole argument
// for migrating them as ONE slice, and because a future edit that made one of them
// diverge (a raised integrity floor, a second falsifier, a changed freshness policy)
// should have to say so here rather than pass silently under a per-type table.
it("R2-S5 — the two history specs differ ONLY in their key names and marker arms", () => {
  const normalize = (spec: typeof ORDER_HISTORY_REGISTRY_SPEC | typeof PAYMENT_HISTORY_REGISTRY_SPEC) =>
    JSON.parse(
      JSON.stringify(spec).replace(/(order|payment)_history/g, "HISTORY"),
    ) as unknown;
  expect(normalize(ORDER_HISTORY_REGISTRY_SPEC)).toEqual(
    normalize(PAYMENT_HISTORY_REGISTRY_SPEC),
  );
  // …and the ONE modelled facet where they legitimately differ, pinned so the sameness
  // assertion above cannot be read as "the two nets are interchangeable".
  expect(ORDER_HISTORY_SOURCE.decomposition.markers).toHaveLength(3);
  expect(PAYMENT_HISTORY_SOURCE.decomposition.markers).toHaveLength(2);
});

// ── R2-S6 — THE CART PRESENCE-COMPLEMENT PAIR: one closure row, two sources. ───────────
//
// The ownership axis itself is the R2-S4/R2-S5 axis and is quantified over both members by
// the table below, exactly as the histories were. What is NEW — and what has no precedent in
// the five prior slices — is that the two share ONE §O#15 closure row. The design (declared
// by the SPAN-OWNING source; the twin declares none; agreement enforced by the EXISTING
// generic INV-4, fail-closed, both directions) is argued in `../cart-contents.claim.ts`'s
// header; every claim that header makes about the MACHINERY is measured here.
const CART_CASES = [
  {
    type: "CART_CONTENTS",
    source: CART_CONTENTS_SOURCE,
    spec: CART_CONTENTS_REGISTRY_SPEC,
    id: CART_CONTENTS_ID,
    baseKey: "cart_contents",
    falsifierKey: "cart_cleared",
    field: "itemsSummaryText",
    posture: "answer-with-abstention",
  },
  {
    type: "CART_EMPTY",
    source: CART_EMPTY_SOURCE,
    spec: CART_EMPTY_REGISTRY_SPEC,
    id: CART_EMPTY_ID,
    baseKey: "cart_empty",
    falsifierKey: "cart_item_added",
    field: "emptinessText",
    posture: "answer-anyway",
  },
] as const;

describe.each(CART_CASES)(
  "R2-S6 — the generated $type spec preserves the OWNERSHIP axis",
  ({ type, source, spec, id, baseKey, falsifierKey, field, posture }) => {
    it("ownershipPolicy: required survives the compile, on evidence AND falsifiers", () => {
      expect(spec.requiredEvidence.map((e) => e.ownershipPolicy)).toEqual(["required"]);
      expect(spec.falsifiers.map((f) => f.ownershipPolicy)).toEqual(["required"]);
      const compiled = compilePerResourceClaimDefinition(source);
      expect(compiled.registrySpec.requiredEvidence).toBe(source.requiredEvidence);
      expect(compiled.registrySpec.falsifiers).toBe(source.falsifiers);
      expect(spec.requiredEvidence).toEqual(source.requiredEvidence);
      expect(spec.falsifiers).toEqual(source.falsifiers);
    });

    it("ownerScopedBaseKey resolves the UNSUFFIXED base key, joined to a DECLARED ledger prefix", () => {
      expect(ownerScopedBaseKey(type)).toBe(baseKey);
      expect(baseKey).not.toContain(":");
      expect(OWNER_SCOPED_KEY_PREFIXES).toContain(`${baseKey}:`);
    });

    it("publicPerItemBaseKey stays undefined — the complement holds after adoption", () => {
      expect(publicPerItemBaseKey(type)).toBeUndefined();
      expect(REGISTRY_SPECS[type].customerScoped).toBe(true);
      expect((REGISTRY_SPECS[type] as { perResourceKey?: boolean }).perResourceKey).toBe(true);
    });

    it("selectCandidateClaim suffixes by CUSTOMER id AND derives the C1 resource binding", () => {
      const candidate = selectCandidateClaim({
        type,
        subject: "cus_owner_1",
        actor: { principal: "cus_owner_1" },
        value: undefined,
      });
      expect(candidate).toBeDefined();
      const s = candidate!.soundness;
      expect(s.requiredEvidence.map((e) => e.key)).toEqual([`${baseKey}:cus_owner_1`]);
      expect(s.falsifiers?.map((f) => f.key)).toEqual([`${falsifierKey}:cus_owner_1`]);
      expect(s.valueBinding?.key).toBe(`${baseKey}:cus_owner_1`);
      expect(s.requiredEvidence.map((e) => e.key)).toContain(s.valueBinding?.key);
      expect(s.resources).toEqual({ [`${baseKey}:cus_owner_1`]: "cus_owner_1" });
    });

    it("TWO customers get DISJOINT suffixed keys — the per-customer partition", () => {
      // The cart's subject is the AUTHENTICATED customerId (one cart per customer), the
      // ORDER_HISTORY shape: a dropped flag leaves BOTH customers resolving the same bare
      // key, so whichever cart was read last answers for everyone.
      const a = selectCandidateClaim({
        type,
        subject: "cus_a",
        actor: { principal: "cus_a" },
        value: undefined,
      })!;
      const b = selectCandidateClaim({
        type,
        subject: "cus_b",
        actor: { principal: "cus_b" },
        value: undefined,
      })!;
      expect(a.soundness.requiredEvidence[0]!.key).toBe(`${baseKey}:cus_a`);
      expect(b.soundness.requiredEvidence[0]!.key).toBe(`${baseKey}:cus_b`);
      expect(a.soundness.valueBinding?.key).not.toBe(b.soundness.valueBinding?.key);
      for (const c of [a, b]) {
        expect(c.soundness.requiredEvidence[0]!.key).not.toBe(baseKey);
      }
    });

    it("the REGISTRY_SPECS row is the generated spec + the spliced owner posture, nothing else", () => {
      expect(REGISTRY_SPECS[type]).toEqual({ ...spec, dietaryPosture: posture });
      expect(id).toBe(`${type}@1`);
      expect("triadScoped" in REGISTRY_SPECS[type]).toBe(false);
      // The posture is NOT in the generated half — the split the `GeneratedReadClaimSpec`
      // type exists to enforce, re-measured on the pair that takes two DIFFERENT values.
      expect("dietaryPosture" in spec).toBe(false);
    });

    it("C1 is the ONLY difference between a VALIDATED owner and a REFUSED non-owner", () => {
      const CUST = "cus_c1_cart_probe";
      const SUFFIXED = `${baseKey}:${CUST}`;
      // Bound to the C6 path the GENERATED spec declares, so value-binding PASSES and
      // ownership is the live conjunct. Per-type, since the pair's C6 FIELDS differ.
      const VALUE = { [field]: "2x Costela — total R$123,00" };

      const candidate = selectCandidateClaim({
        type,
        subject: CUST,
        actor: CUST,
        value: VALUE,
      })!;

      const ledgerFor = (): EvidenceLedger => {
        const l = new EvidenceLedger("turn-c1-cart");
        l.record({
          key: SUFFIXED,
          value: VALUE,
          source: "cart.readCartContents",
          fetchedAt: NOW,
          sourceMode: "live",
          taint: "TRUSTED",
          originProvenance: "FIRST_PARTY",
        });
        return l;
      };
      const depsWith = (owned: readonly string[]) =>
        createPerTurnClaimsKernelDeps({
          now: NOW,
          ownership: { principal: CUST, ownedResources: new Set(owned) },
          outcomes: [],
        });

      // CONTROL — the legitimate owner. MUST validate, or the treatment proves nothing.
      const owner = runClaimsKernel(ledgerFor(), [candidate], depsWith([CUST]));
      expect(owner.perClaim[0]?.verdict).toBe("VALIDATED");
      expect(owner.renderable).toHaveLength(1);

      // TREATMENT — identical ledger, candidate and value; the resource is simply not owned.
      const nonOwner = runClaimsKernel(ledgerFor(), [candidate], depsWith(["cus_someone_else"]));
      expect(nonOwner.perClaim[0]?.verdict).not.toBe("VALIDATED");
      expect(nonOwner.renderable).toHaveLength(0);

      expect(candidate.soundness.requiredEvidence.map((e) => e.ownershipPolicy)).toEqual([
        "required",
      ]);
    });

    it("the PUBLISHED compiler on the SAME source still drops only perResourceKey", () => {
      const published = compileClaimDefinition(source);
      expect("perResourceKey" in published.registrySpec).toBe(false);
      expect({ ...published.registrySpec, perResourceKey: true }).toEqual(spec);
      expect(published.registrySpec.requiredEvidence.map((e) => e.ownershipPolicy)).toEqual([
        "required",
      ]);
    });
  },
);

// ── THE SHARED CLOSURE ROW — the facet with no precedent (R2-S6). ──────────────────────
describe("R2-S6 — the SHARED closure row lives on the SPAN-OWNING source", () => {
  it("the published `requires` is NOT self-referential and is passed through BY REFERENCE", () => {
    // THE MEASUREMENT THE WHOLE DESIGN RESTS ON. If `toClosure` rebuilt the array, or if the
    // published schema constrained `requires` to the def's own type, the two-type row would
    // need a repo-local widening the way `perResourceKey` did. It does neither — so
    // `per-resource-claim.ts` is UNCHANGED by this slice, and that is a measured fact rather
    // than an inference from the published type declaration.
    const compiled = compilePerResourceClaimDefinition(CART_CONTENTS_SOURCE);
    expect(compiled.closure!.requires).toBe(CART_CONTENTS_SOURCE.decomposition.requires);
    expect(compiled.closure!.requires).toEqual(["CART_CONTENTS", "CART_EMPTY"]);
    // …and the PUBLISHED compiler carries it identically: the shared row owes nothing to the
    // repo-local wrapper.
    expect(compileClaimDefinition(CART_CONTENTS_SOURCE).closure!.requires).toEqual([
      "CART_CONTENTS",
      "CART_EMPTY",
    ]);
  });

  it("the twin contributes NO closure at all, and emits no closure export", () => {
    const compiled = compilePerResourceClaimDefinition(CART_EMPTY_SOURCE);
    expect(compiled.closure).toBeUndefined();
    expect("decomposition" in CART_EMPTY_SOURCE).toBe(false);
    // The generated module for a closure-less unit must not even declare the export (the
    // emitter's conditional block) — otherwise a consumer could splice a blank row.
    expect(Object.keys(cartEmptyGenerated)).not.toContain("CART_EMPTY_CLOSURE");
    expect(Object.keys(cartContentsGenerated)).toContain("CART_CONTENTS_CLOSURE");
  });

  it("the LIVE closure table row IS the generated one, and requires the whole pair", () => {
    expect(REQUIRED_CLAIM_CLOSURE.CART_CONTENTS_Q).toBe(CART_CONTENTS_CLOSURE.requires);
    expect(REQUIRED_CLAIM_CLOSURE.CART_CONTENTS_Q).toEqual(["CART_CONTENTS", "CART_EMPTY"]);
  });

  it("INV-4 REFUSES a de-synced pair in BOTH directions (the agreement check, fail-closed)", () => {
    // WHY THIS IS THE AGREEMENT CHECK AND NO NEW FACILITY IS NEEDED. The pair's only
    // structural obligation is "the shared row names both members". Break it either way and
    // the EXISTING generic INV-4 — the one `assertClaimDefinitionRegistryValid` already runs
    // fail-closed at claims-pipeline boot — rejects the whole registry. A bespoke symmetry
    // check would be a second mechanism guarding an unreachable state.
    const contents = compilePerResourceClaimDefinition(CART_CONTENTS_SOURCE);
    const empty = compilePerResourceClaimDefinition(CART_EMPTY_SOURCE);

    // CONTROL — the real pair validates as a cluster. Without it both treatments below
    // could be failing for a reason unrelated to the row.
    const world = (
      rows: Readonly<Record<string, readonly string[]>>,
      types: readonly string[],
    ) =>
      validateClaimDefinitions(
        {
          CART_CONTENTS: contents.definition,
          CART_EMPTY: empty.definition,
        },
        {
          templates: {
            CART_CONTENTS: contents.renderTemplate,
            CART_EMPTY: empty.renderTemplate,
          },
          closures: rows,
          registryEnum: types,
        },
      );
    expect(
      world({ CART_CONTENTS_Q: ["CART_CONTENTS", "CART_EMPTY"] }, ["CART_CONTENTS", "CART_EMPTY"]),
    ).toEqual({ ok: true });

    // TREATMENT 1 — the owner's row loses the twin (the FORWARD direction: a Triad-scoped
    // type in no closure value).
    const forward = world({ CART_CONTENTS_Q: ["CART_CONTENTS"] }, [
      "CART_CONTENTS",
      "CART_EMPTY",
    ]);
    expect(forward.ok).toBe(false);
    if (!forward.ok) {
      expect(forward.code).toBe("DECOMPOSITION_UNREACHABLE");
      expect(forward.reason).toContain("CART_EMPTY");
    }

    // TREATMENT 2 — the twin loses its registration while the row still names it (the
    // REVERSE direction: a closure-referenced type with no registered ClaimDefinition).
    const reverse = validateClaimDefinitions(
      { CART_CONTENTS: contents.definition },
      {
        templates: { CART_CONTENTS: contents.renderTemplate },
        closures: { CART_CONTENTS_Q: ["CART_CONTENTS", "CART_EMPTY"] },
        registryEnum: ["CART_CONTENTS"],
      },
    );
    expect(reverse.ok).toBe(false);
    if (!reverse.ok) {
      expect(reverse.code).toBe("DECOMPOSITION_UNREACHABLE");
      expect(reverse.reason).toContain("CART_EMPTY");
    }
  });

  // ── R2-S7 — INV-4 WITH TWO ROWS NAMING ONE TYPE (the brief's entanglement 1) ────────
  //
  // R2-S6's rule leaves PICKUP_Q hand-written, so ORDER_FULFILLMENT_STAGE is named by a
  // GENERATED row AND a hand-written one. Two things had to be MEASURED rather than inferred,
  // and they do not point the same way — which is why both are pinned here.
  it("R2-S7 — INV-4 stays GREEN with a generated row and a hand-written row naming one type", () => {
    const order = compilePerResourceClaimDefinition(ORDER_FULFILLMENT_STAGE_SOURCE);
    const openNow = compileClaimDefinition(STORE_OPEN_NOW_SOURCE);
    const world = (rows: Readonly<Record<string, readonly string[]>>) =>
      validateClaimDefinitions(
        {
          ORDER_FULFILLMENT_STAGE: order.definition,
          STORE_OPEN_NOW: openNow.definition,
        },
        {
          templates: {
            ORDER_FULFILLMENT_STAGE: order.renderTemplate,
            STORE_OPEN_NOW: openNow.renderTemplate,
          },
          closures: rows,
          registryEnum: ["ORDER_FULFILLMENT_STAGE", "STORE_OPEN_NOW"],
        },
      );

    // The REAL two-row shape: the generated self-only row PLUS the hand-written PICKUP_Q.
    // Nothing about a generated row sitting beside a hand-written one is treated specially.
    expect(
      world({
        ORDER_STATUS_Q: ["ORDER_FULFILLMENT_STAGE"],
        STORE_OPEN_NOW_Q: ["STORE_OPEN_NOW"],
        PICKUP_Q: ["STORE_OPEN_NOW", "ORDER_FULFILLMENT_STAGE"],
      }),
    ).toEqual({ ok: true });
  });

  it("R2-S7 — the FORWARD direction is MASKED for the two-row type, and NOT for its sibling", () => {
    // THE MEASUREMENT THAT DIFFERS FROM R2-S6, recorded because a future reader debugging an
    // INV-4 failure will otherwise assume the cart pair's behaviour generalizes.
    //
    // The forward check accumulates `closureTypes` across ALL rows before testing any def, so a
    // Triad-scoped type named by TWO rows is reachable through EITHER. Dropping it from ONE row
    // therefore does NOT fail — the guarantee CART_EMPTY gets from the shared row does not
    // extend to ORDER_FULFILLMENT_STAGE, and pretending otherwise would be a comment asserting
    // a safety property the measurement denies.
    const order = compilePerResourceClaimDefinition(ORDER_FULFILLMENT_STAGE_SOURCE);
    const openNow = compileClaimDefinition(STORE_OPEN_NOW_SOURCE);
    const world = (rows: Readonly<Record<string, readonly string[]>>) =>
      validateClaimDefinitions(
        {
          ORDER_FULFILLMENT_STAGE: order.definition,
          STORE_OPEN_NOW: openNow.definition,
        },
        {
          templates: {
            ORDER_FULFILLMENT_STAGE: order.renderTemplate,
            STORE_OPEN_NOW: openNow.renderTemplate,
          },
          closures: rows,
          registryEnum: ["ORDER_FULFILLMENT_STAGE", "STORE_OPEN_NOW"],
        },
      );

    // MASKED: the generated row stops naming the type, PICKUP_Q still does → GREEN.
    expect(
      world({
        ORDER_STATUS_Q: ["STORE_OPEN_NOW"],
        PICKUP_Q: ["STORE_OPEN_NOW", "ORDER_FULFILLMENT_STAGE"],
      }),
    ).toEqual({ ok: true });

    // UNMASKED: with BOTH rows silent the forward direction fires, so the check itself is not
    // broken — it is the redundancy that hides a single-row de-sync.
    const both = world({ ORDER_STATUS_Q: ["STORE_OPEN_NOW"], PICKUP_Q: ["STORE_OPEN_NOW"] });
    expect(both.ok).toBe(false);
    if (!both.ok) {
      expect(both.code).toBe("DECOMPOSITION_UNREACHABLE");
      expect(both.reason).toContain("ORDER_FULFILLMENT_STAGE");
    }

    // THE CONTRAST — the sibling has ONE row, so for PAYMENT_STATUS the forward direction is a
    // live de-sync detector exactly as it is for every R2-S1..R2-S5 type. Same treatment shape,
    // opposite outcome, which is what makes the masking a property of the ROW COUNT rather than
    // of adoption.
    const payment = compilePerResourceClaimDefinition(PAYMENT_STATUS_SOURCE);
    const paymentWorld = (rows: Readonly<Record<string, readonly string[]>>) =>
      validateClaimDefinitions(
        { PAYMENT_STATUS: payment.definition, STORE_OPEN_NOW: openNow.definition },
        {
          templates: {
            PAYMENT_STATUS: payment.renderTemplate,
            STORE_OPEN_NOW: openNow.renderTemplate,
          },
          closures: rows,
          registryEnum: ["PAYMENT_STATUS", "STORE_OPEN_NOW"],
        },
      );
    // Control: the real row validates.
    expect(
      paymentWorld({ PAYMENT_STATUS_Q: ["PAYMENT_STATUS"], STORE_OPEN_NOW_Q: ["STORE_OPEN_NOW"] }),
    ).toEqual({ ok: true });
    // Treatment: its ONE row stops naming it → the forward direction fires immediately.
    const paymentDesync = paymentWorld({ PAYMENT_STATUS_Q: ["STORE_OPEN_NOW"] });
    expect(paymentDesync.ok).toBe(false);
    if (!paymentDesync.ok) {
      expect(paymentDesync.code).toBe("DECOMPOSITION_UNREACHABLE");
      expect(paymentDesync.reason).toContain("PAYMENT_STATUS");
    }

    // The REVERSE direction still covers the hand-written row for BOTH types: a PICKUP_Q that
    // named an unregistered type is rejected, which is what keeps the hand-written row honest.
    const reverse = validateClaimDefinitions(
      { STORE_OPEN_NOW: openNow.definition },
      {
        templates: { STORE_OPEN_NOW: openNow.renderTemplate },
        closures: { PICKUP_Q: ["STORE_OPEN_NOW", "ORDER_FULFILLMENT_STAGE"] },
        registryEnum: ["STORE_OPEN_NOW"],
      },
    );
    expect(reverse.ok).toBe(false);
    if (!reverse.ok) {
      expect(reverse.code).toBe("DECOMPOSITION_UNREACHABLE");
      expect(reverse.reason).toContain("ORDER_FULFILLMENT_STAGE");
    }
  });

  it("the REAL boot validator accepts the real registry with the shared row", () => {
    // The end of the chain: the two treatments above are synthetic worlds; this is the
    // function `claims-pipeline.ts` calls, over the REAL 23-type registry and the REAL
    // cross-tables, with the generated shared row in place.
    expect(validateClaimDefinitionRegistry()).toEqual({ ok: true });
    expect(() => assertClaimDefinitionRegistryValid()).not.toThrow();
  });
});

// The pair is STRUCTURALLY IDENTICAL on every compiler-modelled facet except the key names,
// the C6 field, the render literals and the closure ownership — asserted directly, because
// that sameness is the argument for migrating them as ONE slice, and because a future edit
// that diverged one of them (a raised floor, a second falsifier, a changed freshness policy)
// should have to say so here rather than pass silently under a per-type table.
it("R2-S6 — the two cart specs differ ONLY in their key names and C6 field", () => {
  const normalize = (spec: unknown) =>
    JSON.parse(
      JSON.stringify(spec)
        .replace(/cart_contents|cart_empty/g, "CART")
        .replace(/cart_cleared|cart_item_added/g, "CART_FALSIFIER")
        .replace(/itemsSummaryText|emptinessText/g, "CART_FIELD"),
    ) as unknown;
  expect(normalize(CART_CONTENTS_REGISTRY_SPEC)).toEqual(normalize(CART_EMPTY_REGISTRY_SPEC));
  // …and the facets where they legitimately differ, pinned so the sameness assertion cannot
  // be read as "the two rows are interchangeable": the POSTURE (an owner ruling — this is
  // the registry's only `answer-with-abstention` row) and the CLOSURE OWNERSHIP.
  expect(REGISTRY_SPECS.CART_CONTENTS.dietaryPosture).toBe("answer-with-abstention");
  expect(REGISTRY_SPECS.CART_EMPTY.dietaryPosture).toBe("answer-anyway");
  expect(
    CLAIM_REGISTRY.filter(
      (t) =>
        (REGISTRY_SPECS[t] as { dietaryPosture?: string }).dietaryPosture ===
        "answer-with-abstention",
    ),
  ).toEqual(["CART_CONTENTS"]);
});

// ── R2-S7 — THE STATUS SIBLINGS: the ownership axis, quantified over BOTH. ─────────────
//
// The R2-S4/R2-S5 table shape, re-run on the two status types. Their SUBJECT is the ORDER id
// (the RESERVATION_STATUS shape, not the histories' customerId), so the discrimination axis
// that matters is TWO RESOURCES OF ONE OWNER — asserted below at the kernel seam and at the
// turn seam in `../../__tests__/r2s7-status-siblings-claims.e2e.test.ts`.
const STATUS_CASES = [
  {
    type: "ORDER_FULFILLMENT_STAGE",
    source: ORDER_FULFILLMENT_STAGE_SOURCE,
    spec: ORDER_FULFILLMENT_STAGE_REGISTRY_SPEC,
    id: ORDER_FULFILLMENT_STAGE_ID,
    baseKey: "order_fulfillment_stage",
    falsifierKeys: ["order_cancelled"],
    boundField: "fulfillmentStatus",
    floor: "structured",
    provenance: "preserve",
    spanClass: "ORDER_STATUS_Q",
    armCount: 8,
  },
  {
    type: "PAYMENT_STATUS",
    source: PAYMENT_STATUS_SOURCE,
    spec: PAYMENT_STATUS_REGISTRY_SPEC,
    id: PAYMENT_STATUS_ID,
    baseKey: "payment_status",
    // THE FIRST TWO-FALSIFIER TYPE in the adopted corpus.
    falsifierKeys: ["payment_refund", "payment_chargeback"],
    boundField: "status",
    // THE FIRST non-`structured` FLOOR and the FIRST `first_party_only` PROVENANCE.
    floor: "first_party_verified",
    provenance: "first_party_only",
    spanClass: "PAYMENT_STATUS_Q",
    armCount: 5,
  },
] as const;

describe.each(STATUS_CASES)(
  "R2-S7 — the generated $type spec preserves the OWNERSHIP axis",
  ({ type, source, spec, id, baseKey, falsifierKeys, boundField, floor, provenance, spanClass, armCount }) => {
    it("ownershipPolicy: required survives the compile, on evidence AND every falsifier", () => {
      expect(spec.requiredEvidence.map((e) => e.ownershipPolicy)).toEqual(["required"]);
      expect(spec.falsifiers.map((f) => f.ownershipPolicy)).toEqual(
        falsifierKeys.map(() => "required"),
      );
      // The R2-S4 mechanism assertion, re-made per type: in the COMPILER's output the spec's
      // evidence array IS the source's array (`toRegistrySpec` does `requiredEvidence:
      // def.requiredEvidence`, not a field-by-field rebuild), so there is no copy step in
      // which any per-row policy could be dropped the way `perResourceKey` is.
      const compiled = compilePerResourceClaimDefinition(source);
      expect(compiled.registrySpec.requiredEvidence).toBe(source.requiredEvidence);
      expect(compiled.registrySpec.falsifiers).toBe(source.falsifiers);
      expect(spec.requiredEvidence).toEqual(source.requiredEvidence);
      expect(spec.falsifiers).toEqual(source.falsifiers);
    });

    // ── THE THREE REGISTRY FIRSTS, asserted PER FIELD (the brief's entanglement 3) ─────
    //
    // R2-S4 proved the reference-pass argument for `ownershipPolicy`. These are the three
    // facets no prior source carried, each checked against the PUBLISHED projection rather
    // than assumed to extend: a dropped or reshaped floor/provenance/falsifier-row is a
    // SILENT weakening of the §5 predicate on the MONEY read.
    it("the INTEGRITY FLOOR survives the compile as the declared scalar", () => {
      expect(spec.minSourceIntegrity).toBe(floor);
      expect(source.minSourceIntegrity).toBe(floor);
      // Projected as a plain scalar, so the assertion that matters is that the published
      // compiler — not the repo-local wrapper — is what carries it.
      expect(compileClaimDefinition(source).registrySpec.minSourceIntegrity).toBe(floor);
      // …and it reaches the object the BOOT VALIDATOR quantifies over, which is a different
      // artifact from the registry spec.
      expect(compilePerResourceClaimDefinition(source).definition.minSourceIntegrity).toBe(
        floor,
      );
      // Every evidence row must MEET its own type's floor, or the claim can never validate.
      for (const e of spec.requiredEvidence) expect(e.sourceIntegrity).toBe(floor);
    });

    it("the PROVENANCE POLICY survives on EVERY row (evidence + falsifiers)", () => {
      // C3 is a SEPARATE axis from the C2 floor above (origin trust vs evidence quality), so
      // it is asserted separately even though both happen to be uniform per type here.
      expect(spec.requiredEvidence.map((e) => e.provenancePolicy)).toEqual([provenance]);
      expect(spec.falsifiers.map((f) => f.provenancePolicy)).toEqual(
        falsifierKeys.map(() => provenance),
      );
      // Through the PUBLISHED compiler, on both artifacts.
      const published = compileClaimDefinition(source);
      expect(published.registrySpec.requiredEvidence.map((e) => e.provenancePolicy)).toEqual([
        provenance,
      ]);
      expect(published.definition.requiredEvidence.map((e) => e.provenancePolicy)).toEqual([
        provenance,
      ]);
    });

    it("the FALSIFIER SET survives at full ARITY, in order, keys intact", () => {
      // The two-row set is the registry first. `toRegistrySpec` spreads the whole tuple by
      // reference with no arity assumption — asserted by identity above; asserted here by
      // KEYS AND ORDER, which is what a re-materializing projection would disturb.
      expect(spec.falsifierComplete).toBe(true);
      expect(spec.falsifiers.map((f) => f.key)).toEqual(falsifierKeys);
      expect(compileClaimDefinition(source).registrySpec.falsifiers?.map((f) => f.key)).toEqual(
        falsifierKeys,
      );
      // The boot-validated definition carries them too (INV-2 quantifies over this array).
      expect(
        compilePerResourceClaimDefinition(source).definition.falsifiers?.map((f) => f.key),
      ).toEqual(falsifierKeys);
      // Every falsifier is `must_read_this_turn` — a cached falsifier could not demote a live
      // base read.
      for (const f of spec.falsifiers) expect(f.freshnessPolicy).toBe("must_read_this_turn");
    });

    it("ownerScopedBaseKey resolves the UNSUFFIXED base key, joined to a DECLARED ledger prefix", () => {
      expect(ownerScopedBaseKey(type)).toBe(baseKey);
      expect(baseKey).not.toContain(":");
      expect(OWNER_SCOPED_KEY_PREFIXES).toContain(`${baseKey}:`);
    });

    it("publicPerItemBaseKey stays undefined — the complement holds after adoption", () => {
      expect(publicPerItemBaseKey(type)).toBeUndefined();
      expect(REGISTRY_SPECS[type].customerScoped).toBe(true);
      expect((REGISTRY_SPECS[type] as { perResourceKey?: boolean }).perResourceKey).toBe(true);
    });

    it("selectCandidateClaim suffixes EVERY key by the ORDER id AND derives the C1 binding", () => {
      const candidate = selectCandidateClaim({
        type,
        subject: "ord_42",
        actor: { principal: "cus_owner" },
        value: undefined,
      });
      expect(candidate).toBeDefined();
      const s = candidate!.soundness;
      expect(s.requiredEvidence.map((e) => e.key)).toEqual([`${baseKey}:ord_42`]);
      // The arity point again, this time at the RUNTIME seam: BOTH falsifier keys must be
      // suffixed, in lockstep. A parameterizer that suffixed only `falsifiers[0]` would leave
      // the chargeback arm resolving a bare key that is never present — a falsifier that can
      // never fire, i.e. a silently WEAKER §5 predicate on the money read.
      expect(s.falsifiers?.map((f) => f.key)).toEqual(
        falsifierKeys.map((k) => `${k}:ord_42`),
      );
      expect(s.valueBinding?.key).toBe(`${baseKey}:ord_42`);
      expect(s.requiredEvidence.map((e) => e.key)).toContain(s.valueBinding?.key);
      expect(s.resources).toEqual({ [`${baseKey}:ord_42`]: "ord_42" });
    });

    it("TWO ORDERS of ONE owner get DISJOINT suffixed keys — the discrimination axis", () => {
      // The failure this pins is specific to an order-subjected type: a dropped flag leaves
      // BOTH of one customer's orders resolving the SAME bare key, so whichever order was read
      // last answers for both — the customer is told about the wrong order, with correct-looking
      // provenance. Two candidates, same actor, every key distinct.
      const a = selectCandidateClaim({
        type,
        subject: "ord_a",
        actor: { principal: "cus_owner" },
        value: undefined,
      })!;
      const b = selectCandidateClaim({
        type,
        subject: "ord_b",
        actor: { principal: "cus_owner" },
        value: undefined,
      })!;
      expect(a.soundness.requiredEvidence[0]!.key).toBe(`${baseKey}:ord_a`);
      expect(b.soundness.requiredEvidence[0]!.key).toBe(`${baseKey}:ord_b`);
      expect(a.soundness.valueBinding?.key).not.toBe(b.soundness.valueBinding?.key);
      expect(a.soundness.resources).not.toEqual(b.soundness.resources);
      // …and each falsifier partitions too (the two-row case again).
      expect(a.soundness.falsifiers?.map((f) => f.key)).not.toEqual(
        b.soundness.falsifiers?.map((f) => f.key),
      );
    });

    it("the REGISTRY_SPECS row is the generated spec + the spliced owner posture, nothing else", () => {
      expect(REGISTRY_SPECS[type]).toEqual({ ...spec, dietaryPosture: "answer-anyway" });
      expect(id).toBe(`${type}@1`);
      // triadScoped is source-declared and is NOT a registry-spec field — it must not leak.
      expect("triadScoped" in REGISTRY_SPECS[type]).toBe(false);
    });

    it("the compiled closure is SELF-ONLY and the LIVE table row IS it", () => {
      const closure = compilePerResourceClaimDefinition(source).closure!;
      expect(closure.spanClass).toBe(spanClass);
      expect(closure.requires).toEqual([type]);
      // Passed through BY REFERENCE (the R2-S6 mechanism), so the row cannot be edited at the
      // table without editing the source.
      expect(closure.requires).toBe(source.decomposition.requires);
      expect(closure.markers).toBe(source.decomposition.markers);
      expect(closure.markers).toHaveLength(armCount);
      expect(
        (REQUIRED_CLAIM_CLOSURE as Record<string, readonly string[]>)[spanClass],
      ).toEqual([type]);
    });

    it("C1 is the ONLY difference between a VALIDATED owner and a REFUSED non-owner", () => {
      // The control/treatment pair R2-S4 established, on the status row. The CONTROL must
      // VALIDATE, which proves C6/freshness/integrity/provenance are all satisfied and
      // therefore cannot be what fails the treatment arm.
      const ORD = "ord_c1_probe";
      const SUFFIXED = `${baseKey}:${ORD}`;
      const VALUE = "paid_or_ready";

      const candidate = selectCandidateClaim({
        type,
        subject: ORD,
        actor: "cus_owner",
        value: { [boundField]: VALUE },
      })!;

      const ledgerFor = (): EvidenceLedger => {
        const l = new EvidenceLedger("turn-c1-status");
        l.record({
          key: SUFFIXED,
          value: { [boundField]: VALUE, orderId: ORD },
          source: "order.getById",
          fetchedAt: NOW,
          sourceMode: "live",
          taint: "TRUSTED",
          // FIRST_PARTY is required for PAYMENT_STATUS's `first_party_only` conjunct and
          // acceptable for the ORDER type's `preserve` — so one ledger serves both arms and
          // the ONLY varying input stays ownership.
          originProvenance: "FIRST_PARTY",
        });
        return l;
      };
      const depsWith = (owned: readonly string[]) =>
        createPerTurnClaimsKernelDeps({
          now: NOW,
          ownership: { principal: "cus_owner", ownedResources: new Set(owned) },
          outcomes: [],
        });

      const owner = runClaimsKernel(ledgerFor(), [candidate], depsWith([ORD]));
      expect(owner.perClaim[0]?.verdict).toBe("VALIDATED");
      expect(owner.renderable).toHaveLength(1);

      const nonOwner = runClaimsKernel(ledgerFor(), [candidate], depsWith(["ord_someone_else"]));
      expect(nonOwner.perClaim[0]?.verdict).not.toBe("VALIDATED");
      expect(nonOwner.renderable).toHaveLength(0);

      expect(candidate.soundness.requiredEvidence.map((e) => e.ownershipPolicy)).toEqual([
        "required",
      ]);
    });

    it("the PUBLISHED compiler on the SAME source still drops only perResourceKey", () => {
      // The R2-S2 control, re-run here — and it is what proves the three registry firsts above
      // are the PUBLISHED compiler's own output rather than something the repo-local wrapper
      // is quietly supplying.
      const published = compileClaimDefinition(source);
      expect("perResourceKey" in published.registrySpec).toBe(false);
      expect({ ...published.registrySpec, perResourceKey: true }).toEqual(spec);
    });
  },
);

// THE `first_party_only` CONJUNCT ITSELF, non-vacuously — the one registry first that is a
// RUNTIME wall rather than a projected field, so a reference-identity assertion cannot reach
// it. Control/treatment over ONE correctly-bound, correctly-owned, fresh value: the arms differ
// in exactly the ledger entry's `originProvenance`.
//
// WHY THIS IS NOT SKIPPABLE: every other assertion in this file would stay green if the
// published kernel stopped enforcing C3, and so would the whole apps/api suite — the policy is
// only ever a string on a row until something makes a TRUSTED_THIRD_PARTY origin fail.
it("R2-S7 — first_party_only REFUSES a TRUSTED_THIRD_PARTY origin the money read must not accept", () => {
  const ORD = "ord_fp_probe";
  const SUFFIXED = `payment_status:${ORD}`;
  const candidate = selectCandidateClaim({
    type: "PAYMENT_STATUS",
    subject: ORD,
    actor: "cus_owner",
    value: { status: "paid" },
  })!;
  const ledgerWith = (origin: "FIRST_PARTY" | "TRUSTED_THIRD_PARTY"): EvidenceLedger => {
    const l = new EvidenceLedger("turn-fp");
    l.record({
      key: SUFFIXED,
      value: { status: "paid", orderId: ORD },
      source: "payment.getByOrder",
      fetchedAt: NOW,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: origin,
    });
    return l;
  };
  const deps = () =>
    createPerTurnClaimsKernelDeps({
      now: NOW,
      ownership: { principal: "cus_owner", ownedResources: new Set([ORD]) },
      outcomes: [],
    });

  // CONTROL — a first-party origin VALIDATES, so nothing else can be what fails the treatment.
  const firstParty = runClaimsKernel(ledgerWith("FIRST_PARTY"), [candidate], deps());
  expect(firstParty.perClaim[0]?.verdict).toBe("VALIDATED");

  // TREATMENT — a TRUSTED THIRD PARTY is *trusted* (it is not UNTRUSTED_DATA) and would satisfy
  // `preserve`. It must still fail here: a PSP echo is not a first-party money fact (Inv 3).
  const thirdParty = runClaimsKernel(ledgerWith("TRUSTED_THIRD_PARTY"), [candidate], deps());
  expect(thirdParty.perClaim[0]?.verdict).not.toBe("VALIDATED");
  expect(thirdParty.renderable).toHaveLength(0);

  // The wall is reached through the GENERATED spec's own rows — neuter the source to
  // `preserve`, regenerate, and the treatment arm validates.
  expect(candidate.soundness.requiredEvidence.map((e) => e.provenancePolicy)).toEqual([
    "first_party_only",
  ]);
  // …and the ORDER sibling is the contrast that keeps this from reading as a global rule:
  // `preserve` is what its rows declare, and the registry is not uniform.
  expect(
    ORDER_FULFILLMENT_STAGE_REGISTRY_SPEC.requiredEvidence.map((e) => e.provenancePolicy),
  ).toEqual(["preserve"]);
});

// The status siblings are NOT structural twins the way the cart pair is — and unlike that pair,
// the DIFFERENCES are the interesting part, so they are pinned directly rather than normalized
// away. A future edit that homogenized them (raising the ORDER floor to match, or dropping a
// PAYMENT falsifier) should have to say so here.
it("R2-S7 — the two status specs differ in exactly the four declared facets", () => {
  expect([
    ORDER_FULFILLMENT_STAGE_REGISTRY_SPEC.minSourceIntegrity,
    PAYMENT_STATUS_REGISTRY_SPEC.minSourceIntegrity,
  ]).toEqual(["structured", "first_party_verified"]);
  expect([
    ORDER_FULFILLMENT_STAGE_REGISTRY_SPEC.falsifiers.length,
    PAYMENT_STATUS_REGISTRY_SPEC.falsifiers.length,
  ]).toEqual([1, 2]);
  expect([
    ORDER_FULFILLMENT_STAGE_REGISTRY_SPEC.requiredEvidence[0]!.provenancePolicy,
    PAYMENT_STATUS_REGISTRY_SPEC.requiredEvidence[0]!.provenancePolicy,
  ]).toEqual(["preserve", "first_party_only"]);
  expect([
    ORDER_FULFILLMENT_STAGE_REGISTRY_SPEC.valueBinding.path,
    PAYMENT_STATUS_REGISTRY_SPEC.valueBinding.path,
  ]).toEqual([["fulfillmentStatus"], ["status"]]);
  // Everything else about them IS the same shape, which is why one slice adopts both.
  for (const spec of [ORDER_FULFILLMENT_STAGE_REGISTRY_SPEC, PAYMENT_STATUS_REGISTRY_SPEC]) {
    expect(spec.kind).toBe("read_claim");
    expect(spec.customerScoped).toBe(true);
    expect(spec.perResourceKey).toBe(true);
    expect(spec.falsifierComplete).toBe(true);
    expect(spec.requiredEvidence[0]!.freshnessPolicy).toBe("must_read_this_turn");
    expect(spec.requiredEvidence[0]!.ownershipPolicy).toBe("required");
  }
});

// PAYMENT_STATUS is the only registry type whose floor is not `structured`/`trusted_service`,
// and ORDER_FULFILLMENT_STAGE + PAYMENT_STATUS are the only two types named by more than one
// closure row between them. Both are quantified over the WHOLE registry rather than spot-checked,
// so a future adoption cannot satisfy its own case while moving one of these properties.
it("R2-S7 — the money floor and the two-row situation are registry-wide facts", () => {
  expect(
    CLAIM_REGISTRY.filter(
      (t) => REGISTRY_SPECS[t].minSourceIntegrity === "first_party_verified",
    ),
  ).toEqual(["PAYMENT_STATUS"]);
  const rowCount = (type: string) =>
    Object.values(REQUIRED_CLAIM_CLOSURE).filter((v) =>
      (v as readonly string[]).includes(type),
    ).length;
  // The masking fact, quantified: exactly TWO types are named by 2+ rows, and both are
  // reachable through the hand-written PICKUP_Q worked example.
  expect(CLAIM_REGISTRY.filter((t) => rowCount(t) > 1).sort()).toEqual([
    "ORDER_FULFILLMENT_STAGE",
    "STORE_OPEN_NOW",
  ]);
  expect(rowCount("PAYMENT_STATUS")).toBe(1);
});
