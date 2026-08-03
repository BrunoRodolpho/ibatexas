/**
 * R2-S8 — STORE_HOURS_FOR_DATE AT THE REAL TURN SEAM.
 *
 * The type is now GENERATED from `../claustrum/claimdefs/store-hours-for-date.claim.ts`.
 * This file is the proof that the generated spec renders through the REAL adapter —
 * `composeCustomerConductor` + `runCustomerTurn`, the real planner, investigator, claims
 * kernel and renderer-from-claims — and not merely that the compiled object has the right
 * fields.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 *  WHAT ALREADY EXISTED, MEASURED BEFORE WRITING THIS (both suites UNEDITED here)
 * ════════════════════════════════════════════════════════════════════════════════
 *
 *   - L3 (real `handleTurn`) coverage EXISTS, but only as DIETARY-POSTURE cases:
 *     `./dietary-posture.e2e.test.ts` ("STORE_HOURS_FOR_DATE answers a celiac") and
 *     `./span-net-precision.e2e.test.ts` ("`answer-anyway` — a diabetic still gets
 *     Sunday's hours"). Each drives ONE date and asserts ONE hours string. They exist to
 *     prove the POSTURE, and they keep passing unedited — which is the migration's
 *     central claim for this type.
 *   - `../claustrum/__tests__/tracka-store-hours-for-date.test.ts` is deep (real kernel,
 *     real planner, real renderer — the derive/validate/falsify/stale chain, incl. the
 *     SCN-003 "TODAY's holiday does not demote a future date" case) but it is NOT at the
 *     turn seam: it never composes a conductor. Also unedited.
 *   - NO suite at ANY depth drove TWO DATES and asked which one answered. Every existing
 *     case mocks `readHoursForDate` as a CONSTANT — `async () => ({ hoursText: "12h–16h" })`
 *     — so "rendered THIS date" is indistinguishable from "rendered SOME date", which is
 *     exactly the failure a dropped `perResourceKey` causes: the kernel would resolve the
 *     BARE `schedule:store_hours` against a ledger holding only
 *     `schedule:store_hours:{date}`, read ABSENT, and degrade to a perfectly honest
 *     UNKNOWN with nothing red anywhere.
 *
 * So this file adds the DISCRIMINATION AXIS this type lacked, plus the two seams the
 * conjunction migration put at risk. The backend below returns a DATE-DERIVED hours string
 * (never a constant), so no assertion here can be satisfied by the wrong day's read.
 *
 * ── THE AXIS IS TWO DATES, AND THE SUBJECT IS NEVER MODEL-AUTHORED ──────────────
 *
 * R2-S2's MENU_ITEM_PRICE discriminates by PRODUCT, R2-S4/S7 by ORDER, R2-S5 by CUSTOMER.
 * Here the "resource" is a CALENDAR DAY: the subject is the ISO date from
 * `resolveQueriedScheduleDate`, the SAME pure resolver the investigator uses to build its
 * date-suffixed ledger keys — so candidate subject and evidence key match by construction.
 * The dates are computed from the live clock through that resolver rather than hardcoded,
 * because a hardcoded date would rot the moment the suite runs in a different week.
 *
 * ── THE TWO SEAMS THIS SLICE PUT AT RISK ────────────────────────────────────────
 *
 *   1. The span CONJUNCTION. `scheduleContext` became the generated marker net;
 *      `dateAnchor` stayed a hand-written guard. If the guard were lost, every bare hours
 *      question would classify as day-specific. The `bare hours` control case below is the
 *      turn-seam half of that proof (the unit half is in
 *      `../claustrum/__tests__/required-claim-decomposer.test.ts`).
 *   2. BKL-289's UNION. `deriveUnionSubject` classifies this type through
 *      `publicPerItemBaseKey`, which reads `requiredEvidence[0].key` off the REGISTRY SPEC
 *      — now the generated one. A base key that drifted, or a dropped `perResourceKey`,
 *      would silently move this type into the fixed-subject branch and bind the PRINCIPAL
 *      as its subject: `schedule:store_hours:cust-…` is ABSENT by construction, so the
 *      claim would resolve UNKNOWN and the turn would degrade — the exact silent shape
 *      BKL-289 exists to prevent. The union cases below drive BOTH directions of the
 *      cluster through the real planner.
 *
 * Deterministic: mocked reads, a scripted model, the clock reached only through the shared
 * resolver, no network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";
import { CLASSIFY_ONLY_READS_ENABLED_ENV } from "../claustrum/classify-only-reads.js";
import { resolveQueriedScheduleDate } from "../claustrum/schedule-date-resolver.js";

/** The restaurant timezone the investigator and the claim planner both resolve dates in. */
const TZ = "America/Sao_Paulo";

