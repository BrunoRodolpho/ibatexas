// ops-grounded-recovery — BKL-262 STAGE 2 (owner ruling: option (c)).
//
// Stage 1 fixed the RANKING for the write-twin case: a mis-parsed question whose
// twin read validated now renders that validated answer (lattice rule 2a). Stage 2
// closes everything that still FALLS THROUGH to the ops REFUSE-recovery branch.
//
// THE SURFACE BEING CLOSED. That branch used to SYNTHESISE the reply with the
// model, gated only by REFUSAL_RECOVERY_SUCCESS_RE — a false-SUCCESS LEXICON. A
// lexicon catches "pronto, alterei"; it cannot catch a fabricated statement of
// FACT, which carries no success word at all. That is precisely how BKL-262's two
// live proofs shipped. Stage 2 removes the model call from the branch entirely:
// the recovery reply is COMPOSED from the deterministic refusal, plus a grounded
// read render when a real read happened, plus the proposition-free epistemic
// self-report when the turn was question-shaped and nothing was read.
//
// THE FALL-THROUGH TAXONOMY (every case rule 2a does NOT rescue):
//   A. un-twinned refused kind          — payment.refund.issue, claims validated
//   B. twin kind, span never fired      — order.note.add on an hours question
//   C. claims degraded to UNKNOWN       — the read errored, nothing validated
//   D. genuine refused MUTATION         — the Stage-1 counter-case
//   E. SECURITY / AUTH refusal          — must STILL skip recovery entirely
//
// In A-D the model is armed with a fabricated fact on every single turn, and the
// assertion is that it never reaches the operator.
//
// What is faked: the ModelProvider (scripted) and the claims pipeline's ONE
// external IO boundary. The responder, resolver, kernel, router, precedence
// lattice and conductor are PRODUCTION code, driven through a real `handleTurn`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../../claustrum/claims-pipeline.js";

const { scheduleBackend } = vi.hoisted(() => ({
  scheduleBackend: {
    signal: { isClosed: false, mealPeriod: "dinner" } as unknown,
    hours: { hoursText: "11h–15h / 18h–23h" } as unknown,
    hoursThrows: false,
    scheduleThrows: false,
  },
}));

vi.mock("../../claustrum/turn-reads.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../claustrum/turn-reads.js")>();
  const notUsed = (name: string) => async (): Promise<never> => {
    throw new Error(`turn-reads.${name} must not run in this suite`);
  };
  return {
    ...actual,
    createDomainTriadReadBackend: () => ({
      readSchedule: async () => {
        if (scheduleBackend.scheduleThrows) throw new Error("schedule store unavailable");
        return scheduleBackend.signal;
      },
      readScheduleOverride: async () => null,
      readStoreHours: async () => {
        if (scheduleBackend.hoursThrows) throw new Error("schedule store unavailable");
        return scheduleBackend.hours;
      },
      readHoliday: async () => null,
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
      listActiveOrderIds: async () => [],
      listActiveReservationIds: async () => [],
      countActivePayments: async () => 0,
    }),
  };
});

const { createOpsResolver } = await import("../ops-resolver.js");
const {
  buildOpsTools,
  composeOpsDeps,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulSession,
  runOpsTurn,
} = await import("./ops-e2e-harness.js");

/** The proposition-free epistemic self-report (the BKL-184 abstain+offer shape). */
const SAFE_UNKNOWN =
  "Não localizei essa informação confirmada agora. Quer que eu verifique?";
/** The VALIDATED STORE_HOURS render. */
const HOURS_RENDER = "Hoje nosso horário de funcionamento é: 11h–15h / 18h–23h.";

/**
 * THE FABRICATED FACT, verbatim from the BKL-234 pin-down. Every turn in this
 * suite arms the model with it. It carries NO success word, so the false-SUCCESS
 * lexicon passes it clean — which is exactly why a lexicon was never sufficient
 * and why Stage 2 had to remove the synthesis rather than filter it harder.
 */
const FABRICATED_HOURS = "Funcionamos todos os dias das 10h às 22h!";

const SCHEDULE_PAIR = [
  { type: "STORE_HOURS", subject: "loja" },
  { type: "STORE_OPEN_NOW", subject: "loja" },
] as const;

const expressIntent = (capability: string, payload: unknown) => ({
  id: "tc-1",
  name: "express_intent",
  input: { capability, payload },
});

function claimsScriptedModel(opts: {
  readonly intentCalls?: ReadonlyArray<{ id: string; name: string; input: unknown }>;
  readonly claims?: ReadonlyArray<{ readonly type: string; readonly subject: string }>;
  readonly responderText?: string;
}): ModelProvider & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (req: CompletionRequest): Promise<Completion> => {
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
        toolCalls: (opts.claims ?? []).map((claim, i) => ({
          id: `claim-${i}`,
          name: PROPOSE_CLAIM_TOOL,
          input: { ...claim },
        })),
      };
    }
    if (toolNames.length > 0) {
      const calls = opts.intentCalls ?? [];
      return {
        ...base,
        text: calls.length > 0 ? "" : "ok (mock planner pass — nothing to propose)",
        toolCalls: [...calls],
      };
    }
    return { ...base, text: opts.responderText ?? FABRICATED_HOURS, toolCalls: [] };
  });
  return {
    complete,
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  } as ModelProvider & { complete: ReturnType<typeof vi.fn> };
}

