// proposable-renderable-drift — BKL-112, defense in depth (the BKL-096
// forbidden-verb-drift-test idiom applied to the claims registry).
//
// CONTRACT: the set of claim types the planner may PROPOSE (the closed
// `CLAIM_REGISTRY` enum — constrained generation, claim-registry.ts) is a
// SUPERSET of the set the renderer can RENDER as an asserting sentence (the
// `VALIDATED_TEMPLATES` keys — slot-grammar.ts). A proposable type with NO
// validated template can ONLY safe-degrade: renderer-from-claims.ts:355-364
// ABSTAINS a VALIDATED-but-untemplated claim to the proposition-free UNKNOWN
// template (never free-authoring prose — §O#3). So a proposable-but-unrenderable
// type is a CORRECTNESS-FIDELITY gap (a genuinely-validated claim dead-ends in
// UNKNOWN), not a soundness hole. This suite PINS the gap that exists today so a
// FUTURE proposable type added without a template — or a template added/removed
// for a pinned type — TRIPS CI and forces an explicit decision.
//
// The gap today is THREE types, and the partition is BY DESIGN, not a bug —
// claim-definition-registry.ts:68-70 names exactly this group: "the non-Triad
// public/action types (MENU_ITEM_ALLERGENS, STORE_HOURS, PURCHASE_COMPLETED) are
// deliberately NOT marked [triadScoped]". They split into TWO kinds of gap:
//
//   (i)  MENU_ITEM_ALLERGENS + STORE_HOURS — `read_claim`s. A validated allergen/
//        hours read HAS a real answer but no template, so it degrades to UNKNOWN.
//        This is a TEMPORARY correctness-fidelity gap PENDING their validated
//        read-templates (tracker BKL-121). Adding those templates is soundness-
//        sensitive registry growth (allergens are Hard-Rule-1 safety-critical),
//        so it is a separate focused effort — NOT done here.
//   (ii) PURCHASE_COMPLETED — an `action_claim`. Its customer-facing surface is
//        NOT the read-template grammar at all: action outcomes render via the
//        responder's SUCCESS_CLAIM_CLASSES path (ibatexas-responder.ts, the
//        `purchase-completed` class, justifiedBy ["order.checkout.create"]). It is
//        therefore DELIBERATELY + PERMANENTLY absent from VALIDATED_TEMPLATES —
//        it is NOT pending any read-template and must NOT be filed under BKL-121.
//
// A FAILURE of the pin below is a DELIBERATE DECISION POINT, never a flake:
//   · gap GREW  → a new proposable type has no template. Either add its validated
//     template, or consciously extend the pin with a linked tracker id.
//   · gap SHRANK → a pinned type got a template (e.g. BKL-121 landed for
//     STORE_HOURS). Good — update the pin to remove it.
// Adjust the pin as a conscious act; do not just re-sort it green.

import { describe, expect, it } from "vitest";
import { CLAIM_REGISTRY } from "../claim-registry.js";
import { CLAIM_DEFINITIONS } from "../claim-definition-registry.js";
import { VALIDATED_TEMPLATES } from "../slot-grammar.js";

// ── The two sets, computed from the ACTUAL exported source of truth (never a
//    hardcoded list — the whole point is to track drift in the real registry). ──

/** PROPOSABLE — every claim TYPE the constrained-generation planner may select. */
const PROPOSABLE: readonly string[] = [...CLAIM_REGISTRY];

/** RENDERABLE — every claim TYPE that has a `validated` (asserting) template. */
const RENDERABLE: ReadonlySet<string> = new Set(Object.keys(VALIDATED_TEMPLATES));

/** Sorted `a \ b` (set difference) as an array, for stable equality assertions. */
const sortedDiff = (a: readonly string[], b: ReadonlySet<string>): string[] =>
  [...a].filter((x) => !b.has(x)).sort();

/**
 * THE PIN — the proposable-but-unrenderable types that exist today (sorted). This
 * is the tested contract; see the split rationale in the header (BKL-112 / -121).
 * A literal on purpose: it is what pins reality so any drift in the computed
 * `PROPOSABLE \ RENDERABLE` breaks CI.
 */
const KNOWN_UNRENDERABLE = ["MENU_ITEM_ALLERGENS", "PURCHASE_COMPLETED", "STORE_HOURS"];