/**
 * Per-drive switches the mocked backend reads. Declared inside `vi.hoisted` because the
 * `vi.mock` factory below is hoisted above every ordinary top-level binding.
 */
const { st } = vi.hoisted(() => ({
  st: {
    /** Every ISO date `readHoursForDate` was ASKED for, in order. */
    dateReads: [] as string[],
    /** ISO dates that are a HOLIDAY (the per-date W6 falsifier fires). */
    holidayDates: [] as string[],
    /** ISO dates carrying a per-date ScheduleOverride (the shared W6 falsifier). */
    overrideDates: [] as string[],
    /** TRUE ⟹ TODAY is a holiday, recorded under the BARE `schedule:holiday` key. */
    todayIsHoliday: false,
  },
}));

/**
 * The hours string for an ISO date — DERIVED FROM THE DATE, never a constant. Two
 * different days can never produce the same string, which is what makes every assertion
 * below directional. The shape stays a plausible pt-BR free-form hours value (the real
 * `hoursText` is "11h–15h / 18h–23h" | "fechado"), with the day-of-month as the
 * discriminator.
 */
function hoursFor(isoDate: string): string {
  const dd = isoDate.slice(8, 10);
  return `${dd}h–23h`;
}

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return {
    ...actual,
    // ONE product, so a COMPOUND "price + hours" turn can carry a surviving non-schedule
    // candidate. That is what lets the BKL-289 union cases below actually REACH the union
    // — see their comment for why a schedule-only turn cannot.
    searchProducts: vi.fn(async () => ({
      products: [
        {
          id: "prod_costela",
          title: "Costela Bovina Defumada",
          price: 8900,
          description: "Costela bovina defumada 14h no carvalho.",
          categoryHandle: "carnes-defumadas",
          inStock: true,
          tags: [] as string[],
        },
      ],
    })),
    medusaAdmin: vi.fn(async () => ({ stores: [] })),
  };
});

