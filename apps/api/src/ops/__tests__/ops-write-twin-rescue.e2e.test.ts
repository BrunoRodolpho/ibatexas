// ops-write-twin-rescue — BKL-262 STAGE 1: THE TURN-SEAM PROOF.
//
// BKL-262 is the row LE2-013 and BKL-234 both landed on: a staff QUESTION that the
// planner mis-parses into a MUTATION is kernel-REFUSEd, and the refusal then HIJACKS
// the reply with raw model prose. Both live proofs are reproduced here at the REAL ops
// turn seam (real `composeOpsConductor` + real `handleTurn` + real composed router +
// real audited kernel + real ops tool registry), asserting the DELIVERED REPLY.
//
// ── The two measured cases ───────────────────────────────────────────────────
//   · LE2-013 (turn 3eee7d6c-2e5e): "entregam em Ibaté?" → `order.note.add` (the
//     question text stuffed into `orderId`) → kernel REFUSE → the operator was told
//     "Não, a loja está fechada…" on a coverage question whose ground truth was Sim.
//   · BKL-234 (production-code-verified against the REAL createOpsResolver): "Qual
//     horário de funcionamento?" → `schedule.override.set` → kernel REFUSE → the
//     fabricated "Funcionamos todos os dias das 10h às 22h!" delivered verbatim on all
//     three hours phrasings, EVEN WHILE the correct hours claim VALIDATED that turn.
//
// MECHANISM: lattice rule 2 (`live_action_decision` — REFUSE with ≥1 envelope) sat
// ABOVE rule 3 (`validated_render`), so the kept DRAFT won. And that draft was not a
// deterministic action reply at all — `renderOpsActionAnswer` returns `undefined` for
// a refused dispatch, so the ops `conversationalRefusal` recovery SYNTHESISED prose,
// gated only by a false-SUCCESS lexicon that a fabricated statement of FACT passes.
//
// FIX (owner ruling 2026-07-27, option (b) — a RANKING fix and nothing else): new
// lattice rule 2a, ordered above rule 2 and below the rule-1 no-leak invariant. When
// the refused envelope is the DECLARED WRITE TWIN of the read actually asked and that
// read's claims VALIDATED and ANSWER it, the validated render outranks the kept draft.
//
// Stage 2 (option (c) — grounded recovery synthesis) is a SEPARATE PR. The
// false-SUCCESS lexicon gate is deliberately UNTOUCHED here.
//
// WHAT IS FAKED: the ModelProvider (scripted), the claims pipeline's ONE external IO
// boundary (`createDomainTriadReadBackend`), and the delivery-coverage RESOLVER seam.
// The planner, investigator, claim planner, claims kernel, renderer, PRECEDENCE
// LATTICE, responder, resolver plumbing and conductor are all PRODUCTION code.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../../claustrum/claims-pipeline.js";
import type { DeliveryCoverageResolution } from "../../claustrum/delivery-coverage-resolver.js";

// ── Mock 1: the claims pipeline's read backend (no DB/network) ─────────────────
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
      // A staff principal owns no customer orders/payments/reservations.
      listActiveOrderIds: async () => [],
      listActiveReservationIds: async () => [],
      countActivePayments: async () => 0,
    }),
  };
});

// ── Mock 2: the delivery-coverage RESOLVER seam ────────────────────────────────
// Only `resolveDeliveryCoverage` is replaced; `composeDeliveryCoverageText` stays
// REAL, so the asserted scalar is the production one.
vi.mock("../../claustrum/delivery-coverage-resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../claustrum/delivery-coverage-resolver.js")>();
  return { ...actual, resolveDeliveryCoverage: vi.fn() };
});

const { resolveDeliveryCoverage, composeDeliveryCoverageText } = await import(
  "../../claustrum/delivery-coverage-resolver.js"
);

const { createOpsResolver } = await import("../ops-resolver.js");

const {
  buildOpsTools,
  composeOpsDeps,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulSession,
  runOpsTurn,
} = await import("./ops-e2e-harness.js");

// ── The renders + the prose, verbatim ─────────────────────────────────────────

