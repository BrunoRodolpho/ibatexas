/**
 * Q6b — the CLAIM-REGISTRY-AWARE planner port + its three deterministic walls
 * (SDD §H · §P3 · §P4 · §O#9; v1.1 §8; claim-registry v0.1 §1). These tests pin:
 *
 *   1. PRE-planning constrained generation (§H/§P3): a model-proposed claim TYPE
 *      outside the registry enum is NOT emitted as a candidate (dropped); an
 *      in-enum type is selected + parameterized into a typed `CandidateClaim`.
 *   2. POST-planning completeness (§P4/Inv 8/§J.8): an UNMAPPED interrogative/
 *      imperative span → CLARIFY (never silently dropped); a mapped span → its
 *      claim disposition.
 *   3. §O#9 closed-taxonomy safety routing: an UNRECOGNIZED safety marker →
 *      ESCALATE (closed-by-construction); a recognized non-safety request is NOT
 *      over-escalated.
 *   4. The produced `CandidateClaim`s match the LINKED `@adjudicate/core` shape,
 *      so Q6a's `runClaimsKernel` consumes them — proven by feeding them through
 *      the real kernel (NOT a stub) and asserting a non-throwing typed result.
 *
 * NON-VACUITY (each invariant is RED under the named guard removal — verified by
 * transient mutation of `claim-registry.ts`, then restored; see the `sdd_selfcheck`
 * in `.orch/Q6b.impl.json`):
 *   - remove the enum constraint in `selectCandidateClaim` (free-gen) → test (1) RED.
 *   - remove the `mappedClaimType === undefined → CLARIFY` branch in
 *     `checkCompleteness` → test (2) RED.
 *   - remove the unrecognized-marker `→ ESCALATE` default in `routeSafety` → test (3) RED.
 *
 * Pure unit tests — a hand-built `ModelProvider` mock (no live model), no DB.
 */

import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  runClaimsKernel,
  type CandidateClaim,
} from "@adjudicate/core";
import type {
  CognitiveState,
  Completion,
  ModelProvider,
} from "@claustrum/core";
import {
  createIbatexasPlanner,
  PROPOSE_CLAIM_TOOL,
  type ClaimAwarePlannerPort,
} from "../ibatexas-planner.js";
import {
  CLAIM_REGISTRY,
  checkCompleteness,
  constrainClaimGeneration,
  routeSafety,
  selectCandidateClaim,
  type ProposedClaim,
} from "../claim-registry.js";

// ── Test doubles ────────────────────────────────────────────────────────────

/** A `ModelProvider` whose `complete` returns one scripted completion (the tool
 *  calls the planner will translate). Only `complete` is exercised here. */
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
    perception: { text, channel: "web", receivedAt: "2026-06-25T00:00:00.000Z" },
    memory: {} as CognitiveState["memory"],
    retrieval: {} as CognitiveState["retrieval"],
    tenantId: "t1",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  };
}

function planner(toolCalls: Completion["toolCalls"]): ClaimAwarePlannerPort {
  return createIbatexasPlanner({
    model: mockModel(toolCalls),
    modelId: "mock",
    capabilityPlanners: [],
  });
}

/** A `propose_claim` tool call with the given input. */
function claimCall(input: unknown): NonNullable<Completion["toolCalls"]>[number] {
  return { id: "tc-1", name: PROPOSE_CLAIM_TOOL, input };
}

// ── (1) PRE-planning constrained generation (SDD §H/§P3) ────────────────────

