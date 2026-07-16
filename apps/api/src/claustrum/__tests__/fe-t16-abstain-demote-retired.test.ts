/**
 * FE-T16 (FE-3.3) — proof that the "abstain-demote" for now-VALIDATED
 * owner-scoped reads is RETIRED. Ground truth established during this ticket
 * (see claim-registry.ts's `perResourceKey` docstring): the "per-resource
 * alignment is necessary-but-not-sufficient... until then ORDER/PAYMENT
 * degrade SAFE to UNKNOWN" caveat was NEVER a separate demote code branch — it
 * described the process-wide FAIL-CLOSED `owns → false` default
 * (`createIbatexasClaimsKernelDeps`) that governed before the per-turn `owns`
 * threading (Wall 2) landed. Wall 2 IS landed and WIRED: `claims-pipeline.ts`
 * `buildClaimsSeams` threads the REAL per-turn `owns` predicate
 * (`buildPerTurnOwnsFromLedger`) as the Conductor's `claimsKernelDepsForTurn`
 * seam whenever the claims pipeline is on — not the fail-closed stub. So this
 * suite REDUCES TO PROOF, not a code change: it drives the FULL
 * responder-facing render seam — planner → kernel (real per-turn owns) →
 * `createIbatexasClaimsRenderer` (the §O#15-gated adapter) →
 * `decideRenderPrecedence` (the render-vs-draft lattice, BKL-155/153) — one
 * level past `tracka-fix-actor-subject.test.ts` / `reservation-status-claim.test.ts`
 * (§3), which stop at the bare `render()` call and never exercise the adapter's
 * completeness gate or the precedence lattice that decides whether the render
 * actually reaches the customer over the responder's own draft.
 *
 * Two cases, mirroring the ticket's own framing ("the abstain remains the
 * correct behavior only when a claim genuinely fails to validate"):
 *   1. a seeded, OWNED payment → VALIDATED → the lattice picks "render" via
 *      rule 3 (`validated_render`) → the customer receives the grounded fact,
 *      never a SAFE_UNKNOWN abstain.
 *   2. no payment on record → genuinely UNKNOWN → the SAME chain still
 *      abstains honestly — the retirement is scoped to VALIDATED reads only,
 *      never weakening the honest-abstain floor.
 *
 * Pure unit tests — a hand-built `ModelProvider` mock + real `EvidenceLedger`;
 * no DB / no live model.
 */

import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  runClaimsKernel,
  type CandidateClaim,
  type Decision,
} from "@adjudicate/core";
import type {
  ClaimPlannerInput,
  CognitiveState,
  Completion,
  ModelProvider,
  Plan,
} from "@claustrum/core";
import { normalizeClaimPlannerResult } from "@claustrum/core";
import { createIbatexasClaimPlanner } from "../ibatexas-claim-planner.js";
import { createPerTurnClaimsKernelDeps } from "../ibatexas-claims-kernel-deps.js";
import {
  createIbatexasPlanner,
  PROPOSE_CLAIM_TOOL,
} from "../ibatexas-planner.js";
import { createIbatexasClaimsRenderer } from "../claims-renderer-adapter.js";
import {
  decideRenderPrecedence,
  type RenderPrecedenceContext,
} from "../claims-render-precedence.js";

// ── Test doubles (mirrors reservation-status-claim.test.ts /
//    tracka-fix-actor-subject.test.ts exactly) ─────────────────────────────

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
    perception: { text, channel: "web", receivedAt: "2026-07-16T00:00:00.000Z" },
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

const NOW = 30_000;

/** Record the per-resource PAYMENT_STATUS entry the investigator mints — keyed
 *  `payment_status:{orderId}` (ibatexas-investigator.ts's real source label). */
function recordPayment(ledger: EvidenceLedger, orderId: string, status: string): void {
  ledger.record({
    key: `payment_status:${orderId}`,
    value: { status },
    source: "payment.getActiveByOrderId",
    fetchedAt: NOW,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  });
}

/** The "nothing to authorize" conversational REFUSE (empty plan) — the EXACT
 *  decision shape `ibatexas-responder.ts`'s REFUSE-with-empty-plan branch (the
 *  historical `safeUnknown.gate` abstain point) receives on an info question. */
function conversationalRefuse(): Decision {
  return {
    kind: "REFUSE",
    refusal: {
      kind: "BUSINESS_RULE",
      code: "conversational.no_op",
      userFacing: "",
    },
    basis: [],
  } as Decision;
}

// ── (1) A seeded, OWNED payment renders the grounded fact — never abstains ─────

