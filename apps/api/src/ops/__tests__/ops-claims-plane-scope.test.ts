// ops-claims-plane-scope — LE2-012 acceptance criterion 4: OPS-SCOPED MEANS
// OPS-SCOPED.
//
// The three store-level claim types must be reachable from the OPS plane and
// UNREACHABLE from the CUSTOMER plane — not by convention, but at every seam a
// type could leak through. This suite pins ALL of them, in both directions, off
// the REAL exported sources of truth (never a hand-copied list — the whole point
// is to trip CI when the real registries drift):
//
//   1. REGISTRY   — the customer enum never gains an ops type (and the counts are
//                   pinned: 17 customer / 3 ops, the CLAUDE.SDD.md registry
//                   discipline, EXTENDED not weakened).
//   2. PARSE      — the customer `propose_claim` tool advertises no ops type, so a
//                   customer 4B cannot even SELECT one; the ops planner's does.
//   3. WALL       — `selectCandidateClaim` DROPS an ops type under the customer
//                   scope (defense in depth: a compromised prompt that bypasses
//                   the enum is still dropped), and admits it under the ops scope.
//   4. P4         — an ops-mapped span force-CLARIFYs on the customer plane
//                   (never silently honored) and maps cleanly on the ops plane.
//   5. RENDER     — the customer template grammar has no ops template, and the
//                   customer renderer ABSTAINS a (hypothetically) VALIDATED ops
//                   claim to the proposition-free UNKNOWN rather than emitting a
//                   store fact to a customer.
//   6. BOOT GATES — the customer render-drift gate stays green, the ops-scoped one
//                   is green too, and the ops inv.18 registry assertion passes.

import { describe, expect, it } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import {
  CLAIM_REGISTRY,
  CUSTOMER_CLAIM_SCOPE,
  checkCompleteness,
  constrainClaimGeneration,
  selectCandidateClaim,
} from "../../claustrum/claim-registry.js";
import { claimsRenderDriftProblems } from "../../claustrum/claims-render-drift.js";
import {
  PROPOSE_CLAIM_TOOL,
  createIbatexasPlanner,
} from "../../claustrum/ibatexas-planner.js";
import { renderRenderables } from "../../claustrum/renderer-from-claims.js";
import { SAFE_TEMPLATES, VALIDATED_TEMPLATES } from "../../claustrum/slot-grammar.js";
import {
  OPS_CLAIM_REGISTRY,
  OPS_CLAIM_SCOPE,
  OPS_ORDERS_TODAY,
  OPS_ORDERS_TODAY_FIELD,
  OPS_PENDING_ESCALATIONS,
  OPS_PLANE_VALIDATED_TEMPLATES,
  OPS_REGISTRY_SPECS,
  OPS_RESERVATIONS_TODAY,
  OPS_VALIDATED_TEMPLATES,
  assertOpsClaimDefinitionRegistryValid,
} from "../ops-claim-registry.js";
import { detectOpsClaimSpans } from "../ops-claim-reads.js";

/** The three ops-only type names, from the real enum. */
const OPS_TYPES: readonly string[] = [...OPS_CLAIM_REGISTRY];

/** The proposition-free abstain a customer render must fall back to. */
const SAFE_UNKNOWN = SAFE_TEMPLATES.unknown.slots
  .map((s) => (s.kind === "LITERAL" ? s.text : ""))
  .join("");