vi.mock("../claustrum/turn-reads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claustrum/turn-reads.js")>();
  // Dynamic import: a `vi.mock` factory is hoisted above this file's static imports,
  // so it cannot close over one. The builder is type-only against turn-reads.js, so
  // this drags no infrastructure into the factory (see the helper's header).
  const { buildTriadReadBackend } = await import("./helpers/triad-backend-builder.js");
  // R5-S3 — the holiday / override doubles below were RESHAPED when this suite moved
  // onto the typed builder. They previously returned ad-hoc literals (`{ name, isoDate }`
  // and `{ isoDate, isClosed, reason }`) that match NEITHER published type: `HolidayRead`
  // IS `HolidayEntry { id, date, label, allDay, startTime, endTime }` and
  // `ScheduleOverrideRead` IS `ScheduleOverrideEntry { id, date, isOpen, blocks, note }`
  // (@ibatexas/types · schedule.types.ts). Note the POLARITY on the override: the real
  // field is `isOpen`, so "closed that day" is `isOpen: false` — the old `isClosed: true`
  // read as `isOpen === undefined`, falsy, i.e. closed only by coincidence. Both were
  // BEHAVIOURALLY INERT and therefore invisible to every runtime assertion: the
  // investigator records these falsifiers PRESENT-vs-ABSENT (`(await b.readHoliday()) ??
  // ABSENT_READ`) and reads no field off them, so a wrong spelling could never fail a
  // case. That is the R2-S7 class exactly, and the typed builder is what surfaced it.
  // The counts below are unchanged by the reshape — presence is all that was ever read.
  const TODAY_ISO = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date());
  return {
    ...actual,
    // Every read NOT declared below defaults to a `notUsed` thrower naming itself, so
    // an unexpected read fails loudly instead of returning a fabricated value.
    createDomainTriadReadBackend: () =>
      buildTriadReadBackend({
        readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
        readScheduleOverride: async () => null,
        // TODAY's hours. Deliberately a shape `hoursFor` can NEVER emit (no day-of-month
        // prefix), so an assertion on a date-specific string can never be satisfied by the
        // today read — "the DATE claim rendered" stays distinguishable from "some hours
        // claim rendered".
        readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
        // TODAY's holiday, under the BARE key. The SCN-003 separation lives here: this must
        // never demote a future-date answer, because that answer's falsifier is the
        // DATE-SUFFIXED key below.
        readHoliday: async () =>
          st.todayIsHoliday
            ? {
                id: "holiday-today",
                date: TODAY_ISO,
                label: "feriado de hoje",
                allDay: true,
                startTime: null,
                endTime: null,
              }
            : null,
        readHoursForDate: async (isoDate) => {
          st.dateReads.push(isoDate);
          return { hoursText: hoursFor(isoDate) };
        },
        readHolidayForDate: async (isoDate) =>
          st.holidayDates.includes(isoDate)
            ? {
                id: `holiday-${isoDate}`,
                date: isoDate,
                label: "feriado municipal",
                allDay: true,
                startTime: null,
                endTime: null,
              }
            : null,
        readScheduleOverrideForDate: async (isoDate) =>
          st.overrideDates.includes(isoDate)
            ? {
                id: `override-${isoDate}`,
                date: isoDate,
                isOpen: false,
                blocks: [],
                note: "manutenção",
              }
            : null,
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

/**
 * What a real 4B does with a schedule question once the turn leaves the grounded path. It
 * asserts an hours window NO read produced, in a shape `hoursFor` can never emit, so its
 * arrival is a FAILURE rather than a silent regression.
 */
const MODEL_PROSE =
  "Claro! Aos domingos a gente abre das 9h às 22h direto, e amanhã funcionamos " +
  "normalmente das 8h às 20h. Pode vir quando quiser!";

/** The STORE_OPEN_NOW validated template's static frame (slot-grammar.ts). Byte-pinned
 *  here so "the open-now companion co-rendered" is asserted on the SENTENCE rather than on
 *  a meal-period word that could appear for another reason. */
const OPEN_NOW_FRAME = "período de funcionamento";
/** The STORE_HOURS_FOR_DATE validated template's static frame. */
const FOR_DATE_FRAME = "Nesse dia, nosso horário de funcionamento é:";

/**
 * A model that SERVES the planner's extraction leg and the responder but THROWS if the
 * claim-proposal leg is requested — the leg classify-only retires. Reaching it means the
 * turn took the model path, and the failure is structural rather than a count somebody has
 * to remember to assert.
 */
function claimProposalForbiddenModel(label: string): ModelProvider {
  return {
    complete: vi.fn(async (req: CompletionRequest): Promise<Completion> => {
      const toolNames = (req.tools ?? []).map((t) => t.name);
      if (toolNames.includes(PROPOSE_CLAIM_TOOL)) {
        throw new Error(
          `[r2s8] propose_claim was requested — ${label} must ride the DETERMINISTIC ` +
            `classify-only path, not the model claim proposal`,
        );
      }
      return {
        model: "mock",
        stopReason: "end_turn",
        text: MODEL_PROSE,
        toolCalls: [],
        inputTokens: 5,
        outputTokens: 4,
      };
    }),
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  } as unknown as ModelProvider;
}

/** A model that proposes EXACTLY the given claims — the union-interplay driver. */
function scriptedModel(
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
      // Non-empty on purpose: an empty completion trips the planner's extraction-failure
      // REFUSE and short-circuits before the claims render, which would make every
      // assertion below pass for the wrong reason.
      return { ...base, text: MODEL_PROSE, toolCalls: [] };
    }),
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  } as unknown as ModelProvider;
}