describe("Q6b constrained generation — registry-enum (SDD §H/§P3)", () => {
  it("DROPS a model-proposed claim type outside the registry enum (no free-gen)", async () => {
    const p = planner([
      claimCall({ type: "MENU_ITEM_ALLERGENS", subject: "burger" }),
      // A hallucinated type NOT in CLAIM_REGISTRY — must never become a candidate.
      claimCall({ type: "TOTALLY_MADE_UP_CLAIM", subject: "x" }),
    ]);
    const result = await p.proposeClaims(state("o hamburguer tem glúten?"));

    // Exactly one candidate survived — the in-enum one; the out-of-enum dropped.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.type).toBe("MENU_ITEM_ALLERGENS");
    expect(result.droppedClaimTypes).toContain("TOTALLY_MADE_UP_CLAIM");
    expect(result.droppedClaimTypes).not.toContain("MENU_ITEM_ALLERGENS");
  });

  it("SELECTS + parameterizes an in-enum type into a typed CandidateClaim", () => {
    const proposed: ProposedClaim = {
      type: "PAYMENT_STATUS",
      subject: "order-42",
      actor: { principal: "customer", sessionId: "s1" },
      resources: { payment_status: "order-42" },
      value: { status: "approved" },
    };
    const candidate = selectCandidateClaim(proposed);
    expect(candidate).toBeDefined();
    // The registry type's FIXED evidence schema was bound (model never authored it).
    expect(candidate?.type).toBe("PAYMENT_STATUS");
    expect(candidate?.subject).toBe("order-42");
    expect(candidate?.soundness.kind).toBe("read_claim");
    expect(candidate?.soundness.minSourceIntegrity).toBe("first_party_verified");
    // C0 — requiredEvidence is non-empty (a registry type can never validate vacuously).
    expect(candidate?.soundness.requiredEvidence.length).toBeGreaterThan(0);
    // The ownership-required money read carries its `first_party_only` provenance.
    expect(candidate?.soundness.requiredEvidence[0]?.ownershipPolicy).toBe("required");
    expect(candidate?.soundness.requiredEvidence[0]?.provenancePolicy).toBe(
      "first_party_only",
    );
  });

  it("returns undefined for an out-of-enum type — the constrained-gen guard", () => {
    expect(
      selectCandidateClaim({
        type: "NOT_A_REGISTRY_TYPE",
        subject: "s",
        actor: null,
        value: 1,
      }),
    ).toBeUndefined();
    // …and every CLAIM_REGISTRY member DOES select (the guard is not over-broad).
    for (const type of CLAIM_REGISTRY) {
      expect(
        selectCandidateClaim({ type, subject: "s", actor: null, value: 1 }),
        `registry type ${type} must select`,
      ).toBeDefined();
    }
  });
});

// ── (2) POST-planning completeness — P4 (SDD §C P4 / §J.8 / Inv 8) ───────────

describe("Q6b P4 completeness — unmapped span → CLARIFY (SDD §J.8)", () => {
  it("an UNMAPPED span resolves CLARIFY (never silently dropped)", () => {
    const completeness = checkCompleteness([
      { text: "o hamburguer tem glúten?", mappedClaimType: "MENU_ITEM_ALLERGENS" },
      // No mapped claim — the model proposed nothing for this span.
      { text: "e qual o sentido da vida?" },
    ]);
    expect(completeness).toHaveLength(2);
    expect(completeness[0]?.disposition).toBe("MENU_ITEM_ALLERGENS");
    // The unmapped span is surfaced — not dropped — as CLARIFY.
    expect(completeness[1]?.disposition).toBe("CLARIFY");
  });

  it("a span mapped to an OUT-OF-ENUM type also → CLARIFY (defense in depth)", () => {
    const completeness = checkCompleteness([
      { text: "algo", mappedClaimType: "MADE_UP_TYPE" },
    ]);
    expect(completeness[0]?.disposition).toBe("CLARIFY");
  });

  it("proposeClaims surfaces an unmapped span as the forced CLARIFY terminal", async () => {
    const p = planner([
      claimCall({
        type: "STORE_HOURS",
        subject: "store",
        spans: [
          { text: "que horas abre?", mappedClaimType: "STORE_HOURS" },
          { text: "frase sem claim mapeado" }, // unmapped → CLARIFY
        ],
      }),
    ]);
    const result = await p.proposeClaims(state("que horas abre? frase sem claim mapeado"));
    expect(result.forcedTerminal).toBe("CLARIFY");
    expect(result.completeness.some((s) => s.disposition === "CLARIFY")).toBe(true);
  });
});