function buildDeps(model: ModelProvider) {
  const sink = makeCapturingAuditSink();
  const { tools } = buildOpsTools({}, sink);
  return {
    sink,
    deps: composeOpsDeps({
      adjudicator: makeAuditedAdjudicator({ sink }),
      session: makeStatefulSession(),
      tools,
      model,
      // The REAL resolver — the Stage-1 lesson: the identity-mapper stub yields a
      // guard_panic/SECURITY refusal, and SECURITY SKIPS recovery entirely, so the
      // stub would silently not exercise the branch under test here at all.
      buildResolver: (staffId: string) =>
        createOpsResolver({
          staffId,
          tenantId: "ibatexas",
          now: () => new Date("2026-07-04T12:00:00.000Z"),
          lookupProduct: async () => null,
          lookupOrder: async () => null,
          lookupActivePayment: async () => null,
          lookupSpecialProduct: async () => null,
          lookupAlert: async () => null,
          lookupIncident: async () => null,
        }),
    }),
  };
}

async function drive(model: ModelProvider, text: string) {
  const { deps, sink } = buildDeps(model);
  const out = await runOpsTurn(deps, { role: "OWNER", staffId: "owner1", text });
  return { out, sink };
}

/** The deterministic refusal the explainer rendered for this turn. */
const refusalOf = (out: { decision: unknown }): string => {
  const r = (out.decision as { refusal?: { userFacing?: string } }).refusal;
  expect(r?.userFacing).toBeTruthy();
  return r!.userFacing!;
};

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  scheduleBackend.signal = { isClosed: false, mealPeriod: "dinner" };
  scheduleBackend.hours = { hoursText: "11h–15h / 18h–23h" };
  scheduleBackend.hoursThrows = false;
  scheduleBackend.scheduleThrows = false;
});

// ── The invariant that spans the whole taxonomy ──────────────────────────────

describe("BKL-262 Stage 2 — model prose never ships from the REFUSE-recovery branch", () => {
  /**
   * Every fall-through class rule 2a does not rescue. In all four the model is
   * armed with the fabricated hours; in none of them may it reach the operator.
   */
  const FALL_THROUGH: ReadonlyArray<{
    readonly label: string;
    readonly text: string;
    readonly capability: string;
    readonly payload: unknown;
    readonly claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>;
    readonly breakReads?: boolean;
  }> = [
    {
      label: "A · un-twinned refused kind (claims validated)",
      text: "Qual horário de funcionamento?",
      capability: "payment.refund.issue",
      payload: { orderId: "order_4242", amountInCentavos: 5_000, reason: "x" },
      claims: [...SCHEDULE_PAIR],
    },
    {
      label: "B · twin kind whose declared span never fired",
      text: "Qual horário de funcionamento?",
      capability: "order.note.add",
      payload: { orderId: "x", note: "x" },
      claims: [...SCHEDULE_PAIR],
    },
    {
      label: "C · claims degraded to UNKNOWN (the read errored)",
      text: "Qual horário de funcionamento?",
      capability: "schedule.override.set",
      payload: { blocks: [], date: "amanhã", isOpen: true },
      claims: [...SCHEDULE_PAIR],
      breakReads: true,
    },
    {
      label: "D · a GENUINE refused mutation (the Stage-1 counter-case)",
      text: "muda o horário de amanhã para 10h às 22h",
      capability: "schedule.override.set",
      payload: { blocks: [], date: "amanhã", isOpen: true },
      claims: [...SCHEDULE_PAIR],
    },
  ];

  for (const c of FALL_THROUGH) {
    it(`${c.label}: the refusal LEADS and the fabricated fact never ships`, async () => {
      if (c.breakReads === true) {
        scheduleBackend.hoursThrows = true;
        scheduleBackend.scheduleThrows = true;
      }
      const model = claimsScriptedModel({
        intentCalls: [expressIntent(c.capability, c.payload)],
        claims: c.claims,
        responderText: FABRICATED_HOURS,
      });

      const { out } = await drive(model, c.text);

      expect(out.decision.kind).toBe("REFUSE");
      // 1. The refusal is the load-bearing sentence and it comes FIRST.
      expect(out.response.startsWith(refusalOf(out))).toBe(true);
      // 2. THE POINT: zero model-authored facts.
      expect(out.response).not.toContain(FABRICATED_HOURS);
      expect(out.response).not.toContain("10h");
      expect(out.response).not.toContain("22h");
    });
  }

  it("the model is never even ASKED to author a recovery reply", async () => {
    // Structural, not post-hoc: the branch makes NO responder completion at all,
    // which is what makes "no prose can ship" a property of the code path rather
    // than of a filter that has to be smart enough.
    const model = claimsScriptedModel({
      intentCalls: [
        expressIntent("schedule.override.set", {
          blocks: [],
          date: "amanhã",
          isOpen: true,
        }),
      ],
      claims: [...SCHEDULE_PAIR],
      responderText: FABRICATED_HOURS,
    });

    await drive(model, "muda o horário de amanhã para 10h às 22h");

    const responderCalls = model.complete.mock.calls.filter(
      (call: unknown[]) => ((call[0] as CompletionRequest).tools ?? []).length === 0,
    );
    expect(responderCalls).toHaveLength(0);
  });
});

