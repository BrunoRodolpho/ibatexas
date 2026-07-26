// LE2 decision 6 — the OPS CLAIMS-PIPELINE CONVERGENCE pin.
//
// THIS FILE REPLACES `ops-conductor-safe-unknown.test.ts` (BKL-078 D5), which
// pinned the OPPOSITE property: "the ops conductor must NEVER wire the customer-
// plane safeUnknown gate, EVEN with ENABLE_CLAIMS_PIPELINE on". That decision is
// FORMALLY DISSOLVED by owner decision (Language Engine 2.0 program spec,
// Implementation Decision 6 — "Full claims-pipeline convergence, no stopgap …
// The prior 'ops never wires safe-unknown' decision (D5) is dissolved, its pinning
// test replaced"). The replacement pins CONVERGENCE: with the flag ON the ops
// conductor composes the SAME claims seams and the SAME safe-unknown gate the
// customer conductor does — and with the flag OFF it is byte-identical to the
// pre-LE2 composition.
//
// What survived D5 unchanged, and is re-pinned here so convergence cannot quietly
// cost it: the BKL-100 `readAnswer` governor (the deterministic staff-read render
// runs BEFORE the gate, so a captured read is still answered from the ACTUAL read),
// and the ops persona overrides.
//
// Technique (carried from the replaced file): spy `createIbatexasResponder` and
// `createConductor` and read the deps/options the REAL `composeOpsConductor` handed
// them. No infra, no turn, no model call — this is a COMPOSITION pin. The turn-seam
// proof (utterance in → grounded render out) is
// `ops-store-open-claims.e2e.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeOpsConductor } from "../ops-conductor.js";
import {
  buildClaimsSeams,
  CLAIMS_PIPELINE_ENABLED_ENV,
} from "../../claustrum/claims-pipeline.js";
import type { ClaimAwarePlannerPort } from "../../claustrum/ibatexas-planner.js";
import { OPS_PLANNER_PERSONA } from "../../claustrum/prompts/personas.js";

