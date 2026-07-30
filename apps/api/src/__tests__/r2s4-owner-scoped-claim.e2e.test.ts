// r2s4-owner-scoped-claim.e2e.test.ts — the FIRST owner-scoped claimdef adoption,
// proven at the REAL customer turn seam in BOTH directions.
//
// WHAT THIS PINS. RESERVATION_STATUS's registry row, template, ClaimDefinition and
// §O#15 closure row are now COMPILED from `claustrum/claimdefs/reservation-status.claim.ts`
// (R2-S4), reaching the runtime through R2-S2's repo-local `perResourceKey` widening. The
// axis this adoption is the first to exercise is OWNERSHIP: `ownerScopedBaseKey`
// (claim-registry.ts) decides owner scoping off the BASE key of the FIRST
// `ownershipPolicy: "required"` evidence row, and `OWNER_SCOPED_KEY_PREFIXES`
// (ibatexas-claims-kernel-deps.ts) joins that base key to the ledger so a PRESENT
// `reservation_status:{id}` read attributes ownership.
//
// WHY BOTH DIRECTIONS, AND WHY THE NEGATIVE IS THE LOAD-BEARING ONE. A spec that lost
// its `ownershipPolicy: "required"` row still SATISFIES the positive direction: the base
// key is unchanged, the read is still recorded, the claim still validates for the owner,
// and the render is byte-identical. What changes is that `ownerScopedBaseKey` returns
// `undefined`, `publicPerItemBaseKey` starts answering for a customer-scoped type, the
// claim planner stops re-resolving the subject from the authenticated owner-scoped reads
// and starts accepting the model's — i.e. the IDOR this wiring closes reopens, silently,
// with the happy path fully green. So the C1 direction is the actual proof; the owner
// direction only establishes that the generated spec works at all.
//
// WHY THE NEGATIVES ARE NOT VACUOUS. The known failure mode of an access-class negative
// test is that it passes with the enforcement DELETED, because nothing in the test ever
// ATTEMPTS the forbidden thing. Here the scripted model proposes
// `{ type: "RESERVATION_STATUS", subject: VICTIM_RESERVATION_ID }` in EVERY case — the
// guest and non-owner cases are genuine IDOR attempts naming a real, existing, seeded
// reservation belonging to someone else. The victim's reservation facts are distinctive
// strings this very suite can produce, so a leak surfaces as a positive assertion
// failure rather than as an absence nobody notices. The authenticated-but-different
// customer additionally owns their OWN reservation with DIFFERENT facts, so the
// non-owner case discriminates "re-resolved to my own" (correct) from "answered about
// the id the model named" (the IDOR).
//
// WHY `realResponder: true` IS LOAD-BEARING (the BKL-273 / LE2-029 lesson). Losing the
// claim is not fail-safe: with nothing to render, the REAL responder authors the answer
// in prose, and the default inert responder would show that as a harmless placeholder.
// The scripted model is ARMED with a confident, unsourced reservation sentence
// (MODEL_RESERVATION_PROSE) that only the model path can produce, and every case asserts
// the reply is not it.
//
// The only fakes are the ModelProvider and the triad read backend. `composeReservationStatusLine`,
// the investigator's owner-scope gate, `selectCandidateClaim`'s key suffixing, the linked
// `@adjudicate/core` kernel, the §O#15 decomposer and the renderer all run for real,
// against the GENERATED registry row.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";

/** The authenticated OWNER of the reservation every case names. */
const OWNER_ID = "cus_owner_r2s4";
/** A DIFFERENT authenticated customer — the cross-owner (C1/IDOR) attacker. */
const OTHER_ID = "cus_other_r2s4";
/** A guest session (`isGuestCustomerId` marker prefix) — owns nothing by construction. */
const GUEST_ID = "guest:anon_r2s4";

