// BKL-234 — an operating-hours QUESTION on the ops plane, answered from the claims
// pipeline. The TURN-SEAM proof: a real ops `handleTurn` through the real
// `composeOpsConductor` (shared ops e2e harness — real composed router, real kernel,
// real ops tool registry, real system channel), asserting the DELIVERED REPLY.
//
// ── The defect this pins closed ──────────────────────────────────────────────
// BKL-234 registered "the ops roster offered a schedule WRITE but no hours READ".
// After the LE2-011/012/013 convergence the READ was in fact fully present — the
// type is customer-registered, reaches ops through the `customer ∪ ops`
// OPS_CLAIM_SCOPE, grounds off `readStoreHours` (which sits BEFORE the
// authenticated-customer gate, so a staff principal reads it) and renders from
// OPS_PLANE_VALIDATED_TEMPLATES. What was broken was the CO-RENDER:
//
//   · the §O#15 span STORE_OPEN_NOW_Q fires on every hours phrasing and REQUIRES
//     STORE_OPEN_NOW, so a turn proposing only STORE_HOURS had a required-but-ABSENT
//     companion → the completeness gate degraded a claim that had ALREADY VALIDATED;
//   · proposing BOTH hit §O#1 default-deny — `DEFAULT_CONSISTENCY_TABLE` declares no
//     relation for {STORE_HOURS, STORE_OPEN_NOW}, so P2 suppressed BOTH and the turn
//     terminal became ESCALATE.
//
// The second failure was subject-dependent and therefore a COIN FLIP: consistency
// partitions by subject, and `ibatexas-planner.ts` leaves a public single-key type's
// `subject` exactly as the model emitted it. The claim-planner persona tells the 4B
// to use "loja" for store questions — i.e. it steered straight into the collision.
// `SCHEDULE_CLUSTER_COMPATIBLE` declares the cluster pairs, and the persona now names
// the pair, so the answer no longer depends on which string the model picked.
//
// What is faked: the ModelProvider (scripted) and the claims pipeline's ONE external
// IO boundary, `createDomainTriadReadBackend`. Investigator, claim planner, claims
// kernel, renderer, precedence lattice, responder and conductor are PRODUCTION code.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../../claustrum/claims-pipeline.js";
import type {
  HolidayRead,
  ScheduleOverrideRead,
  ScheduleRead,
  StoreHoursRead,
} from "../../claustrum/turn-reads.js";

// ── The ONE mocked external: the claims pipeline's read backend ───────────────
const { scheduleBackend } = vi.hoisted(() => ({
  scheduleBackend: {
    signal: { isClosed: false, mealPeriod: "dinner" } as ScheduleRead,
    scheduleThrows: false,
    hours: { hoursText: "11h–15h / 18h–23h" } as StoreHoursRead,
    hoursThrows: false,
    holiday: null as HolidayRead | null,
    override: null as ScheduleOverrideRead | null,
  },
}));

vi.mock("../../claustrum/turn-reads.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../claustrum/turn-reads.js")>();
  const { buildTriadReadBackend } = await import(
    "../../__tests__/helpers/triad-backend-builder.js"
  );
  return {
    ...actual,
    createDomainTriadReadBackend: () =>
      buildTriadReadBackend({
        readSchedule: async () => {
          if (scheduleBackend.scheduleThrows) {
            throw new Error("schedule store unavailable");
          }
          return scheduleBackend.signal;
        },
        readScheduleOverride: async () => scheduleBackend.override,
        // BKL-121 — THROWS on an unavailable schedule so the investigator records a
        // fail-closed read ERROR (Inv 7), never a fabricated hours string.
        readStoreHours: async () => {
          if (scheduleBackend.hoursThrows) throw new Error("schedule store unavailable");
          return scheduleBackend.hours;
        },
        readHoliday: async () => scheduleBackend.holiday,
        readHoursForDate: async () => ({ hoursText: "11h–15h / 18h–23h" }),
        readHolidayForDate: async () => null,
        readScheduleOverrideForDate: async () => null,
        // A staff principal owns no customer orders/payments/reservations.
        listActiveOrderIds: async () => [],
        listActiveReservationIds: async () => [],
        countActivePayments: async () => 0,
      }),
  };
});