// vi.mock is hoisted above the imports; the spies are defined via vi.hoisted so the
// factories can reference them (the BKL-101 idiom).
const { createIbatexasResponderSpy, createIbatexasPlannerSpy, createConductorSpy } =
  vi.hoisted(() => ({
    createIbatexasResponderSpy: vi.fn((_deps: Record<string, unknown>) => ({
      respond: async () => ({ text: "" }),
    })),
    createIbatexasPlannerSpy: vi.fn((_deps: Record<string, unknown>) => ({
      plan: async () => ({ envelopes: [] }),
      propose: async () => ({ envelopes: [] }),
      proposeClaims: async () => ({ candidates: [] }),
    })),
    createConductorSpy: vi.fn((_opts: Record<string, unknown>) => ({
      openCapsule: async () => ({}),
      closeCapsule: async () => {},
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
  return { ...actual, createIbatexasPlanner: createIbatexasPlannerSpy };
});

// createConductor-spy (PR #187 / BKL-003 idiom): keep every other `@claustrum/core`
// export REAL, so the composed `ConductorOptions` can be inspected.
vi.mock("@claustrum/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claustrum/core")>();
  return { ...actual, createConductor: createConductorSpy };
});

/**
 * The exact seam key set `buildClaimsSeams(ON)` produces — i.e. the keys the
 * `...claimsSeams` spread MUST carry into the OPS composition. Derived from
 * `buildClaimsSeams` itself (not a hand-copied list), mirroring the customer-plane
 * boot guard, so a newly-added seam is AUTOMATICALLY required of the ops plane too.
 */
const SEAM_KEYS: readonly string[] = Object.keys(
  buildClaimsSeams({
    planner: {} as unknown as ClaimAwarePlannerPort,
    env: { [CLAIMS_PIPELINE_ENABLED_ENV]: "true" } as NodeJS.ProcessEnv,
    warn: () => {},
  }),
);

/** Minimal deps sufficient to reach every composition call under test. */
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

interface ComposedOps {
  readonly responderDeps: Record<string, unknown>;
  readonly plannerDeps: Record<string, unknown>;
  readonly conductorOptions: Record<string, unknown>;
}

/** Compose the REAL ops conductor and return what each factory was handed. */
function composed(): ComposedOps {
  createIbatexasResponderSpy.mockClear();
  createIbatexasPlannerSpy.mockClear();
  createConductorSpy.mockClear();
  composeOpsConductor(minimalOpsDeps() as never, {
    staffId: "owner-1",
    role: "OWNER",
  });
  expect(createIbatexasResponderSpy).toHaveBeenCalledTimes(1);
  expect(createIbatexasPlannerSpy).toHaveBeenCalledTimes(1);
  expect(createConductorSpy).toHaveBeenCalledTimes(1);
  return {
    responderDeps: createIbatexasResponderSpy.mock.calls[0]![0],
    plannerDeps: createIbatexasPlannerSpy.mock.calls[0]![0],
    conductorOptions: createConductorSpy.mock.calls[0]![0],
  };
}

describe("composeOpsConductor — LE2 decision 6: the ops plane CONVERGES on the claims pipeline", () => {
  const saved = process.env[CLAIMS_PIPELINE_ENABLED_ENV];
  beforeEach(() => {
    createIbatexasResponderSpy.mockClear();
    createIbatexasPlannerSpy.mockClear();
    createConductorSpy.mockClear();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[CLAIMS_PIPELINE_ENABLED_ENV];
    else process.env[CLAIMS_PIPELINE_ENABLED_ENV] = saved;
  });

  describe("flag ON", () => {
    beforeEach(() => {
      process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
    });

    it("the ops responder IS composed WITH the safe-unknown gate (D5 dissolved)", () => {
      const { responderDeps } = composed();
      expect(responderDeps).toHaveProperty("safeUnknown");
      const safeUnknown = responderDeps.safeUnknown as {
        gate: (t: string) => boolean;
        render: (s: unknown, t: string) => string;
      };
      expect(typeof safeUnknown.gate).toBe("function");
      expect(typeof safeUnknown.render).toBe("function");
    });

    it("the gate is the real discriminator: factual questions degrade, small talk NEVER does", () => {
      const { responderDeps } = composed();
      const { gate } = responderDeps.safeUnknown as { gate: (t: string) => boolean };
      // A staff factual question — the prose fall-through this closes.
      expect(gate("estamos abertos?")).toBe(true);
      expect(gate("qual o horário de funcionamento hoje?")).toBe(true);
      // Small talk stays natural (decision 6 keeps the raw-prose path for it).
      expect(gate("oi, tudo bem?")).toBe(false);
      expect(gate("valeu, obrigado!")).toBe(false);
    });

    it("the ops render is the proposition-free pt-BR abstain, WITHOUT the customer pickup offer", () => {
      const { responderDeps } = composed();
      const { render } = responderDeps.safeUnknown as {
        render: (s: unknown, t: string) => string;
      };
      const closedHoursQuestion = render(
        { isClosed: true, nextOpenDay: "amanhã" },
        "estamos abertos?",
      );
      expect(closedHoursQuestion).toBe(
        "Não localizei essa informação confirmada agora. Quer que eu verifique?",
      );
      // The customer-copy scheduled-pickup OFFER must never be voiced at the staff
      // member who RUNS the store (see SafeUnknownGateOptions.closedHoursOffer).
      expect(closedHoursQuestion).not.toContain("retirada agendada");
      expect(render(undefined, "estamos abertos?")).toBe(closedHoursQuestion);
    });

    it("EVERY claims seam buildClaimsSeams produces is spread into the ops conductor", () => {
      const { conductorOptions } = composed();
      expect(SEAM_KEYS.length).toBeGreaterThan(0);
      for (const key of SEAM_KEYS) {
        expect(conductorOptions[key], `ops claims seam '${key}' not composed`).toBeDefined();
      }
      // The four the ticket names explicitly, so a rename of the derived set can
      // never silently drop one of them.
      expect(conductorOptions.investigator).toBeDefined();
      expect(conductorOptions.claimPlanner).toBeDefined();
      expect(conductorOptions.claimsKernel).toBeDefined();
      expect(conductorOptions.claimsRenderer).toBeDefined();
    });

    it("the CLAIM path gets the claim-framed persona, NOT the staff intent persona", () => {
      const { plannerDeps } = composed();
      // The intent path keeps the ops persona (staffEnvelopeActor + ops verbs)…
      expect(plannerDeps.system).toContain(OPS_PLANNER_PERSONA);
      // …while the claim path is given its own prompt. Inheriting `system` here
      // would suppress `propose_claim` on a 4B — zero candidates, silent prose.
      expect(typeof plannerDeps.claimPlannerSystem).toBe("string");
      expect(plannerDeps.claimPlannerSystem).not.toBe(plannerDeps.system);
      expect(plannerDeps.claimPlannerSystem).toContain("propose_claim");
      expect(plannerDeps.claimPlannerSystem).toContain("STORE_OPEN_NOW");
    });

    it("the staff-actor envelope seam is preserved EXACTLY through convergence", () => {
      const { plannerDeps } = composed();
      expect(plannerDeps.staffEnvelopeActor).toEqual({
        staffId: "owner-1",
        role: "OWNER",
      });
    });

    it("the BKL-100 read-answer governor SURVIVES convergence (it still runs first)", () => {
      const { responderDeps } = composed();
      expect(responderDeps).toHaveProperty("readAnswer");
      const readAnswer = responderDeps.readAnswer as Record<string, unknown>;
      expect(typeof readAnswer.render).toBe("function");
      expect(typeof readAnswer.renderAction).toBe("function");
      expect(typeof readAnswer.governGrounded).toBe("function");
    });
  });

  describe("flag OFF (the committed default) — byte-identical to the pre-LE2 composition", () => {
    beforeEach(() => {
      delete process.env[CLAIMS_PIPELINE_ENABLED_ENV];
    });

    it("no safe-unknown gate on the ops responder", () => {
      expect("safeUnknown" in composed().responderDeps).toBe(false);
    });

    it("NO claims seam reaches the ops conductor", () => {
      const { conductorOptions } = composed();
      for (const key of SEAM_KEYS) {
        expect(
          key in conductorOptions,
          `claims seam '${key}' leaked into a flag-OFF ops composition`,
        ).toBe(false);
      }
    });

    it("the deterministic ops governors + staff actor are untouched", () => {
      const { responderDeps, plannerDeps } = composed();
      expect(responderDeps).toHaveProperty("readAnswer");
      expect(responderDeps.conversationalRefusal).toBe(true);
      expect(plannerDeps.staffEnvelopeActor).toEqual({
        staffId: "owner-1",
        role: "OWNER",
      });
    });

    it("a literal non-'true' flag value is treated as OFF", () => {
      process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "1";
      const { responderDeps, conductorOptions } = composed();
      expect("safeUnknown" in responderDeps).toBe(false);
      expect("investigator" in conductorOptions).toBe(false);
    });
  });
});