// ── (3) §O#9 closed-taxonomy safety routing ─────────────────────────────────

describe("Q6b §O#9 closed-taxonomy safety routing", () => {
  it("an UNRECOGNIZED safety marker → ESCALATE (closed by construction)", () => {
    // A novel, attacker-crafted marker string not in the closed taxonomy.
    expect(routeSafety({ markers: ["some-novel-unmodeled-marker"] })).toBe("ESCALATE");
    // SDD §O#9 — harassment / medical-emergency have no typed terminal yet → ESCALATE.
    expect(routeSafety({ markers: ["harassment"] })).toBe("ESCALATE");
    expect(routeSafety({ markers: ["medical-emergency"] })).toBe("ESCALATE");
  });

  it("a recognized NON-safety request (no marker) is NOT over-escalated", () => {
    expect(routeSafety({ markers: [] })).toBeUndefined();
  });

  it("proposeClaims forces ESCALATE on an unrecognized safety marker, outranking CLARIFY", async () => {
    const p = planner([
      claimCall({
        type: "MENU_ITEM_ALLERGENS",
        subject: "burger",
        safetyMarkers: ["unrecognized-health-marker"],
        // Also leave an unmapped span — ESCALATE must outrank the CLARIFY.
        spans: [{ text: "trecho sem mapeamento" }],
      }),
    ]);
    const result = await p.proposeClaims(state("tenho alergia grave, e isso aqui?"));
    expect(result.forcedTerminal).toBe("ESCALATE");
  });

  it("proposeClaims does NOT over-escalate an ordinary request (no markers)", async () => {
    const p = planner([
      claimCall({
        type: "STORE_HOURS",
        subject: "store",
        spans: [{ text: "que horas abre?", mappedClaimType: "STORE_HOURS" }],
      }),
    ]);
    const result = await p.proposeClaims(state("que horas abre?"));
    expect(result.forcedTerminal).toBeUndefined();
    expect(result.candidates).toHaveLength(1);
  });
});

// ── (4) The candidates match the linked @adjudicate/core kernel input ────────

describe("Q6b candidates feed the linked runClaimsKernel (Q6a) — not a stub", () => {
  it("constrainClaimGeneration output is a valid runClaimsKernel candidate set", () => {
    const { candidates } = constrainClaimGeneration([
      {
        type: "MENU_ITEM_ALLERGENS",
        subject: "burger",
        actor: { principal: "customer" },
        resources: {},
        value: { allergens: ["glúten"] },
      },
    ]);
    // Feed the produced candidates through the REAL kernel from the linked
    // @adjudicate/core (1.5.0). A real, empty per-turn ledger + injected pure
    // deps: the kernel must consume the shape and return a typed three-valued
    // result without throwing — proving the planner's output IS the kernel's
    // input contract (so Q6a's CLAIMS-VALIDATE stage consumes it unchanged).
    const ledger = new EvidenceLedger("turn-1");

    const result = runClaimsKernel(ledger, candidates as readonly CandidateClaim[], {
      soundness: {
        owns: () => false,
        outcomeConfirmed: () => false,
        now: 0,
      },
    });

    // Every candidate gets an explicit three-valued verdict (P4: none disappears);
    // with an empty ledger nothing validates → honest-ignorance terminal.
    expect(result.perClaim).toHaveLength(candidates.length);
    expect(["VALIDATED", "UNKNOWN", "REFUSED"]).toContain(result.perClaim[0]?.verdict);
    expect(["RENDER", "UNKNOWN", "ESCALATE", "CLARIFY"]).toContain(result.terminal);
    // Nothing validated against an empty ledger → not rendered.
    expect(result.renderable).toHaveLength(0);
  });
});
