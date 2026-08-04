/**
 * R7 — CROSS-PATH SUBJECT PARITY (the parity-by-comment hazard, converted to a test).
 *
 * The registry's 3-class subject taxonomy (owner-scoped per-resource / public
 * per-item / fixed-subject) is dispositioned in more than one home. Two of them
 * frame a candidate for the SAME turn depending only on which route the turn took:
 *
 *   - the CLASSIFY-ONLY route — `buildClassifyOnlyCandidates` (classify-only-reads.ts),
 *     taken when `classifyOnlyRequiredTypes` classifies the turn WHOLESALE into
 *     `CLASSIFY_ONLY_ELIGIBLE_TYPES` and `ENABLE_CLASSIFY_ONLY_READS` is on;
 *   - the MODEL route — the FIX 1 (actor) + FIX 2 (subject) resolution inside
 *     `proposeClaims` (ibatexas-planner.ts), taken for every other turn.
 *
 * `buildClassifyOnlyCandidates`'s own doc comment asserts it "Mirrors
 * `ibatexas-planner.ts`'s FIX 1 (actor) + FIX 2 (subject) resolution EXACTLY, minus
 * the 'honor the model's subject if it happens to name an owned resource' branch".
 * Until this file, that contract was stated ONLY in that comment and pinned by NO
 * test: `fe-t18-classify-only-reads.test.ts` drives the classify-only route with a
 * COUNTING SPY standing in for `proposeClaims` (it asserts the model call was or was
 * not made, never what the model route would have derived), and
 * `tracka-fix-actor-subject.test.ts` drives the model route alone. Neither compares
 * the two.
 *
 * This file drives BOTH REAL routes on IDENTICAL inputs. It pins parity where the
 * contract holds, and CHARACTERIZES the two places where it has already drifted, so
 * neither can widen silently and closing either forces the record
 * (`docs/architecture/design/r7-candidate-assembly.md`) to be updated with it.
 *
 * Deliberately NOT a merge of the assemblers — see that record for the measured
 * reason (their shared predicates are already shared; what differs is disposition
 * policy, and the model route has no `EvidenceLedger` in scope at all).
 *
 * Pure unit tests — a hand-built `ModelProvider` mock + a real `EvidenceLedger`;
 * the menu resolvers are mocked so no catalog/network read is attempted.
 */

import { describe, expect, it, vi } from "vitest";
import { EvidenceLedger } from "@adjudicate/core";
import type { CognitiveState, Completion, ModelProvider } from "@claustrum/core";
import type { ResolvedMenuItem } from "../menu-item-resolver.js";

// The menu family's in-planner subject branch calls the SHARED resolver; mock it so
// this file makes no catalog read. `resolveMenuItem` returning a real item is what
// lets the MENU_ITEM_* assertions below prove the branch OVERRIDES the model subject
// (rather than merely dropping the proposal, which a `undefined` return would do).
const RESOLVED_ITEM: ResolvedMenuItem = {
  id: "prod_1",
  title: "Costela Defumada",
  price: 8900,
  description: "Costela bovina defumada 12h.",
  categoryHandle: "carnes",
  inStock: true,
};
vi.mock("../menu-item-resolver.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../menu-item-resolver.js")>();
  return {
    ...orig,
    resolveMenuItem: vi.fn(async () => RESOLVED_ITEM),
    resolveMenuOverviewText: vi.fn(async () => undefined),
    resolveDietaryOptionsText: vi.fn(async () => undefined),
  };
});

const { buildClassifyOnlyCandidates, publicPerItemBaseKey } = await import(
  "../classify-only-reads.js"
);
const { createIbatexasPlanner, PROPOSE_CLAIM_TOOL } = await import("../ibatexas-planner.js");
type ClaimAuthContext = import("../ibatexas-planner.js").ClaimAuthContext;
const { REGISTRY_SPECS, ownerScopedBaseKey } = await import("../claim-registry.js");
type RegistryClaimType = import("../claim-registry.js").RegistryClaimType;

const NOW = 10_000;
const ALL_TYPES = Object.keys(REGISTRY_SPECS) as RegistryClaimType[];

// ── doubles ───────────────────────────────────────────────────────────────────

