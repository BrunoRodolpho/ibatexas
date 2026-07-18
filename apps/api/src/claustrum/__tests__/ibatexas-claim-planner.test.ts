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
import { normalizeClaimPlannerResult, resolveTurnTerminal } from "@claustrum/core";
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

/**
 * Propose + normalize to the candidate array. Post-BKL-077 `propose` returns the
 * widened `ClaimPlannerResult` union (a bare array OR `{ candidates, forcedTerminal }`);
 * the candidate-shape assertions below are all NO-forced-terminal turns, so normalize
 * to the array. `normalizeClaimPlannerResult` passes a bare array through BY REFERENCE,
 * so the "surfaced unchanged" reference contract is preserved.
 */
async function proposeCandidates(
  adapter: ReturnType<typeof createIbatexasClaimPlanner>,
  input: ClaimPlannerInput,
): Promise<ReadonlyArray<CandidateClaim>> {
  return normalizeClaimPlannerResult(await adapter.propose(input)).candidates;
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

    const candidates = await proposeCandidates(adapter,adapterInput("o hamburguer tem glúten?"));

    // Exactly the in-enum claim survived the constrained-generation wall.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe("MENU_ITEM_ALLERGENS");
    // The candidate carries the registry type's FIXED evidence schema — a typed
    // `CandidateClaim`, never free-text reasoning.
    expect(candidates[0]?.soundness.requiredEvidence.length).toBeGreaterThan(0);
  });

  it("returns an empty candidate set when the model proposes nothing", async () => {
    const adapter = createIbatexasClaimPlanner(plannerOver([]));
    const candidates = await proposeCandidates(adapter,adapterInput("oi"));
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

describe("ibatexas-claim-planner — BKL-168 resilient completion boundary", () => {
  it("RETRIES proposeClaims to the budget before the F1 degrade, then emits a structured completion_error event", async () => {
    let calls = 0;
    const flakingPlanner: ClaimAwarePlannerPort = {
      async propose() {
        return emptyPlan;
      },
      async proposeClaims(): Promise<ClaimPlan> {
        calls += 1;
        throw new Error("simulated 4B tool-call XML parse flake");
      },
    };
    const warnSpy = vi.spyOn(logger, "warn");
    const adapter = createIbatexasClaimPlanner(flakingPlanner, {
      completionRetry: { maxAttempts: 3, sleep: async () => {}, delayForAttempt: () => 0 },
    });

    const candidates = await proposeCandidates(adapter, adapterInput("vocês estão abertos?"));

    // Retried to the budget (3 attempts) before giving up…
    expect(calls).toBe(3);
    // …then degraded to the SAME F1 safe terminal (never silence): a synthesized
    // proposition-free UNKNOWN candidate for the required claim type.
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.find((c) => c.type === "STORE_OPEN_NOW")).toBeDefined();
    // A STRUCTURED, VictoriaLogs-queryable completion_error event with the attempt count.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "claim_planner.propose_failed",
        reason: "completion_error",
        attempts: 3,
      }),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it("a RECOVERED retry (throws once, then a successful proposal) surfaces it — NO F1 degrade", async () => {
    let calls = 0;
    const recoveringPlanner: ClaimAwarePlannerPort = {
      async propose() {
        return emptyPlan;
      },
      async proposeClaims(): Promise<ClaimPlan> {
        calls += 1;
        if (calls === 1) throw new Error("transient flake");
        return { candidates: [], completeness: [], droppedClaimTypes: [] };
      },
    };
    const adapter = createIbatexasClaimPlanner(recoveringPlanner, {
      completionRetry: { maxAttempts: 3, sleep: async () => {}, delayForAttempt: () => 0 },
    });

    // A claim-requiring question, but the SECOND attempt succeeds with an honest EMPTY
    // proposal → the F1 synthesis must NOT fire (a successful empty is surfaced
    // unchanged — the BKL-078 gap). Proves the retry converted a would-be degrade
    // into a recovered success.
    const candidates = await proposeCandidates(adapter, adapterInput("vocês estão abertos?"));
    expect(calls).toBe(2);
    expect(candidates).toHaveLength(0);
  });
});

describe("ibatexas-claim-planner — F1 safe terminal (BKL-005)", () => {
  it("synthesizes a safe candidate when proposeClaims THROWS on a claim-requiring question", async () => {
    const adapter = createIbatexasClaimPlanner(throwingClaimPlanner());
    const candidates = await proposeCandidates(adapter,adapterInput("vocês estão abertos?"));

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
    const candidates = await proposeCandidates(adapter,adapterInput("qual o status?"));

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe("PAYMENT_STATUS");
    expect(candidates[0]?.subject).toBe("order-7");
  });

  it("a synthesized candidate resolves UNKNOWN (not REFUSED) through the real claims kernel", async () => {
    const adapter = createIbatexasClaimPlanner(throwingClaimPlanner());
    // Bare "status" → two owner-scoped synthetics (ORDER_FULFILLMENT_STAGE + PAYMENT_STATUS).
    const candidates = await proposeCandidates(adapter,adapterInput("qual o status?"));
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
    const candidates = await proposeCandidates(adapter,{
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
    const candidates = await proposeCandidates(adapter,adapterInput("qual o status?"));
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

// ── BKL-110 DEMOTE-ONLY candidate-relevance filter ───────────────────────────
//
// Live-proven defect (round-2, turn 157bbfff): "oi, tudo bem?" got the SAFE_UNKNOWN
// template because the 4B claim-planner OVER-PROPOSED a schedule claim on smalltalk,
// and a non-empty candidate set defeats the @claustrum/core prose-preservation
// (emptiness) gate. The filter DROPS a model-proposed candidate the §O#15 decomposer
// GOVERNS but did NOT require this turn, so the set collapses back to empty and the
// greeting prose is preserved. Strictly DEMOTE-ONLY (never adds a candidate) and
// scoped to the decomposer's marker-covered types — a type it has no marker for
// (MENU_ITEM_ALLERGENS, PURCHASE_COMPLETED) is never demoted (unchanged-from-today).
// These tests drive the REAL registry-constrained planner + the adapter filter.

/** A minimal typed CandidateClaim — the filter reads only `.type`. */
function candidateOf(type: string, subject: string): CandidateClaim {
  return {
    soundness: {
      requiredEvidence: [],
      minSourceIntegrity: "structured",
      kind: "read_claim",
      actor: null,
    },
    subject,
    type,
    value: undefined,
  };
}

describe("ibatexas-claim-planner — BKL-110 demote-only relevance filter", () => {
  it("drops a schedule over-proposal on a greeting → empty set (prose preserved)", async () => {
    // The whole greeting corpus: each maps to an EMPTY required set, so a
    // model-proposed STORE_HOURS/STORE_OPEN_NOW is demoted → [] (the emptiness gate
    // then preserves the conversational prose instead of the UNKNOWN non-sequitur).
    for (const greeting of ["oi, tudo bem?", "boa noite!", "obrigado!", "valeu"]) {
      const adapter = createIbatexasClaimPlanner(
        plannerOver([claimCall({ type: "STORE_HOURS", subject: "loja" })]),
      );
      expect(await adapter.propose(adapterInput(greeting))).toHaveLength(0);
    }
    // Both schedule-cluster types over-proposed at once → both demoted.
    const adapter = createIbatexasClaimPlanner(
      plannerOver([
        claimCall({ type: "STORE_HOURS", subject: "loja" }),
        claimCall({ type: "STORE_OPEN_NOW", subject: "loja" }),
      ]),
    );
    expect(await adapter.propose(adapterInput("oi, tudo bem?"))).toHaveLength(0);
  });

  it("records the demoted types in structured telemetry (reason not_required_for_span)", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const adapter = createIbatexasClaimPlanner(
        plannerOver([
          claimCall({ type: "STORE_HOURS", subject: "loja" }),
          claimCall({ type: "STORE_OPEN_NOW", subject: "loja" }),
        ]),
      );
      expect(await adapter.propose(adapterInput("oi, tudo bem?"))).toHaveLength(0);
      // The demotion is OBSERVABLE (a distinct reason keeps it separable from the
      // constrained-generation out-of-enum drops).
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          component: "claim-planner",
          event: "claim_planner.candidate_demoted",
          reason: "not_required_for_span",
          droppedClaimTypes: expect.arrayContaining(["STORE_HOURS", "STORE_OPEN_NOW"]),
        }),
        expect.any(String),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("keeps a required candidate — byte-identical (reference-preserved) result vs no-filter", async () => {
    // A genuine hours question → required contains STORE_OPEN_NOW → the candidate is
    // KEPT and, because nothing dropped, the planner's exact array reference is
    // surfaced unchanged (the "surfaced unchanged" contract; no reshape).
    const sentinel: CandidateClaim[] = [candidateOf("STORE_OPEN_NOW", "loja")];
    const stub: ClaimAwarePlannerPort = {
      async propose() {
        return emptyPlan;
      },
      async proposeClaims(): Promise<ClaimPlan> {
        return { candidates: sentinel, completeness: [], droppedClaimTypes: [] };
      },
    };
    const adapter = createIbatexasClaimPlanner(stub);
    const result = await adapter.propose(adapterInput("vocês estão abertos agora?"));
    expect(result).toBe(sentinel);
  });

  it("drops the off-span companion of a MIXED proposal, keeps the required one", async () => {
    // Hours question; the model over-proposes PAYMENT_STATUS alongside STORE_OPEN_NOW.
    // required = {STORE_OPEN_NOW} → PAYMENT_STATUS demoted, STORE_OPEN_NOW kept.
    const adapter = createIbatexasClaimPlanner(
      plannerOver([
        claimCall({ type: "STORE_OPEN_NOW", subject: "loja" }),
        claimCall({ type: "PAYMENT_STATUS", subject: "order-7" }),
      ]),
    );
    const candidates = await proposeCandidates(adapter,
      adapterInput("vocês estão abertos agora?"),
    );
    expect(candidates.map((c) => c.type)).toEqual(["STORE_OPEN_NOW"]);
  });

  it("NEVER demotes a type the decomposer has no marker for (MENU_ITEM_ALLERGENS preserved)", async () => {
    // The regression guard for the demote-only scope: an allergens question maps to
    // an EMPTY required set (the decomposer is Triad-scoped), but MENU_ITEM_ALLERGENS
    // is OUTSIDE the filter's governed domain, so the safety-critical answer is kept.
    const adapter = createIbatexasClaimPlanner(
      plannerOver([claimCall({ type: "MENU_ITEM_ALLERGENS", subject: "burger" })]),
    );
    const candidates = await proposeCandidates(adapter,
      adapterInput("o hamburguer tem glúten?"),
    );
    expect(candidates.map((c) => c.type)).toEqual(["MENU_ITEM_ALLERGENS"]);
  });

  it("keeps a STORE_HOURS answer on a legitimate hours question (schedule-cluster alias)", async () => {
    // "que horas fecham?" maps to STORE_OPEN_NOW_Q (required = {STORE_OPEN_NOW}); the
    // Triad closure names only STORE_OPEN_NOW, so the alias keeps a STORE_HOURS
    // candidate on this turn — a legit hours answer is never demoted (no regression).
    const adapter = createIbatexasClaimPlanner(
      plannerOver([claimCall({ type: "STORE_HOURS", subject: "loja" })]),
    );
    const candidates = await proposeCandidates(adapter,
      adapterInput("que horas vocês fecham?"),
    );
    expect(candidates.map((c) => c.type)).toEqual(["STORE_HOURS"]);
  });

  it("keeps a net-matching STATEMENT's over-proposal — the bounded residual (BKL-078, not worsened)", async () => {
    // "meu pedido chegou, obrigado!" is a THANKS statement, but the keyword net
    // matches ORDER_STATUS_Q (it cannot tell a statement from a question). required
    // contains ORDER_FULFILLMENT_STAGE → the over-proposed claim is KEPT. This pins
    // the documented residual: worst case is unchanged-from-today (the demote-only
    // filter never worsens it), never a newly-introduced demotion.
    const adapter = createIbatexasClaimPlanner(
      plannerOver([claimCall({ type: "ORDER_FULFILLMENT_STAGE", subject: "order-9" })]),
    );
    const candidates = await proposeCandidates(adapter,
      adapterInput("meu pedido chegou, obrigado!"),
    );
    expect(candidates.map((c) => c.type)).toContain("ORDER_FULFILLMENT_STAGE");
  });

  it("does NOT run on the BKL-005 throw path — synthesis still fires (throw path byte-identical)", async () => {
    // The filter is gated to the SUCCESSFUL path. On a flake (throw) the candidate
    // set is [] before the filter, so nothing is filtered and the required-non-empty
    // safe-terminal synthesis is unchanged: a hours flake still synthesizes STORE_OPEN_NOW.
    const adapter = createIbatexasClaimPlanner(throwingClaimPlanner());
    const candidates = await proposeCandidates(adapter,adapterInput("vocês estão abertos agora?"));
    expect(candidates.find((c) => c.type === "STORE_OPEN_NOW")).toBeDefined();
  });

  it("is pure — the filter adds no model call and is deterministic across turns", async () => {
    // The sole model hop is `proposeClaims`; the filter (decompose + membership) is
    // pure. So proposeClaims is invoked EXACTLY once per turn (no extra call), and a
    // greeting over-proposal demotes to [] identically on repeat.
    const proposeClaims = vi.fn(
      async (): Promise<ClaimPlan> => ({
        candidates: [candidateOf("PAYMENT_STATUS", "order-7")],
        completeness: [],
        droppedClaimTypes: [],
      }),
    );
    const stub: ClaimAwarePlannerPort = {
      async propose() {
        return emptyPlan;
      },
      proposeClaims,
    };
    const adapter = createIbatexasClaimPlanner(stub);
    const r1 = await adapter.propose(adapterInput("oi, tudo bem?"));
    const r2 = await adapter.propose(adapterInput("oi, tudo bem?"));
    expect(proposeClaims).toHaveBeenCalledTimes(2);
    expect(r1).toHaveLength(0);
    expect(r2).toHaveLength(0);
  });
});

// ── BKL-111: the PROSE-PRESERVED `claims.terminal` signal (empty candidate set) ──
//
// When the returned candidate set is EMPTY, CLAIMS-VALIDATE returns undefined and
// the model's prose draft stands — the render-path `claims.terminal` emitter in
// claims-renderer-adapter.ts never fires. The planner adapter emits the single
// `claims.terminal` (posture=prose_preserved) HERE instead, carrying turnId + the
// collapse reason + the types that collapsed. These tests pin: ONE event per
// collapse (signal-only), the reason discriminator (demoted / none / flake), and —
// critically — NO event when the candidate set is NON-empty (the renderer owns
// that turn; a double-emit would violate one-per-turn).

describe("ibatexas-claim-planner — BKL-111 prose-preserved claims.terminal", () => {
  /** The `claims.terminal` info payloads emitted during a spied propose. */
  function terminalPayloads(
    spy: ReturnType<typeof vi.spyOn>,
  ): Array<Record<string, unknown>> {
    return spy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((o) => o?.event === "claims.terminal");
  }

  async function proposeSpied(
    adapter: ReturnType<typeof createIbatexasClaimPlanner>,
    text: string,
  ): Promise<Array<Record<string, unknown>>> {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      await adapter.propose(adapterInput(text));
      return terminalPayloads(infoSpy);
    } finally {
      infoSpy.mockRestore();
    }
  }

  it("a demote-to-empty greeting → ONE prose_preserved event with turnId + reason demoted_to_empty", async () => {
    const adapter = createIbatexasClaimPlanner(
      plannerOver([claimCall({ type: "STORE_HOURS", subject: "loja" })]),
    );
    const payloads = await proposeSpied(adapter, "oi, tudo bem?");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      component: "claims",
      event: "claims.terminal",
      turnId: "turn-1",
      posture: "prose_preserved",
      reason: "demoted_to_empty",
      candidateTypes: ["STORE_HOURS"],
      droppedClaimTypes: ["STORE_HOURS"],
    });
  });

  it("a proposal of nothing → ONE prose_preserved event, reason no_candidates (no droppedClaimTypes key)", async () => {
    const adapter = createIbatexasClaimPlanner(plannerOver([]));
    const payloads = await proposeSpied(adapter, "oi");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      posture: "prose_preserved",
      reason: "no_candidates",
      candidateTypes: [],
    });
    // No demote happened → the optional droppedClaimTypes key is omitted.
    expect(payloads[0]).not.toHaveProperty("droppedClaimTypes");
  });

  it("a planner FLAKE on smalltalk (required empty) → ONE prose_preserved event, reason planner_flake", async () => {
    const adapter = createIbatexasClaimPlanner(throwingClaimPlanner());
    const payloads = await proposeSpied(adapter, "oi, tudo bem?");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      posture: "prose_preserved",
      reason: "planner_flake",
      candidateTypes: [],
    });
  });

  it("NO prose_preserved event when the candidate set is NON-empty (the renderer owns that turn)", async () => {
    // A genuine hours question keeps STORE_OPEN_NOW → all non-empty → the planner
    // does NOT emit; the render-path emitter fires downstream instead. This is the
    // mutual-exclusion guarantee (exactly one claims.terminal per engaged turn).
    const adapter = createIbatexasClaimPlanner(
      plannerOver([claimCall({ type: "STORE_OPEN_NOW", subject: "loja" })]),
    );
    const payloads = await proposeSpied(adapter, "vocês estão abertos agora?");
    expect(payloads).toHaveLength(0);
  });
});

