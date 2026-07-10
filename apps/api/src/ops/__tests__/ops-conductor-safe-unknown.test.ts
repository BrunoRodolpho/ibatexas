// BKL-078 D5 — the OPS conductor must NEVER wire the customer-plane safeUnknown
// gate, EVEN with ENABLE_CLAIMS_PIPELINE on. The ops plane already renders staff
// reads deterministically (BKL-100 readAnswer) and its persona is staff-facing;
// degrading a staff info-question to the customer SAFE_UNKNOWN template would be
// wrong. This pins the property at composition: whatever deps composeOpsConductor
// hands createIbatexasResponder, `safeUnknown` is absent.
//
// Technique: spy createIbatexasResponder (keep the planner factory a stub so the
// compose reaches the responder build cheaply) and read the deps it was handed.
// createConductor may throw on the minimal stubs AFTER the responder is built — we
// assert on the recorded call regardless (try/catch), so this needs no real infra.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeOpsConductor } from "../ops-conductor.js";

// vi.mock is hoisted above the imports; the spy is defined via vi.hoisted so the
// factory can reference it (the BKL-101 idiom).
const { createIbatexasResponderSpy } = vi.hoisted(() => ({
  createIbatexasResponderSpy: vi.fn((_deps: Record<string, unknown>) => ({
    respond: async () => ({ text: "" }),
  })),
}));

vi.mock("../../claustrum/ibatexas-responder.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../claustrum/ibatexas-responder.js")>();
  return { ...actual, createIbatexasResponder: createIbatexasResponderSpy };
});

vi.mock("../../claustrum/ibatexas-planner.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../claustrum/ibatexas-planner.js")>();
  return {
    ...actual,
    createIbatexasPlanner: vi.fn(() => ({ plan: async () => ({ envelopes: [] }) })),
  };
});

/** Minimal deps sufficient to reach the createIbatexasResponder call. Downstream
 *  createConductor may throw on these stubs — the caller tolerates it. */
function minimalOpsDeps(): Record<string, unknown> {
  return {
    adjudicator: {},
    memory: {},
    grounding: {},
    explainer: { render: (r: { userFacing: string }) => r.userFacing },
    handoff: { queue: async () => {} },
    telemetry: {},
    session: {},
    tenantResolver: { resolve: async () => ({}) },
    sessionLock: { acquire: async () => ({ release: async () => {} }) },
    systemChannel: { kind: "system" },
    tools: {},
    model: {},
    modelId: "mock",
    opsReadToolExecutors: {},
    buildResolver: () => ({}),
  };
}

/** Compose the ops conductor, tolerating a downstream createConductor throw (the
 *  responder spy has already recorded its deps by then), and return those deps. */
function opsResponderDeps(): Record<string, unknown> {
  createIbatexasResponderSpy.mockClear();
  try {
    composeOpsConductor(minimalOpsDeps() as never, {
      staffId: "owner-1",
      role: "OWNER",
    });
  } catch {
    /* downstream createConductor on stubs — irrelevant to this assertion */
  }
  expect(createIbatexasResponderSpy).toHaveBeenCalledTimes(1);
  return createIbatexasResponderSpy.mock.calls[0]![0];
}

describe("composeOpsConductor — BKL-078 D5: ops NEVER wires safeUnknown", () => {
  const saved = process.env.ENABLE_CLAIMS_PIPELINE;
  beforeEach(() => createIbatexasResponderSpy.mockClear());
  afterEach(() => {
    if (saved === undefined) delete process.env.ENABLE_CLAIMS_PIPELINE;
    else process.env.ENABLE_CLAIMS_PIPELINE = saved;
  });

  it("flag OFF: the ops responder has no safeUnknown dep", () => {
    delete process.env.ENABLE_CLAIMS_PIPELINE;
    expect(opsResponderDeps()).not.toHaveProperty("safeUnknown");
  });

  it("flag ON: the ops responder STILL has no safeUnknown dep (customer-only)", () => {
    process.env.ENABLE_CLAIMS_PIPELINE = "true";
    expect(opsResponderDeps()).not.toHaveProperty("safeUnknown");
  });

  it("sanity: it DOES still wire the ops read-answer governor (readAnswer)", () => {
    // Guards the spy actually observes the real ops deps (not an empty object).
    expect(opsResponderDeps()).toHaveProperty("readAnswer");
  });
});