/** The reservation the model names in EVERY case. Owned by OWNER_ID only. */
const VICTIM_RESERVATION_ID = "res_victim_9001";
/** OTHER_ID's own reservation — deliberately DIFFERENT facts, so the non-owner case can
 *  tell a correct re-resolution from a leak. */
const OTHER_RESERVATION_ID = "res_other_9002";
/** OWNER_ID's SECOND reservation. Its whole purpose is the subject-discriminating pair
 *  below: two reservations in the SAME owner's ledger, so a per-subject render can be
 *  told apart from a render that is incidentally right for one subject. Every field
 *  differs from the first so no assertion can confuse the two. */
const OWNER_SECOND_RESERVATION_ID = "res_owner_9003";

// The seeded reservations. Field shapes mirror what the domain `getById` returns, so
// `composeReservationStatusLine` (the REAL composer) produces the production scalar.
const RESERVATIONS: Record<
  string,
  {
    readonly ownerId: string;
    readonly status: string;
    readonly partySize: number;
    readonly date: string;
    readonly startTime: string;
  }
> = {
  [VICTIM_RESERVATION_ID]: {
    ownerId: OWNER_ID,
    status: "confirmed",
    partySize: 4,
    date: "2026-07-20",
    startTime: "19:30",
  },
  [OTHER_RESERVATION_ID]: {
    ownerId: OTHER_ID,
    status: "pending",
    partySize: 2,
    date: "2026-07-21",
    startTime: "20:00",
  },
  [OWNER_SECOND_RESERVATION_ID]: {
    ownerId: OWNER_ID,
    status: "cancelled",
    partySize: 8,
    date: "2026-12-25",
    startTime: "12:00",
  },
};

/**
 * The rendered fragments unique to the VICTIM's reservation — a leak in either negative
 * direction can only show up as one of these appearing.
 *
 * NOTE the status word is spelled as the RENDERED CLAUSE (`"é: confirmada"`), not the
 * bare adjective. The honest-abstain template this suite's negatives legitimately land on
 * is "Não localizei essa informação CONFIRMADA agora…", where "confirmada" modifies
 * "informação" and carries no reservation fact at all. A bare-substring leak witness
 * would fire on the very degrade that proves the wall holds — a false RED that would
 * have been "fixed" by weakening the assertion.
 */
const VICTIM_FACTS = ["é: confirmada", "20/07", "19:30", "4 pessoas"] as const;
/** OTHER_ID's own fragments — what a CORRECT re-resolution renders for them. */
const OTHER_FACTS = ["é: pendente", "21/07", "20:00", "2 pessoas"] as const;

/** What a real 4B does with a reservation question once the turn leaves the
 *  deterministic path — armed here so its return is a test failure, not a silent
 *  regression. Names a status, a date, a time and a party size NO read produced. */
const MODEL_RESERVATION_PROSE =
  "Sua reserva está confirmada para hoje às 21h para 6 pessoas, mesa perto da janela. " +
  "Qualquer coisa é só avisar!";

const backend = vi.hoisted(() => ({
  /** Every (reservationId, customerId) pair the owner-scoped read was asked for — so a
   *  case can prove the read was ATTEMPTED and refused, not merely never reached. */
  reservationReads: [] as Array<{ id: string; customerId: string; owned: boolean }>,
}));

