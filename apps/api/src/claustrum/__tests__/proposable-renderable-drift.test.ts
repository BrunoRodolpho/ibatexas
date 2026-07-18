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
// The gap today is TWO types, and the partition is BY DESIGN, not a bug —
// claim-definition-registry.ts:68-70 names the non-Triad public/action group. After
// BKL-121 graduated STORE_HOURS (it now carries a validated today's-hours template),
// the remaining gap splits into TWO kinds:
//
//   (i)  MENU_ITEM_ALLERGENS — a `read_claim`. A validated allergen read HAS a real
//        answer but no template, so it degrades to UNKNOWN. This is a correctness-
//        fidelity gap DECISION-GATED as BKL-123 (a renderer list-slot capability + an
//        owner liability policy are prerequisites; allergens are Hard-Rule-1 safety-
//        critical) — a separate focused effort, NOT done here.
//   (ii) PURCHASE_COMPLETED — an `action_claim`. Its customer-facing surface is
//        NOT the read-template grammar at all: action outcomes render via the
//        responder's SUCCESS_CLAIM_CLASSES path (ibatexas-responder.ts, the
//        `purchase-completed` class, justifiedBy ["order.checkout.create"]). It is
//        therefore DELIBERATELY + PERMANENTLY absent from VALIDATED_TEMPLATES —
//        it is NOT pending any read-template and must NOT be filed under BKL-121/-123.
//
// STORE_HOURS (graduated, BKL-121) is NOW renderable but is the ONE deliberate
// NON-Triad renderable type — see the RENDERABLE==triadScoped∪{STORE_HOURS} block.
//
// A FAILURE of the pin below is a DELIBERATE DECISION POINT, never a flake:
//   · gap GREW  → a new proposable type has no template. Either add its validated
//     template, or consciously extend the pin with a linked tracker id.
//   · gap SHRANK → a pinned type got a template (as BKL-121 did for STORE_HOURS).
//     Good — update the pin to remove it (and, if non-Triad, the triadScoped block).
// Adjust the pin as a conscious act; do not just re-sort it green.
//
// FE-T16 (FE-3.3) — this unit-test-only pin is now ALSO enforced as a REAL
// fail-closed BOOT gate: `claimsRenderDriftProblems` (claims-render-drift.ts),
// called from `claims-pipeline.ts` `buildClaimsSeams` whenever the claims
// pipeline is on, so a future proposable-but-unrenderable type fails BOOT, not
// merely CI. Both this test and the gate import the SAME
// `KNOWN_CUSTOMER_UNRENDERABLE_TYPES` constant (single-sourced) so the pin here
// and the gate's deliberate-exception list can never silently diverge — this
// test stays (belt and braces): a real boot gate is a fresh-process assertion, a
// fast unit test is the everyday drift signal.

import { describe, expect, it } from "vitest";
import { CLAIM_REGISTRY } from "../claim-registry.js";
import { CLAIM_DEFINITIONS } from "../claim-definition-registry.js";
import { KNOWN_CUSTOMER_UNRENDERABLE_TYPES } from "../claims-render-drift.js";
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
// BKL-121 SHRUNK this pin: STORE_HOURS graduated (it now has a validated template —
// the full read→evidence→falsifier→derive→template chain), so it is no longer in the
// gap. The remaining two are the by-design partition: MENU_ITEM_ALLERGENS (a
// read_claim pending BKL-123 — decision-gated on a renderer list-slot capability + an
// owner liability policy) and PURCHASE_COMPLETED (an action_claim rendered via the
// responder's SUCCESS_CLAIM_CLASSES path, DELIBERATELY + PERMANENTLY untemplated).
// Single-sourced from claims-render-drift.ts (FE-T16) — see the header note above.
const KNOWN_UNRENDERABLE = KNOWN_CUSTOMER_UNRENDERABLE_TYPES;