const {
  buildOpsTools,
  composeOpsDeps,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulSession,
  runOpsTurn,
} = await import("./ops-e2e-harness.js");

/** The VALIDATED STORE_HOURS render (slot-grammar template × the read's scalar). */
const HOURS_RENDER = "Hoje nosso horário de funcionamento é: 11h–15h / 18h–23h.";
/** The VALIDATED STORE_OPEN_NOW render (template × the pt-BR meal-period label). */
const OPEN_RENDER = "No momento, o período de funcionamento é: jantar.";
const CLOSED_RENDER = "No momento, o período de funcionamento é: fechado.";
/** The proposition-free abstain a degraded claims turn renders. */
const SAFE_UNKNOWN =
  "Não localizei essa informação confirmada agora. Quer que eu verifique?";
/** The ESCALATE copy the un-declared same-subject pair used to produce. */
const ESCALATE_COPY =
  "Não consegui confirmar isso com segurança agora — vou encaminhar para um atendente verificar. Posso ajudar em mais alguma coisa?";
/** Fabricated hours the 4B would happily assert; must never reach the operator. */
const MODEL_PROSE = "Funcionamos todos os dias das 10h às 22h!";

/**
 * The utterances BKL-233/234 were registered from: the live misparsed turn plus two
 * phrasings an operator actually uses. Every one trips the generated
 * STORE_OPEN_NOW_Q markers, and none carries a date anchor (so STORE_HOURS_FOR_DATE_Q
 * stays quiet — these are TODAY questions).
 */
const HOURS_UTTERANCES = [
  "Qual horário de funcionamento?",
  "que horas abre?",
  "até que horas vocês ficam abertos hoje?",
] as const;

/** The pair the persona now instructs, on the SUBJECT the persona names. */
const SCHEDULE_PAIR = [
  { type: "STORE_HOURS", subject: "loja" },
  { type: "STORE_OPEN_NOW", subject: "loja" },
] as const;

/**
 * A three-role scripted model (the `ops-store-open-claims.e2e.test.ts` idiom): a
 * converged ops turn makes up to THREE completions — intent planner, claim planner,
 * responder. Dispatch is by TOOL SURFACE, never by call order.
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
        toolCalls: (opts.claims ?? []).map((c, i) => ({
          id: `claim-${i}`,
          name: PROPOSE_CLAIM_TOOL,
          input: { ...c },
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
    return { ...base, text: opts.responderText ?? MODEL_PROSE, toolCalls: [] };
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

function buildDeps(model: ModelProvider): ReturnType<typeof composeOpsDeps> {
  const sink = makeCapturingAuditSink();
  const { tools } = buildOpsTools({}, sink);
  return composeOpsDeps({
    adjudicator: makeAuditedAdjudicator({ sink }),
    session: makeStatefulSession(),
    tools,
    model,
    buildResolver: () => ({
      resolve: async ({ plan }: { plan: { envelopes: readonly unknown[] } }) =>
        plan.envelopes.map((envelope) => ({ envelope, state: {} })),
    }),
  });
}

/** Drive one hours turn with the schedule pair proposed. */
async function runHoursTurn(
  text: string,
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }> = SCHEDULE_PAIR,
): Promise<string> {
  const model = claimsScriptedModel({ claims, responderText: MODEL_PROSE });
  const out = await runOpsTurn(buildDeps(model), {
    role: "OWNER",
    staffId: "owner1",
    text,
  });
  return out.response;
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  scheduleBackend.signal = { isClosed: false, mealPeriod: "dinner" };
  scheduleBackend.scheduleThrows = false;
  scheduleBackend.hours = { hoursText: "11h–15h / 18h–23h" };
  scheduleBackend.hoursThrows = false;
  scheduleBackend.holiday = null;
  scheduleBackend.override = null;
});