/** NOT a `guest:`/`anon:` id — kept authenticated so nothing here is explained by guest
 *  gating. This type is PUBLIC, which the guest case below is what actually proves. */
const OWNER_ID = "cust-r2s8-owner";
let seq = 0;

async function drive(args: {
  readonly text: string;
  readonly model: ModelProvider;
  readonly classifyOnly: boolean;
  readonly customerId?: string;
}): Promise<string> {
  seq += 1;
  if (args.classifyOnly) process.env[CLASSIFY_ONLY_READS_ENABLED_ENV] = "true";
  else delete process.env[CLASSIFY_ONLY_READS_ENABLED_ENV];
  const harness = composeCustomerConductor({
    model: args.model,
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
    realResponder: true,
    scheduleSignal: { isClosed: false, mealPeriod: "dinner" } as never,
  });
  const out = await runCustomerTurn(harness, {
    customerId: args.customerId ?? OWNER_ID,
    conversationId: `conv-r2s8-${seq}`,
    text: args.text,
  });
  return out.response;
}

/** Resolve a probe's date through the SAME pure resolver the runtime uses, and fail the
 *  test (rather than silently assert nothing) if the probe does not anchor a date. */
function dateOf(text: string): string {
  const resolved = resolveQueriedScheduleDate(text, TZ, new Date());
  expect(resolved, `the probe ${JSON.stringify(text)} must anchor a date`).not.toBeNull();
  return resolved!.isoDate;
}

/** pt-BR weekday names, indexed by `getDay()` — used to build a probe that resolves to
 *  TODAY, which is the BKL-152-edge branch of the suppression seam. */
const WEEKDAY_PT = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
] as const;

/** Today's weekday name in the restaurant timezone (not the runner's). */
function todayWeekdayPt(): string {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
  }).format(new Date());
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
  expect(dow, "the timezone weekday must resolve").toBeGreaterThanOrEqual(0);
  return WEEKDAY_PT[dow]!;
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  st.dateReads = [];
  st.holidayDates = [];
  st.overrideDates = [];
  st.todayIsHoliday = false;
});

// ── THE DISCRIMINATION AXIS ─────────────────────────────────────────────────────