describe("BKL-112 — proposable ⊇ renderable: the known-unrenderable gap is pinned", () => {
  it("pins PROPOSABLE \\ RENDERABLE to exactly {MENU_ITEM_ALLERGENS, PURCHASE_COMPLETED}", () => {
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

// BKL-121 / BKL-138 — the schedule-cluster public reads STORE_HOURS and
// STORE_HOURS_FOR_DATE are the TWO deliberate NON-Triad renderable types. Each carries a
// validated hours template but is NOT Trustworthiness-Triad-scoped: both are PUBLIC
// (owned by nobody, like STORE_OPEN_NOW) yet intentionally left out of
// TRIAD_SCOPED_TYPES so their honest override/holiday UNKNOWN can never DEGRADE the
// live-proven STORE_OPEN_NOW answer (coupling them into STORE_OPEN_NOW_Q's required set
// would regress that path — see ibatexas-claim-planner.ts). So RENDERABLE == triadScoped
// ∪ {STORE_HOURS, STORE_HOURS_FOR_DATE}: the guard is EXTENDED (not deleted) to allow
// exactly these two deliberate additions; any OTHER divergence (a Triad type losing its
// template, or a THIRD non-Triad type gaining one) still trips CI as a decision point.
// BKL-142 EXTENDS the deliberate non-Triad renderable set with the PUBLIC menu reads
// MENU_ITEM_PRICE / MENU_ITEM_CONTENTS: each carries a validated pre-composed-scalar
// template but is `not_applicable`-ownership (public catalog, owned by nobody) and so
// intentionally OUT of TRIAD_SCOPED_TYPES — exactly like STORE_HOURS / STORE_HOURS_FOR_
// DATE. Any OTHER divergence still trips CI as a decision point.
const NON_TRIAD_RENDERABLE = [
  "STORE_HOURS",
  "STORE_HOURS_FOR_DATE",
  "MENU_ITEM_PRICE",
  "MENU_ITEM_CONTENTS",
] as const;

describe("BKL-112 — context: RENDERABLE == the triadScoped definitions ∪ the deliberate non-Triad public reads", () => {
  it("the renderable set equals exactly triadScoped ∪ the deliberate non-Triad types", () => {
    // Derived from the real exported CLAIM_DEFINITIONS.triadScoped flags, not
    // hardcoded — plus the BKL-121/-138/-142 non-Triad allowances. If any OTHER type
    // diverges, this documents it as the same deliberate decision point.
    const triadScoped = [...CLAIM_REGISTRY].filter(
      (type) => CLAIM_DEFINITIONS[type].triadScoped,
    );
    const expected = [...triadScoped, ...NON_TRIAD_RENDERABLE].sort();
    expect([...RENDERABLE].sort()).toEqual(expected);
    // POSITIVE controls: each is genuinely renderable AND genuinely NON-Triad (so the
    // extension is not vacuously masking a Triad-flag flip).
    expect(RENDERABLE.has("STORE_HOURS")).toBe(true);
    expect(CLAIM_DEFINITIONS.STORE_HOURS.triadScoped).toBe(false);
    expect(RENDERABLE.has("STORE_HOURS_FOR_DATE")).toBe(true);
    expect(CLAIM_DEFINITIONS.STORE_HOURS_FOR_DATE.triadScoped).toBe(false);
    expect(RENDERABLE.has("MENU_ITEM_PRICE")).toBe(true);
    expect(CLAIM_DEFINITIONS.MENU_ITEM_PRICE.triadScoped).toBe(false);
    expect(RENDERABLE.has("MENU_ITEM_CONTENTS")).toBe(true);
    expect(CLAIM_DEFINITIONS.MENU_ITEM_CONTENTS.triadScoped).toBe(false);
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
    // Simulate a FUTURE row (e.g. BKL-123) landing a template for MENU_ITEM_ALLERGENS
    // (a STILL-pinned type — STORE_HOURS already graduated under BKL-121).
    const withTemplate = new Set<string>([...RENDERABLE, "MENU_ITEM_ALLERGENS"]);
    const drifted = sortedDiff(CLAIM_REGISTRY, withTemplate);
    expect(drifted).not.toContain("MENU_ITEM_ALLERGENS");
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