function mockModel(capture: CompletionRequest[]): ModelProvider {
  return {
    async complete(req: CompletionRequest): Promise<Completion> {
      capture.push(req);
      return {
        model: "mock",
        stopReason: "end_turn",
        text: "",
        toolCalls: [],
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

function state(text: string) {
  return {
    perception: { text, channel: "web" as const, receivedAt: "2026-07-24T12:00:00.000Z" },
    memory: {} as never,
    retrieval: {} as never,
    tenantId: "t1",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  };
}

/** Drive `proposeClaims` once and return the `propose_claim` tool's type enum. */
async function proposeClaimEnum(
  claimScope?: typeof OPS_CLAIM_SCOPE,
): Promise<readonly string[]> {
  const requests: CompletionRequest[] = [];
  const planner = createIbatexasPlanner({
    model: mockModel(requests),
    modelId: "mock",
    capabilityPlanners: [],
    ...(claimScope === undefined ? {} : { claimScope }),
  });
  await planner.proposeClaims(state("quantos pedidos hoje?"));
  const tool = (requests[0]?.tools ?? []).find((t) => t.name === PROPOSE_CLAIM_TOOL);
  const schema = tool?.inputSchema as
    | { properties?: { type?: { enum?: readonly string[] } } }
    | undefined;
  return schema?.properties?.type?.enum ?? [];
}

// ── 1. REGISTRY ─────────────────────────────────────────────────────────────

describe("LE2-012 registry discipline — the two enums stay disjoint", () => {
  it("pins the runtime counts: 17 customer types, 3 ops types, 20 in the ops scope", () => {
    // CLAUDE.SDD.md registry discipline: the pin is EXTENDED (a second, plane-
    // scoped count) and never weakened. A failure here is a deliberate decision
    // point — a type was added; decide WHICH plane owns it.
    expect(CLAIM_REGISTRY).toHaveLength(17);
    expect(OPS_CLAIM_REGISTRY).toHaveLength(3);
    expect(OPS_CLAIM_SCOPE.types).toHaveLength(20);
  });

  it("no ops type is in the customer registry, and vice versa", () => {
    const customer = new Set<string>(CLAIM_REGISTRY);
    for (const type of OPS_TYPES) expect(customer.has(type)).toBe(false);
    // …and the ops enum carries ONLY ops types (it is the delta, not a copy).
    for (const type of OPS_TYPES) expect(type.startsWith("OPS_")).toBe(true);
  });

  it("the ops SCOPE is exactly customer ∪ ops, with specs exhaustive over types", () => {
    expect([...OPS_CLAIM_SCOPE.types].sort()).toEqual(
      [...CLAIM_REGISTRY, ...OPS_TYPES].sort(),
    );
    // A scope whose `types` and `specs` drift apart would advertise a type its own
    // walls then drop — assert exhaustiveness in both directions, both scopes.
    for (const scope of [CUSTOMER_CLAIM_SCOPE, OPS_CLAIM_SCOPE]) {
      expect(Object.keys(scope.specs).sort()).toEqual([...scope.types].sort());
    }
  });

  it("every ops spec is a store-level read: not customer-scoped, live, falsifier-complete", () => {
    for (const type of OPS_TYPES) {
      const spec = OPS_REGISTRY_SPECS[type as keyof typeof OPS_REGISTRY_SPECS];
      expect(spec.kind).toBe("read_claim");
      // Store-level ⇒ NOT customer-scoped (this is also what keeps the §O#15
      // customer-companion scoping from ever touching an ops type).
      expect(spec.customerScoped).toBe(false);
      // Operational figures are LIVE — never a cacheable TTL.
      expect(spec.requiredEvidence[0]?.freshnessPolicy).toBe("must_read_this_turn");
      expect(spec.requiredEvidence[0]?.ownershipPolicy).toBe("not_applicable");
      // C0 non-vacuity + the W6 cap escape, with a real value binding.
      expect(spec.requiredEvidence.length).toBeGreaterThan(0);
      expect(spec.falsifierComplete).toBe(true);
      expect(spec.falsifiers?.length).toBeGreaterThan(0);
      expect(spec.valueBinding?.key).toBe(spec.requiredEvidence[0]?.key);
      // Not per-resource: the store is the only subject (single, unsuffixed key).
      expect(spec.perResourceKey).toBeUndefined();
    }
  });
});

// ── 2. PARSE — the advertised enum ──────────────────────────────────────────

describe("LE2-012 plane scoping — the customer planner cannot SELECT an ops type", () => {
  it("the CUSTOMER propose_claim enum advertises no ops type", async () => {
    const advertised = new Set(await proposeClaimEnum());
    expect(advertised.size).toBe(17);
    for (const type of OPS_TYPES) expect(advertised.has(type)).toBe(false);
  });

  it("the OPS propose_claim enum advertises all three (and still the customer ones)", async () => {
    const advertised = new Set(await proposeClaimEnum(OPS_CLAIM_SCOPE));
    expect(advertised.size).toBe(20);
    for (const type of OPS_TYPES) expect(advertised.has(type)).toBe(true);
    // The ops scope is a SUPERSET — the LE2-011 store-open chain must survive.
    expect(advertised.has("STORE_OPEN_NOW")).toBe(true);
  });
});

// ── 3. WALL — constrained generation as the plane boundary ──────────────────

describe("LE2-012 plane scoping — the constrained-generation wall drops ops types on the customer plane", () => {
  const proposed = (type: string) => ({
    type,
    subject: "loja",
    actor: { principal: "cust-1", sessionId: "conv-1" },
    value: undefined,
  });

  it("selectCandidateClaim DROPS every ops type under the CUSTOMER scope", () => {
    for (const type of OPS_TYPES) {
      expect(selectCandidateClaim(proposed(type))).toBeUndefined();
      // …and under an explicit customer scope (same thing, stated explicitly).
      expect(selectCandidateClaim(proposed(type), CUSTOMER_CLAIM_SCOPE)).toBeUndefined();
    }
  });

  it("selectCandidateClaim ADMITS every ops type under the OPS scope", () => {
    for (const type of OPS_TYPES) {
      const candidate = selectCandidateClaim(proposed(type), OPS_CLAIM_SCOPE);
      expect(candidate?.type).toBe(type);
      // The model authors no value under the tag protocol; the resolver's ledger
      // entry binds it downstream.
      expect(candidate?.value).toBeUndefined();
      expect(candidate?.soundness.requiredEvidence.length).toBeGreaterThan(0);
    }
  });

  it("constrainClaimGeneration reports the ops types as DROPPED on the customer plane", () => {
    const { candidates, dropped } = constrainClaimGeneration(
      OPS_TYPES.map(proposed),
      CUSTOMER_CLAIM_SCOPE,
    );
    expect(candidates).toHaveLength(0);
    expect(dropped.sort()).toEqual([...OPS_TYPES].sort());
  });

  it("a casing-robust ops tag is STILL dropped on the customer plane", () => {
    // The rescue path (`ops_orders_today` → `OPS_ORDERS_TODAY`) must not become a
    // back door: canonicalization happens BEFORE the membership test, and the
    // customer scope has no such member.
    expect(selectCandidateClaim(proposed("ops_orders_today"))).toBeUndefined();
    expect(
      selectCandidateClaim(proposed("ops_orders_today"), OPS_CLAIM_SCOPE)?.type,
    ).toBe(OPS_ORDERS_TODAY);
  });
});

// ── 4. P4 completeness ──────────────────────────────────────────────────────

describe("LE2-012 plane scoping — P4 never silently honors an out-of-scope mapping", () => {
  const spans = [{ text: "quantos pedidos hoje?", mappedClaimType: OPS_ORDERS_TODAY }];

  it("a span mapped to an ops type force-CLARIFYs on the CUSTOMER plane", () => {
    expect(checkCompleteness(spans)[0]?.disposition).toBe("CLARIFY");
  });

  it("the SAME span maps cleanly on the OPS plane", () => {
    expect(checkCompleteness(spans, OPS_CLAIM_SCOPE)[0]?.disposition).toBe(
      OPS_ORDERS_TODAY,
    );
  });
});

// ── 5. RENDER ───────────────────────────────────────────────────────────────

describe("LE2-012 plane scoping — the customer renderer can never emit an ops template", () => {
  it("the CUSTOMER template grammar has no ops key; the ops one has all three", () => {
    for (const type of OPS_TYPES) {
      expect(Object.hasOwn(VALIDATED_TEMPLATES, type)).toBe(false);
      expect(Object.hasOwn(OPS_VALIDATED_TEMPLATES, type)).toBe(true);
      expect(Object.hasOwn(OPS_PLANE_VALIDATED_TEMPLATES, type)).toBe(true);
    }
    // The ops PLANE table is a superset — it still renders every customer type.
    for (const type of Object.keys(VALIDATED_TEMPLATES)) {
      expect(Object.hasOwn(OPS_PLANE_VALIDATED_TEMPLATES, type)).toBe(true);
    }
  });

  it("a VALIDATED ops claim rendered with the CUSTOMER grammar ABSTAINS (never a store fact)", () => {
    // The last line of defense: even if a type leaked past every wall above, the
    // customer renderer has no template for it and §O#3 forbids free-authoring
    // one — so it degrades to the proposition-free UNKNOWN, never a leak.
    const result = renderRenderables(
      [
        {
          subject: "loja",
          type: OPS_ORDERS_TODAY,
          value: { [OPS_ORDERS_TODAY_FIELD]: "12" },
          verdict: "VALIDATED",
        },
      ],
      "RENDER",
    );
    expect(result.text).toBe(SAFE_UNKNOWN);
    expect(result.text).not.toContain("12");
    expect(result.lines[0]?.kind).toBe("ABSTENTION");
  });

  it("the SAME claim renders its ops template under the OPS grammar", () => {
    const result = renderRenderables(
      [
        {
          subject: "loja",
          type: OPS_ORDERS_TODAY,
          value: { [OPS_ORDERS_TODAY_FIELD]: "12" },
          verdict: "VALIDATED",
        },
      ],
      "RENDER",
      [],
      [],
      false,
      false,
      OPS_PLANE_VALIDATED_TEMPLATES,
    );
    expect(result.text).toBe("Pedidos de hoje: 12.");
    expect(result.lines[0]?.kind).toBe("ASSERTION");
  });
});

// ── 6. BOOT GATES ───────────────────────────────────────────────────────────

describe("LE2-012 boot gates — both scopes are advertised-⊆-renderable and inv.18-valid", () => {
  it("the CUSTOMER render-drift gate is unchanged and green", () => {
    expect(claimsRenderDriftProblems()).toEqual([]);
  });

  it("the OPS-scoped render-drift gate is green (every ops type has a template)", () => {
    expect(
      claimsRenderDriftProblems({
        proposable: OPS_CLAIM_SCOPE.types,
        renderable: new Set(Object.keys(OPS_PLANE_VALIDATED_TEMPLATES)),
      }),
    ).toEqual([]);
  });

  it("NEGATIVE control: an ops type shipped WITHOUT a template fails the gate", () => {
    const problems = claimsRenderDriftProblems({
      proposable: [...OPS_CLAIM_SCOPE.types, "OPS_SYNTHETIC_UNTEMPLATED"],
      renderable: new Set(Object.keys(OPS_PLANE_VALIDATED_TEMPLATES)),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("OPS_SYNTHETIC_UNTEMPLATED");
  });

  it("the ops inv.18 registry assertion passes on the REAL ops registry", () => {
    expect(() => assertOpsClaimDefinitionRegistryValid()).not.toThrow();
  });
});

// ── The deterministic span net (what makes a read RUN) ──────────────────────

describe("LE2-012 ops span detection — tight, and silent on small talk", () => {
  it("detects each store-level question", () => {
    expect([...detectOpsClaimSpans("quantos pedidos hoje?")]).toEqual([
      OPS_ORDERS_TODAY,
    ]);
    expect([...detectOpsClaimSpans("tem escalação pendente?")]).toEqual([
      OPS_PENDING_ESCALATIONS,
    ]);
    expect([...detectOpsClaimSpans("quais reservas hoje?")]).toEqual([
      OPS_RESERVATIONS_TODAY,
    ]);
  });

  it("stays SILENT on small talk and on unrelated staff turns (no read, no cost)", () => {
    expect(detectOpsClaimSpans("bom dia!").size).toBe(0);
    expect(detectOpsClaimSpans("marca o brisket como esgotado").size).toBe(0);
    expect(detectOpsClaimSpans("estamos abertos?").size).toBe(0);
    // The FE-T17 `preserv*` false-fire class, re-pinned here.
    expect(detectOpsClaimSpans("como preservar a carne hoje?").size).toBe(0);
  });

  it("requires the today anchor for the day-scoped types", () => {
    // "quantos pedidos?" with no day anchor is not the store's TODAY figure — a
    // miss is the safe direction (no evidence ⇒ honest UNKNOWN, never a wrong day).
    expect(detectOpsClaimSpans("quantos pedidos?").size).toBe(0);
    expect(detectOpsClaimSpans("qual a reserva do cliente?").size).toBe(0);
  });
});