vi.mock("../claustrum/turn-reads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claustrum/turn-reads.js")>();
  const notUsed = (name: string) => async (): Promise<never> => {
    throw new Error(`turn-reads.${name} must not run in this suite`);
  };
  return {
    ...actual,
    createDomainTriadReadBackend: () => ({
      readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
      readScheduleOverride: async () => null,
      readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
      readHoliday: async () => null,
      readHoursForDate: async () => ({ hoursText: "11h–15h / 18h–23h" }),
      readHolidayForDate: async () => null,
      readOrderFulfillment: notUsed("readOrderFulfillment"),
      readPaymentStatus: notUsed("readPaymentStatus"),
      readPaymentRefund: notUsed("readPaymentRefund"),
      readPaymentChargeback: notUsed("readPaymentChargeback"),
      readCartContents: notUsed("readCartContents"),
      readOrderHistory: notUsed("readOrderHistory"),
      readPaymentHistory: notUsed("readPaymentHistory"),
      readScheduleOverrideForDate: async () => null,

      // THE OWNER-SCOPED READ. `null` on a cross-owner / absent id is the production
      // contract (turn-reads.ts `readReservation`: owner-scoped `getById` throws on a
      // cross-owner id, caught → null), and the investigator turns that into
      // `OwnerScopedReadUnavailable` → `recordError` → ledger state `error`. Inv 7:
      // error ≠ absence, and an errored read NEVER attributes ownership.
      readReservation: async (reservationId: string, customerId: string) => {
        const r = RESERVATIONS[reservationId];
        const owned = r !== undefined && r.ownerId === customerId;
        backend.reservationReads.push({ id: reservationId, customerId, owned });
        if (!owned) return null;
        return {
          reservationId,
          status: r.status,
          partySize: r.partySize,
          // The REAL composer — the C6-bound scalar is production's, not the test's.
          statusLine: actual.composeReservationStatusLine({
            status: r.status,
            partySize: r.partySize,
            isoDate: r.date,
            startTime: r.startTime,
          }),
        };
      },

      // FE-T17b — the owner-scoped enumeration the investigator unions in (a
      // `get_my_reservations` LIST call carries no id, so the model's extraction is
      // structurally empty). Keyed ONLY by customerId, so it is the wall that decides
      // which subjects can ever be admissible.
      listActiveReservationIds: async (customerId: string) =>
        Object.entries(RESERVATIONS)
          .filter(([, r]) => r.ownerId === customerId)
          .map(([id]) => id),

      // A reservation question owns no order/payment; present-with-0 keeps §O#15 from
      // force-requiring an order companion.
      listActiveOrderIds: async () => [],
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
      // The planner's intent leg AND the responder's authoring call both land here.
      // Non-empty on purpose: an empty completion trips the planner's extraction-failure
      // REFUSE and would short-circuit before the claims render, making the assertions
      // pass for the wrong reason.
      return { ...base, text: MODEL_RESERVATION_PROSE, toolCalls: [] };
    }),
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  } as unknown as ModelProvider;
}

let turnSeq = 0;

async function runReservationTurn(args: {
  readonly customerId: string;
  readonly text: string;
  /** The subject the MODEL proposes — the id under IDOR test. */
  readonly proposedSubject: string;
}): Promise<string> {
  turnSeq += 1;
  const harness = composeCustomerConductor({
    model: scriptedModel([
      { type: "RESERVATION_STATUS", subject: args.proposedSubject },
    ]),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
    // Production's responder — without it the prose regression is invisible.
    realResponder: true,
    scheduleSignal: { isClosed: false, mealPeriod: "dinner" } as never,
  });
  const out = await runCustomerTurn(harness, {
    customerId: args.customerId,
    conversationId: `conv-r2s4-${turnSeq}`,
    text: args.text,
  });
  return out.response;
}

const ASK = "minha reserva está confirmada?";

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  backend.reservationReads.length = 0;
});