/** The VALIDATED STORE_HOURS render (slot-grammar template × the read's scalar). */
const HOURS_RENDER = "Hoje nosso horário de funcionamento é: 11h–15h / 18h–23h.";
/** The VALIDATED STORE_OPEN_NOW render (template × the pt-BR meal-period label). */
const OPEN_RENDER = "No momento, o período de funcionamento é: jantar.";
/** The live zone row behind the Ibaté proof (integer centavos — Hard Rule 2). */
const IBATE_ZONE = { zoneName: "Ibaté", feeInCentavos: 1500, estimatedMinutes: 50 };
const IBATE_COVERED: DeliveryCoverageResolution = {
  kind: "covered",
  coverageText: composeDeliveryCoverageText(IBATE_ZONE),
  ...IBATE_ZONE,
};
/** THE OPS COVERAGE RENDER, verbatim (staff frame — no customer checkout tail). */
const OPS_IBATE_RENDER =
  "Sim, entregamos em Ibaté — taxa de R$ 15,00 e prazo estimado de cerca de 50 minutos.";

/**
 * THE FABRICATED HOURS, verbatim from the BKL-234 pin-down. This exact sentence was
 * delivered to an operator on a turn where the REAL hours had already validated.
 */
const FABRICATED_HOURS = "Funcionamos todos os dias das 10h às 22h!";
/**
 * THE FALSE NEGATIVE: model-composed prose whose leading "Não," reads as a coverage
 * DENIAL on a zone we DO serve. Ground truth was Sim.
 *
 * The live 2026-07-26 sentence was "Não, a loja está fechada e não conseguimos
 * entregar aí no momento." — deliberately NOT used verbatim here, and the reason is
 * worth recording: that exact wording asserts the store is CLOSED, so under this
 * suite's open-store signal it also trips `closedHoursDeliveryGuard`, the draft is
 * guard-rewritten, and the responder falls back to the deterministic refusal line. The
 * turn is still wrong for the operator, but it no longer demonstrates the PROSE-SHIPS
 * harm. This phrasing carries the same false denial with no schedule assertion and no
 * digits, so it passes every existing guard AND the false-SUCCESS lexicon — which is
 * exactly the residual Stage 2 (grounded recovery synthesis) exists to close, and
 * exactly why Stage 1 had to be a RANKING fix rather than another prose filter.
 */
const FABRICATED_DENIAL = "Não, infelizmente não atendemos essa região.";

// ── The two misparsed envelopes, shaped as the live planner emitted them ───────

/**
 * BKL-233/234: the ops roster's only schedule-shaped capability is this WRITE, so an
 * hours QUESTION pattern-matches onto it and the 4B fabricates the payload. The live
 * turn (363c092e-707b) emitted exactly `{blocks: [], date: "amanhã", isOpen: true}`.
 */
const SCHEDULE_MISPARSE = {
  id: "tc-1",
  name: "express_intent",
  input: {
    capability: "schedule.override.set",
    payload: { blocks: [], date: "amanhã", isOpen: true },
  },
} as const;

/**
 * LE2-013: the question text stuffed into the note's `orderId` — which is why the
 * kernel refuses on order state rather than schema.
 */
const NOTE_MISPARSE = {
  id: "tc-1",
  name: "express_intent",
  input: {
    capability: "order.note.add",
    payload: { orderId: "entregam em Ibaté?", note: "entregam em Ibaté?" },
  },
} as const;

/** The pair the ops claim persona instructs for a schedule question. */
const SCHEDULE_PAIR = [
  { type: "STORE_HOURS", subject: "loja" },
  { type: "STORE_OPEN_NOW", subject: "loja" },
] as const;

/** The complementary coverage pair (exactly one can ever validate). */
const COVERAGE_PAIR = [
  { type: "DELIVERY_COVERAGE", subject: "" },
  { type: "DELIVERY_NO_COVERAGE", subject: "" },
] as const;

/**
 * A three-role scripted model. A converged ops turn makes up to THREE completions —
 * intent planner, claim planner, responder. Dispatch is by TOOL SURFACE, never by
 * call order.
 */
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

