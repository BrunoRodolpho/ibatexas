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

import { describe, expect, it, vi } from "vitest";
import type { CandidateClaim } from "@adjudicate/core";
import { EvidenceLedger, runClaimsKernel } from "@adjudicate/core";
import type {
  ClaimPlannerInput,
  CognitiveState,
  Completion,
  ModelProvider,
  Plan,
} from "@claustrum/core";
import { logger } from "../../lib/logger.js";
import {
  createIbatexasPlanner,
  PROPOSE_CLAIM_TOOL,
  type ClaimAwarePlannerPort,
  type ClaimPlan,
} from "../ibatexas-planner.js";
import { createIbatexasClaimPlanner } from "../ibatexas-claim-planner.js";
import { createIbatexasClaimsKernelDeps } from "../ibatexas-claims-kernel-deps.js";
import { render } from "../renderer-from-claims.js";

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

  it("surfaces the planner's candidates unchanged when they COVER the required set (no reshape)", async () => {
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
    // A payment question → the §O#15 required set is {PAYMENT_STATUS}, which the
    // returned PAYMENT_STATUS candidate COVERS → no synthetic is added → the
    // planner's array is surfaced unchanged (no add/drop/reshape), delegated from
    // the SAME cognition the seam passed.
    const result = await adapter.propose(adapterInput("meu pagamento foi aprovado?"));

    expect(result).toBe(sentinel);
    expect(sawCognition?.perception.text).toBe("meu pagamento foi aprovado?");
  });
});

// ── F1 SAFE TERMINAL (BKL-005) ───────────────────────────────────────────────
//
// When `proposeClaims` throws (the 4B tool-call XML flake) or returns no candidate
// for a claim-requiring question, the adapter SYNTHESIZES a proposition-free UNKNOWN
// candidate for every §O#15-REQUIRED type the planner left uncovered — so the
// candidate set is never empty on a turn that had a claim to make, CLAIMS-VALIDATE
// always produces a result, and the turn degrades to the renderer's safe terminal
// instead of falling through to the lie-capable prose responder. Smalltalk (no
// required claim) keeps returning [] so the conversational responder still handles
// it. These tests drive the REAL registry + the LINKED `@adjudicate/core` kernel.

/** A claim planner whose `proposeClaims` throws — the 4B tool-call XML parse flake. */
function throwingClaimPlanner(): ClaimAwarePlannerPort {
  return {
    async propose() {
      return emptyPlan;
    },
    async proposeClaims(): Promise<ClaimPlan> {
      throw new Error("simulated 4B tool-call XML parse flake");
    },
  };
}

/** A claim planner returning a FIXED candidate set (empty = the no-claim flake). */
function fixedClaimPlanner(candidates: CandidateClaim[]): ClaimAwarePlannerPort {
  return {
    async propose() {
      return emptyPlan;
    },
    async proposeClaims(): Promise<ClaimPlan> {
      return { candidates, completeness: [], droppedClaimTypes: [] };
    },
  };
}

const KERNEL_NOW = 10_000;

