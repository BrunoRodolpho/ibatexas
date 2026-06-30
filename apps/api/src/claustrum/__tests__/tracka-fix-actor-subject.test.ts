/**
 * Track A on Nemotron-4B — FIX 1 (actor) + FIX 2 (subject), the IDOR-safe close of
 * the live owner-positive path (TRACK_A_NEMOTRON_ONLY_PLAN.md). These tests pin the
 * two upstream bugs the RCA isolated (the kernel + reads + valueBinding + key
 * alignment were already PROVEN-correct) — driven through the REAL planner
 * `proposeClaims` + the LINKED `@adjudicate/core` kernel (NOT a stub):
 *
 *   BUG 1 — the planner stamped `actor={principal:"llm"}`; `buildOwns`'
 *     defense-in-depth `actorId===principal` check then REFUSED even the legit
 *     owner ("llm" != the authenticated customer). FIX 1 stamps the candidate
 *     actor from the AUTHENTICATED principal (`auth.customerId`, the SAME principal
 *     `buildPerTurnOwnsFromLedger` quantifies over) → the owner PASSES, a mismatch
 *     still REFUSES (the guard is NOT weakened).
 *
 *   BUG 2 — the 4B routinely fails to extract a correct orderId into the read/claim
 *     subject (empty / missing / hallucinated), so the owner-scoped subject never
 *     bound. FIX 2 resolves the SUBJECT from the AUTHENTICATED owner-scoped reads
 *     (`auth.ownedByBaseKey` — the owner-scoped entries that resolved PRESENT this
 *     turn): exactly one owned → bind it; ≥2 → CLARIFY; a model id is honored ONLY
 *     if it is itself owned. The 4B keeps emitting type-only.
 *
 * The three pinned cases (the FIX_SCHEMA acceptance set):
 *   (a) an owner candidate (model subject EMPTY) gets actor=authenticated principal
 *       AND subject=the single owned order → `buildOwns` passes → VALIDATED + RENDER.
 *   (b) a FORGED / model-supplied NON-OWNED id never validates: the authenticated
 *       customer does not own it, `owns=false`, no leak (UNKNOWN/REFUSED).
 *   (c) AMBIGUOUS (≥2 owned, no unambiguous model match) → CLARIFY, never a guess
 *       (no candidate is emitted for the owner-scoped type).
 *
 * HARD GUARD: actor + subject BOTH derive from the authenticated `customerId` /
 * owner-scoped reads — never the model/session payload. Pure unit tests — a
 * hand-built `ModelProvider` mock + real `EvidenceLedger`; no DB / no live model.
 */

import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  runClaimsKernel,
  type CandidateClaim,
} from "@adjudicate/core";
import type {
  ClaimPlannerInput,
  CognitiveState,
  Completion,
  ModelProvider,
  Plan,
} from "@claustrum/core";
import {
  createIbatexasPlanner,
  PROPOSE_CLAIM_TOOL,
  type ClaimAuthContext,
} from "../ibatexas-planner.js";
import { createIbatexasClaimPlanner } from "../ibatexas-claim-planner.js";
import { createPerTurnClaimsKernelDeps } from "../ibatexas-claims-kernel-deps.js";
import { render } from "../renderer-from-claims.js";

// ── Test doubles ──────────────────────────────────────────────────────────────

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

function claimCall(input: unknown): NonNullable<Completion["toolCalls"]>[number] {
  return { id: "tc-1", name: PROPOSE_CLAIM_TOOL, input };
}

function planner(toolCalls: Completion["toolCalls"]) {
  return createIbatexasPlanner({
    model: mockModel(toolCalls),
    modelId: "mock",
    capabilityPlanners: [],
  });
}

const NOW = 10_000;

/** Record the per-resource ORDER_FULFILLMENT_STAGE entry the investigator mints —
 *  keyed `order_fulfillment_stage:{orderId}`; value bound on `["fulfillmentStatus"]`. */
function recordOrder(ledger: EvidenceLedger, orderId: string, stage: string): void {
  ledger.record({
    key: `order_fulfillment_stage:${orderId}`,
    value: { fulfillmentStatus: stage },
    source: "order.getById",
    fetchedAt: NOW,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  });
}

// ── (a) OWNER-POSITIVE — authenticated actor + owner-scoped subject → VALIDATED ─

