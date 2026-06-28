/**
 * B-PR1 — the candidate-claim source host (`ibatexas-claim-planner.ts`).
 * Implements the published `@claustrum/core` `ClaimPlannerPort` as a THIN adapter
 * over the EXISTING Q6b claim-aware planner (`proposeClaims`) + the
 * `claim-registry.ts` walls. These tests pin REUSE (not reimplementation):
 *
 *   - The adapter delegates to the REAL `createIbatexasPlanner().proposeClaims`,
 *     so a candidate set is produced via the registry-constrained path: a
 *     model-proposed claim TYPE outside the registry enum is DROPPED (constrained
 *     generation, SDD §H/§P3); an in-enum type becomes a typed `CandidateClaim`.
 *     NON-VACUOUS: a turn proposing one in-enum + one out-of-enum type yields a
 *     candidate set with ONLY the in-enum claim.
 *   - The adapter surfaces EXACTLY the planner's `ClaimPlan.candidates` (it does
 *     not add, drop, or re-shape claims) — proven against a stub planner.
 *
 * Pure unit tests — a hand-built `ModelProvider` mock (no live model), no DB.
 */

import { describe, expect, it } from "vitest";
import type { CandidateClaim } from "@adjudicate/core";
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
  type ClaimAwarePlannerPort,
  type ClaimPlan,
} from "../ibatexas-planner.js";
import { createIbatexasClaimPlanner } from "../ibatexas-claim-planner.js";

// ── Test doubles ─────────────────────────────────────────────────────────────

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

function cognition(text: string): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-06-26T00:00:00.000Z" },
    memory: {} as CognitiveState["memory"],
    retrieval: {} as CognitiveState["retrieval"],
    tenantId: "t1",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  };
}

function plannerOver(toolCalls: Completion["toolCalls"]): ClaimAwarePlannerPort {
  return createIbatexasPlanner({
    model: mockModel(toolCalls),
    modelId: "mock",
    capabilityPlanners: [],
  });
}

function claimCall(input: unknown): NonNullable<Completion["toolCalls"]>[number] {
  return { id: "tc-1", name: PROPOSE_CLAIM_TOOL, input };
}

const emptyPlan: Plan = { envelopes: [] };

function adapterInput(text: string): ClaimPlannerInput {
  return { cognition: cognition(text), plan: emptyPlan };
}

// ── Reuse of the real Q6b planner + registry-constrained path ────────────────

describe("ibatexas-claim-planner — delegates to Q6b + registry walls", () => {
  it("produces candidates via the registry-constrained path (out-of-enum DROPPED)", async () => {
    const adapter = createIbatexasClaimPlanner(
      plannerOver([
        claimCall({ type: "MENU_ITEM_ALLERGENS", subject: "burger" }),
        // A hallucinated type NOT in the registry — must never reach the kernel.
        claimCall({ type: "TOTALLY_MADE_UP_CLAIM", subject: "x" }),
      ]),
    );

    const candidates = await adapter.propose(adapterInput("o hamburguer tem glúten?"));

    // Exactly the in-enum claim survived the constrained-generation wall.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe("MENU_ITEM_ALLERGENS");
    // The candidate carries the registry type's FIXED evidence schema — a typed
    // `CandidateClaim`, never free-text reasoning.
    expect(candidates[0]?.soundness.requiredEvidence.length).toBeGreaterThan(0);
  });

  it("returns an empty candidate set when the model proposes nothing", async () => {
    const adapter = createIbatexasClaimPlanner(plannerOver([]));
    const candidates = await adapter.propose(adapterInput("oi"));
    expect(candidates).toHaveLength(0);
  });

  it("surfaces EXACTLY the planner's ClaimPlan.candidates (no add/drop/reshape)", async () => {
    const sentinel: CandidateClaim[] = [
      {
        soundness: {
          requiredEvidence: [],
          minSourceIntegrity: "first_party_verified",
          kind: "read_claim",
          actor: null,
        },
        subject: "order-7",
        type: "PAYMENT_STATUS",
        value: { status: "approved" },
      },
    ];
    let sawCognition: CognitiveState | undefined;
    const stub: ClaimAwarePlannerPort = {
      async propose() {
        return emptyPlan;
      },
      async proposeClaims(state): Promise<ClaimPlan> {
        sawCognition = state;
        return { candidates: sentinel, completeness: [], droppedClaimTypes: [] };
      },
    };
    const adapter = createIbatexasClaimPlanner(stub);
    const result = await adapter.propose(adapterInput("status do pedido 7"));

    // Same array contents, delegated from the SAME cognition the seam passed.
    expect(result).toBe(sentinel);
    expect(sawCognition?.perception.text).toBe("status do pedido 7");
  });
});
