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
// F-12 — the `renderCarriersForTurn` callback carries NO DATE, and no clock.
//
// THIS BLOCK USED TO PIN THE DATE CARRIER: three cases asserting that the callback
// closed over its own clock + tz and returned `resolvedQueryDate` only for a
// CONFIRMED NON-TODAY day, so the required-claim decomposer could read
// absent-under-active as "the named weekday is today → KEEP the STORE_OPEN_NOW
// companion". That KEEP branch is exactly what F-12 deleted — it made the
// renderer's §O#15 gate require a companion the claim planner had already
// suppressed, degrading an answerable hours turn one day a week. With its sole
// reader gone the field would have been dead data crossing a seam, so the carrier
// half was removed with it.
//
// What remains is `disambiguationCandidates` (BKL-170/BKL-189, sourced from the
// per-turn stash). The date cases are replaced by an ABSENCE pin below: no
// utterance may reintroduce the field, which is what would red if a future change
// re-wired a clock into the render path.
// ─────────────────────────────────────────────────────────────────────────────
describe("claims-pipeline — renderCarriersForTurn (F-12: no date carrier, no clock)", () => {
  const carrier = buildClaimsSeams({ planner: stubPlanner, env: ON_ENV }).renderCarriersForTurn;
  const call = (requestText: string) =>
    carrier?.({ ledger: new EvidenceLedger(), customerId: "cust_1", requestText });

  it("F-12 (was: three resolvedQueryDate cases) — NO utterance threads a resolved date", () => {
    // The three shapes the deleted cases covered, now asserted as one absence: a
    // confirmed NON-TODAY anchor (the case that used to require the field PRESENT),
    // a today anchor, and no anchor at all. "amanhã" is always today+1 and "hoje" is
    // always today, so this stays deterministic under any wall clock.
    for (const text of [
      "vocês abrem amanhã?",
      "que horas vocês abrem hoje?",
      "vocês estão abertos agora?",
    ]) {
      expect(call(text)).not.toHaveProperty("resolvedQueryDate");
    }
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

// ── BKL-270 — the dietary-posture gate ABORTS BOOT ──────────────────────────
//
// The gap this closes, stated plainly: before this test, NOTHING proved a registry
// gate actually stops the pipeline from booting. The existing coverage proves only
// that the assert FUNCTION throws when handed a bad table — a different claim, and
// the weaker one. A gate wired in the wrong place, or wrapped in a try/catch, passes
// every such test while serving traffic.
//
// So this drives the REAL composition root (`buildClaimsSeams` — the same call
// `claustrum-bootstrap.ts` makes) with a registry that violates the gate, and pins
// that the seams are never returned. The PLANE scope is the injection point: it is
// the one registry a caller supplies, so it can be made bad without mutating a
// module constant that every other test in the process shares.

describe("BKL-270 — the dietary-posture boot gate is FAIL-CLOSED at the composition root", () => {
  const readSpec = (key: string, posture?: string): unknown => ({
    kind: "read_claim",
    ...(posture === undefined ? {} : { dietaryPosture: posture }),
    minSourceIntegrity: "structured",
    requiredEvidence: [
      {
        key,
        ownershipPolicy: "not_applicable",
        freshnessPolicy: "must_read_this_turn",
        sourceIntegrity: "structured",
        provenancePolicy: "preserve",
      },
    ],
    customerScoped: false,
  });

  const planeWith = (specs: Record<string, unknown>): never =>
    ({
      claimScope: { types: Object.keys(specs), specs },
      templates: {},
      gatherReads: () => [],
    }) as never;

  it("REFUSES TO BOOT when a plane read spec declares no dietaryPosture", () => {
    expect(() =>
      buildClaimsSeams({
        planner: stubPlanner,
        env: ON_ENV,
        plane: planeWith({ OPS_UNDECLARED: readSpec("ops:undeclared") }),
      }),
    ).toThrow(/OPS_UNDECLARED/);
  });

  it("the refusal names the field and the ticket, so the fix is obvious from the log", () => {
    expect(() =>
      buildClaimsSeams({
        planner: stubPlanner,
        env: ON_ENV,
        plane: planeWith({ OPS_UNDECLARED: readSpec("ops:undeclared") }),
      }),
    ).toThrow(/dietaryPosture[\s\S]*BKL-270/);
  });

  it("NON-VACUITY: declaring the posture gets the SAME plane PAST this gate", () => {
    // Without this control the tests above would pass if `buildClaimsSeams` threw for
    // any unrelated reason — a malformed plane shape, say.
    //
    // The synthetic type still fails a LATER gate (LE2-012 render drift: it has no
    // template), and that is precisely what makes the control sharp — it proves the
    // posture gate specifically STOPPED being the thing that rejects this plane, and
    // it incidentally pins the gate ORDER: posture is checked before render drift.
    let message = "";
    try {
      buildClaimsSeams({
        planner: stubPlanner,
        env: ON_ENV,
        plane: planeWith({ OPS_DECLARED: readSpec("ops:declared", "answer-anyway") }),
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toMatch(/dietaryPosture/);
    expect(message).toMatch(/render drift/);
  });

  it("does NOT run when the pipeline is disabled — no seams exist, so there is nothing to protect", () => {
    expect(() =>
      buildClaimsSeams({
        planner: stubPlanner,
        env: OFF_ENV,
        plane: planeWith({ OPS_UNDECLARED: readSpec("ops:undeclared") }),
      }),
    ).not.toThrow();
  });
});