describe("BKL-234 — a staff hours QUESTION renders GROUNDED hours on the ops plane", () => {
  it.each(HOURS_UTTERANCES)(
    "OPEN: %j is answered with today's real hours, never the model's invented ones",
    async (text) => {
      const response = await runHoursTurn(text);

      // The whole point of the row: the operator gets the HOURS.
      expect(response).toContain(HOURS_RENDER);
      // …and the sibling schedule fact co-renders instead of annihilating it.
      expect(response).toContain(OPEN_RENDER);
      // The regressions this replaces, named explicitly so a re-break is unambiguous.
      expect(response).not.toBe(SAFE_UNKNOWN);
      expect(response).not.toBe(ESCALATE_COPY);
      // No model-authored sentence reaches staff (claims-not-prose).
      expect(response).not.toContain(MODEL_PROSE);
      expect(response).not.toContain("10h");
    },
  );

  it("CLOSED: today's hours still render alongside the closed period (they cannot conflict)", async () => {
    scheduleBackend.signal = { isClosed: true, mealPeriod: "closed" };

    const response = await runHoursTurn("Qual horário de funcionamento?");

    // The pair is COMPATIBLE precisely because this is coherent: the store is closed
    // right now AND today's schedule is 11h–15h / 18h–23h.
    expect(response).toContain(HOURS_RENDER);
    expect(response).toContain(CLOSED_RENDER);
    expect(response).not.toBe(ESCALATE_COPY);
  });

  // The BKL-234 root cause, pinned directly: the persona tells the 4B to use "loja"
  // for store questions, so the two schedule claims arrive on the SAME subject —
  // which §O#1 default-deny turned into an ESCALATE before SCHEDULE_CLUSTER_COMPATIBLE.
  it("SAME SUBJECT (what the persona instructs) co-renders — no §O#1 default-deny ESCALATE", async () => {
    const response = await runHoursTurn("Qual horário de funcionamento?", [
      { type: "STORE_HOURS", subject: "loja" },
      { type: "STORE_OPEN_NOW", subject: "loja" },
    ]);

    expect(response).toContain(HOURS_RENDER);
    expect(response).toContain(OPEN_RENDER);
    expect(response).not.toBe(ESCALATE_COPY);
  });

  // …and the answer must not depend on which free-text subject the model happened to
  // emit (it was a coin flip: distinct subjects landed in different P2 buckets and
  // rendered, identical ones escalated).
  it("is INVARIANT to the model's subject choice — distinct subjects render the same reply", async () => {
    const sameSubject = await runHoursTurn("Qual horário de funcionamento?", [
      { type: "STORE_HOURS", subject: "loja" },
      { type: "STORE_OPEN_NOW", subject: "loja" },
    ]);
    const distinctSubjects = await runHoursTurn("Qual horário de funcionamento?", [
      { type: "STORE_HOURS", subject: "loja" },
      { type: "STORE_OPEN_NOW", subject: "restaurante" },
    ]);

    expect(sameSubject).toBe(distinctSubjects);
    expect(sameSubject).toContain(HOURS_RENDER);
  });
});