/**
 * The REAL `createOpsResolver`, every lookup returning null.
 *
 * This is deliberate and load-bearing, not incidental fidelity. The identity-mapper
 * resolver stub the other ops claims e2e files use (`state: {}`) makes the ops order
 * guard read `orderId` off `undefined`, so `order.note.add` refuses with a
 * **`guard_panic` / SECURITY** refusal — and the responder skips the
 * `conversationalRefusal` synthesis entirely on SECURITY refusals. The turn would then
 * reproduce a REFUSE, but NOT the prose surface that makes BKL-262 dangerous.
 *
 * Through the real resolver a missing order projects `ctx.orderId: null` and pack-orders
 * REFUSEs `no_order` — a STATE refusal, exactly what the LE2-013 live turn recorded, and
 * one the recovery synthesis DOES run for. This mirrors the BKL-234 pin-down, which only
 * closed once it was re-run against the real `createOpsResolver`.
 */
function buildDeps(model: ModelProvider): {
  deps: ReturnType<typeof composeOpsDeps>;
  sink: ReturnType<typeof makeCapturingAuditSink>;
} {
  const sink = makeCapturingAuditSink();
  const { tools } = buildOpsTools({}, sink);
  return {
    sink,
    deps: composeOpsDeps({
      adjudicator: makeAuditedAdjudicator({ sink }),
      session: makeStatefulSession(),
      tools,
      model,
      buildResolver: (staffId: string) =>
        createOpsResolver({
          staffId,
          tenantId: "ibatexas",
          // A FIXED clock so the misparsed "amanhã" normalizes deterministically.
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

/** Drive one ops turn as the OWNER. */
async function drive(model: ModelProvider, text: string) {
  const { deps, sink } = buildDeps(model);
  const out = await runOpsTurn(deps, { role: "OWNER", staffId: "owner1", text });
  return { out, sink };
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  scheduleBackend.signal = { isClosed: false, mealPeriod: "dinner" };
  scheduleBackend.hours = { hoursText: "11h–15h / 18h–23h" };
  scheduleBackend.hoursThrows = false;
  scheduleBackend.scheduleThrows = false;
  vi.mocked(resolveDeliveryCoverage).mockReset();
  vi.mocked(resolveDeliveryCoverage).mockResolvedValue({ kind: "unknown" });
});

// ── 1. THE TWO MEASURED CASES, FIXED ─────────────────────────────────────────

describe("BKL-262 Stage 1 — a mis-parsed staff QUESTION gets its validated answer", () => {
  /**
   * BKL-234's proof, healed. Every one of these phrasings trips the generated
   * STORE_OPEN_NOW_Q markers and carries no date anchor, and every one of them
   * mis-parsed onto `schedule.override.set` in production.
   */
  const HOURS_UTTERANCES = [
    "Qual horário de funcionamento?",
    "que horas abre?",
    "até que horas vocês ficam abertos hoje?",
  ] as const;

  it.each(HOURS_UTTERANCES)(
    "HOURS %j: the refused schedule WRITE no longer suppresses the validated hours",
    async (text) => {
      const model = claimsScriptedModel({
        intentCalls: [SCHEDULE_MISPARSE],
        claims: [...SCHEDULE_PAIR],
        responderText: FABRICATED_HOURS,
      });

      const { out, sink } = await drive(model, text);

      // The turn really IS on the defect path: the kernel refused a real envelope.
      expect(out.decision.kind).toBe("REFUSE");
      expect(sink.byKind("schedule.override.set").length).toBeGreaterThan(0);

      // …and the operator now gets the GROUNDED schedule facts instead of the draft.
      expect(out.response).toContain(HOURS_RENDER);
      expect(out.response).toContain(OPEN_RENDER);

      // The exact fabricated sentence BKL-234 measured never reaches staff again.
      expect(out.response).not.toContain(FABRICATED_HOURS);
      expect(out.response).not.toContain("10h");
      expect(out.response).not.toContain("22h");
    },
  );

  it("COVERAGE: the refused order.note.add no longer denies a covered zone", async () => {
    // Ground truth: we DO deliver to Ibaté. The 2026-07-26 turn said we do not.
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue(IBATE_COVERED);
    const model = claimsScriptedModel({
      intentCalls: [NOTE_MISPARSE],
      claims: [...COVERAGE_PAIR],
      responderText: FABRICATED_DENIAL,
    });

    const { out, sink } = await drive(model, "entregam em Ibaté?");

    expect(out.decision.kind).toBe("REFUSE");
    expect(sink.byKind("order.note.add").length).toBeGreaterThan(0);
    // …and it is a STATE refusal (pack-orders `no_order`), NOT a SECURITY one. This
    // pin matters: the responder skips the conversationalRefusal synthesis entirely on
    // SECURITY refusals, so a SECURITY refusal here would make the turn reproduce a
    // REFUSE while quietly NOT reproducing the prose surface the row is about.
    const refusal = (out.decision as { refusal?: { kind?: string } }).refusal;
    expect(refusal?.kind).not.toBe("SECURITY");

    // The grounded answer, with the fee and ETA bound to the zones projection.
    expect(out.response).toBe(OPS_IBATE_RENDER);
    expect(out.response).toContain("R$ 15,00");
    expect(out.response).toContain("50 minutos");

    // The false NEGATIVE that shipped on the live turn — the whole reason this row
    // was rated the most serious open item on the plane.
    expect(out.response).not.toContain(FABRICATED_DENIAL);
    expect(out.response).not.toContain("não atendemos");
  });

  it("the rescue promotes a render that ANSWERS the ask — not merely 'some claim validated'", async () => {
    // STORE_HOURS alone does NOT satisfy the STORE_OPEN_NOW_Q closure (BKL-121 D3
    // keeps STORE_HOURS out of REQUIRED_CLAIM_CLOSURE), so §O#15 completeness fails
    // and the rescue must DECLINE even though a claim did validate. Without the
    // completeness conjunct this turn would promote a half-answer.
    const model = claimsScriptedModel({
      intentCalls: [SCHEDULE_MISPARSE],
      claims: [{ type: "STORE_HOURS", subject: "loja" }],
      responderText: FABRICATED_HOURS,
    });

    const { out } = await drive(model, "Qual horário de funcionamento?");

    expect(out.decision.kind).toBe("REFUSE");
    expect(out.response).not.toContain(HOURS_RENDER);
  });
});

// ── 2. THE COUNTER-CASE — a REAL refused mutation still surfaces ─────────────

describe("BKL-262 Stage 1 — a GENUINE refused mutation is never masked", () => {
  /**
   * THE COUNTER-CASE THE OWNER REQUIRED. Staff really tried to change the hours and
   * the kernel refused. That refusal IS the message: answering with today's hours
   * would silently drop a write the operator asked for — the mirror-image failure of
   * the one this ticket fixes.
   *
   * NOTE this case is NOT excluded by "has read spans": `classifyRequestSpans` fires
   * STORE_OPEN_NOW_Q + STORE_HOURS_FOR_DATE_Q here, because the schedule markers
   * match the word "horário" whatever the verb. It is excluded by the MUTATION-SHAPE
   * conjunct, which is precisely why that conjunct exists and is checked first.
   */
  const MUTATION_UTTERANCES = [
    "muda o horário de amanhã para 10h às 22h",
    "fecha a loja amanhã",
  ] as const;

  it.each(MUTATION_UTTERANCES)(
    "MUTATION %j: the refusal still reaches the operator",
    async (text) => {
      // Arm the model with a fabricated fact. Under Stage 2 this branch makes NO
      // model call, so it can never ship — asserted below.
      const model = claimsScriptedModel({
        intentCalls: [SCHEDULE_MISPARSE],
        claims: [...SCHEDULE_PAIR],
        responderText: FABRICATED_HOURS,
      });

      const { out } = await drive(model, text);

      expect(out.decision.kind).toBe("REFUSE");
      // Rule 2 stands: the validated render does NOT supersede the refusal.
      expect(out.response).not.toContain(HOURS_RENDER);
      expect(out.response).not.toContain(OPEN_RENDER);
      // The refusal itself LEADS the reply — the operator is told the action did
      // not happen before anything else.
      //
      // BKL-262 STAGE 2 UPDATED THIS ASSERTION. It used to pin the MODEL draft's
      // wording ("Não consegui…"), which passed only because the recovery branch
      // synthesised prose. Stage 2 abolishes that synthesis, so the reply is now
      // the deterministic explainer copy. The PROPERTY under test is unchanged —
      // a genuine refused mutation still surfaces its refusal, and is not masked
      // by the validated read — so the assertion is re-pinned to the property
      // (the refusal leads) rather than to a sentence the model happened to write.
      const refusal = (out.decision as { refusal?: { userFacing?: string } }).refusal;
      expect(refusal?.userFacing).toBeTruthy();
      expect(out.response.startsWith(refusal!.userFacing!)).toBe(true);
      // …and no model-authored fact rides along.
      expect(out.response).not.toContain(FABRICATED_HOURS);
    },
  );

  it("a refused mutation whose kind is NOT in the twin table keeps rule 2", async () => {
    // `payment.refund.issue` is deliberately absent from OPS_WRITE_TWIN_READ_FAMILIES.
    // Even on an hours-shaped question with validated hours, a refused money verb must
    // surface — the twin table is CLOSED, and absence means no rescue.
    const refusalDraft = "Não consegui emitir esse reembolso.";
    const model = claimsScriptedModel({
      intentCalls: [
        {
          id: "tc-1",
          name: "express_intent",
          input: {
            capability: "payment.refund.issue",
            payload: { orderId: "order_4242", amountInCentavos: 5_000, reason: "x" },
          },
        },
      ],
      claims: [...SCHEDULE_PAIR],
      responderText: refusalDraft,
    });

    const { out } = await drive(model, "Qual horário de funcionamento?");

    expect(out.decision.kind).toBe("REFUSE");
    expect(out.response).not.toContain(HOURS_RENDER);
  });
});

// ── 3. THE UNCHANGED PATHS ───────────────────────────────────────────────────

describe("BKL-262 Stage 1 — every other REFUSE path is byte-unchanged", () => {
  it("a REFUSE turn with NO validated claims is not rescued (rule 2a declines)", async () => {
    // The schedule reads fail, so nothing validates and there is no answer to
    // promote — rule 2a's conjunct 2 declines and rule 2 keeps the draft.
    //
    // BKL-262 STAGE 2 UPDATED THIS ASSERTION. It used to additionally pin
    // `not.toContain(SAFE_UNKNOWN)`, which described the OLD recovery path (model
    // prose). Stage 2 deliberately replaces that with the epistemic self-report,
    // so the safe-unknown text now DOES appear here by design — that is the fix,
    // not a regression, and the fall-through taxonomy is pinned in
    // ops-grounded-recovery.e2e.test.ts. What this test still owns is the RULE 2a
    // decision: no validated render is promoted.
    scheduleBackend.hoursThrows = true;
    scheduleBackend.scheduleThrows = true;
    const model = claimsScriptedModel({
      intentCalls: [SCHEDULE_MISPARSE],
      claims: [...SCHEDULE_PAIR],
      responderText: FABRICATED_HOURS,
    });

    const { out } = await drive(model, "Qual horário de funcionamento?");

    expect(out.decision.kind).toBe("REFUSE");
    expect(out.response).not.toContain(HOURS_RENDER);
    expect(out.response).not.toContain(OPEN_RENDER);
    expect(out.response).not.toContain(FABRICATED_HOURS);
  });

  it("SMALL TALK is untouched — no spans, no rescue, natural prose survives", async () => {
    const model = claimsScriptedModel({ responderText: "Bom dia! Tudo certo por aqui." });

    const { out } = await drive(model, "bom dia!");

    expect(out.response).toBe("Bom dia! Tudo certo por aqui.");
  });

  it("a plain read turn (no refused envelope) still renders from claims as before", async () => {
    // No intent call at all ⇒ rule 2 was never in play; rule 3 renders. Proves the new
    // rule did not perturb the ordinary validated-render path.
    const model = claimsScriptedModel({
      claims: [...SCHEDULE_PAIR],
      responderText: FABRICATED_HOURS,
    });

    const { out } = await drive(model, "Qual horário de funcionamento?");

    expect(out.response).toContain(HOURS_RENDER);
    expect(out.response).toContain(OPEN_RENDER);
  });
});
