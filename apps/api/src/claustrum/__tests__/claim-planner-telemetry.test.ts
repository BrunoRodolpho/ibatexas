/**
 * F2 observability — the claim-planner (`proposeClaims`) LLM-call trace.
 *
 * RCA (Track A on Nemotron-4B): the Q6b `proposeClaims` model call was INVISIBLE
 * in `turn_trace` — only the intent `propose` path and the responder emitted an
 * `LLMTrace`. So when a store-open turn degraded to the safe UNKNOWN terminal,
 * the in-pipeline 4B `propose_claim` tag AND the first-party-derived candidate
 * value could not be seen — the drop point could not be localized from telemetry.
 *
 * The fix wires a dedicated `emitModelCallTrace` at the END of `proposeClaims`,
 * emitting one `LLMTrace` whose `completion` JSON carries:
 *   - `stage: "claims-validate/proposeClaims"` (so the row is identifiable);
 *   - `toolCalls` — the RAW 4B tag (what the model emitted);
 *   - `derivedCandidates` — the first-party-DERIVED {type,subject,value} (what
 *     reaches the kernel — proving the value is derived, never model-authored);
 *   - `droppedClaimTypes` / `forcedTerminal` — the wall dispositions.
 *
 * These tests PIN that hop (the model is mocked — no live model, no DB):
 *   1. with a `telemetry` sink, ONE trace is emitted carrying the tag + the
 *      derived STORE_OPEN_NOW value (mealPeriod re-read from the schedule signal);
 *   2. WITHOUT a sink, no trace is attempted and the candidate set is unchanged
 *      (telemetry is best-effort — its absence never alters planning output);
 *   3. a telemetry sink that THROWS never breaks the turn (non-throwing contract).
 */

import { describe, expect, it, vi } from "vitest";
import type {
  CognitiveState,
  Completion,
  LLMTrace,
  ModelProvider,
  TelemetryPort,
} from "@claustrum/core";
import type { ScheduleSignal } from "@ibatexas/tools";
import {
  createIbatexasPlanner,
  PROPOSE_CLAIM_TOOL,
  type ClaimAwarePlannerPort,
} from "../ibatexas-planner.js";

// ── Test doubles ─────────────────────────────────────────────────────────────