// ── DIRECTION (a): the authenticated OWNER ─────────────────────────────────────────
describe("R2-S4 e2e — the GENERATED owner-scoped spec renders for its OWNER", () => {
  it("the owner's own reservation VALIDATES and renders the C6-bound statusLine", async () => {
    const response = await runReservationTurn({
      customerId: OWNER_ID,
      text: ASK,
      proposedSubject: VICTIM_RESERVATION_ID,
    });

    // The generated template's static frame + the ledger-sourced scalar. This passes
    // only if the generated spec's BARE `reservation_status` was suffixed to
    // `reservation_status:res_victim_9001` and resolved the investigator's real
    // per-subject entry — lose the perResourceKey flag and the kernel resolves the bare
    // key, the evidence reads ABSENT, and the claim degrades to an honest UNKNOWN.
    expect(response).toContain("O status da sua reserva é:");
    for (const fact of VICTIM_FACTS) expect(response).toContain(fact);
    expect(response).not.toBe(MODEL_RESERVATION_PROSE);
    // The model's invented facts never reach the customer.
    expect(response).not.toMatch(/21h|6 pessoas|janela/i);
    // …and the turn genuinely went to the owner-scoped read for it.
    expect(backend.reservationReads).toContainEqual({
      id: VICTIM_RESERVATION_ID,
      customerId: OWNER_ID,
      owned: true,
    });
  });

  // THE SUBJECT-DISCRIMINATING PAIR — the R2-S2 template's added value, transposed onto an
  // OWNER-SCOPED type. The case above establishes that the generated spec works at all;
  // it cannot distinguish "the keys are suffixed per subject" from "there happens to be
  // exactly one entry and any key shape would have found it". So: ONE owner who owns TWO
  // reservations, each named in turn, each of which must come back with ITS OWN
  // pre-composed scalar and NOT the sibling's. A spec that emitted a pre-suffixed key, or
  // dropped the flag so both subjects collapsed onto one bare `reservation_status`, cannot
  // satisfy both rows.
  //
  // This is also the ≥2-owned condition, which is the interesting one for an owner-scoped
  // type: with two owned reservations and an EMPTY model subject, FIX 2 forces CLARIFY
  // rather than guessing. Here the model names one UNAMBIGUOUSLY, so it is honoured — the
  // two behaviours share a code path and this pins the honoured half at the turn seam.
  it.each([
    [VICTIM_RESERVATION_ID, "confirmada", "20/07", "19:30", "4 pessoas", "cancelada", "25/12"],
    [OWNER_SECOND_RESERVATION_ID, "cancelada", "25/12", "12:00", "8 pessoas", "confirmada", "20/07"],
  ] as const)(
    "subject %s → its OWN statusLine renders, never the sibling's",
    async (subject, status, date, time, party, siblingStatus, siblingDate) => {
      const response = await runReservationTurn({
        customerId: OWNER_ID,
        text: ASK,
        proposedSubject: subject,
      });

      expect(response).toContain(`O status da sua reserva é: ${status} — ${date} às ${time}, para ${party}.`);
      // The discriminating half: the sibling's facts are real strings this very suite can
      // produce, so a collapsed or pre-suffixed key would surface them here.
      expect(response).not.toContain(siblingDate);
      expect(response).not.toContain(`é: ${siblingStatus}`);
      expect(response).not.toBe(MODEL_RESERVATION_PROSE);
      // Both reservations were read (the owner owns both), so the render genuinely CHOSE
      // between two present per-subject ledger entries rather than having only one.
      expect(backend.reservationReads).toContainEqual({
        id: VICTIM_RESERVATION_ID,
        customerId: OWNER_ID,
        owned: true,
      });
      expect(backend.reservationReads).toContainEqual({
        id: OWNER_SECOND_RESERVATION_ID,
        customerId: OWNER_ID,
        owned: true,
      });
    },
  );
});

