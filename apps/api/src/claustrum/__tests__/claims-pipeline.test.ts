/**
 * B-PR1 — the composition-root claims-seam assembly (`claims-pipeline.ts`),
 * FLAG DEFAULT-OFF. These tests pin acceptance (a):
 *
 *   - DEFAULT-OFF: with no `ENABLE_CLAIMS_PIPELINE` (the default), the assembled
 *     seams are `{}` — NO investigator / claimPlanner / claimsKernel. Spread into
 *     `createConductor({ ... })`, `{}` adds no keys, so the Conductor is composed
 *     BYTE-IDENTICALLY to today (no INVESTIGATE / CLAIMS-VALIDATE stage).
 *   - NON-VACUOUS: with the flag ON, ALL THREE seams ARE injected (the three host
 *     modules instantiate) — proving the OFF result is a real gate, not a
 *     module that never wires anything.
 *
 * Pure unit tests — a tiny `ClaimAwarePlannerPort` stub; no DB / model / boot.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceLedger } from "@adjudicate/core";
import { normalizeClaimPlannerResult } from "@claustrum/core";
import type { ClaimPlannerInput, CognitiveState, Plan } from "@claustrum/core";
import { CLASSIFY_ONLY_READS_ENABLED_ENV } from "../classify-only-reads.js";
import { render } from "../renderer-from-claims.js";
import type { ClaimAwarePlannerPort, ClaimPlan } from "../ibatexas-planner.js";
import {
  buildClaimsSeams,
  claimsPipelineEnabled,
  CLAIMS_PIPELINE_ENABLED_ENV,
  warnOncePerMessage,
} from "../claims-pipeline.js";

const stubPlanner: ClaimAwarePlannerPort = {
  async propose(): Promise<Plan> {
    return { envelopes: [] };
  },
  async proposeClaims(_state: CognitiveState): Promise<ClaimPlan> {
    return { candidates: [], completeness: [], droppedClaimTypes: [] };
  },
};

const OFF_ENV: NodeJS.ProcessEnv = {};
const ON_ENV: NodeJS.ProcessEnv = { [CLAIMS_PIPELINE_ENABLED_ENV]: "true" };

describe("claims-pipeline — flag reader (default OFF)", () => {
  it("is OFF by default and only ON for the exact 'true' string", () => {
    expect(claimsPipelineEnabled(OFF_ENV)).toBe(false);
    expect(claimsPipelineEnabled({ [CLAIMS_PIPELINE_ENABLED_ENV]: "1" })).toBe(false);
    expect(claimsPipelineEnabled({ [CLAIMS_PIPELINE_ENABLED_ENV]: "false" })).toBe(false);
    expect(claimsPipelineEnabled(ON_ENV)).toBe(true);
  });
});

describe("claims-pipeline — buildClaimsSeams (byte-identical when OFF)", () => {
  it("OFF (default) → {} : no claims seams are injected", () => {
    const seams = buildClaimsSeams({ planner: stubPlanner, env: OFF_ENV });
    expect(seams).toEqual({});
    expect(seams.investigator).toBeUndefined();
    expect(seams.claimPlanner).toBeUndefined();
    expect(seams.claimsKernel).toBeUndefined();
    // W5b per-turn owner-attribution seam is ALSO gated OFF.
    expect(seams.claimsKernelDepsForTurn).toBeUndefined();
    // E-2 render-from-claims seam is ALSO gated OFF (no renderer wired).
    expect(seams.claimsRenderer).toBeUndefined();
    // BKL-155/153 — the render-vs-draft precedence seam is PAIRED with the renderer
    // and gated OFF with it.
    expect(seams.claimsRenderPrecedence).toBeUndefined();
    // BKL-152-edge — the render-carrier seam (resolvedQueryDate) is gated OFF too.
    expect(seams.renderCarriersForTurn).toBeUndefined();
    // Spreading {} into the Conductor options adds no keys (byte-identical).
    expect(Object.keys(seams)).toHaveLength(0);
  });

  it("ON → all seams are injected (the host modules instantiate)", () => {
    const seams = buildClaimsSeams({ planner: stubPlanner, env: ON_ENV });
    expect(seams.investigator).toBeDefined();
    expect(seams.claimPlanner).toBeDefined();
    expect(seams.claimsKernel).toBeDefined();
    // W5b — the per-turn owner-attribution seam (Track-A) is wired too.
    expect(seams.claimsKernelDepsForTurn).toBeDefined();
    // E-2 — the render-from-claims seam activates ATOMICALLY with the pipeline.
    expect(seams.claimsRenderer).toBeDefined();
    // BKL-155/153 — the render-vs-draft precedence seam is PAIRED with the renderer
    // (co-wired so it only runs where the render does — customer plane, claims-ON).
    expect(seams.claimsRenderPrecedence).toBeDefined();
    expect(typeof seams.claimsRenderPrecedence).toBe("function");
    // The seams are the published shapes the Conductor consumes.
    expect(typeof seams.investigator?.investigate).toBe("function");
    expect(typeof seams.claimPlanner?.propose).toBe("function");
    expect(typeof seams.claimsKernel?.soundness.owns).toBe("function");
    expect(typeof seams.claimsKernel?.soundness.outcomeConfirmed).toBe("function");
    expect(typeof seams.claimsKernel?.soundness.now).toBe("number");
    // claimsKernelDepsForTurn is the per-turn rebuild function the Conductor calls.
    expect(typeof seams.claimsKernelDepsForTurn).toBe("function");
    expect(typeof seams.claimsRenderer?.render).toBe("function");
    // BKL-152-edge — the render-carrier seam (resolvedQueryDate) wires with the pipeline.
    expect(seams.renderCarriersForTurn).toBeDefined();
    expect(typeof seams.renderCarriersForTurn).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKL-152-edge — the `renderCarriersForTurn` carrier callback (@claustrum/core
// 0.8.0). It closes over its OWN clock + tz and returns `resolvedQueryDate` ONLY for
// a CONFIRMED NON-TODAY day (a today/unresolvable anchor omits it, so the decomposer
// reads absent-under-active as "today → KEEP"). `disambiguationCandidates` is
// sourced from the BKL-189 per-turn stash (tested below); an unstashed ledger
// omits it.
// Deterministic assertions only — "amanhã" is always today+1 (never today) and
// "hoje" is always today, independent of the wall clock.
// ─────────────────────────────────────────────────────────────────────────────
describe("claims-pipeline — BKL-152-edge renderCarriersForTurn (resolvedQueryDate carrier)", () => {
  const carrier = buildClaimsSeams({ planner: stubPlanner, env: ON_ENV }).renderCarriersForTurn;
  const call = (requestText: string) =>
    carrier?.({ ledger: new EvidenceLedger(), customerId: "cust_1", requestText });
  const todayIso = (): string =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo",
    }).format(new Date());

  it("a relative NON-TODAY anchor ('amanhã') → resolvedQueryDate PRESENT (≠ today)", () => {
    const out = call("vocês abrem amanhã?");
    expect(out?.resolvedQueryDate).toBeDefined();
    expect(out?.resolvedQueryDate).not.toBe(todayIso());
  });

  it("a TODAY anchor ('hoje') → resolvedQueryDate ABSENT (weekday==today ⇒ decomposer KEEPs)", () => {
    expect(call("que horas vocês abrem hoje?")?.resolvedQueryDate).toBeUndefined();
  });

  it("NO date anchor → resolvedQueryDate ABSENT (nothing to thread)", () => {
    expect(call("vocês estão abertos agora?")?.resolvedQueryDate).toBeUndefined();
  });

  it("an UNSTASHED ledger threads no disambiguationCandidates (BKL-189 absent-path)", () => {
    expect(call("vocês abrem amanhã?")?.disambiguationCandidates).toBeUndefined();
  });
});

describe("claims-pipeline — BKL-108 unconditional boot marker", () => {
  it("OFF → the info sink still gets ONE 'disabled' line (state is never log-silent)", () => {
    const info = vi.fn();
    buildClaimsSeams({ planner: stubPlanner, env: OFF_ENV, info });
    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0]![0] as string;
    expect(line).toContain("[claims-pipeline] disabled");
    expect(line).toContain(CLAIMS_PIPELINE_ENABLED_ENV);
  });

  it("ON → the info sink gets ONE 'ENABLED' line naming the flag", () => {
    const info = vi.fn();
    buildClaimsSeams({ planner: stubPlanner, env: ON_ENV, info });
    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0]![0] as string;
    expect(line).toContain("[claims-pipeline] ENABLED");
    expect(line).toContain(`${CLAIMS_PIPELINE_ENABLED_ENV}=true`);
  });

  it("no info sink (the per-trigger factory path) → both states still assemble fine", () => {
    // The per-trigger factory deliberately omits `info` (boot-class marker must
    // not repeat per trigger) — assembly must be unaffected in both states.
    expect(buildClaimsSeams({ planner: stubPlanner, env: OFF_ENV })).toEqual({});
    expect(buildClaimsSeams({ planner: stubPlanner, env: ON_ENV }).investigator).toBeDefined();
  });
});

describe("claims-pipeline — warnOncePerMessage (BKL-003 per-trigger dedup)", () => {
  it("emits each DISTINCT message once, collapsing repeats across invocations", () => {
    const emitted: string[] = [];
    // Built ONCE (the dedup set lives in the closure); reused across triggers.
    const warn = warnOncePerMessage((m) => emitted.push(m));
    // Two below-floor kernels → two distinct messages, re-seen every trigger.
    warn("adjudicate below floor");
    warn("claustrum below floor");
    warn("adjudicate below floor"); // trigger 2 — repeat
    warn("claustrum below floor"); // trigger 2 — repeat
    warn("adjudicate below floor"); // trigger 3 — repeat
    expect(emitted).toEqual(["adjudicate below floor", "claustrum below floor"]);
  });

  it("does not truncate: BOTH package warnings on the first pass survive", () => {
    const sink = vi.fn();
    const warn = warnOncePerMessage(sink);
    warn("msg-A");
    warn("msg-B");
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenNthCalledWith(1, "msg-A");
    expect(sink).toHaveBeenNthCalledWith(2, "msg-B");
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// BKL-189 — the CLARIFY-with-candidates PRODUCER: the per-turn WeakMap carrier
// keyed by the EvidenceLedger (the one object identity `handleTurn` passes to
// BOTH the claim planner and `renderCarriersForTurn`). End-to-end through the
// REAL seams `buildClaimsSeams` assembles: ambiguous 2-owned turn → the planner
// adapter stashes labeled candidates → the carriers callback returns them → the
// renderer voices the #332 copy. Absent/single-owned paths byte-identical.
// ─────────────────────────────────────────────────────────────────────────────
const CO_ENV_KEY = CLASSIFY_ONLY_READS_ENABLED_ENV;
const originalClassifyOnly = process.env[CO_ENV_KEY];
afterEach(() => {
  if (originalClassifyOnly === undefined) delete process.env[CO_ENV_KEY];
  else process.env[CO_ENV_KEY] = originalClassifyOnly;
});

function cog(text: string, turnId: string): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-07-19T00:00:00.000Z" },
    memory: {} as CognitiveState["memory"],
    retrieval: {} as CognitiveState["retrieval"],
    tenantId: "t1",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId,
  };
}

function recordOrder(ledger: EvidenceLedger, orderId: string, displayId: number): void {
  ledger.record({
    key: `order_fulfillment_stage:${orderId}`,
    value: { orderId, displayId, fulfillmentStatus: "preparing" },
    source: "order.getById",
    fetchedAt: 40_000,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  });
}

async function proposeOn(
  seams: ReturnType<typeof buildClaimsSeams>,
  ledger: EvidenceLedger,
  text: string,
  turnId: string,
) {
  const input: ClaimPlannerInput = {
    cognition: cog(text, turnId),
    plan: { envelopes: [] } as Plan,
    customerId: "cust-A",
    ledger,
  };
  return normalizeClaimPlannerResult(await seams.claimPlanner!.propose(input));
}

describe("BKL-189 — disambiguation-candidate producer (per-turn ledger-keyed stash)", () => {
  const ORDER_Q = "qual o status do meu pedido?";

  it("ambiguous 2-owned turn → CLARIFY + the carriers callback returns the labeled candidates + the renderer voices the #332 copy", async () => {
    process.env[CO_ENV_KEY] = "true";
    const seams = buildClaimsSeams({ planner: stubPlanner, env: ON_ENV });
    const ledger = new EvidenceLedger("turn-amb");
    recordOrder(ledger, "order-B", 205);
    recordOrder(ledger, "order-A", 101);

    const normalized = await proposeOn(seams, ledger, ORDER_Q, "turn-amb");
    expect(normalized.forcedTerminal).toBe("CLARIFY");

    const carriers = seams.renderCarriersForTurn!({
      ledger,
      customerId: "cust-A",
      requestText: ORDER_Q,
    });
    // Sorted by displayId — the deterministic copy order.
    expect(carriers.disambiguationCandidates).toEqual([
      { kind: "order", id: "order-A", label: "#101" },
      { kind: "order", id: "order-B", label: "#205" },
    ]);
    // No date anchor in the text → the date carrier stays absent.
    expect("resolvedQueryDate" in carriers).toBe(false);

    // End-to-end close: the CLARIFY render voices the candidates (#332 template).
    const rendered = render([], "CLARIFY", [], carriers.disambiguationCandidates!);
    expect(rendered.text).toBe(
      "Tenho mais de um registro possível para isso — qual deles: #101 ou #205?",
    );
  });

  it("SINGLE-owned turn → no CLARIFY, no stash, the carriers field is OMITTED (byte-identical absent)", async () => {
    process.env[CO_ENV_KEY] = "true";
    const seams = buildClaimsSeams({ planner: stubPlanner, env: ON_ENV });
    const ledger = new EvidenceLedger("turn-single");
    recordOrder(ledger, "order-A", 101);

    const normalized = await proposeOn(seams, ledger, ORDER_Q, "turn-single");
    expect(normalized.forcedTerminal).toBeUndefined();

    const carriers = seams.renderCarriersForTurn!({
      ledger,
      customerId: "cust-A",
      requestText: ORDER_Q,
    });
    expect("disambiguationCandidates" in carriers).toBe(false);
  });

  it("CONCURRENCY: interleaved turns keyed by DISTINCT ledgers never cross-contaminate", async () => {
    process.env[CO_ENV_KEY] = "true";
    const seams = buildClaimsSeams({ planner: stubPlanner, env: ON_ENV });

    const ledgerA = new EvidenceLedger("turn-A");
    recordOrder(ledgerA, "order-A1", 11);
    recordOrder(ledgerA, "order-A2", 22);
    const ledgerB = new EvidenceLedger("turn-B");
    recordOrder(ledgerB, "order-B1", 33);
    recordOrder(ledgerB, "order-B2", 44);

    // Interleave: propose A, propose B, then read carriers in reverse order.
    await proposeOn(seams, ledgerA, ORDER_Q, "turn-A");
    await proposeOn(seams, ledgerB, ORDER_Q, "turn-B");

    const outB = seams.renderCarriersForTurn!({
      ledger: ledgerB,
      customerId: "cust-A",
      requestText: ORDER_Q,
    });
    const outA = seams.renderCarriersForTurn!({
      ledger: ledgerA,
      customerId: "cust-A",
      requestText: ORDER_Q,
    });
    expect(outA.disambiguationCandidates?.map((c) => c.label)).toEqual(["#11", "#22"]);
    expect(outB.disambiguationCandidates?.map((c) => c.label)).toEqual(["#33", "#44"]);
  });

  it("TEARDOWN/RESIDUE: a ledger that never hit the ambiguous branch reads NOTHING (fresh-turn isolation; WeakMap entries die with the ledger)", async () => {
    process.env[CO_ENV_KEY] = "true";
    const seams = buildClaimsSeams({ planner: stubPlanner, env: ON_ENV });

    const ambiguous = new EvidenceLedger("turn-old");
    recordOrder(ambiguous, "order-A", 101);
    recordOrder(ambiguous, "order-B", 205);
    await proposeOn(seams, ambiguous, ORDER_Q, "turn-old");

    // The NEXT turn's fresh ledger sees no residue from the prior turn's stash.
    const fresh = new EvidenceLedger("turn-new");
    const out = seams.renderCarriersForTurn!({
      ledger: fresh,
      customerId: "cust-A",
      requestText: ORDER_Q,
    });
    expect("disambiguationCandidates" in out).toBe(false);
  });

  it("classify-only OFF → the model path runs, nothing stashes, carriers stay absent (byte-identical)", async () => {
    delete process.env[CO_ENV_KEY];
    const seams = buildClaimsSeams({ planner: stubPlanner, env: ON_ENV });
    const ledger = new EvidenceLedger("turn-off");
    recordOrder(ledger, "order-A", 101);
    recordOrder(ledger, "order-B", 205);
    await proposeOn(seams, ledger, ORDER_Q, "turn-off");
    const out = seams.renderCarriersForTurn!({
      ledger,
      customerId: "cust-A",
      requestText: ORDER_Q,
    });
    expect("disambiguationCandidates" in out).toBe(false);
  });
});