function mockModel(toolCalls: Completion["toolCalls"]): ModelProvider {
  return {
    async complete(): Promise<Completion> {
      return {
        model: "mock",
        stopReason: "tool_use",
        text: "",
        toolCalls,
        inputTokens: 1,
        outputTokens: 1,
      };
    },
    stream() {
      throw new Error("not used");
    },
    async embed() {
      return [];
    },
  };
}

function state(text: string): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-06-29T00:00:00.000Z" },
    memory: {} as CognitiveState["memory"],
    retrieval: {} as CognitiveState["retrieval"],
    tenantId: "t1",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  };
}

/** Drive the MODEL route: the real `proposeClaims` FIX 1/FIX 2 resolution. */
async function modelRoute(
  type: string,
  modelSubject: string,
  text: string,
  auth: ClaimAuthContext,
) {
  const planner = createIbatexasPlanner({
    model: mockModel([
      { id: "tc-1", name: PROPOSE_CLAIM_TOOL, input: { type, subject: modelSubject } },
    ]),
    modelId: "mock",
    capabilityPlanners: [],
  });
  return planner.proposeClaims(state(text), auth);
}

/** Drive the CLASSIFY-ONLY route: the real `buildClassifyOnlyCandidates`. */
function classifyOnlyRoute(
  types: RegistryClaimType[],
  auth: ClaimAuthContext,
  ledger: EvidenceLedger,
  text: string,
) {
  return buildClassifyOnlyCandidates(new Set(types), auth, "conv-1", ledger, text);
}

/** The per-resource owner-scoped read the investigator mints, with BKL-203's displayId. */
function recordOrder(
  ledger: EvidenceLedger,
  orderId: string,
  stage: string,
  displayId: number,
): void {
  ledger.record({
    key: `order_fulfillment_stage:${orderId}`,
    value: { fulfillmentStatus: stage, displayId },
    source: "order.getById",
    fetchedAt: NOW,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  });
}

const subjectsOf = (cs: readonly { subject: string }[]): string[] => cs.map((c) => c.subject);

// ── 1. The taxonomy both routes read is TOTAL and DISJOINT ────────────────────