describe("R2-S8 — TWO DATES through the same conductor, each rendering its OWN hours", () => {
  it("a Sunday ask and a Saturday ask each render THEIR day, never the sibling's", async () => {
    const sundayText = "qual o horário de domingo?";
    const saturdayText = "qual o horário de sábado?";
    const sunday = dateOf(sundayText);
    const saturday = dateOf(saturdayText);
    // The axis is only an axis if the two subjects differ. Two distinct weekdays always
    // resolve to two distinct dates, but asserting it keeps the test from going vacuous if
    // the resolver's precedence ever changed.
    expect(sunday).not.toBe(saturday);

    const sundayReply = await drive({
      text: sundayText,
      model: claimProposalForbiddenModel("sunday"),
      classifyOnly: true,
    });
    const saturdayReply = await drive({
      text: saturdayText,
      model: claimProposalForbiddenModel("saturday"),
      classifyOnly: true,
    });

    // BOTH DIRECTIONS on each reply. The positive half alone would pass on a system that
    // renders every day's hours; the negative half is what proves the render CHOSE.
    expect(sundayReply).toContain(FOR_DATE_FRAME);
    expect(sundayReply).toContain(hoursFor(sunday));
    expect(sundayReply).not.toContain(hoursFor(saturday));

    expect(saturdayReply).toContain(FOR_DATE_FRAME);
    expect(saturdayReply).toContain(hoursFor(saturday));
    expect(saturdayReply).not.toContain(hoursFor(sunday));

    // …and the backend was genuinely asked for BOTH days, so neither reply is explained by
    // a read that never ran.
    expect(st.dateReads).toContain(sunday);
    expect(st.dateReads).toContain(saturday);
    // Neither reply is the model's.
    expect(sundayReply).not.toBe(MODEL_PROSE);
    expect(saturdayReply).not.toBe(MODEL_PROSE);
  });

  it("the render is the QUERIED day's hours, not TODAY's — the two reads are distinct", async () => {
    // Without this, a system that answered every date-anchored question with today's
    // STORE_HOURS would satisfy "an hours sentence came back".
    const text = "que horas vocês abrem amanhã?";
    const tomorrow = dateOf(text);
    const reply = await drive({
      text,
      model: claimProposalForbiddenModel("tomorrow vs today"),
      classifyOnly: true,
    });
    expect(reply).toContain(hoursFor(tomorrow));
    expect(reply).not.toContain("11h–15h / 18h–23h");
  });

  it("PUBLIC: a GUEST gets the same day-specific hours (no owner gate on this type)", async () => {
    const text = "qual o horário de domingo?";
    const sunday = dateOf(text);
    const reply = await drive({
      text,
      model: claimProposalForbiddenModel("guest"),
      classifyOnly: true,
      customerId: "guest:anon_r2s8",
    });
    expect(reply).toContain(hoursFor(sunday));
    expect(reply).not.toBe(MODEL_PROSE);
  });
});

// ── THE CONJUNCTION GUARD AT THE TURN SEAM ──────────────────────────────────────

describe("R2-S8 — the dateAnchor GUARD half, at the seam the customer sees", () => {
  it("a BARE hours question does NOT render day-specific hours (the guard's whole job)", async () => {
    // The generated marker net matches "horário" here; ONLY the hand-written dateAnchor
    // conjunct keeps this turn off the day-specific span. With the guard deleted the
    // marker byte pin stays green and THIS case is what goes red — the reason the guard
    // needs a behavioural pin at all.
    const reply = await drive({
      text: "qual o horário de funcionamento?",
      model: scriptedModel([{ type: "STORE_OPEN_NOW", subject: "loja" }]),
      classifyOnly: false,
    });
    expect(reply).not.toContain(FOR_DATE_FRAME);
    // …and the day-specific READ never even ran: no date anchor ⟹ the investigator's
    // date gate resolves null ⟹ none of the three date-keyed reads are issued.
    expect(st.dateReads).toEqual([]);
    expect(reply).not.toBe(MODEL_PROSE);
  });

  it("a day named WITHOUT schedule phrasing does not reach this type either", async () => {
    // The mirror control: the guard conjunct is satisfied, the marker net is not. Together
    // with the case above this pins that BOTH halves are load-bearing at the seam.
    const reply = await drive({
      text: "bom domingo! quero fazer um pedido",
      model: scriptedModel([]),
      classifyOnly: false,
    });
    expect(reply).not.toContain(FOR_DATE_FRAME);
    // MEASURED, and worth stating because it is NOT what a reader would assume from the
    // case above: the per-date READ still runs here. The investigator's date gate is
    // driven by `resolveQueriedScheduleDate` over the raw text — NOT by the span — so a
    // greeting that names a weekday does issue the three date-keyed reads. What the span
    // conjunction decides is whether any CLAIM is required or proposed, and no claim is
    // what keeps the day-specific sentence off this reply. The two gates are separate on
    // purpose, and a test asserting "no read ran" would be asserting the wrong one.
    expect(st.dateReads).not.toEqual([]);
  });
});

