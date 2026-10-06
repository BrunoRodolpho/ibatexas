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
//                   pinned: 19 customer / 3 ops (LE2-002 grew the customer
//                   side by the delivery-coverage pair), the CLAUDE.SDD.md registry
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
import {
  CLAIM_PLANNER_PERSONA,
  OPS_CLAIM_PLANNER_PERSONA,
} from "../../claustrum/prompts/personas.js";
import { renderRenderables } from "../../claustrum/renderer-from-claims.js";
import {
  SAFE_TEMPLATES,
  VALIDATED_TEMPLATES,
  type Template,
} from "../../claustrum/slot-grammar.js";
import {
  OPS_CLAIM_REGISTRY,
  OPS_CLAIM_SCOPE,
  OPS_ORDERS_TODAY,
  OPS_ORDERS_TODAY_FIELD,
  OPS_PENDING_ESCALATIONS,
  OPS_PLANE_TEMPLATE_OVERRIDES,
  OPS_PLANE_VALIDATED_TEMPLATES,
  OPS_REGISTRY_SPECS,
  OPS_RESERVATIONS_TODAY,
  OPS_VALIDATED_TEMPLATES,
  assertOpsClaimDefinitionRegistryValid,
  opsTemplateOverrideProblems,
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
  it("pins the runtime counts: 23 customer types, 3 ops types, 26 in the ops scope", () => {
    // CLAUDE.SDD.md registry discipline: the pin is EXTENDED (a second, plane-
    // scoped count) and never weakened. A failure here is a deliberate decision
    // point — a type was added; decide WHICH plane owns it.
    // LE2-002 / NEW-007 GREW the CUSTOMER count 17 → 19 (the DELIVERY_COVERAGE /
    // DELIVERY_NO_COVERAGE complementary pair — a CUSTOMER-plane decision: a
    // coverage answer is store policy every customer may ask about, and the
    // ops-plane delivery answers are LE2-013's separate job). The ops count is
    // UNCHANGED, and the ops-scope total moves in lockstep (19 + 3) because that
    // scope is customer ∪ ops by construction — this is the pin being EXTENDED,
    // never weakened.
    // LE2-019 GREW the CUSTOMER count 19 → 21 (the COUPON_VALID / COUPON_INVALID
    // complementary pair — again a CUSTOMER-plane decision: whether a coupon code
    // works is a customer question, and the ops plane reaches it only through its
    // SUPERSET scope, with no OPS_COUPON_* twin and no ops phrasing override). The
    // ops count is UNCHANGED and the ops-scope total moves in lockstep (21 + 3).
    // LE2-029 GREW the CUSTOMER count 21 → 23 (the MENU_PAIRINGS /
    // MENU_SUBSTITUTIONS complementary pair — again a CUSTOMER-plane decision:
    // what the house serves together is knowledge a customer asks for while
    // deciding what to order, and the ops plane reaches it only through its
    // SUPERSET scope, with no OPS_PAIRING_* twin and no ops phrasing override).
    // The ops count is UNCHANGED and the ops-scope total moves in lockstep
    // (23 + 3).
    expect(CLAIM_REGISTRY).toHaveLength(23);
    expect(OPS_CLAIM_REGISTRY).toHaveLength(3);
    expect(OPS_CLAIM_SCOPE.types).toHaveLength(26);
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
    expect(advertised.size).toBe(23);
    for (const type of OPS_TYPES) expect(advertised.has(type)).toBe(false);
  });

  it("the OPS propose_claim enum advertises all three (and still the customer ones)", async () => {
    const advertised = new Set(await proposeClaimEnum(OPS_CLAIM_SCOPE));
    expect(advertised.size).toBe(26);
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

// ── 7. LE2-013 — THE PLANE-SHARED DELIVERY PAIR + the phrasing overrides ────
//
// The pins above are EXTENDED here, never weakened: LE2-013's scope decision was
// to keep DELIVERY_COVERAGE / DELIVERY_NO_COVERAGE CUSTOMER-registered and let the
// ops plane reach them through the SUPERSET scope — so every count above is
// unchanged, and what needs pinning is the SHARED-ness itself plus the bounded
// nature of the ops re-frame.

const DELIVERY_PAIR = ["DELIVERY_COVERAGE", "DELIVERY_NO_COVERAGE"] as const;

describe("LE2-013 delivery pair — PLANE-SHARED by the superset, not duplicated", () => {
  it("both members are CUSTOMER-registered and reachable on BOTH planes", () => {
    for (const type of DELIVERY_PAIR) {
      // Customer-registered — the ops plane never took ownership of them.
      expect(CLAIM_REGISTRY as readonly string[]).toContain(type);
      expect(CUSTOMER_CLAIM_SCOPE.types as readonly string[]).toContain(type);
      // …and reachable on ops purely because ops ⊃ customer.
      expect(OPS_CLAIM_SCOPE.types as readonly string[]).toContain(type);
      // NOT an ops-only type: no OPS_DELIVERY_* twin was minted (a second type
      // would be a second source of truth for ONE zones projection).
      expect(OPS_CLAIM_REGISTRY as readonly string[]).not.toContain(type);
      expect(Object.hasOwn(OPS_VALIDATED_TEMPLATES, type)).toBe(false);
    }
  });

  it("the constrained-generation wall ADMITS the pair on BOTH scopes", () => {
    const proposed = (type: string) => ({
      type,
      subject: "",
      actor: { principal: "staff:owner1", sessionId: "admin:owner1" },
      value: undefined,
    });
    for (const type of DELIVERY_PAIR) {
      expect(selectCandidateClaim(proposed(type), CUSTOMER_CLAIM_SCOPE)?.type).toBe(type);
      expect(selectCandidateClaim(proposed(type), OPS_CLAIM_SCOPE)?.type).toBe(type);
    }
  });

  it("the OPS claim-planner persona names the mapping (else the 4B has no tag)", async () => {
    // The enum alone is not enough on a 4B: without a mapping line the model does
    // not associate "vocês entregam em X?" with the type, and the chain never
    // starts. This is the ops half of the wiring LE2-002 left for this ticket.
    const advertised = new Set(await proposeClaimEnum(OPS_CLAIM_SCOPE));
    for (const type of DELIVERY_PAIR) expect(advertised.has(type)).toBe(true);
    expect(OPS_CLAIM_PLANNER_PERSONA).toContain("DELIVERY_COVERAGE");
    expect(OPS_CLAIM_PLANNER_PERSONA).toContain("DELIVERY_NO_COVERAGE");
  });

  // BKL-234 — the hours mapping must name the PAIR on BOTH planes. Naming only
  // STORE_HOURS is the defect: the §O#15 span STORE_OPEN_NOW_Q fires on every hours
  // phrasing and REQUIRES the companion, so an hours-only proposal degrades a claim
  // that already VALIDATED. The pt-BR schedule lines are shared verbatim
  // (SCHEDULE_CLAIM_MAPPING_LINES), so this pins that they stay identical rather than
  // drifting to a plane-specific hours vocabulary.
  it("BOTH claim-planner personas map an hours question to the STORE_HOURS pair", async () => {
    const advertised = new Set(await proposeClaimEnum(OPS_CLAIM_SCOPE));
    expect(advertised.has("STORE_HOURS")).toBe(true);
    expect(advertised.has("STORE_OPEN_NOW")).toBe(true);

    for (const persona of [OPS_CLAIM_PLANNER_PERSONA, CLAIM_PLANNER_PERSONA]) {
      expect(persona).toContain("STORE_HOURS");
      expect(persona).toContain("STORE_OPEN_NOW");
      // The hours phrasings BKL-233/234 were registered from must be reachable.
      expect(persona).toContain("qual o horário de funcionamento");
      expect(persona).toContain("até que horas fica aberto");
      // The pair instruction itself (the DELIVERY_COVERAGE "proponha TAMBÉM" idiom).
      expect(persona).toContain("proponha");
    }
  });

  it("the shared schedule mapping is BYTE-IDENTICAL on both planes (no drift)", () => {
    const scheduleBlock = (persona: string): string => {
      const lines = persona.split("\n");
      const start = lines.findIndex((l) => l.includes("STORE_OPEN_NOW"));
      const end = lines.findIndex((l) => l.includes("STORE_HOURS_FOR_DATE"));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return lines.slice(start, end + 1).join("\n");
    };
    expect(scheduleBlock(OPS_CLAIM_PLANNER_PERSONA)).toBe(
      scheduleBlock(CLAIM_PLANNER_PERSONA),
    );
  });
});

describe("LE2-013 phrasing overrides — same FACT, plane-appropriate FRAME", () => {
  it("the ops table re-frames the pair; the customer grammar is untouched", () => {
    for (const type of DELIVERY_PAIR) {
      expect(Object.hasOwn(OPS_PLANE_TEMPLATE_OVERRIDES, type)).toBe(true);
      // The ops plane resolves to the override, the customer plane to its own.
      expect(OPS_PLANE_VALIDATED_TEMPLATES[type]).toBe(OPS_PLANE_TEMPLATE_OVERRIDES[type]);
      expect(VALIDATED_TEMPLATES[type]).not.toBe(OPS_PLANE_TEMPLATE_OVERRIDES[type]);
    }
  });

  it("the CUSTOMER-voiced frames are gone from the ops renders", () => {
    const opsText = (type: string) =>
      (OPS_PLANE_VALIDATED_TEMPLATES[type]?.slots ?? [])
        .map((s) => (s.kind === "LITERAL" ? s.text : ""))
        .join("");
    // "…pelo endereço no checkout" describes what the system does at THE
    // CUSTOMER'S checkout; the operator asking is the person who runs it.
    expect(opsText("DELIVERY_COVERAGE")).not.toContain("checkout");
    // Offering pickup to the restaurant's own staff is the same non-sequitur.
    expect(opsText("DELIVERY_NO_COVERAGE")).not.toContain("retirar aqui");
  });

  it("an override may re-frame ONLY — the proposition signature is identical", () => {
    // The load-bearing bound: the plane's ClaimDefinition (and its §5-gated
    // valueProjections) is assembled from the CUSTOMER template, so a changed
    // field would render a projection §5 never licensed.
    const propSig = (t: Template | undefined) =>
      (t?.slots ?? [])
        .filter(
          (s): s is Extract<typeof s, { kind: "PROPOSITION" }> => s.kind === "PROPOSITION",
        )
        .map((s) => `${s.claimType}.${s.field}`);
    for (const type of DELIVERY_PAIR) {
      expect(propSig(OPS_PLANE_TEMPLATE_OVERRIDES[type])).toEqual(
        propSig(VALIDATED_TEMPLATES[type]),
      );
    }
    expect(opsTemplateOverrideProblems()).toEqual([]);
  });

  it("NEGATIVE control: an override that changes WHAT IS ASSERTED is rejected", () => {
    const problems = opsTemplateOverrideProblems({
      DELIVERY_COVERAGE: {
        claimType: "DELIVERY_COVERAGE",
        posture: "validated",
        slots: [
          { kind: "PROPOSITION", claimType: "DELIVERY_COVERAGE", field: "somethingElse" },
        ],
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("changes what is ASSERTED");
  });

  it("NEGATIVE control: an override of a NON-customer template is rejected", () => {
    const problems = opsTemplateOverrideProblems({
      OPS_ORDERS_TODAY: OPS_VALIDATED_TEMPLATES[OPS_ORDERS_TODAY]!,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("overrides no CUSTOMER template");
  });

  it("the fail-closed ops registry assertion runs the override guard", () => {
    // Same call site as boot: a bad override must refuse to boot the ops pipeline.
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