describe("FE-T16 — a previously-abstained VALIDATED payment read renders through the FULL adapter + precedence seam", () => {
  it("planner → kernel (real per-turn owns) → adapter (§O#15) → lattice all agree: render the fact", async () => {
    // The 4B emits TYPE-ONLY with an EMPTY subject — the tag protocol every
    // owner-scoped type follows (ORDER/PAYMENT/RESERVATION alike).
    const adapter = createIbatexasClaimPlanner(
      planner([claimCall({ type: "PAYMENT_STATUS", subject: "" })]),
    );

    const ledger = new EvidenceLedger("turn-1");
    recordPayment(ledger, "pay-A", "paid");
    const requestText = "meu pagamento foi aprovado?";
    const input: ClaimPlannerInput = {
      cognition: state(requestText),
      plan: { envelopes: [] } as Plan,
      customerId: "cust-A",
      ledger,
    };

    const candidates = normalizeClaimPlannerResult(await adapter.propose(input)).candidates;
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0] as CandidateClaim;
    expect(candidate.subject).toBe("pay-A");
    expect(candidate.value).toMatchObject({ status: "paid" });

    // The REAL per-turn kernel deps — cust-A genuinely owns pay-A this turn.
    const result = runClaimsKernel(
      ledger,
      candidates,
      createPerTurnClaimsKernelDeps({
        now: NOW,
        ownership: { principal: "cust-A", ownedResources: new Set(["pay-A"]) },
        outcomes: [],
      }),
    );
    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
    expect(result.terminal).toBe("RENDER");

    // The REAL adapter (§O#15 completeness gate included) — not the bare pure
    // `render()` the earlier FE-T17 / Track A suites stop at.
    const renderer = createIbatexasClaimsRenderer();
    const rendered = renderer.render(result, { requestText });
    expect(rendered.text).toBe("O status do seu pagamento é: pago.");
    expect(rendered.text).not.toContain("Não localizei");

    // The render-vs-draft LATTICE (BKL-155/153): a conversational REFUSE
    // (empty plan) with a VALIDATED terminal must pick RENDER via rule 3
    // (`validated_render`) — the claims fact wins over whatever the responder's
    // own model draft (or the retired SAFE_UNKNOWN abstain) would have said.
    const ctx: RenderPrecedenceContext = {
      decision: conversationalRefuse(),
      plan: { envelopes: [] } as Plan,
      claims: result,
      requestText,
    };
    const verdict = decideRenderPrecedence(ctx);
    expect(verdict).toEqual({ decision: "render", mechanism: "validated_render" });
  });
});

// ── (2) No payment on record → the honest abstain STILL fires (retirement is
//        scoped to VALIDATED reads only — never weakens the safety floor) ─────

describe("FE-T16 — no payment on record → the honest SAFE_UNKNOWN abstain is UNCHANGED", () => {
  it("an absent ledger entry still degrades to the proposition-free UNKNOWN template, never a fabricated fact", async () => {
    const adapter = createIbatexasClaimPlanner(
      planner([claimCall({ type: "PAYMENT_STATUS", subject: "" })]),
    );

    // Empty ledger — no owner-scoped payment read PRESENT this turn.
    const ledger = new EvidenceLedger("turn-2");
    const requestText = "meu pagamento foi aprovado?";
    const input: ClaimPlannerInput = {
      cognition: state(requestText),
      plan: { envelopes: [] } as Plan,
      customerId: "cust-A",
      ledger,
    };

    const candidates = normalizeClaimPlannerResult(await adapter.propose(input)).candidates;
    const result = runClaimsKernel(
      ledger,
      candidates,
      createPerTurnClaimsKernelDeps({
        now: NOW,
        ownership: { principal: "cust-A", ownedResources: new Set<string>() },
        outcomes: [],
      }),
    );
    // No PRESENT evidence → honest UNKNOWN, never VALIDATED.
    expect(result.perClaim.some((c) => c.verdict === "VALIDATED")).toBe(false);

    const renderer = createIbatexasClaimsRenderer();
    const rendered = renderer.render(result, { requestText });
    expect(rendered.text).not.toContain("pago");
    expect(rendered.text).toBe(
      "Não localizei essa informação confirmada agora. Quer que eu verifique?",
    );

    // The lattice still degrades this SAFELY (rule 4, a question honest-degrades)
    // — retiring the STALE caveat never touches the genuinely-unvalidated path.
    const ctx: RenderPrecedenceContext = {
      decision: conversationalRefuse(),
      plan: { envelopes: [] } as Plan,
      claims: result,
      requestText,
    };
    const verdict = decideRenderPrecedence(ctx);
    expect(verdict.decision).toBe("render");
    expect(verdict.mechanism).toBe("safe_degrade");
  });
});