// ── DIRECTION (b): the C1 / IDOR direction ────────────────────────────────────────
describe("R2-S4 e2e — the GENERATED owner-scoped spec FAILS CLOSED for a non-owner", () => {
  it("a GUEST naming the owner's reservation id gets NO reservation fact", async () => {
    const response = await runReservationTurn({
      customerId: GUEST_ID,
      text: ASK,
      proposedSubject: VICTIM_RESERVATION_ID,
    });

    // The wall: `isAuthenticatedCustomer` gates the whole owner-scoped read block
    // (ibatexas-investigator.ts), so a guest records NO `reservation_status:` entry —
    // hence no owned resource, hence `owns → false`, hence REFUSED. "No owner" ≠ "any
    // owner" (Inv 2).
    expect(response).not.toContain("O status da sua reserva é:");
    for (const fact of VICTIM_FACTS) expect(response).not.toContain(fact);
    // And not via the OTHER escape hatch either — the model must not author it.
    expect(response).not.toBe(MODEL_RESERVATION_PROSE);
    expect(response).not.toMatch(/21h|6 pessoas|janela/i);
    // The owner-scoped read was never even ATTEMPTED for a guest (gated upstream), which
    // is what makes this the strongest of the three walls rather than the weakest.
    expect(backend.reservationReads).toHaveLength(0);
  });

  it("an AUTHENTICATED non-owner naming the owner's reservation id gets THEIR OWN, never the owner's", async () => {
    const response = await runReservationTurn({
      customerId: OTHER_ID,
      text: ASK,
      proposedSubject: VICTIM_RESERVATION_ID,
    });

    // THE DISCRIMINATING ASSERTION. The model named the victim's id; the customer gets a
    // fact about THEMSELVES or nothing.
    for (const fact of VICTIM_FACTS) expect(response).not.toContain(fact);
    expect(response).not.toBe(MODEL_RESERVATION_PROSE);
    if (response.includes("O status da sua reserva é:")) {
      for (const fact of OTHER_FACTS) expect(response).toContain(fact);
    }

    // WHERE THE WALL ACTUALLY IS — measured, not assumed. The victim's id is NEVER READ
    // AT ALL for this customer, so there is no cross-owner refusal to observe here: the
    // reservation read set is `extractTurnResourceIds` ∪ `listActiveReservationIds(customerId)`
    // (ibatexas-investigator.ts FE-T17b), and a `propose_claim` SUBJECT feeds NEITHER —
    // the former reads read-TOOL params, the latter is keyed ONLY by the authenticated
    // customerId. So the model cannot get an id into the ledger by naming it, which is a
    // strictly stronger wall than "the read is attempted and refused".
    //
    // That is why this pair of assertions is the non-vacuous one: it pins that the
    // admissible-subject set is derived from the AUTHENTICATED enumeration rather than
    // from the proposal. If the generated spec lost `ownershipPolicy: "required"`,
    // `ownerScopedBaseKey` would return `undefined`, the claim planner would stop
    // re-resolving the subject from owner-scoped reads, and the model's proposed subject
    // would be honoured — at which point the victim's id WOULD reach a read and this
    // pair would move.
    expect(backend.reservationReads).not.toContainEqual({
      id: VICTIM_RESERVATION_ID,
      customerId: OTHER_ID,
      owned: false,
    });
    expect(backend.reservationReads).toContainEqual({
      id: OTHER_RESERVATION_ID,
      customerId: OTHER_ID,
      owned: true,
    });
    // The customer whose id it is can still read it — so the absence above is scoping,
    // not a suite-wide inability to read that reservation.
    expect(RESERVATIONS[VICTIM_RESERVATION_ID]!.ownerId).toBe(OWNER_ID);
  });
});

// ── The C1 REFUSAL itself (a cross-owner read that IS attempted) is proven one layer
//    down, against this SAME generated registry row. Cited rather than duplicated:
//    `claustrum/__tests__/reservation-status-claim.test.ts` drives the REAL planner, the
//    REAL `selectCandidateClaim`/`REGISTRY_SPECS`/`CLAIM_DEFINITIONS` and the LINKED
//    `@adjudicate/core` kernel over a ledger holding a cross-owner read ERROR and a
//    present-but-unowned value, and asserts both degrade SAFE. Because it resolves the
//    spec through the real registry, it now runs against the GENERATED row — it needed no
//    edit for this adoption, and it would go red if the compiled spec's ownership rows
//    changed. What it cannot say, and what the three cases above add, is that the wall
//    holds through a REAL handleTurn where the subject's provenance is the live
//    investigator rather than a hand-built ledger.