// ── THE BKL-152 SUPPRESSION SEAM, BOTH DIRECTIONS ───────────────────────────────

describe("R2-S8 — the STORE_OPEN_NOW suppression seam at the turn seam", () => {
  it("a CONFIRMED NON-TODAY date suppresses the open-now companion; the day's hours render", async () => {
    // "amanhã" is non-today by construction, so the seam's exact branch fires under any
    // clock — the one date phrasing that cannot accidentally resolve to today.
    const text = "que horas vocês abrem amanhã?";
    const tomorrow = dateOf(text);
    const reply = await drive({
      text,
      model: claimProposalForbiddenModel("suppression"),
      classifyOnly: true,
    });
    expect(reply).toContain(hoursFor(tomorrow));
    expect(reply).not.toContain(OPEN_NOW_FRAME);
  });

  it("THE CONTROL: the open-now sentence is reachable at all (a bare open-now ask renders it)", async () => {
    // Without this, the suppression case above would pass on a system that had simply
    // lost STORE_OPEN_NOW everywhere — the direction that makes a suppression assertion
    // non-vacuous.
    const reply = await drive({
      text: "vocês estão abertos agora?",
      model: scriptedModel([{ type: "STORE_OPEN_NOW", subject: "loja" }]),
      classifyOnly: false,
    });
    expect(reply).toContain(OPEN_NOW_FRAME);
  });

  it("FINDING (pre-existing): a weekday that IS TODAY degrades the whole turn", async () => {
    // ════════════════════════════════════════════════════════════════════════════
    //  F-12 — MEASURED, PRE-EXISTING, AND PINNED HERE SO A CHANGE MUST ANNOUNCE ITSELF (ledger: F-12; F-11 is the typed-backend-builder finding)
    // ════════════════════════════════════════════════════════════════════════════
    //
    // The BKL-152-edge branch KEEPS the STORE_OPEN_NOW companion when the named weekday
    // resolves to TODAY (`decomposeRequiredClaims`'s `resolvedQueryDate === undefined`
    // arm). On that turn the customer gets the proposition-free generic UNKNOWN instead
    // of the day's real hours — the answerable question is thrown away.
    //
    // MEASURED, not inferred, and on THREE independent paths: the deterministic
    // classify-only path (which DOES build both candidates — verified at the unit level
    // against `buildClassifyOnlyCandidates`, with the correct `schedule:store_open_now`
    // and `schedule:store_hours:{today}` evidence keys), the model path with BOTH claims
    // proposed, and the model path with only the date claim. All three land on the same
    // string. The neighbouring measurement that localises it: on ANY date-anchored turn
    // the open-now companion never reaches the reply — demote the date claim with a
    // holiday and the turn degrades rather than rendering the surviving open-now half —
    // so the "keep it when the day is today" branch requires a companion that this turn
    // shape cannot satisfy, and §O#15 completeness degrades everything.
    //
    // NOT CAUSED BY THIS SLICE, and that is measured rather than argued: the whole probe
    // set above was re-run against a tree checked out at 94b75ce4 (this branch's parent,
    // before any adoption edit) and every reply was BYTE-IDENTICAL. The migration moved
    // no behaviour here; it only made the existing behaviour visible, because this is the
    // first suite to drive a weekday==today hours turn at any depth.
    //
    // MECHANISM, confirmed by a controlled experiment rather than inferred. Delete the
    // BKL-152 suppression outright (`required.delete("STORE_OPEN_NOW")`) and this exact
    // turn renders BOTH sentences correctly:
    //
    //     "No momento, o período de funcionamento é: jantar.
    //      Nesse dia, nosso horário de funcionamento é: 03h–23h."
    //
    // So the answer was available the whole time, and neither claim was unvalidatable.
    // What loses it is a DISAGREEMENT between two decompositions of the same utterance:
    // the claim planner decomposes CLOCK-FREE (the pure #301 arm — always suppress, so
    // STORE_OPEN_NOW is neither proposed nor unioned, and a model that proposes it has it
    // relevance-DEMOTED), while the renderer's §O#15 completeness gate decomposes
    // CLOCK-AWARE (seam active — KEEP, because the named day is today). The gate then
    // requires a companion the planner was told to drop, finds it ABSENT, and degrades.
    // On every other date-anchored turn the two agree on "suppress" and nothing is lost,
    // which is why this has stayed invisible.
    //
    // Backlog-shaped, not fixable inside an adoption slice: the fix is to give the planner
    // the same clock-aware `DateAnchorSignal` the renderer's gate already receives (or to
    // stop the seam keeping a companion the planner cannot deliver). Either change alters
    // live routing for every hours turn and belongs to its own ticket with its own
    // measurement.
    const text = `que horas vocês abrem ${todayWeekdayPt()}?`;
    const today = dateOf(text);
    const reply = await drive({
      text,
      model: claimProposalForbiddenModel("weekday==today"),
      classifyOnly: true,
    });
    // The pin is DIRECTIONAL in both senses: the day's hours are absent (the loss), and
    // the reply is the honest self-report rather than prose or a wrong day (the floor
    // that makes this a degrade and not a soundness failure).
    expect(reply).not.toContain(hoursFor(today));
    expect(reply).toBe(
      "Não localizei essa informação confirmada agora. Quer que eu verifique?",
    );
    expect(reply).not.toBe(MODEL_PROSE);
    // …and the read genuinely ran, so the loss is a routing/completeness one rather than
    // a missing read. That is what makes this worth a ticket instead of a mock fix.
    expect(st.dateReads).toContain(today);
  });
});