// ── BKL-077: forcedTerminal emission (safety ESCALATE / ambiguity CLARIFY) ────
//
// The adapter now RETURNS the planner-FORCED turn terminal in the widened
// `ClaimPlannerProposal` shape `{ candidates, forcedTerminal }` instead of
// discarding it. claustrum's CLAIMS-VALIDATE folds it via `resolveTurnTerminal`:
// a forced ESCALATE OUTRANKS a would-be RENDER; a forced CLARIFY is honored even
// on an EMPTY candidate set (the 3-payments "which order?" turn — live session
// 1846a742, which pre-adoption delivered garbage prose where a CLARIFY belonged).
// These tests assert the DELIVERED turn terminal (normalize → resolveTurnTerminal),
// mirroring the loop's own fold (claims-validate `applyForcedTerminal`), not merely
// the adapter's return, and pin the invariants: a NO-forced-terminal turn returns
// the BARE array (byte-identical); the flake path emits no forced terminal; a
// CLARIFY-on-empty does NOT double-emit the prose_preserved `claims.terminal`.

/**
 * A claim planner that FORCES a terminal alongside its candidates — mirrors the
 * real planner's computed §O#9 safety ESCALATE / P4-unmapped-or-owner-ambiguity
 * CLARIFY (ibatexas-planner.ts), whose `ClaimPlan.forcedTerminal` the adapter now
 * surfaces. The 3-payments ambiguity is `forcingClaimPlanner([], "CLARIFY")`: the
 * real planner drops the ambiguous owner-scoped proposal (candidates empty) and
 * sets forcedTerminal CLARIFY.
 */