describe("BKL-112 — proposable ⊇ renderable: the known-unrenderable gap is pinned", () => {
  it("pins PROPOSABLE \\ RENDERABLE to exactly {MENU_ITEM_ALLERGENS, PURCHASE_COMPLETED, STORE_HOURS}", () => {
    // If this fails the gap MOVED — a deliberate decision point, not a flake:
    //   grew → a new proposable type lacks a template (add one, or extend the pin
    //     with a linked tracker id);
    //   shrank → a pinned type gained a template (e.g. BKL-121 for STORE_HOURS) —
    //     remove it from the pin.
    expect(sortedDiff(PROPOSABLE, RENDERABLE)).toEqual(KNOWN_UNRENDERABLE);
  });

  it("POSITIVE control: RENDERABLE is non-empty and every pinned type IS proposable", () => {
    // Without this, an empty template map would make the diff assertion pass on a
    // vacuously-huge gap. RENDERABLE must be a real, non-empty set.
    expect(RENDERABLE.size).toBeGreaterThan(0);
    // And each pinned type must actually be in the registry (else the pin is stale).
    const proposableSet = new Set<string>(PROPOSABLE);
    for (const type of KNOWN_UNRENDERABLE) {
      expect(proposableSet.has(type)).toBe(true);
    }
  });
});

describe("BKL-112 — RENDERABLE ⊆ PROPOSABLE: no dangling template", () => {
  it("every VALIDATED_TEMPLATES key is a registered proposable type", () => {
    // The inverse direction: a template keyed to a type ABSENT from CLAIM_REGISTRY
    // is the dangling-template shape the ClaimDefinition validator (INV-3) already
    // rejects — the exact ORDER_ESTIMATED_ARRIVAL state that was removed from
    // slot-grammar.ts. This asserts it structurally at the set level too.
    const proposableSet = new Set<string>(PROPOSABLE);
    for (const key of RENDERABLE) {
      expect(proposableSet.has(key)).toBe(true);
    }
    // POSITIVE control: the subtraction is real — there ARE renderable keys to check.
    expect([...RENDERABLE].length).toBeGreaterThan(0);
  });
});

describe("BKL-112 — context: RENDERABLE coincides with the triadScoped definitions today", () => {
  it("the renderable set equals exactly the triadScoped claim definitions", () => {
    // By-design partition (NOT a bug): the types that carry a validated template are
    // precisely the Trustworthiness-Triad live reads (STORE_OPEN_NOW,
    // ORDER_FULFILLMENT_STAGE, PAYMENT_STATUS); the non-Triad public/action types
    // carry none (claim-definition-registry.ts:68-70). Derived from the real
    // exported CLAIM_DEFINITIONS.triadScoped flags, not hardcoded — so if the two
    // sets ever diverge (a Triad type loses its template, or a non-Triad type gains
    // one) this documents that as the same deliberate decision point.
    const triadScoped = [...CLAIM_REGISTRY]
      .filter((type) => CLAIM_DEFINITIONS[type].triadScoped)
      .sort();
    expect([...RENDERABLE].sort()).toEqual(triadScoped);
  });
});

// ── Drift-guard positive controls: prove the pin is NON-VACUOUS — it actually
//    catches the two failure shapes it exists to catch (mirrors BKL-096's
//    "FLAGS a synthetic ..." tests). These operate on synthetic augmented sets;
//    they never touch the real registry/grammar. ──────────────────────────────

describe("BKL-112 — the drift guard catches gap growth and shrink", () => {
  it("FLAGS growth: a new proposable type with no template breaks the pin", () => {
    // Simulate a future proposable type added WITHOUT a validated template.
    const withNewType: readonly string[] = [...CLAIM_REGISTRY, "SYNTHETIC_NEW_TYPE"];
    const drifted = sortedDiff(withNewType, RENDERABLE);
    expect(drifted).toContain("SYNTHETIC_NEW_TYPE");
    // The pinned equality would FAIL (CI trips) → forces the decision.
    expect(drifted).not.toEqual(KNOWN_UNRENDERABLE);
  });

  it("FLAGS shrink: giving a pinned type a template removes it from the gap", () => {
    // Simulate BKL-121 landing a template for STORE_HOURS.
    const withTemplate = new Set<string>([...RENDERABLE, "STORE_HOURS"]);
    const drifted = sortedDiff(CLAIM_REGISTRY, withTemplate);
    expect(drifted).not.toContain("STORE_HOURS");
    // The pin would FAIL (CI trips) → forces updating the pin.
    expect(drifted).not.toEqual(KNOWN_UNRENDERABLE);
  });

  it("FLAGS a dangling template — a renderable type absent from the registry", () => {
    // Simulate re-introducing the removed ORDER_ESTIMATED_ARRIVAL dangling template.
    const danglingRenderable = new Set<string>([...RENDERABLE, "ORDER_ESTIMATED_ARRIVAL"]);
    const proposableSet = new Set<string>(CLAIM_REGISTRY);
    const dangling = [...danglingRenderable].filter((type) => !proposableSet.has(type));
    expect(dangling).toEqual(["ORDER_ESTIMATED_ARRIVAL"]);
  });
});