describe("Track A FIX 1+2 — owner candidate (empty model subject) → actor+subject from auth → VALIDATED", () => {
  it("derives actor + subject + value from the authenticated owner-scoped ledger, then VALIDATEs + renders (end-to-end via the adapter)", async () => {
    // The 4B emits TYPE-ONLY with an EMPTY subject (BUG 2) and no actor (BUG 1).
    // Drive the PUBLISHED adapter (createIbatexasClaimPlanner) so the WHOLE chain
    // runs from the authenticated inputs: ownedResourceIdsByBaseKey(ledger) →
    // FIX 1 actor + FIX 2 subject in proposeClaims → owner-scoped value-bind.
    const adapter = createIbatexasClaimPlanner(
      planner([claimCall({ type: "ORDER_FULFILLMENT_STAGE", subject: "" })]),
    );

    // The AUTHENTICATED owner-scoped read for this turn: customer A owns exactly ONE
    // active order, recorded PRESENT by INVESTIGATE (the adapter derives the owned
    // set + the bound value straight from this ledger — no model/session id).
    const ledger = new EvidenceLedger("turn-1");
    recordOrder(ledger, "order-A", "preparing");
    const input: ClaimPlannerInput = {
      cognition: state("cadê meu pedido?"),
      plan: { envelopes: [] } as Plan,
      customerId: "cust-A",
      ledger,
    };

    const candidates = await adapter.propose(input);

    // FIX 1 — actor is the AUTHENTICATED principal, NOT "llm" / a model actor.
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0] as CandidateClaim;
    expect(candidate.soundness.actor).toMatchObject({ principal: "cust-A" });
    // FIX 2 — subject bound from the owner-scoped read, NOT the (empty) model id.
    expect(candidate.subject).toBe("order-A");
    // Key alignment: per-resource evidence key carries the resolved subject.
    expect(candidate.soundness.valueBinding?.key).toBe("order_fulfillment_stage:order-A");
    // Owner-positive close — the value is the FIRST-PARTY ledger value (model none).
    expect(candidate.value).toMatchObject({ fulfillmentStatus: "preparing" });

    // Feed through the REAL kernel: per-turn owns built from cust-A's owned set
    // (principal === the stamped actor → buildOwns passes; a mismatch still fails).
    const result = runClaimsKernel(
      ledger,
      candidates,
      createPerTurnClaimsKernelDeps({
        now: NOW,
        ownership: { principal: "cust-A", ownedResources: new Set(["order-A"]) },
        outcomes: [],
      }),
    );

    // buildOwns(cust-A) passes AND C6 binds the first-party value → VALIDATED +
    // RENDER of the ledger-sourced stage (never a model value).
    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
    expect(result.terminal).toBe("RENDER");
    expect(result.renderable).toHaveLength(1);
    expect(result.renderable[0]?.value).toMatchObject({ fulfillmentStatus: "preparing" });
    const out = render(result.renderable, result.terminal);
    expect(out.text.length).toBeGreaterThan(0);
  });
});

// ── (b) FORGED / NON-OWNED model id never validates (owns=false; no leak) ───────

describe("Track A FIX 1+2 — a forged / model-supplied NON-OWNED id never validates", () => {
  it("authenticated customer does NOT own the model's id → owns=false → not VALIDATED, no leak", async () => {
    // Mallory (authenticated) probes the OWNER's order id via the model subject.
    // She owns NOTHING relevant this turn (her owner-scoped read set is empty).
    const p = planner([
      claimCall({ type: "ORDER_FULFILLMENT_STAGE", subject: "order-OWNER" }),
    ]);
    const auth: ClaimAuthContext = {
      customerId: "mallory",
      ownedByBaseKey: new Map(), // 0 owned → no admissible owner-scoped subject
    };

    const plan = await p.proposeClaims(state("status do pedido order-OWNER?"), auth);

    // FIX 1 — the actor is stamped to the AUTHENTICATED principal (mallory), NEVER
    // the owner. FIX 2 — with 0 owned, the model id is NOT silently swapped for
    // someone else's; it is kept so the kernel's owner-scoped owns can REFUSE it.
    expect(plan.candidates).toHaveLength(1);
    const candidate = plan.candidates[0] as CandidateClaim;
    expect(candidate.soundness.actor).toMatchObject({ principal: "mallory" });
    expect(candidate.soundness.actor).not.toMatchObject({ principal: "order-OWNER" });

    // Even with the OWNER's value PRESENT in the ledger, mallory's per-turn owns
    // (built ONLY from HER owned set) refuses it → never VALIDATED, never leaked.
    const ledger = new EvidenceLedger("turn-2");
    recordOrder(ledger, "order-OWNER", "preparing");
    const result = runClaimsKernel(
      ledger,
      plan.candidates,
      createPerTurnClaimsKernelDeps({
        now: NOW,
        ownership: { principal: "mallory", ownedResources: new Set(["order-mallory"]) },
        outcomes: [],
      }),
    );

    expect(result.perClaim[0]?.verdict).not.toBe("VALIDATED");
    expect(result.renderable).toHaveLength(0);
    const out = render(result.renderable, result.terminal);
    expect(out.text).not.toContain("preparing");
  });

  it("a model id is honored ONLY if it is itself owned (IDOR-safe accept)", async () => {
    // The model named an id that IS in the authenticated owner-scoped present set.
    const p = planner([
      claimCall({ type: "ORDER_FULFILLMENT_STAGE", subject: "order-A" }),
    ]);
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map([["order_fulfillment_stage", ["order-A", "order-B"]]]),
    };
    const plan = await p.proposeClaims(state("status do order-A?"), auth);
    // Unambiguous OWNED match → accepted (no CLARIFY despite ≥2 owned).
    expect(plan.forcedTerminal).toBeUndefined();
    expect((plan.candidates[0] as CandidateClaim).subject).toBe("order-A");
    expect((plan.candidates[0] as CandidateClaim).soundness.actor).toMatchObject({
      principal: "cust-A",
    });
  });
});

// ── (c) AMBIGUOUS (≥2 owned, no model match) → CLARIFY, never a guess ───────────

describe("Track A FIX 2 — ambiguous owner-scoped subject → CLARIFY (no guess)", () => {
  it("≥2 owned relevant orders and an empty model subject → CLARIFY, emits no candidate", async () => {
    const p = planner([claimCall({ type: "ORDER_FULFILLMENT_STAGE", subject: "" })]);
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map([["order_fulfillment_stage", ["order-A1", "order-A2"]]]),
    };

    const plan = await p.proposeClaims(state("cadê meu pedido?"), auth);

    // Never a guess: the ambiguous owner-scoped proposal is dropped, the turn
    // degrades to CLARIFY (ask which order) — exactly like an unmapped P4 span.
    expect(plan.forcedTerminal).toBe("CLARIFY");
    expect(
      plan.candidates.some((c) => c.type === "ORDER_FULFILLMENT_STAGE"),
    ).toBe(false);
  });
});
