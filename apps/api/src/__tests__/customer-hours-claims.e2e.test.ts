// BKL-234 — the CUSTOMER-plane turn-seam proof of the schedule-cluster co-render.
//
// The consistency table is PLANE-INDEPENDENT: both conductors compose the same
// `createIbatexasClaimsKernelDeps`, so the §O#1 default-deny that blocked an ops hours
// answer blocked the CUSTOMER one identically. BKL-121's hours feature had only ever
// been proven at the kernel level (`tracka-store-hours.test.ts`, which drives
// `runClaimsKernel` over a hand-built ledger) — no turn-seam test anywhere asserted the
// hours render, which is why a plane-wide defect went unnoticed. This suite closes that
// gap on the customer side; `ops/__tests__/ops-hours-read.e2e.test.ts` is its ops twin.
//
// Real customer `handleTurn` through `composeCustomerConductor({ withClaims: true })` —
// real planner, real resolver, real tool registry, real claims seams (investigator,
// claim planner, claims kernel, render-from-claims renderer, precedence lattice). The
// only fakes are the ModelProvider and the claims pipeline's single IO boundary.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";

const { scheduleBackend } = vi.hoisted(() => ({
  scheduleBackend: {
    signal: { isClosed: false, mealPeriod: "dinner" } as unknown,
    hours: { hoursText: "11h–15h / 18h–23h" } as unknown,
    holiday: null as unknown,
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
      readSchedule: async () => scheduleBackend.signal,
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
const ESCALATE_COPY =
  "Não consegui confirmar isso com segurança agora — vou encaminhar para um atendente verificar. Posso ajudar em mais alguma coisa?";

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

async function runHoursTurn(
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>,
  text = "qual o horário de funcionamento?",
): Promise<string> {
  const harness = composeCustomerConductor({
    model: claimsScriptedModel(claims),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
  });
  const out = await runCustomerTurn(harness, {
    customerId: "cust-hours-1",
    conversationId: "conv-hours-1",
    text,
  });
  return out.response;
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  scheduleBackend.signal = { isClosed: false, mealPeriod: "dinner" };
  scheduleBackend.hours = { hoursText: "11h–15h / 18h–23h" };
  scheduleBackend.holiday = null;
});

describe("BKL-234 — customer plane renders the schedule cluster together", () => {
  // The SAME subject the customer persona instructs ("loja") — the case that used to
  // hit §O#1 default-deny and deliver the escalation copy on this plane too.
  it("SAME SUBJECT: hours + open-now co-render, no default-deny ESCALATE", async () => {
    const response = await runHoursTurn([
      { type: "STORE_HOURS", subject: "loja" },
      { type: "STORE_OPEN_NOW", subject: "loja" },
    ]);

    expect(response).toContain(HOURS_RENDER);
    expect(response).toContain(OPEN_RENDER);
    expect(response).not.toBe(ESCALATE_COPY);
  });

  it("DISTINCT SUBJECTS render the identical reply — no dependence on the model's string", async () => {
    const same = await runHoursTurn([
      { type: "STORE_HOURS", subject: "loja" },
      { type: "STORE_OPEN_NOW", subject: "loja" },
    ]);
    const distinct = await runHoursTurn([
      { type: "STORE_HOURS", subject: "loja" },
      { type: "STORE_OPEN_NOW", subject: "restaurante" },
    ]);

    expect(same).toBe(distinct);
    expect(same).toContain(HOURS_RENDER);
  });

  it("CLOSED: today's hours still render beside the closed period", async () => {
    scheduleBackend.signal = { isClosed: true, mealPeriod: "closed" };

    const response = await runHoursTurn([
      { type: "STORE_HOURS", subject: "loja" },
      { type: "STORE_OPEN_NOW", subject: "loja" },
    ]);

    expect(response).toContain(HOURS_RENDER);
    expect(response).toContain("fechado");
    expect(response).not.toBe(ESCALATE_COPY);
  });

  // An OFF-CLUSTER companion that cannot validate degrades the turn, and the hours
  // fact must NOT leak past that degrade.
  //
  // HONESTY NOTE — this is deliberately NOT the §O#1 default-deny negative control,
  // and must not be read as one. MENU_OVERVIEW has no catalog read in this suite, so
  // it resolves ABSENT → UNKNOWN and is dropped by the §D filter BEFORE P2; the turn
  // then degrades on §O#15 (MENU_OVERVIEW_Q required it) and returns the abstain, NOT
  // the ESCALATE copy. Asserting "no ESCALATE" here would therefore pass for the wrong
  // reason. The real, NON-VACUOUS default-deny control — both members VALIDATED, then
  // suppressed with reason UNMODELLED_SAME_SUBJECT — is in
  // `claustrum/__tests__/ibatexas-claims-kernel-deps.test.ts`, driven through the real
  // published `checkConsistency`, which is the only level at which both members of an
  // arbitrary pair can be forced to VALIDATE.
  it("an unvalidatable OFF-CLUSTER companion degrades the turn — hours do not leak", async () => {
    const response = await runHoursTurn(
      [
        { type: "STORE_HOURS", subject: "loja" },
        { type: "MENU_OVERVIEW", subject: "loja" },
      ],
      "qual o horário de funcionamento e o que tem no cardápio?",
    );

    expect(response).toBe(
      "Não localizei essa informação confirmada agora. Quer que eu verifique?",
    );
    expect(response).not.toContain(HOURS_RENDER);
  });
});