function forcingClaimPlanner(
  candidates: CandidateClaim[],
  forcedTerminal: "ESCALATE" | "CLARIFY",
): ClaimAwarePlannerPort {
  return {
    async propose() {
      return emptyPlan;
    },
    async proposeClaims(): Promise<ClaimPlan> {
      return { candidates, completeness: [], droppedClaimTypes: [], forcedTerminal };
    },
  };
}

/**
 * The turn terminal a proposal DELIVERS — the SAME fold claustrum's CLAIMS-VALIDATE
 * applies (`resolveTurnTerminal(runClaimsKernel(...).terminal, forcedTerminal)`), so
 * the assertion is the customer-delivered terminal, not just the adapter return.
 */
function deliveredTerminal(
  result: Awaited<ReturnType<ReturnType<typeof createIbatexasClaimPlanner>["propose"]>>,
  ledger: EvidenceLedger,
): string {
  const { candidates, forcedTerminal } = normalizeClaimPlannerResult(result);
  const kernel = runClaimsKernel(
    ledger,
    candidates,
    createIbatexasClaimsKernelDeps({ now: () => KERNEL_NOW, owns: () => false }),
  );
  return resolveTurnTerminal(kernel.terminal, forcedTerminal);
}

describe("ibatexas-claim-planner — BKL-077 forcedTerminal emission", () => {
  it("a turn with NO forced terminal returns the BARE array (byte-identical widening)", async () => {
    const adapter = createIbatexasClaimPlanner(
      plannerOver([claimCall({ type: "MENU_ITEM_ALLERGENS", subject: "burger" })]),
    );
    const result = await adapter.propose(adapterInput("o hamburguer tem glúten?"));
    // The non-forced path is a plain array; the normalizer reads it as
    // forcedTerminal: undefined → no downstream terminal change.
    expect(Array.isArray(result)).toBe(true);
    expect(normalizeClaimPlannerResult(result).forcedTerminal).toBeUndefined();
    expect(deliveredTerminal(result, new EvidenceLedger("t-legacy"))).not.toBe(
      "CLARIFY",
    );
  });

  it("the 3-payments AMBIGUITY delivers a CLARIFY terminal end-to-end (empty candidates)", async () => {
    const adapter = createIbatexasClaimPlanner(forcingClaimPlanner([], "CLARIFY"));
    const result = await adapter.propose(adapterInput("meu pagamento saiu?"));
    // Widened return, not a bare array.
    expect(Array.isArray(result)).toBe(false);
    const norm = normalizeClaimPlannerResult(result);
    expect(norm.candidates).toHaveLength(0);
    expect(norm.forcedTerminal).toBe("CLARIFY");
    // DELIVERED terminal: CLARIFY is honored on an EMPTY candidate set (it wins over
    // the kernel's honest-ignorance UNKNOWN) — the pre-adoption prose fall-through.
    const ledger = new EvidenceLedger("turn-clarify");
    expect(deliveredTerminal(result, ledger)).toBe("CLARIFY");
    // …and it renders a proposition-free safe pt-BR line (never prose / a fact).
    const out = render([], "CLARIFY");
    expect(out.terminal).toBe("CLARIFY");
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text).not.toContain("aprovado");
  });

  it("a real-planner UNMAPPED span drives CLARIFY through the adapter (genuine end-to-end)", async () => {
    // Not a stub echo: the REAL planner computes forcedTerminal from a P4 unmapped
    // span (SDD §J.8), and the adapter surfaces it unchanged.
    const adapter = createIbatexasClaimPlanner(
      plannerOver([
        claimCall({
          type: "STORE_HOURS",
          subject: "store",
          spans: [
            { text: "que horas abre?", mappedClaimType: "STORE_HOURS" },
            { text: "frase sem claim mapeado" }, // unmapped → CLARIFY
          ],
        }),
      ]),
    );
    const result = await adapter.propose(
      adapterInput("que horas abre? frase sem claim mapeado"),
    );
    expect(normalizeClaimPlannerResult(result).forcedTerminal).toBe("CLARIFY");
  });

  it("a SAFETY marker delivers an ESCALATE terminal end-to-end, outranking render", async () => {
    // The real planner routes an unrecognized safety marker to ESCALATE (§O#9). The
    // MENU_ITEM_ALLERGENS candidate is NOT demoted (outside the decomposer's domain),
    // so candidates are NON-empty — yet a forced ESCALATE OUTRANKS a would-be RENDER.
    const adapter = createIbatexasClaimPlanner(
      plannerOver([
        claimCall({
          type: "MENU_ITEM_ALLERGENS",
          subject: "burger",
          safetyMarkers: ["unrecognized-health-marker"],
        }),
      ]),
    );
    const result = await adapter.propose(
      adapterInput("tenho alergia grave, e isso aqui?"),
    );
    const norm = normalizeClaimPlannerResult(result);
    expect(norm.forcedTerminal).toBe("ESCALATE");
    const ledger = new EvidenceLedger("turn-escalate");
    expect(deliveredTerminal(result, ledger)).toBe("ESCALATE");
    // The human-handoff safe template, never a domain fact.
    const out = render([], "ESCALATE");
    expect(out.terminal).toBe("ESCALATE");
    expect(out.text.toLowerCase()).toContain("atendente");
  });

  it("the FLAKE path emits NO forced terminal — synthesis returns the bare array (unchanged)", async () => {
    const adapter = createIbatexasClaimPlanner(throwingClaimPlanner());
    const result = await adapter.propose(adapterInput("qual o status?"));
    // Bare array (not the widened object): a flake produced no planner signal, so the
    // turn still degrades to the synthesized safe UNKNOWN, never a forced terminal.
    expect(Array.isArray(result)).toBe(true);
    expect(normalizeClaimPlannerResult(result).forcedTerminal).toBeUndefined();
    expect((result as readonly CandidateClaim[]).length).toBeGreaterThan(0);
  });

  it("a CLARIFY on EMPTY candidates does NOT emit the prose_preserved claims.terminal (no double-emit)", async () => {
    // With a forced terminal, claustrum's CLAIMS-VALIDATE runs the kernel over [] and
    // STAMPS CLARIFY (the render-path emitter fires downstream). The adapter must NOT
    // also log prose_preserved — that would mis-state the turn as prose AND break the
    // one-claims.terminal-per-engaged-turn invariant.
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const adapter = createIbatexasClaimPlanner(forcingClaimPlanner([], "CLARIFY"));
      await adapter.propose(adapterInput("meu pagamento saiu?"));
      const prosePreserved = infoSpy.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .filter(
          (o) => o?.event === "claims.terminal" && o?.posture === "prose_preserved",
        );
      expect(prosePreserved).toHaveLength(0);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