// ── THE W6 FALSIFIERS, ON THE QUERIED DATE ──────────────────────────────────────

describe("R2-S8 — the per-date falsifiers demote, and only for THEIR date", () => {
  it("a HOLIDAY on the queried date demotes to UNKNOWN — no hours proposition leaks", async () => {
    const text = "qual o horário de domingo?";
    const sunday = dateOf(text);
    st.holidayDates = [sunday];
    const reply = await drive({
      text,
      model: claimProposalForbiddenModel("holiday falsifier"),
      classifyOnly: true,
    });
    expect(reply).not.toContain(hoursFor(sunday));
    expect(reply).not.toContain(FOR_DATE_FRAME);
    expect(reply).not.toBe(MODEL_PROSE);
  });

  it("a per-date OVERRIDE on the queried date demotes it too (the SHARED falsifier key)", async () => {
    const text = "qual o horário de domingo?";
    const sunday = dateOf(text);
    st.overrideDates = [sunday];
    const reply = await drive({
      text,
      model: claimProposalForbiddenModel("override falsifier"),
      classifyOnly: true,
    });
    expect(reply).not.toContain(hoursFor(sunday));
    expect(reply).not.toContain(FOR_DATE_FRAME);
  });

  it("TODAY's holiday does NOT demote a clean future-date answer (SCN-003, at the seam)", async () => {
    // The date-SUFFIXED falsifier key is what separates the two. Without the suffixing
    // this case renders the safe self-report instead of the day's real hours — a silent,
    // day-of-the-year-dependent loss.
    const text = "que horas vocês abrem amanhã?";
    const tomorrow = dateOf(text);
    st.todayIsHoliday = true;
    const reply = await drive({
      text,
      model: claimProposalForbiddenModel("today holiday isolation"),
      classifyOnly: true,
    });
    expect(reply).toContain(hoursFor(tomorrow));
  });
});

// ── BKL-289's UNION, BOTH DIRECTIONS OF THE SCHEDULE CLUSTER ────────────────────