describe("R7 — the 3-class subject taxonomy is a total, disjoint partition", () => {
  it("every registry type falls in EXACTLY one class (owner-scoped / public-per-item / fixed)", () => {
    for (const type of ALL_TYPES) {
      const owner = ownerScopedBaseKey(type) !== undefined;
      const publicItem = publicPerItemBaseKey(type) !== undefined;
      // `publicPerItemBaseKey` documents itself as the COMPLEMENT of
      // `ownerScopedBaseKey` over the per-resource types — never both. Both routes
      // rely on this (each tests owner-scoped FIRST so an owner-scoped per-resource
      // type can never reach a public/fixed branch).
      expect(
        [owner, publicItem].filter(Boolean).length,
        `${type} must be in at most one per-resource class`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("pins the PUBLIC-PER-ITEM membership — the class coupled to a per-type in-planner branch", () => {
    // This class is the one whose in-planner (model-route) subject derivation is
    // written per TYPE rather than per CLASS, so a new member silently gets no
    // deterministic subject there. A change here must be reflected in the
    // model-route coverage test below.
    const publicPerItem = ALL_TYPES.filter((t) => publicPerItemBaseKey(t) !== undefined).sort();
    expect(publicPerItem).toEqual([
      "MENU_DIETARY",
      "MENU_ITEM_CONTENTS",
      "MENU_ITEM_PRICE",
      "STORE_HOURS_FOR_DATE",
    ]);
  });
});

// ── 2. OWNER-SCOPED cross-route subject PARITY (where the contract holds) ─────

describe("R7 — owner-scoped subject parity across the classify-only and model routes", () => {
  it("EXACTLY ONE owned + an empty model subject: both routes bind the owned id", async () => {
    const ledger = new EvidenceLedger("turn-1");
    recordOrder(ledger, "order-A", "preparing", 111);
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map([["order_fulfillment_stage", ["order-A"]]]),
    };
    const text = "cadê meu pedido?";

    const viaClassifyOnly = classifyOnlyRoute(["ORDER_FULFILLMENT_STAGE"], auth, ledger, text);
    const viaModel = await modelRoute("ORDER_FULFILLMENT_STAGE", "", text, auth);

    expect(subjectsOf(viaClassifyOnly.candidates)).toEqual(["order-A"]);
    expect(subjectsOf(viaModel.candidates)).toEqual(subjectsOf(viaClassifyOnly.candidates));
    expect(viaModel.forcedTerminal).toBe(viaClassifyOnly.forcedTerminal);
    // The FIX-1 half of the same contract: the actor is the AUTHENTICATED principal
    // on BOTH routes, never the model's self-report.
    expect(viaClassifyOnly.candidates[0]?.soundness.actor).toMatchObject({
      principal: "cust-A",
    });
    expect(viaModel.candidates[0]?.soundness.actor).toMatchObject({ principal: "cust-A" });
  });

  it("ZERO owned + an empty model subject: both routes leave the subject empty", async () => {
    const ledger = new EvidenceLedger("turn-2");
    const auth: ClaimAuthContext = { customerId: "cust-A", ownedByBaseKey: new Map() };
    const text = "cadê meu pedido?";

    const viaClassifyOnly = classifyOnlyRoute(["ORDER_FULFILLMENT_STAGE"], auth, ledger, text);
    const viaModel = await modelRoute("ORDER_FULFILLMENT_STAGE", "", text, auth);

    // An empty subject parameterizes a key nothing recorded → ABSENT → honest
    // UNKNOWN. Both routes must reach it the same way (never a placeholder that
    // could collide with a real resource id).
    expect(subjectsOf(viaClassifyOnly.candidates)).toEqual([""]);
    expect(subjectsOf(viaModel.candidates)).toEqual(subjectsOf(viaClassifyOnly.candidates));
    expect(viaModel.forcedTerminal).toBe(viaClassifyOnly.forcedTerminal);
  });

  it("TWO owned + an empty model subject: both routes refuse to guess and force CLARIFY", async () => {
    const ledger = new EvidenceLedger("turn-3");
    recordOrder(ledger, "order-A1", "preparing", 933869);
    recordOrder(ledger, "order-A2", "shipped", 771002);
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map([["order_fulfillment_stage", ["order-A1", "order-A2"]]]),
    };
    const text = "cadê meu pedido?";

    const viaClassifyOnly = classifyOnlyRoute(["ORDER_FULFILLMENT_STAGE"], auth, ledger, text);
    const viaModel = await modelRoute("ORDER_FULFILLMENT_STAGE", "", text, auth);

    expect(viaClassifyOnly.forcedTerminal).toBe("CLARIFY");
    expect(viaModel.forcedTerminal).toBe("CLARIFY");
    expect(subjectsOf(viaClassifyOnly.candidates)).toEqual([]);
    expect(subjectsOf(viaModel.candidates)).toEqual([]);
  });
});

// ── 3. The two MEASURED divergences, characterized ───────────────────────────

describe("R7 — DIVERGENCE 1: a NAMED owned order binds on classify-only only (BKL-203)", () => {
  it("≥2 owned + the message names one by displayId: classify-only binds it, the model route CLARIFYs", async () => {
    const ledger = new EvidenceLedger("turn-4");
    recordOrder(ledger, "order-A1", "preparing", 933869);
    recordOrder(ledger, "order-A2", "shipped", 771002);
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map([["order_fulfillment_stage", ["order-A1", "order-A2"]]]),
    };
    const text = "e o pedido 933869, como está?";

    const viaClassifyOnly = classifyOnlyRoute(["ORDER_FULFILLMENT_STAGE"], auth, ledger, text);
    // The model can only ever emit what the TEXT gave it — the DISPLAY number. It has
    // no access to internal resource ids, so `owned.includes(modelSubject)` is false.
    const viaModel = await modelRoute("ORDER_FULFILLMENT_STAGE", "933869", text, auth);

    // BKL-203 resolves the display number against the customer's OWN orders.
    expect(subjectsOf(viaClassifyOnly.candidates)).toEqual(["order-A1"]);
    expect(viaClassifyOnly.forcedTerminal).toBeUndefined();

    // The model route has no BKL-203 analog: the named order dead-ends in the
    // ≥2-owned CLARIFY. Fail-SAFE (an ask, never a wrong order) but NOT parity —
    // the same utterance is answered on one route and deflected on the other.
    expect(subjectsOf(viaModel.candidates)).toEqual([]);
    expect(viaModel.forcedTerminal).toBe("CLARIFY");
  });
});

describe("R7 — DIVERGENCE 2: public per-item subject derivation on the model route", () => {
  // The classify-only + union routes derive a public per-item subject from the LEDGER
  // (`presentPublicItemIds` — the investigator names the admissible item, never the
  // model). The model route cannot: `proposeClaims(state, auth)` receives NO
  // EvidenceLedger. It instead re-derives the subject per TYPE from the request text
  // with the SAME shared resolvers the investigator used. That is sound where a branch
  // exists — and absent where one does not.
  const MODEL_ROUTE_TEXT: Record<string, string> = {
    MENU_ITEM_PRICE: "quanto custa a costela?",
    MENU_ITEM_CONTENTS: "o que vem na costela?",
    STORE_HOURS_FOR_DATE: "qual o horário de domingo?",
    MENU_DIETARY: "tem opção vegetariana?",
  };
  const JUNK = "subject-the-4b-made-up";

  it.each(["MENU_ITEM_PRICE", "MENU_ITEM_CONTENTS", "STORE_HOURS_FOR_DATE"])(
    "%s — the model's subject is OVERRIDDEN by the deterministic in-planner derivation",
    async (type) => {
      const auth: ClaimAuthContext = { customerId: "cust-A", ownedByBaseKey: new Map() };
      const plan = await modelRoute(type, JUNK, MODEL_ROUTE_TEXT[type] as string, auth);
      const candidate = plan.candidates.find((c) => c.type === type);
      // Either overridden to the deterministically-resolved id, or the proposal is
      // dropped outright — never the model's string.
      expect(candidate?.subject).not.toBe(JUNK);
    },
  );

  it("MENU_DIETARY — DOCUMENTED GAP: the model's subject passes through VERBATIM", async () => {
    // MENU_DIETARY joined the public per-item class (BKL-214) with a classify-only
    // subject derivation and an in-planner VALUE deriver, but WITHOUT an in-planner
    // SUBJECT branch. So on the model route the candidate is keyed by whatever the 4B
    // emitted. Fail-SAFE (an unrecognised tag parameterizes a key nothing recorded →
    // ABSENT → honest UNKNOWN; the ledger still gates every validation), but it is the
    // one public per-item type whose model-route subject is model-authored.
    //
    // This test is a CHARACTERIZATION, not an endorsement: closing the gap turns it
    // RED, which is the intended signal to update
    // `docs/architecture/design/r7-candidate-assembly.md` and move MENU_DIETARY into
    // the overridden set above.
    const auth: ClaimAuthContext = { customerId: "cust-A", ownedByBaseKey: new Map() };
    const plan = await modelRoute("MENU_DIETARY", JUNK, MODEL_ROUTE_TEXT.MENU_DIETARY as string, auth);
    const candidate = plan.candidates.find((c) => c.type === "MENU_DIETARY");

    expect(candidate?.subject).toBe(JUNK);
    expect(candidate?.soundness.valueBinding?.key).toBe(`menu:dietary:${JUNK}`);
  });

  it("the classify-only route derives MENU_DIETARY's subject from the LEDGER instead", () => {
    const ledger = new EvidenceLedger("turn-5");
    ledger.record({
      key: "menu:dietary:vegetariano",
      value: { dietaryText: "Salada X, Risoto Y" },
      source: "catalog.searchProducts",
      fetchedAt: NOW,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
    const auth: ClaimAuthContext = { customerId: "cust-A", ownedByBaseKey: new Map() };

    const built = classifyOnlyRoute(["MENU_DIETARY"], auth, ledger, "tem opção vegetariana?");

    expect(subjectsOf(built.candidates)).toEqual(["vegetariano"]);
    expect(built.candidates[0]?.soundness.valueBinding?.key).toBe("menu:dietary:vegetariano");
  });
});