// ── Composition: what the operator actually receives ─────────────────────────

describe("BKL-262 Stage 2 — the recovery reply is composed, never authored", () => {
  it("nothing validated + a question-shaped turn ⇒ the epistemic self-report", async () => {
    scheduleBackend.hoursThrows = true;
    scheduleBackend.scheduleThrows = true;
    const model = claimsScriptedModel({
      intentCalls: [
        expressIntent("schedule.override.set", {
          blocks: [],
          date: "amanhã",
          isOpen: true,
        }),
      ],
      claims: [...SCHEDULE_PAIR],
      responderText: FABRICATED_HOURS,
    });

    const { out } = await drive(model, "Qual horário de funcionamento?");

    // The refusal, then an abstention that asserts nothing about the world.
    expect(out.response).toBe(`${refusalOf(out)}\n\n${SAFE_UNKNOWN}`);
    // Inv 6 / §5: a safe terminal states no domain fact.
    expect(out.response).not.toContain("horário de funcionamento é");
  });

  it("a NON-question refused mutation gets the bare refusal — no gratuitous abstention", async () => {
    // "fecha a loja amanhã" is an imperative, not an information question, so the
    // self-report would be a non-sequitur. The refusal alone is the whole truth.
    const model = claimsScriptedModel({
      intentCalls: [
        expressIntent("schedule.override.set", {
          blocks: [],
          date: "amanhã",
          isOpen: true,
        }),
      ],
      responderText: FABRICATED_HOURS,
    });

    const { out } = await drive(model, "fecha a loja amanhã");

    expect(out.response).toBe(refusalOf(out));
  });
});

// ── SECURITY / AUTH must be untouched ────────────────────────────────────────

describe("BKL-262 Stage 2 — SECURITY refusals still skip recovery entirely", () => {
  it("a SECURITY refusal renders the verbatim line, with no composition appended", async () => {
    // The identity-mapper resolver reproduces a guard_panic ⇒ SECURITY refusal
    // (the Stage-1 finding, put to work as the SECURITY fixture). Tamper copy must
    // render verbatim — never paraphrased, and never decorated with an abstention.
    const sink = makeCapturingAuditSink();
    const { tools } = buildOpsTools({}, sink);
    const model = claimsScriptedModel({
      intentCalls: [expressIntent("order.note.add", { orderId: "x", note: "x" })],
      claims: [...SCHEDULE_PAIR],
      responderText: FABRICATED_HOURS,
    });
    const deps = composeOpsDeps({
      adjudicator: makeAuditedAdjudicator({ sink }),
      session: makeStatefulSession(),
      tools,
      model,
      buildResolver: () => ({
        resolve: async ({ plan }: { plan: { envelopes: readonly unknown[] } }) =>
          plan.envelopes.map((envelope) => ({ envelope, state: {} })),
      }),
    });

    const out = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner1",
      text: "Qual horário de funcionamento?",
    });

    const refusal = (out.decision as { refusal?: { kind?: string; userFacing?: string } })
      .refusal;
    expect(refusal?.kind).toBe("SECURITY");
    // VERBATIM — the whole reply, nothing appended.
    expect(out.response).toBe(refusal!.userFacing!);
    expect(out.response).not.toContain(SAFE_UNKNOWN);
    expect(out.response).not.toContain(FABRICATED_HOURS);
  });
});

// ── The lexicon survives as a tripwire ───────────────────────────────────────

describe("BKL-262 Stage 2 — the false-SUCCESS lexicon is retained as a tripwire", () => {
  it("still detects a success claim, so a drifted refusal string would be caught", async () => {
    const { refusalRecoveryClaimsSuccess } = await import(
      "../../claustrum/ibatexas-responder.js"
    );
    // It is no longer a gate on model prose (there is none), but it now asserts
    // that the COMPOSED deterministic text never states the refused action
    // succeeded. Pin that it still works, so retaining it is not a no-op.
    expect(refusalRecoveryClaimsSuccess("Pronto, alterei o horário.")).toBe(true);
    expect(refusalRecoveryClaimsSuccess("Não foi possível processar esta operação.")).toBe(
      false,
    );
    expect(refusalRecoveryClaimsSuccess(HOURS_RENDER)).toBe(false);
    expect(refusalRecoveryClaimsSuccess(SAFE_UNKNOWN)).toBe(false);
  });
});