describe("BKL-234 — the honesty rules still hold on the hours read", () => {
  it("an ERRORED hours read degrades honestly — zero invented digits", async () => {
    scheduleBackend.hoursThrows = true;
    scheduleBackend.scheduleThrows = true;

    const response = await runHoursTurn("Qual horário de funcionamento?");

    expect(response).toBe(SAFE_UNKNOWN);
    // Inv 6 / §5: a safe terminal asserts NOTHING about the world.
    expect(response).not.toContain("horário de funcionamento é");
    expect(response).not.toContain(MODEL_PROSE);
  });

  // BKL-121 D3 preserved: STORE_HOURS is NOT in REQUIRED_CLAIM_CLOSURE, so a holiday
  // that demotes it to UNKNOWN must NOT take the open-now answer down with it. This is
  // the exact regression that adding it to the required set would have caused.
  it("a HOLIDAY demotes only the hours claim — the open-now fact still renders", async () => {
    scheduleBackend.holiday = {
      id: "hol-1",
      date: "2026-07-26",
      label: "Feriado municipal",
      allDay: true,
      startTime: null,
      endTime: null,
    };

    const response = await runHoursTurn("Qual horário de funcionamento?");

    // The falsifier fired → the hours claim cannot assert a possibly-wrong schedule.
    expect(response).not.toContain(HOURS_RENDER);
    // …but the turn is NOT degraded: STORE_OPEN_NOW satisfies §O#15 and renders.
    expect(response).toContain(OPEN_RENDER);
    expect(response).not.toBe(SAFE_UNKNOWN);
  });

  // An OVERRIDE is asymmetric to a holiday, and the difference is honest rather than
  // incidental: a holiday is declared in STORE_HOURS's falsifiers only, while an
  // override is a falsifier of BOTH schedule claims (STORE_OPEN_NOW's declared
  // `schedule:schedule_override`, and STORE_HOURS's per BKL-121 D1). So an exception
  // day demotes the WHOLE cluster and the turn abstains — there is no schedule fact
  // left that the store's own exception has not overridden.
  it("a present schedule OVERRIDE demotes the WHOLE cluster — the turn abstains", async () => {
    scheduleBackend.override = {
      id: "ovr-1",
      date: "2026-07-26",
      isOpen: false,
      blocks: [],
      note: "manutenção",
    };

    const response = await runHoursTurn("Qual horário de funcionamento?");

    expect(response).toBe(SAFE_UNKNOWN);
    expect(response).not.toContain(HOURS_RENDER);
    expect(response).not.toContain(OPEN_RENDER);
    // Never the model's invented hours in place of the overridden schedule.
    expect(response).not.toContain(MODEL_PROSE);
  });

  it("SMALL TALK is unaffected — no schedule span, no claims, natural prose survives", async () => {
    const model = claimsScriptedModel({ responderText: "Bom dia! Tudo certo por aqui." });

    const out = await runOpsTurn(buildDeps(model), {
      role: "OWNER",
      staffId: "owner1",
      text: "bom dia!",
    });

    expect(out.response).toBe("Bom dia! Tudo certo por aqui.");
    expect(out.response).not.toContain(HOURS_RENDER);
  });

  // BKL-289 INVERTED THIS TEST — deliberately, and this is the ops twin of the fix.
  //
  // It used to pin the residual coupling as CORRECT: "STORE_HOURS alone still
  // degrades, because §O#15 requires the STORE_OPEN_NOW companion the span asked
  // for. The persona naming the PAIR is what keeps production off this path." That
  // residual WAS the BKL-289 defect — a deterministic requirement guarded only by a
  // probabilistic prompt line. It reproduced live on the customer plane (turns
  // 246f1d64 / 1539337c / c6ff25ca): the 4B proposed STORE_HOURS alone, the hours
  // claim VALIDATED against live Redis, and §O#15 threw the whole answer away.
  //
  // The never-omit-required union now adds the omitted STORE_OPEN_NOW companion
  // deterministically, so an omitting model no longer costs the operator the answer.
  // The persona line stays as belt-and-suspenders but is no longer load-bearing.
  it("hours ALONE now RENDERS — the union supplies the companion the model omitted", async () => {
    const response = await runHoursTurn("Qual horário de funcionamento?", [
      { type: "STORE_HOURS", subject: "loja" },
    ]);

    expect(response).toContain(HOURS_RENDER);
    // The unioned companion did not merely appear — it VALIDATED and rendered.
    expect(response).toContain(OPEN_RENDER);
    expect(response).not.toBe(SAFE_UNKNOWN);
  });

  // …and the degrade is UNWEAKENED: when the unioned companion cannot validate, the
  // turn still degrades and the validated hours do NOT leak past it. This is the
  // control that keeps the test above from reading as "§O#15 was loosened".
  it("hours ALONE still DEGRADES when the unioned companion cannot validate", async () => {
    scheduleBackend.scheduleThrows = true;

    const response = await runHoursTurn("Qual horário de funcionamento?", [
      { type: "STORE_HOURS", subject: "loja" },
    ]);

    expect(response).toBe(SAFE_UNKNOWN);
    expect(response).not.toContain(HOURS_RENDER);
  });
});
