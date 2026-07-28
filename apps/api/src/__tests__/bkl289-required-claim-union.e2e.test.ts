// BKL-289 — the §O#15 NEVER-OMIT-REQUIRED union, proven at the REAL customer turn
// seam with a model that OMITS the required companion.
//
// THE LIVE DEFECT (turns 246f1d64 / 1539337c / c6ff25ca, 2026-07-28): "qual o horário
// de funcionamento?" decomposes to required {STORE_OPEN_NOW} (span STORE_OPEN_NOW_Q),
// the 4B proposes ONLY STORE_HOURS (byte-identically across drives), STORE_HOURS
// VALIDATES against live Redis — and the §O#15 completeness gate
// (claims-renderer-adapter.ts:322-324) degrades the whole turn to the safe-unknown
// self-report, throwing the validated answer away. The sole prior defense was the
// probabilistic persona line (personas.ts:133-135) whose own header documents this
// exact trap: a PROMPT guarding a DETERMINISTIC requirement.
//
// WHY THE EXISTING SUITE COULD NOT CATCH IT (the sampling-gates class): every pin in
// `customer-hours-claims.e2e.test.ts` SCRIPTS THE PAIR, so the model in that suite is
// structurally incapable of the omission that breaks production. This file scripts the
// OMISSION — the exact live shape — which is what makes the revert-to-red honest.
//
// Real customer `handleTurn` through `composeCustomerConductor({ withClaims: true })`:
// real planner, real resolver, real claims seams (investigator, claim planner, claims
// kernel, render-from-claims renderer, precedence lattice). The only fakes are the
// ModelProvider and the claims pipeline's single IO boundary — the same fake surface
// the BKL-234 suite uses.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";

const { scheduleBackend } = vi.hoisted(() => ({
  scheduleBackend: {
    signal: { isClosed: false, mealPeriod: "dinner" } as unknown,
    hours: { hoursText: "11h–15h / 18h–23h" } as unknown,
    holiday: null as unknown,
    // BKL-289 degrade control: when true, the STORE_OPEN_NOW read ERRORS, so the
    // UNIONED candidate cannot validate while STORE_HOURS still can.
    failOpenNowRead: false,
  },
}));

vi.mock("../claustrum/turn-reads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claustrum/turn-reads.js")>();
  const notUsed = (name: string) => async (): Promise<never> => {
    throw new Error(`turn-reads.${name} must not run in this suite`);
  };
  return {
    ...actual,
    createDomainTriadReadBackend: () => ({
      readSchedule: async () => {
        if (scheduleBackend.failOpenNowRead) {
          throw new Error("schedule signal unavailable (constructed BKL-289 control)");
        }
        return scheduleBackend.signal;
      },
      readScheduleOverride: async () => null,
      readStoreHours: async () => scheduleBackend.hours,
      readHoliday: async () => scheduleBackend.holiday,
      readHoursForDate: async () => ({ hoursText: "11h–15h / 18h–23h" }),
      readHolidayForDate: async () => null,
      readScheduleOverrideForDate: async () => null,
      readOrderFulfillment: notUsed("readOrderFulfillment"),
      readPaymentStatus: notUsed("readPaymentStatus"),
      readReservation: notUsed("readReservation"),
      readPaymentRefund: notUsed("readPaymentRefund"),
      readPaymentChargeback: notUsed("readPaymentChargeback"),
      readCartContents: notUsed("readCartContents"),
      readOrderHistory: notUsed("readOrderHistory"),
      readPaymentHistory: notUsed("readPaymentHistory"),
      // A guest asking about hours owns nothing; present-with-0 keeps §O#15 from
      // force-requiring an order companion.
      listActiveOrderIds: async () => [],
      listActiveReservationIds: async () => [],
      countActivePayments: async () => 0,
    }),
  };
});

const {
  composeCustomerConductor,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulCustomerSession,
  runCustomerTurn,
} = await import("./customer-e2e-harness.js");

const HOURS_RENDER = "Hoje nosso horário de funcionamento é: 11h–15h / 18h–23h.";
const OPEN_RENDER = "No momento, o período de funcionamento é: jantar.";
const SAFE_UNKNOWN = "Não localizei essa informação confirmada agora. Quer que eu verifique?";