describe("ibatexas-claim-planner — F1 safe terminal (BKL-005)", () => {
  it("synthesizes a safe candidate when proposeClaims THROWS on a claim-requiring question", async () => {
    const adapter = createIbatexasClaimPlanner(throwingClaimPlanner());
    const candidates = await adapter.propose(adapterInput("vocês estão abertos?"));

    // The flake no longer yields an EMPTY set → CLAIMS-VALIDATE runs (6a fires),
    // never the prose fall-through.
    expect(candidates.length).toBeGreaterThan(0);
    const storeOpen = candidates.find((c) => c.type === "STORE_OPEN_NOW");
    expect(storeOpen).toBeDefined();
    // Subject is NOT model-derived: with no authenticated customer it is the
    // fail-closed "unauthenticated" principal.
    expect(storeOpen?.subject).toBe("unauthenticated");
    // The model authors no value under the tag protocol.
    expect(storeOpen?.value).toBeUndefined();
    // A typed candidate with registry evidence (C0 non-vacuity), never prose.
    expect(storeOpen?.soundness.requiredEvidence.length).toBeGreaterThan(0);
  });

  it("does NOT synthesize on a SUCCESSFUL-but-empty proposal — surfaced unchanged (BKL-078 gap; no non-sequitur)", async () => {
    // A successful empty proposal is the planner's HONEST signal → surfaced
    // unchanged (the turn falls through to the conversational/prose responder).
    // Synthesizing here would fire a non-sequitur "não localizei…" because the
    // §O#15 keyword net also matches STATEMENTS. Regression pins from the review:
    const adapter = createIbatexasClaimPlanner(fixedClaimPlanner([]));
    // marker-bearing STATEMENTS (mid-checkout / a thanks) — required non-empty, but
    // the planner SUCCEEDED with [] → NO synthesis.
    expect(await adapter.propose(adapterInput("vou pagar com pix"))).toHaveLength(0);
    expect(
      await adapter.propose(adapterInput("meu pedido chegou, obrigado!")),
    ).toHaveLength(0);
    // even an outright QUESTION: on a SUCCESSFUL empty proposal the prose responder
    // still handles it (only the throw/flake path synthesizes) — the BKL-078 gap.
    expect(await adapter.propose(adapterInput("vocês estão abertos?"))).toHaveLength(0);
  });

  it("returns [] for smalltalk — no required claim → no synthetic spam", async () => {
    const adapter = createIbatexasClaimPlanner(fixedClaimPlanner([]));
    expect(await adapter.propose(adapterInput("oi"))).toHaveLength(0);
  });

  it("returns [] when proposeClaims THROWS on smalltalk (required set empty → no synthetic)", async () => {
    const adapter = createIbatexasClaimPlanner(throwingClaimPlanner());
    expect(await adapter.propose(adapterInput("oi"))).toHaveLength(0);
  });

  it("does NOT synthesize over a SUCCESSFUL partial proposal — the planner's set is surfaced verbatim", async () => {
    const returned: CandidateClaim = {
      soundness: {
        requiredEvidence: [
          {
            key: "payment_status:order-7",
            ownershipPolicy: "required",
            freshnessPolicy: "must_read_this_turn",
            sourceIntegrity: "first_party_verified",
            provenancePolicy: "first_party_only",
          },
        ],
        minSourceIntegrity: "first_party_verified",
        kind: "read_claim",
        actor: { principal: "cust-A" },
      },
      subject: "order-7",
      type: "PAYMENT_STATUS",
      value: { status: "approved" },
    };
    const adapter = createIbatexasClaimPlanner(fixedClaimPlanner([returned]));
    // A bare "status" over-includes BOTH companions → required
    // {ORDER_FULFILLMENT_STAGE, PAYMENT_STATUS}; the planner covered only
    // PAYMENT_STATUS but SUCCEEDED. A successful partial proposal is HONEST framing
    // → the missing ORDER_FULFILLMENT_STAGE companion is NOT synthesized (promoting
    // it would risk a non-sequitur). The returned set is surfaced verbatim.
    const candidates = await adapter.propose(adapterInput("qual o status?"));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe("PAYMENT_STATUS");
    expect(candidates[0]?.subject).toBe("order-7");
  });

  it("a synthesized candidate resolves UNKNOWN (not REFUSED) through the real claims kernel", async () => {
    const adapter = createIbatexasClaimPlanner(throwingClaimPlanner());
    // Bare "status" → two owner-scoped synthetics (ORDER_FULFILLMENT_STAGE + PAYMENT_STATUS).
    const candidates = await adapter.propose(adapterInput("qual o status?"));
    expect(candidates.length).toBeGreaterThan(0);

    // Empty ledger: no owner-scoped read is PRESENT → §5 present(e) fails BEFORE the
    // C1 ownership REFUSED arm → UNKNOWN. Non-empty requiredEvidence satisfies C0, so
    // the verdict is never the vacuous REFUSED either.
    const ledger = new EvidenceLedger("turn-unknown");
    const result = runClaimsKernel(
      ledger,
      candidates,
      createIbatexasClaimsKernelDeps({ now: () => KERNEL_NOW, owns: () => false }),
    );
    expect(result.perClaim.length).toBe(candidates.length);
    for (const pc of result.perClaim) expect(pc.verdict).toBe("UNKNOWN");
    // Nothing renderable → the turn surfaces a proposition-free safe terminal.
    expect(result.renderable).toHaveLength(0);
    expect(result.terminal).toBe("UNKNOWN");
  });

  it("a synthesized STORE_OPEN_NOW VALIDATEs from a first-party schedule ledger read (sound, ledger-sourced)", async () => {
    const adapter = createIbatexasClaimPlanner(throwingClaimPlanner());
    // A fresh, live, first-party schedule read PRESENT this turn (what INVESTIGATE
    // records) — no ScheduleOverride falsifier present.
    const ledger = new EvidenceLedger("turn-store-open");
    ledger.record({
      key: "schedule:store_open_now",
      value: { mealPeriod: "lunch" },
      source: "schedule.read",
      fetchedAt: KERNEL_NOW,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
    const candidates = await adapter.propose({
      cognition: cognition("vocês estão abertos?"),
      plan: emptyPlan,
      ledger,
    });
    const storeOpen = candidates.find((c) => c.type === "STORE_OPEN_NOW");
    // The synthetic value was bound from the FIRST-PARTY ledger read (not the model).
    expect(storeOpen?.value).toMatchObject({ mealPeriod: "lunch" });

    const result = runClaimsKernel(
      ledger,
      candidates,
      createIbatexasClaimsKernelDeps({ now: () => KERNEL_NOW }),
    );
    // Ledger-sourced → genuinely VALIDATED (better than UNKNOWN); the falsifier +
    // freshness arms still ran (no override present, live read).
    expect(result.perClaim.find((p) => p.type === "STORE_OPEN_NOW")?.verdict).toBe(
      "VALIDATED",
    );
  });

  it("renders a proposition-free safe terminal on a planner flake (not prose)", async () => {
    const adapter = createIbatexasClaimPlanner(throwingClaimPlanner());
    const candidates = await adapter.propose(adapterInput("qual o status?"));
    const ledger = new EvidenceLedger("turn-render");
    const result = runClaimsKernel(
      ledger,
      candidates,
      createIbatexasClaimsKernelDeps({ now: () => KERNEL_NOW, owns: () => false }),
    );
    // All synthetics UNKNOWN → nothing renderable → the renderer emits the
    // proposition-free UNKNOWN template, never a domain fact.
    expect(result.terminal).not.toBe("RENDER");
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text.length).toBeGreaterThan(0);
    // Proposition-free (mirrors the renderer-adapter .not.toContain idiom): no
    // order/payment/store domain fact leaks into the safe terminal.
    expect(out.text).not.toContain("aprovado");
    expect(out.text).not.toContain("preparing");
    expect(out.text.toLowerCase()).not.toContain("aberto");
  });

  it("logs a structured warn (observability) when proposeClaims THROWS — the flake is not silent", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const adapter = createIbatexasClaimPlanner(throwingClaimPlanner());
      await adapter.propose(adapterInput("vocês estão abertos?"));
      // The swallowed flake surfaces with a stable event marker the logging
      // pipeline keys on (regression guard against a silent bare `catch {}`).
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          component: "claim-planner",
          event: "claim_planner.propose_failed",
        }),
        expect.any(String),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
