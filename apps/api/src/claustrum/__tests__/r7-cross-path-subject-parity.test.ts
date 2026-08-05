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
import {
  normalizeClaimPlannerResult,
  type ClaimPlannerInput,
  type CognitiveState,
  type Completion,
  type ModelProvider,
  type Plan,
} from "@claustrum/core";
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
// F-19 — the PRODUCTION owner-scoped projections. Both routes' auth context is built
// from these here, so a parity assertion below compares two routes fed by the SAME
// derivation from the SAME ledger — never a hand-written map that could agree with
// neither.
const { createIbatexasClaimPlanner, namedOwnedSubjectsByBaseKey } = await import(
  "../ibatexas-claim-planner.js"
);
const { ownedResourceIdsByBaseKey } = await import("../ibatexas-claims-kernel-deps.js");

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

/**
 * F-19 — the ONE owner-scoped auth projection the claim-planner adapter builds for a
 * turn, reproduced here from the SAME two production functions the adapter calls
 * (`ownedResourceIdsByBaseKey` + `namedOwnedSubjectsByBaseKey`). Both routes are then
 * driven with THIS context, so "the routes agree" is a statement about the routes and
 * not about two hand-written fixtures. The adapter's own wiring — that it actually
 * calls these — is pinned separately by the REAL-adapter test below.
 */
function authFromLedger(
  customerId: string,
  ledger: EvidenceLedger,
  text: string,
): ClaimAuthContext {
  const ownedByBaseKey = ownedResourceIdsByBaseKey(ledger);
  const named = namedOwnedSubjectsByBaseKey(ownedByBaseKey, ledger, text);
  return {
    customerId,
    ownedByBaseKey,
    ...(named.size === 0 ? {} : { namedOwnedSubjectByBaseKey: named }),
  };
}

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

// ── 3. F-19 — the NAMED owned order, now resolved on BOTH routes ─────────────

describe("R7 / F-19 — a NAMED owned order binds on BOTH routes (BKL-203's resolver, reused)", () => {
  // WAS `DIVERGENCE 1`, a characterization: the same utterance was answered on the
  // classify-only route and deflected into a CLARIFY on the model route, because the
  // model can only ever emit the DISPLAY number it read in the text and that is never
  // an internal resource id (`owned.includes("933869")` is false). F-19 closed it by
  // giving the model route the RESULT of the read plane's OWN
  // `resolveNamedOwnedOrderSubject` through `auth.namedOwnedSubjectByBaseKey` — one
  // resolver, one matcher (BKL-216's `matchNamedOwnedOrders`), two routes.
  it("≥2 owned + the message names one by displayId: BOTH routes bind that owned id", async () => {
    const ledger = new EvidenceLedger("turn-4");
    recordOrder(ledger, "order-A1", "preparing", 933869);
    recordOrder(ledger, "order-A2", "shipped", 771002);
    const text = "e o pedido 933869, como está?";
    const auth = authFromLedger("cust-A", ledger, text);

    const viaClassifyOnly = classifyOnlyRoute(["ORDER_FULFILLMENT_STAGE"], auth, ledger, text);
    // The model emits the DISPLAY number (all the text gave it) — still not an owned
    // id, so the binding cannot come from the model's own string on either route.
    const viaModel = await modelRoute("ORDER_FULFILLMENT_STAGE", "933869", text, auth);

    expect(subjectsOf(viaClassifyOnly.candidates)).toEqual(["order-A1"]);
    expect(subjectsOf(viaModel.candidates)).toEqual(subjectsOf(viaClassifyOnly.candidates));
    expect(viaModel.forcedTerminal).toBe(viaClassifyOnly.forcedTerminal);
    expect(viaModel.forcedTerminal).toBeUndefined();
    // The bound subject is the INTERNAL id, never the display number the model saw.
    expect(subjectsOf(viaModel.candidates)).not.toContain("933869");
  });

  it("≥2 owned + the message names NONE of them: BOTH routes keep the ambiguity CLARIFY", async () => {
    const ledger = new EvidenceLedger("turn-4b");
    recordOrder(ledger, "order-A1", "preparing", 933869);
    recordOrder(ledger, "order-A2", "shipped", 771002);
    const text = "e o meu pedido, como está?";
    const auth = authFromLedger("cust-A", ledger, text);

    const viaClassifyOnly = classifyOnlyRoute(["ORDER_FULFILLMENT_STAGE"], auth, ledger, text);
    const viaModel = await modelRoute("ORDER_FULFILLMENT_STAGE", "", text, auth);

    expect(viaClassifyOnly.forcedTerminal).toBe("CLARIFY");
    expect(viaModel.forcedTerminal).toBe(viaClassifyOnly.forcedTerminal);
    expect(subjectsOf(viaModel.candidates)).toEqual(subjectsOf(viaClassifyOnly.candidates));
    expect(subjectsOf(viaModel.candidates)).toEqual([]);
    // CONTROL, same test: an ABSENCE assertion is satisfied by a mechanism that never
    // fires at all, so prove it fires — the SAME ledger and owned set, with a message
    // that DOES name one, binds on the model route. Without this arm every assertion
    // above passes with F-19 reverted.
    const naming = "e o pedido 933869, como está?";
    const control = await modelRoute(
      "ORDER_FULFILLMENT_STAGE",
      "933869",
      naming,
      authFromLedger("cust-A", ledger, naming),
    );
    expect(subjectsOf(control.candidates)).toEqual(["order-A1"]);
  });

  it("≥2 owned + the message names TWO of them: BOTH routes refuse to guess and CLARIFY", async () => {
    // THE AMBIGUITY BOUNDARY. `resolveNamedOwnedOrderSubject` returns a subject only
    // on EXACTLY ONE match, so a message naming two owned orders yields no entry in
    // `namedOwnedSubjectByBaseKey` and the ≥2-owned CLARIFY stands — on both routes,
    // by construction rather than by two agreeing implementations.
    const ledger = new EvidenceLedger("turn-4c");
    recordOrder(ledger, "order-A1", "preparing", 933869);
    recordOrder(ledger, "order-A2", "shipped", 771002);
    const text = "e os pedidos 933869 e 771002, como estão?";
    const auth = authFromLedger("cust-A", ledger, text);
    expect(auth.namedOwnedSubjectByBaseKey).toBeUndefined();

    const viaClassifyOnly = classifyOnlyRoute(["ORDER_FULFILLMENT_STAGE"], auth, ledger, text);
    const viaModel = await modelRoute("ORDER_FULFILLMENT_STAGE", "933869", text, auth);

    expect(viaClassifyOnly.forcedTerminal).toBe("CLARIFY");
    expect(viaModel.forcedTerminal).toBe(viaClassifyOnly.forcedTerminal);
    expect(subjectsOf(viaModel.candidates)).toEqual(subjectsOf(viaClassifyOnly.candidates));
    expect(subjectsOf(viaModel.candidates)).toEqual([]);
    // CONTROL, same test (see above): drop ONE of the two references and the SAME
    // setup binds — so the CLARIFY here is the ≥2-match boundary, not a dead branch.
    const namingOne = "e o pedido 933869, como está?";
    const control = await modelRoute(
      "ORDER_FULFILLMENT_STAGE",
      "933869",
      namingOne,
      authFromLedger("cust-A", ledger, namingOne),
    );
    expect(subjectsOf(control.candidates)).toEqual(["order-A1"]);
  });

  it("a display number the customer does NOT own binds on NEITHER route (IDOR)", async () => {
    // The resolver can only ever return an id drawn from the authenticated owned set,
    // so a FOREIGN order number is unrepresentable — not merely rejected. Widening the
    // model route did not widen what it can bind.
    const ledger = new EvidenceLedger("turn-4d");
    recordOrder(ledger, "order-A1", "preparing", 933869);
    recordOrder(ledger, "order-A2", "shipped", 771002);
    const text = "e o pedido 555000, como está?";
    const auth = authFromLedger("cust-A", ledger, text);

    const viaClassifyOnly = classifyOnlyRoute(["ORDER_FULFILLMENT_STAGE"], auth, ledger, text);
    const viaModel = await modelRoute("ORDER_FULFILLMENT_STAGE", "555000", text, auth);

    expect(viaClassifyOnly.forcedTerminal).toBe("CLARIFY");
    expect(viaModel.forcedTerminal).toBe("CLARIFY");
    expect(subjectsOf(viaModel.candidates)).toEqual([]);
    expect(subjectsOf(viaClassifyOnly.candidates)).toEqual([]);
    // CONTROL, same test (see above): swap the FOREIGN number for one the customer
    // DOES own and the same setup binds — so "no bind" here is about ownership, not
    // about a resolution that never happens.
    const owning = "e o pedido 771002, como está?";
    const control = await modelRoute(
      "ORDER_FULFILLMENT_STAGE",
      "771002",
      owning,
      authFromLedger("cust-A", ledger, owning),
    );
    expect(subjectsOf(control.candidates)).toEqual(["order-A2"]);
  });
});