describe("R2-S8 — the §O#15 union still parameterizes this type off the LEDGER", () => {
  it("the model omits the DATE claim on a compound turn — the union restores it off the ledger", async () => {
    // ── THE UNION PROBE, AND WHY THE TURN IS COMPOUND ────────────────────────────
    //
    // `deriveUnionSubject` reaches STORE_HOURS_FOR_DATE through its PUBLIC-PER-ITEM
    // branch: `publicPerItemBaseKey` resolves `schedule:store_hours` off the (now
    // GENERATED) registry spec, and the subject is the `{date}` suffix of the PRESENT
    // `schedule:store_hours:{date}` entry this turn's investigator recorded. A dropped
    // `perResourceKey` or a drifted base key moves this type into the FIXED-SUBJECT
    // branch, binds the PRINCIPAL as its subject, resolves a key that is ABSENT by
    // construction, and degrades the turn — with nothing red anywhere. So this case is
    // the end-to-end witness that the adoption preserved the classification.
    //
    // The turn has to be COMPOUND, and that is a MEASURED constraint rather than a
    // stylistic one. The union is gated on `candidates.length > 0` (its own header
    // explains why: unioning into an empty set would PROMOTE a successful-empty proposal
    // and re-open the BKL-110 non-sequitur). On a SCHEDULE-ONLY turn, a 4B that proposes
    // only STORE_OPEN_NOW has that proposal RELEVANCE-DEMOTED — the planner's `required`
    // is the clock-free decomposition, which SUPPRESSES the open-now companion — so the
    // candidate set is empty, the union never runs, and the turn falls through to prose
    // (the documented BKL-078 gap; measured on this exact utterance, and byte-identical
    // at 94b75ce4). Adding the price span gives the turn a candidate that SURVIVES
    // relevance, which is what puts the union in play at all.
    const text = "quanto custa a costela? e qual o horário de domingo?";
    const sunday = dateOf(text);
    const reply = await drive({
      text,
      model: scriptedModel([{ type: "MENU_ITEM_PRICE", subject: "prod_costela" }]),
      classifyOnly: false,
    });
    // The model proposed the price ONLY; the hours sentence can only be the union's work.
    expect(reply).toContain("R$ 89,00");
    expect(reply).toContain(FOR_DATE_FRAME);
    expect(reply).toContain(hoursFor(sunday));
    expect(reply).not.toBe(MODEL_PROSE);
  });

  it("THE CONTROL: proposing the date claim explicitly renders the SAME reply", async () => {
    // Without this the case above could pass on a turn that renders the hours for some
    // reason other than the union. Same utterance, same expected string, model proposes
    // BOTH — so the union case is proven to have reconstructed exactly what the model
    // would have supplied, subject included.
    const text = "quanto custa a costela? e qual o horário de domingo?";
    const sunday = dateOf(text);
    const reply = await drive({
      text,
      model: scriptedModel([
        { type: "MENU_ITEM_PRICE", subject: "prod_costela" },
        { type: "STORE_HOURS_FOR_DATE", subject: sunday },
      ]),
      classifyOnly: false,
    });
    expect(reply).toContain(hoursFor(sunday));
    expect(reply).toContain("R$ 89,00");
  });

  it("the model's WRONG date is discarded — the resolver's date is what renders", async () => {
    // The planner DISCARDS `input.subject` for this type and re-derives it from
    // `perception.text` (ibatexas-planner.ts's STORE_HOURS_FOR_DATE branch, untouched by
    // this slice). Feeding a date the customer never named proves the model cannot steer
    // which day is answered — the FIX-2 analog for a public per-date type.
    const text = "qual o horário de domingo?";
    const sunday = dateOf(text);
    const bogus = "1999-12-31";
    expect(bogus).not.toBe(sunday);
    const reply = await drive({
      text,
      model: scriptedModel([{ type: "STORE_HOURS_FOR_DATE", subject: bogus }]),
      classifyOnly: false,
    });
    expect(reply).toContain(hoursFor(sunday));
    expect(reply).not.toContain(hoursFor(bogus));
    // The backend was never asked for the model's day.
    expect(st.dateReads).not.toContain(bogus);
  });
});