/** Claim-planner-only scripted model: the intent leg proposes nothing. */
function claimsScriptedModel(
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>,
): ModelProvider {
  return {
    complete: vi.fn(async (req: CompletionRequest): Promise<Completion> => {
      const toolNames = (req.tools ?? []).map((t) => t.name);
      const base = {
        model: "mock",
        stopReason: "end_turn",
        inputTokens: 5,
        outputTokens: 4,
      } as const;
      if (toolNames.includes(PROPOSE_CLAIM_TOOL)) {
        return {
          ...base,
          text: "",
          toolCalls: claims.map((c, i) => ({
            id: `claim-${i}`,
            name: PROPOSE_CLAIM_TOOL,
            input: { ...c },
          })),
        };
      }
      return { ...base, text: "ok (mock planner pass — nothing to propose)", toolCalls: [] };
    }),
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  } as unknown as ModelProvider;
}

let convSeq = 0;
async function runTurn(
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>,
  text = "qual o horário de funcionamento?",
): Promise<string> {
  convSeq += 1;
  const harness = composeCustomerConductor({
    model: claimsScriptedModel(claims),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
  });
  const out = await runCustomerTurn(harness, {
    customerId: `cust-bkl289-${convSeq}`,
    conversationId: `conv-bkl289-${convSeq}`,
    text,
  });
  return out.response;
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  scheduleBackend.signal = { isClosed: false, mealPeriod: "dinner" };
  scheduleBackend.hours = { hoursText: "11h–15h / 18h–23h" };
  scheduleBackend.holiday = null;
  scheduleBackend.failOpenNowRead = false;
});

describe("BKL-289 — a model that OMITS the required companion still answers", () => {
  // THE REVERT-TO-RED ANCHOR. Remove the union block in ibatexas-claim-planner.ts and
  // this reverts to SAFE_UNKNOWN — the live degrade copy, verbatim.
  //
  // NON-VACUITY: the scripted model proposes STORE_HOURS *alone*. STORE_HOURS is not in
  // any REQUIRED_CLAIM_CLOSURE row (it is additive-only, BKL-121 D3), so the required
  // set for this utterance is exactly {STORE_OPEN_NOW} — a type the model never names.
  // Nothing but the deterministic union can put it in the candidate set.
  it("LIVE SHAPE: STORE_HOURS proposed ALONE renders validated hours + open-now", async () => {
    const response = await runTurn([{ type: "STORE_HOURS", subject: "loja" }]);

    expect(response).toContain(HOURS_RENDER);
    // The unioned STORE_OPEN_NOW did not merely appear — it VALIDATED off the
    // first-party ledger read and rendered its own proposition.
    expect(response).toContain(OPEN_RENDER);
    expect(response).not.toBe(SAFE_UNKNOWN);
  });

  it("the union is INDEPENDENT of the model's subject string", async () => {
    const viaLoja = await runTurn([{ type: "STORE_HOURS", subject: "loja" }]);
    const viaOutro = await runTurn([{ type: "STORE_HOURS", subject: "restaurante" }]);

    expect(viaLoja).toBe(viaOutro);
    expect(viaLoja).toContain(HOURS_RENDER);
  });

  it("CLOSED store: the omitted companion still unions and reports closed", async () => {
    scheduleBackend.signal = { isClosed: true, mealPeriod: "closed" };

    const response = await runTurn([{ type: "STORE_HOURS", subject: "loja" }]);

    expect(response).toContain(HOURS_RENDER);
    expect(response).toContain("fechado");
    expect(response).not.toBe(SAFE_UNKNOWN);
  });

  // §O#15 UNWEAKENED. The union proposes; it never asserts. When the unioned candidate
  // CANNOT validate (its first-party read errors), the completeness gate degrades the
  // turn exactly as it does today for an ABSENT required type — and the VALIDATED
  // STORE_HOURS must NOT leak past that degrade.
  it("DEGRADE STILL WORKS: a unioned candidate that fails validation degrades the turn", async () => {
    scheduleBackend.failOpenNowRead = true;

    const response = await runTurn([{ type: "STORE_HOURS", subject: "loja" }]);

    expect(response).toBe(SAFE_UNKNOWN);
    expect(response).not.toContain(HOURS_RENDER);
  });

  // The union must not resurrect a turn the model correctly said nothing about: an
  // EMPTY successful proposal stays empty (BKL-078's documented gap / BKL-110's
  // prose-preservation contract), because the §O#15 gate never runs on an empty set.
  it("EMPTY successful proposal is NOT unioned into (prose gate preserved)", async () => {
    const response = await runTurn([]);

    expect(response).not.toContain(HOURS_RENDER);
    expect(response).not.toContain(OPEN_RENDER);
  });
});