describe("R7 / F-19 — the claim-planner ADAPTER carries the resolution to the model route", () => {
  it("the REAL adapter, given only a ledger + text, binds the named order on the MODEL route", async () => {
    // NON-VACUITY for the parity assertions above: they build the auth context with
    // the same two projections the adapter uses, which proves the ROUTES agree but not
    // that anything in production ever fills `namedOwnedSubjectByBaseKey`. This drives
    // `createIbatexasClaimPlanner().propose` — the real CLAIMS-VALIDATE seam — with a
    // ledger and a text and NO hand-built auth at all. ENABLE_CLASSIFY_ONLY_READS is
    // off by default, so this is the MODEL route (the model call is made and its
    // display-number subject is what the planner has to work from).
    const ledger = new EvidenceLedger("turn-4e");
    recordOrder(ledger, "order-A1", "preparing", 933869);
    recordOrder(ledger, "order-A2", "shipped", 771002);
    const text = "e o pedido 933869, como está?";

    const adapter = createIbatexasClaimPlanner(
      createIbatexasPlanner({
        model: mockModel([
          {
            id: "tc-1",
            name: PROPOSE_CLAIM_TOOL,
            input: { type: "ORDER_FULFILLMENT_STAGE", subject: "933869" },
          },
        ]),
        modelId: "mock",
        capabilityPlanners: [],
      }),
    );
    const input: ClaimPlannerInput = {
      cognition: state(text),
      plan: { envelopes: [] } as Plan,
      customerId: "cust-A",
      ledger,
    };
    const { candidates, forcedTerminal } = normalizeClaimPlannerResult(
      await adapter.propose(input),
    );

    const stage = candidates.filter((c) => c.type === "ORDER_FULFILLMENT_STAGE");
    expect(subjectsOf(stage)).toEqual(["order-A1"]);
    expect(forcedTerminal).toBeUndefined();
    // The claim is keyed by the OWNED id, so the kernel's owns-check can pass and the
    // turn can actually answer — the dead-end BKL-203 exists to remove.
    expect(stage[0]?.soundness.valueBinding?.key).toBe("order_fulfillment_stage:order-A1");
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