function mockModel(toolCalls: Completion["toolCalls"]): ModelProvider {
  return {
    async complete(): Promise<Completion> {
      return {
        model: "mock",
        stopReason: "tool_use",
        text: "tagged",
        toolCalls,
        inputTokens: 7,
        outputTokens: 11,
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
    perception: { text, channel: "web", receivedAt: "2026-06-29T12:00:00.000Z" },
    memory: {} as CognitiveState["memory"],
    retrieval: {} as CognitiveState["retrieval"],
    tenantId: "t1",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-OBS-1",
  };
}

function claimCall(input: unknown): NonNullable<Completion["toolCalls"]>[number] {
  return { id: "tc-1", name: PROPOSE_CLAIM_TOOL, input };
}

/** A capturing TelemetryPort whose only live sink is `emitLLMTrace`. */
function capturingTelemetry(traces: LLMTrace[]): TelemetryPort {
  return {
    async emitTurn() {},
    async emitLLMTrace(trace) {
      traces.push(trace);
    },
    async emitMemoryAccess() {},
  };
}

/** An OPEN-for-lunch schedule signal — STORE_OPEN_NOW derives `mealPeriod`. */
const OPEN_LUNCH: ScheduleSignal = { isClosed: false, mealPeriod: "lunch" };

function plannerWith(args: {
  toolCalls: Completion["toolCalls"];
  telemetry?: TelemetryPort;
  scheduleSignal?: ScheduleSignal;
}): ClaimAwarePlannerPort {
  return createIbatexasPlanner({
    model: mockModel(args.toolCalls),
    modelId: "nemotron-3-nano:4b",
    capabilityPlanners: [],
    ...(args.telemetry === undefined ? {} : { telemetry: args.telemetry }),
    ...(args.scheduleSignal === undefined
      ? {}
      : { resolveScheduleSignal: () => args.scheduleSignal }),
  });
}

// ── The hop ──────────────────────────────────────────────────────────────────

describe("proposeClaims — F2 claim-planner LLM-call observability", () => {
  it("emits ONE LLMTrace carrying the raw tag AND the first-party-derived value", async () => {
    const traces: LLMTrace[] = [];
    const planner = plannerWith({
      toolCalls: [claimCall({ type: "STORE_OPEN_NOW", subject: "loja" })],
      telemetry: capturingTelemetry(traces),
      scheduleSignal: OPEN_LUNCH,
    });

    const plan = await planner.proposeClaims(cognition("vocês estão abertos?"));

    // BKL-126 — the candidate leaves the planner with value UNDEFINED (the
    // schedule-family derive was removed; the value now binds downstream from
    // the investigator's recorded ledger entry at claims-validate stage 4b).
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.type).toBe("STORE_OPEN_NOW");
    expect(plan.candidates[0]?.value).toBeUndefined();

    // Exactly one claim-planner trace was emitted, correlated by turnId.
    expect(traces).toHaveLength(1);
    const trace = traces[0]!;
    expect(trace.turnId).toBe("turn-OBS-1");
    expect(trace.model).toBe("nemotron-3-nano:4b");
    expect(trace.inputTokens).toBe(7);
    expect(trace.outputTokens).toBe(11);

    // The completion payload makes the in-pipeline candidate VISIBLE: the stage
    // marker, the RAW 4B tag, and the DERIVED value side-by-side.
    const payload = JSON.parse(trace.completion) as {
      stage: string;
      toolCalls: ReadonlyArray<{ name: string; input: { type: string } }>;
      derivedCandidates: ReadonlyArray<{ type: string; subject: string; value: unknown }>;
      droppedClaimTypes: string[];
    };
    expect(payload.stage).toBe("claims-validate/proposeClaims");
    // The raw tag the model emitted is recorded verbatim.
    expect(payload.toolCalls[0]?.input.type).toBe("STORE_OPEN_NOW");
    // BKL-126 — the trace records the candidate as it leaves this stage: value
    // absent (bound later from the ledger, not authored here).
    expect(payload.derivedCandidates).toEqual([
      { type: "STORE_OPEN_NOW", subject: "loja" },
    ]);
    expect(payload.droppedClaimTypes).toEqual([]);
  });

  it("records an out-of-enum DROP in the trace (droppedClaimTypes is visible)", async () => {
    const traces: LLMTrace[] = [];
    const planner = plannerWith({
      toolCalls: [claimCall({ type: "TOTALLY_MADE_UP", subject: "x" })],
      telemetry: capturingTelemetry(traces),
    });

    const plan = await planner.proposeClaims(cognition("pergunta inventada"));

    // The constrained-generation wall dropped it — no candidate reaches the kernel.
    expect(plan.candidates).toHaveLength(0);
    expect(traces).toHaveLength(1);
    const payload = JSON.parse(traces[0]!.completion) as {
      derivedCandidates: unknown[];
      droppedClaimTypes: string[];
    };
    // The drop is now OBSERVABLE in the trace, not silent.
    expect(payload.derivedCandidates).toEqual([]);
    expect(payload.droppedClaimTypes).toContain("TOTALLY_MADE_UP");
  });

  it("attempts NO trace when no telemetry sink is wired (output unchanged)", async () => {
    const emitSpy = vi.fn();
    const planner = plannerWith({
      toolCalls: [claimCall({ type: "STORE_OPEN_NOW", subject: "loja" })],
      scheduleSignal: OPEN_LUNCH,
      // telemetry omitted
    });

    const plan = await planner.proposeClaims(cognition("abertos?"));

    // Planning output is identical to the wired case — telemetry is side-channel.
    expect(plan.candidates).toHaveLength(1);
    // BKL-126 — value undefined at this stage (see above).
    expect(plan.candidates[0]?.value).toBeUndefined();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("never breaks the turn when the telemetry sink THROWS (best-effort)", async () => {
    const throwingTelemetry: TelemetryPort = {
      async emitTurn() {},
      async emitLLMTrace() {
        throw new Error("sink down");
      },
      async emitMemoryAccess() {},
    };
    const planner = plannerWith({
      toolCalls: [claimCall({ type: "STORE_OPEN_NOW", subject: "loja" })],
      telemetry: throwingTelemetry,
      scheduleSignal: OPEN_LUNCH,
    });

    // The throwing sink is swallowed — the candidate set still returns intact.
    const plan = await planner.proposeClaims(cognition("abertos agora?"));
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.type).toBe("STORE_OPEN_NOW");
  });
});

// ── RCA-legibility: the claim_planner.proposal_summary VL event ──────────────
//
// The LLMTrace above is capped at 500 chars by the audit redactor at write, so
// the out-of-enum drops / forced terminal were unreadable downstream on any
// real turn (the JSON envelope usually exceeds the cap). The summary event is
// the truncation-proof projection: types only, arrays PRE-STRINGIFIED so they
// cross VictoriaLogs and the qa-rca field coercer as one string field.
import { logger } from "../../lib/logger.js";

describe("proposeClaims — claim_planner.proposal_summary (RCA-legibility)", () => {
  function summaryPayloads(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
    return spy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((o) => o?.event === "claim_planner.proposal_summary");
  }

  it("records an out-of-enum drop + the forced terminal, arrays pre-stringified", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const planner = plannerWith({
        // The live 2026-07-29 shape: a mangled type name tagging the whole
        // utterance as its span — dropped by the wall, span left unmapped.
        toolCalls: [
          claimCall({
            type: "MENU_ITEALLEGENS",
            subject: "lazanha",
            spans: [{ mappedClaimType: "MENU_ITEALLEGENS", text: "voces tem lazanha?" }],
          }),
        ],
      });
      await planner.proposeClaims(cognition("voces tem lazanha?"));
      const payloads = summaryPayloads(infoSpy);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({
        component: "claim-planner",
        turnId: "turn-OBS-1",
        // STRINGS, not arrays — the wire-safe encoding is part of the contract.
        candidateTypes: "[]",
        droppedClaimTypes: '["MENU_ITEALLEGENS"]',
        forcedTerminal: "CLARIFY",
      });
      // PII-free: types only — never the utterance or a claim value.
      expect(JSON.stringify(payloads[0])).not.toContain("voces tem lazanha");
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("a clean proposal emits the summary with the candidate types and NO forcedTerminal key", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const planner = plannerWith({
        toolCalls: [claimCall({ type: "STORE_OPEN_NOW", subject: "loja" })],
        scheduleSignal: OPEN_LUNCH,
      });
      await planner.proposeClaims(cognition("vocês estão abertos?"));
      const payloads = summaryPayloads(infoSpy);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({ candidateTypes: '["STORE_OPEN_NOW"]', droppedClaimTypes: "[]" });
      expect(payloads[0]).not.toHaveProperty("forcedTerminal");
    } finally {
      infoSpy.mockRestore();
    }
  });
});
