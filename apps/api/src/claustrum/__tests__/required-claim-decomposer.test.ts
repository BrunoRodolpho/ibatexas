/**
 * required-claim-decomposer.test.ts — SDD §O#15 (Plan 1 Phase 3). Pins:
 *   (1) the closure table maps each span-class to its mandatory required set;
 *   (2) decomposition is CONSERVATIVE-OVER-DECOMPOSING (union; over-include);
 *   (3) an unrecognized span-class forces NO companion (no over-suppression);
 *   (4) completeness quantifies over the REQUIRED set, not the candidates —
 *       an ABSENT / UNKNOWN / REFUSED required companion DEGRADES the turn;
 *   (5) the closure table references only in-registry claim types.
 */
import type { ClaimVerdict } from "@adjudicate/core";
import { describe, expect, it } from "vitest";
import { isRegistryClaimType, type RegistryClaimType } from "../claim-registry.js";
// inv.18 v2 / R2-S4 — the GENERATED reservation closure, asserted directly (per-arm
// marker pins) rather than only through the reassembled `__SPAN_NET_SOURCES_FOR_TEST`
// string, which cannot witness where the arm boundary sits.
// inv.18 v2 / R2-S5 — the GENERATED history closures, pinned per arm for the same reason.
// inv.18 v2 / R2-S6 — the GENERATED cart closure: ONE arm, and the SHARED row.
// inv.18 v2 / R2-S7 — the GENERATED status closures. These two need the per-arm form MORE
// than their predecessors: the ORDER net spans THREE provenances (a split literal, two
// relocated consts, one composed sequence) so its pins address slices of the array, and the
// PAYMENT net is only PART of its span's runtime predicate (two dual-use tokens stay
// guard-conjoined at the classifier), so a whole-net pin would assert a net nothing runs.
// STORE_OPEN_NOW's closure comes along to prove no source claims the hand-written PICKUP_Q.
// inv.18 v2 / R2-S9 — the GENERATED fixed-subject closures. The three SHARED rows are
// pinned through their span-OWNING source, and the PAIRING net needs the per-arm form more
// than any predecessor: its two arms are also the RELATION DISCRIMINATOR read positionally
// at runtime, so a swapped array would invert every borrowed-vocabulary utterance's relation
// with the joined pin still byte-identical.
import { CART_CONTENTS_CLOSURE } from "../claimdefs/cart-contents.generated.js";
import { COUPON_VALID_CLOSURE } from "../claimdefs/coupon-valid.generated.js";
import { DELIVERY_COVERAGE_CLOSURE } from "../claimdefs/delivery-coverage.generated.js";
import { MENU_OVERVIEW_CLOSURE } from "../claimdefs/menu-overview.generated.js";
import { MENU_PAIRINGS_CLOSURE } from "../claimdefs/menu-pairings.generated.js";
import { ORDER_FULFILLMENT_STAGE_CLOSURE } from "../claimdefs/order-fulfillment-stage.generated.js";
import { ORDER_HISTORY_CLOSURE } from "../claimdefs/order-history.generated.js";
import { PAYMENT_HISTORY_CLOSURE } from "../claimdefs/payment-history.generated.js";
import { PAYMENT_STATUS_CLOSURE } from "../claimdefs/payment-status.generated.js";
import { RESERVATION_STATUS_CLOSURE } from "../claimdefs/reservation-status.generated.js";
import { STORE_HOURS_FOR_DATE_CLOSURE } from "../claimdefs/store-hours-for-date.generated.js";
import { STORE_OPEN_NOW_CLOSURE } from "../claimdefs/store-open-now.generated.js";
// BKL-285 — the classify-only ROUTE gate. Imported here so the reservation
// create/read split can be asserted on the decision that actually costs the
// customer their booking, not merely on the span label one step upstream.
import { classifyOnlyRequiredTypes } from "../classify-only-reads.js";
import {
  type ActiveResourceOwnership,
  checkRequiredClaimCompleteness,
  classifyRequestSpans,
  decomposeRequiredClaims,
  detectMedicalEmergencyMarkers,
  hasMutationImperative,
  hasReservationCreateImperative,
  isAllergenFamilyAsk,
  isBothPairingAsk,
  isCouponValidityAsk,
  isDeliveryCoverageAsk,
  isMedicalEmergencyAsk,
  isPairingAsk,
  isSpanClass,
  classifyPairingAsk,
  PRESENCE_COMPLEMENT_PAIRS,
  REQUIRED_CLAIM_CLOSURE,
  __SPAN_NET_SOURCES_FOR_TEST,
} from "../required-claim-decomposer.js";

describe("required-claim decomposer — closure table (SDD §O#15)", () => {
  it("every closure value is an in-registry claim type", () => {
    for (const types of Object.values(REQUIRED_CLAIM_CLOSURE)) {
      for (const t of types) expect(isRegistryClaimType(t)).toBe(true);
    }
  });

  it("a pickup/hours question requires MORE than one type (the §O#15 worked example)", () => {
    const required = decomposeRequiredClaims(["PICKUP_Q"]);
    expect(required.has("STORE_OPEN_NOW")).toBe(true);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(required.size).toBe(2);
  });

  it("each single span-class maps to its declared required set", () => {
    expect([...decomposeRequiredClaims(["STORE_OPEN_NOW_Q"])]).toEqual([
      "STORE_OPEN_NOW",
    ]);
    expect([...decomposeRequiredClaims(["STORE_HOURS_FOR_DATE_Q"])]).toEqual([
      "STORE_HOURS_FOR_DATE",
    ]);
    expect([...decomposeRequiredClaims(["ORDER_STATUS_Q"])]).toEqual([
      "ORDER_FULFILLMENT_STAGE",
    ]);
    expect([...decomposeRequiredClaims(["PAYMENT_STATUS_Q"])]).toEqual([
      "PAYMENT_STATUS",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKL-138 — the DAY-SPECIFIC hours span class (SCN-002/003). Fires ONLY on the
// CONJUNCTION of a date anchor (named weekday / "amanhã" / "feriado") AND schedule
// phrasing; demote-only safe (over-inclusion only forces the date-hours companion).
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyRequestSpans — BKL-138 STORE_HOURS_FOR_DATE_Q", () => {
  it("'qual o horário de domingo?' → STORE_HOURS_FOR_DATE_Q → requires STORE_HOURS_FOR_DATE", () => {
    const spans = classifyRequestSpans("qual o horário de domingo?");
    expect(spans).toContain("STORE_HOURS_FOR_DATE_Q");
    const required = decomposeRequiredClaims(spans);
    expect(required.has("STORE_HOURS_FOR_DATE")).toBe(true);
  });

  it("'vocês abrem amanhã no feriado?' → STORE_HOURS_FOR_DATE_Q (SCN-003)", () => {
    const spans = classifyRequestSpans("vocês abrem amanhã no feriado?");
    expect(spans).toContain("STORE_HOURS_FOR_DATE_Q");
    // …and this phrasing does NOT trip STORE_OPEN_NOW_Q (no abert/que horas/funciona/horário).
    expect(spans).not.toContain("STORE_OPEN_NOW_Q");
  });

  it("named-weekday variants with schedule context all fire", () => {
    for (const text of [
      "que horas abre segunda?",
      "funcionam no sábado?",
      "tem expediente na terça?",
      "vocês atendem quarta-feira?",
    ]) {
      expect(classifyRequestSpans(text)).toContain("STORE_HOURS_FOR_DATE_Q");
    }
  });

  it("a bare schedule question with NO date anchor does NOT fire (stays STORE_OPEN_NOW_Q)", () => {
    const spans = classifyRequestSpans("que horas vocês funcionam?");
    expect(spans).not.toContain("STORE_HOURS_FOR_DATE_Q");
    expect(spans).toContain("STORE_OPEN_NOW_Q");
  });

  it("DEMOTE-ONLY safety: a greeting that merely names a day is NOT swept in", () => {
    // No schedule phrasing → the date anchor alone must not force the companion.
    for (const text of ["bom domingo pra você!", "até sábado, obrigado!", "feliz feriado!"]) {
      expect(classifyRequestSpans(text)).not.toContain("STORE_HOURS_FOR_DATE_Q");
    }
  });

  it("the BKL-005 statement corpus is not over-promoted by the date markers", () => {
    for (const text of [
      "meu pedido chegou, obrigado!",
      "vou pagar com pix",
      "adorei o pagode de sábado", // a weekday word but no schedule context
    ]) {
      expect(classifyRequestSpans(text)).not.toContain("STORE_HOURS_FOR_DATE_Q");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKL-152 — DATE-ANCHOR companion suppression (SCN-002 blocker). A date-anchored
// hours question trips STORE_HOURS_FOR_DATE_Q AND (via "horário"/"que horas")
// STORE_OPEN_NOW_Q; the TODAY open-now companion is irrelevant to a FUTURE-date
// question and the planner never resolves it → the §O#15 completeness gate
// demote-degraded an otherwise-VALIDATED date-hours render to UNKNOWN. The decomposer
// SUPPRESSES STORE_OPEN_NOW iff STORE_HOURS_FOR_DATE_Q ∈ spans AND PICKUP_Q ∉ spans.
// Demote-only: the date-specific hours still render. All four directions pinned.
// ─────────────────────────────────────────────────────────────────────────────
describe("required-claim decomposer — BKL-152 date-anchor STORE_OPEN_NOW suppression", () => {
  it("SUPPRESS (end-to-end): 'que horas vocês abrem amanhã?' drops STORE_OPEN_NOW, keeps STORE_HOURS_FOR_DATE", () => {
    const spans = classifyRequestSpans("que horas vocês abrem amanhã?");
    // Premise — BOTH spans fire: "que horas" trips STORE_OPEN_NOW_Q; amanhã+schedule
    // trips the date-for span. Pre-fix this forced the STORE_OPEN_NOW companion.
    expect(spans).toContain("STORE_HOURS_FOR_DATE_Q");
    expect(spans).toContain("STORE_OPEN_NOW_Q");
    const required = decomposeRequiredClaims(spans);
    expect(required.has("STORE_HOURS_FOR_DATE")).toBe(true);
    expect(required.has("STORE_OPEN_NOW")).toBe(false);
  });

  it("SUPPRESS (end-to-end): 'qual o horário de domingo?' → only STORE_HOURS_FOR_DATE (the exact SCN-002 phrasing)", () => {
    const spans = classifyRequestSpans("qual o horário de domingo?");
    expect(spans).toContain("STORE_HOURS_FOR_DATE_Q");
    // "horário" trips STORE_OPEN_NOW_Q (store-open-now.generated markers /hor[áa]rio/).
    expect(spans).toContain("STORE_OPEN_NOW_Q");
    expect([...decomposeRequiredClaims(spans)]).toEqual(["STORE_HOURS_FOR_DATE"]);
  });

  it("SUPPRESS (unit): STORE_HOURS_FOR_DATE_Q + STORE_OPEN_NOW_Q → only STORE_HOURS_FOR_DATE", () => {
    expect(
      [...decomposeRequiredClaims(["STORE_OPEN_NOW_Q", "STORE_HOURS_FOR_DATE_Q"])],
    ).toEqual(["STORE_HOURS_FOR_DATE"]);
  });

  it("KEEP (today): 'que horas vocês abrem hoje?' keeps STORE_OPEN_NOW ('hoje' never fires the date-for span)", () => {
    const spans = classifyRequestSpans("que horas vocês abrem hoje?");
    expect(spans).not.toContain("STORE_HOURS_FOR_DATE_Q");
    expect(spans).toContain("STORE_OPEN_NOW_Q");
    expect(decomposeRequiredClaims(spans).has("STORE_OPEN_NOW")).toBe(true);
  });

  it("KEEP (undated): 'vocês estão abertos agora?' keeps STORE_OPEN_NOW", () => {
    const spans = classifyRequestSpans("vocês estão abertos agora?");
    expect(spans).not.toContain("STORE_HOURS_FOR_DATE_Q");
    expect(decomposeRequiredClaims(spans).has("STORE_OPEN_NOW")).toBe(true);
  });

  it("KEEP (pickup, unit): a date-for span alongside PICKUP_Q keeps STORE_OPEN_NOW (pickup needs open-now)", () => {
    const required = decomposeRequiredClaims([
      "PICKUP_Q",
      "STORE_OPEN_NOW_Q",
      "STORE_HOURS_FOR_DATE_Q",
    ]);
    expect(required.has("STORE_OPEN_NOW")).toBe(true);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(required.has("STORE_HOURS_FOR_DATE")).toBe(true);
  });

  it("KEEP (pickup, end-to-end): 'que horas posso retirar amanhã?' keeps STORE_OPEN_NOW", () => {
    const spans = classifyRequestSpans("que horas posso retirar amanhã?");
    expect(spans).toContain("PICKUP_Q");
    expect(spans).toContain("STORE_HOURS_FOR_DATE_Q");
    expect(decomposeRequiredClaims(spans).has("STORE_OPEN_NOW")).toBe(true);
  });

  it("NO-OP: a lone STORE_HOURS_FOR_DATE_Q (no open-now span) is unchanged (delete is a no-op)", () => {
    expect([...decomposeRequiredClaims(["STORE_HOURS_FOR_DATE_Q"])]).toEqual([
      "STORE_HOURS_FOR_DATE",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-12 — THE DECOMPOSITION IS CLOCK-FREE, AND THAT IS THE PARITY CONTRACT.
//
// THIS BLOCK PREVIOUSLY PINNED THE DEFECT. Under BKL-152-edge (@claustrum/core
// 0.8.0) this function took an OPTIONAL `DateAnchorSignal`, and these cases pinned
// its arms: seam ACTIVE + a resolved non-today date → SUPPRESS, seam ACTIVE +
// ABSENT date (⇒ the named weekday IS today) → KEEP STORE_OPEN_NOW. The KEEP arm
// is what F-12 removed. It was the only input on which two callers of this ONE
// shared function could compute two DIFFERENT required sets for the same
// utterance — the claim planner called it clock-free (always suppress) while the
// renderer's §O#15 gate called it clock-aware (keep, on the day the weekday is
// today), so the gate demanded a companion the planner had already dropped, found
// it ABSENT, and degraded a fully answerable hours turn to a proposition-free
// UNKNOWN once a week. The parameter is gone; the arms below are what replaces it.
//
// WHY THIS IS A PARITY PIN AND NOT JUST A BEHAVIOUR PIN: the required set for a
// date-anchored ask is now a function of the SPAN CLASSES ALONE. Every caller
// passes the same spans for the same utterance, so all three necessarily agree —
// there is no argument left to disagree about. An RTR that re-splits them (adding
// back a clock-ish input that one caller passes and another does not) has to
// change this function's signature, and the two-caller identity case below is
// what reds when the answer stops being caller-independent.
// ─────────────────────────────────────────────────────────────────────────────
describe("required-claim decomposer — F-12 clock-free date-anchor decomposition", () => {
  const dateSpans = ["STORE_OPEN_NOW_Q", "STORE_HOURS_FOR_DATE_Q"] as const;

  it("a date-anchored hours ask SUPPRESSES STORE_OPEN_NOW — unconditionally", () => {
    expect([...decomposeRequiredClaims([...dateSpans])]).toEqual([
      "STORE_HOURS_FOR_DATE",
    ]);
  });

  it("THE FIX: the answer does not depend on WHICH day is named — no clock input exists", () => {
    // The old KEEP arm was reachable ONLY by passing a third argument. There is no
    // longer any way to express "the named day is today" to this function, so the
    // weekday==today utterance and the tomorrow utterance decompose IDENTICALLY.
    // Driven through the real classifier on two REAL utterances rather than on
    // hand-built span arrays, so a classifier change cannot make this vacuous.
    const todayish = decomposeRequiredClaims(
      classifyRequestSpans("que horas vocês abrem segunda?"),
    );
    const tomorrow = decomposeRequiredClaims(
      classifyRequestSpans("que horas vocês abrem amanhã?"),
    );
    expect([...todayish].sort()).toEqual([...tomorrow].sort());
    expect([...todayish]).toEqual(["STORE_HOURS_FOR_DATE"]);
  });

  it("PARITY: every caller decomposing the SAME utterance gets the SAME set (arity is the contract)", () => {
    // The three production callers — the claim planner, the classify-only
    // eligibility gate and the renderer's §O#15 completeness gate — differ ONLY in
    // whether they supply the `ownership` argument. Ownership cannot touch the
    // schedule cluster (STORE_OPEN_NOW / STORE_HOURS_FOR_DATE are PUBLIC and appear
    // in no OWNERSHIP_GATED_TYPES row), so on a schedule ask all three agree even
    // across that difference. This is the pin that reds if a clock-ish input is
    // reintroduced on one side.
    const spans = classifyRequestSpans("que horas vocês abrem segunda?");
    const plannerSide = decomposeRequiredClaims(spans);
    const gateSideOwnsNothing = decomposeRequiredClaims(spans, {
      hasActiveOrder: false,
      hasActivePayment: false,
    });
    const gateSideOwnsBoth = decomposeRequiredClaims(spans, {
      hasActiveOrder: true,
      hasActivePayment: true,
    });
    expect([...gateSideOwnsNothing].sort()).toEqual([...plannerSide].sort());
    expect([...gateSideOwnsBoth].sort()).toEqual([...plannerSide].sort());
  });

  it("PICKUP still wins over the date suppression (the companion is a real half there)", () => {
    const required = decomposeRequiredClaims(["PICKUP_Q", ...dateSpans]);
    expect(required.has("STORE_OPEN_NOW")).toBe(true);
    expect(required.has("STORE_HOURS_FOR_DATE")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FE-T17 — RESERVATION_STATUS_Q (review fix, PR #249). The marker is ANCHORED
// (`(?<![a-z])reserv(?!at)(a|ar|ad|am|as|ando|ei|ou)`), not a bare substring test:
// the original unanchored `/reserva/` false-fired on the unrelated preserv* family
// (both share the substring "reserva") and — via the completeness gate
// (claims-renderer-adapter.ts) — a false span match can degrade an otherwise-valid
// answer to a DIFFERENT question to UNKNOWN. It also did NOT actually match
// "reservei" / "reservou" despite its old comment claiming coverage. These tests
// pin BOTH directions: every verb form the domain sees fires, and the false-positive
// family (plus "reservatório", a real word sharing the "reserva-" prefix but outside
// this domain) does not.
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyRequestSpans — FE-T17 RESERVATION_STATUS_Q (anchored marker)", () => {
  // BKL-285 — TWO entries left this list, and they left for the SAME reason the
  // ticket exists: `reservar` and "quero reservar uma mesa" are the CREATE verb,
  // not a reference to an existing booking. Pinning them as must-FIRE pinned the
  // defect — a customer asking to BOOK got the status read and lost the booking.
  // They now live in the BKL-285 create-direction block below. Nothing about the
  // ANCHORING claim this test makes is weakened by the move: the must-NOT-fire
  // half (`preservar` — which CONTAINS `reservar` — and the rest of the preserv*
  // family) is untouched and still proves the left guard.
  it("fires on every reservation verb form this domain sees", () => {
    for (const text of [
      "reserva",
      "reservas",
      "reservado",
      "reservada",
      "reservei",
      "reservou",
      "minha reserva",
      "qual minha reserva?",
      "como está minha reserva de amanhã?",
      "vocês reservam mesa para hoje?",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("RESERVATION_STATUS_Q");
    }
  });

  it("'qual minha reserva?' → RESERVATION_STATUS_Q → requires RESERVATION_STATUS", () => {
    const spans = classifyRequestSpans("qual minha reserva?");
    expect(spans).toContain("RESERVATION_STATUS_Q");
    const required = decomposeRequiredClaims(spans);
    expect(required.has("RESERVATION_STATUS")).toBe(true);
  });

  it("does NOT false-fire on the unrelated preserv* family (the anchoring fix)", () => {
    for (const text of [
      "preservar",
      "preservam",
      "preservação",
      "preservativo",
      "vamos preservar o meio ambiente",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("RESERVATION_STATUS_Q");
    }
  });

  it("does NOT fire on 'reservatório' (shares the reserva- prefix, outside this domain)", () => {
    expect(classifyRequestSpans("o reservatório está vazando")).not.toContain(
      "RESERVATION_STATUS_Q",
    );
  });

  // BKL-217 — read-vs-mutation split (the reservation sibling of BKL-201/206): a
  // reservation MUTATION must NOT fire the READ span, or classify-only answers the
  // read and silently drops the reservation.cancel / reservation.modify. Gated on
  // the shared `mutationImperative` net (cancel/mud/troc/…).
  it("does NOT fire on reservation MUTATIONS (routes to the mutation/model path)", () => {
    for (const text of [
      "cancela minha reserva",
      "cancelar minha reserva das 18:30",
      "quero cancelar minha reserva",
      "muda minha reserva para 20h",
      "mudar minha reserva para amanhã",
      "troca minha reserva para 4 pessoas",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("RESERVATION_STATUS_Q");
    }
  });

  it("a how-to interrogative ('como cancelo minha reserva?') routes to the model (fail-safe, no read span)", () => {
    expect(classifyRequestSpans("como cancelo minha reserva?")).not.toContain(
      "RESERVATION_STATUS_Q",
    );
  });

  it("a genuine reservation QUESTION still fires (the gate only excludes mutations)", () => {
    for (const text of [
      "minha reserva está confirmada?",
      "qual minha reserva?",
      "como está minha reserva de amanhã?",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("RESERVATION_STATUS_Q");
    }
  });

  // BKL-219/224 — the 'mesa' (table) synonym: a customer refers to their booking by
  // "mesa" as readily as "reserva". Anchored both sides → standalone only.
  it("BKL-224 — fires on the 'mesa' (table) synonym", () => {
    for (const text of [
      "minha mesa está confirmada?",
      "confirmaram a minha mesa?",
      "qual o horário da minha mesa?",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("RESERVATION_STATUS_Q");
    }
  });

  // BKL-285 — this clause was PARTIALLY VACUOUS. Its "or on a mesa mutation" half
  // only ever exercised "cancela a minha mesa", whose `cancel` root the SHARED net
  // already catches, so the half proved the shared net and nothing about `mesa`.
  // The mutation that the shared net structurally CANNOT catch — a table BOOKING,
  // whose verb is the read anchor itself — was never covered. Both are here now.
  it("BKL-224 — 'mesa' anchoring does not false-fire mid-word (mesada) or on a mesa mutation", () => {
    expect(classifyRequestSpans("quero saber da minha mesada")).not.toContain(
      "RESERVATION_STATUS_Q",
    );
    // a mesa MUTATION still routes to the model path (the shared mutationImperative gate)
    expect(classifyRequestSpans("cancela a minha mesa")).not.toContain(
      "RESERVATION_STATUS_Q",
    );
    // …and so does a table BOOKING, which the shared net cannot see (BKL-285).
    expect(classifyRequestSpans("reserva uma mesa para 4 pessoas às 20h")).not.toContain(
      "RESERVATION_STATUS_Q",
    );
  });

  // BKL-224 — the bare-"status" fallback must NOT shadow a reservation-status ask
  // into the ORDER/PAYMENT candidates CLARIFY (live-caught: "qual o status da minha
  // reserva?" returned the ≥2-owned order picker).
  it("BKL-224 — 'status da minha reserva' fires RESERVATION_STATUS_Q ONLY (no ORDER/PAYMENT shadow)", () => {
    for (const text of [
      "qual o status da minha reserva?",
      "status da minha mesa",
    ]) {
      const spans = classifyRequestSpans(text);
      expect(spans, text).toContain("RESERVATION_STATUS_Q");
      expect(spans, text).not.toContain("ORDER_STATUS_Q");
      expect(spans, text).not.toContain("PAYMENT_STATUS_Q");
    }
  });

  it("BKL-224 — a genuine bare-'status' order ask is UNAFFECTED (still over-includes order+payment)", () => {
    const spans = classifyRequestSpans("qual o status?");
    expect(spans).toContain("ORDER_STATUS_Q");
    expect(spans).toContain("PAYMENT_STATUS_Q");
    expect(spans).not.toContain("RESERVATION_STATUS_Q");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKL-285 — the reservation CREATE imperative, BOTH DIRECTIONS.
//
// THE DEFECT. `reserv` is simultaneously the create VERB and the status read's
// ANCHOR, so the shared mutation net could never carry it: BKL-217 closed
// cancel/modify (whose verbs ARE in the shared net) and left CREATE open. Measured
// on dev d8e5ca60: "reserva uma mesa para 4 pessoas às 20h" returned
// ["RESERVATION_STATUS_Q"] with hasMutationImperative FALSE — the turn was
// classify-only eligible, the STATUS read answered, and the booking was dropped
// while the customer believed they had a table.
//
// WHY THE ROUTE, NOT JUST THE LABEL. A span label is one step removed from the
// harm. `classifyOnlyRequiredTypes` is the actual gate that decides whether the
// turn skips the model's claim proposal and gets answered deterministically, so
// these assert on IT: `undefined` means the deterministic read route DECLINED and
// the turn goes to the model/mutation path, which is the whole deliverable.
//
// STYLE-VARIED per the BKL-271 discipline — verb-initial imperatives, clitic
// forms, volitional + infinitive, the `fazer uma reserva` noun frame, and the
// no-`reserv`-stem `quero uma mesa` frame — with the accented spellings customers
// really type (às / à noite / aniversário / sábado). Every probe is FRESH pt-BR
// authored here: each was checked for exact-match absence from the 697-line
// in-repo utterance corpus, so none is lifted from a fixture that the net was
// tuned against.
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyRequestSpans — BKL-285 reservation CREATE vs the STATUS read", () => {
  /** Booking REQUESTS. Every one must leave the deterministic read route. */
  const CREATE_IMPERATIVES = [
    // verb-initial imperative + indefinite object (THE REGISTERED DEFECT)
    "reserva uma mesa para 4 pessoas às 20h",
    "reserve uma mesa lá pras 21h, somos 6",
    "reserva 2 mesas pro pessoal do escritório",
    "reserve mesa pra 4, por favor",
    // the clitic form
    "me reserva uma mesa na sexta à noite",
    // volitional / deontic + the infinitive
    "gostaria de reservar uma mesa no sábado",
    "preciso reservar uma mesa pro aniversário da minha mãe",
    "podem reservar uma mesa pra gente?",
    // the `fazer uma reserva` NOUN frame
    "queria fazer uma reserva pra domingo de manhã",
    // no `reserv` stem at all — the same booking, one paraphrase away
    "quero uma mesa para 4 pessoas às 20h",
    "queria uma mesa pra hoje à noite",
    "gostaria de uma mesa para 2 no jantar",
  ];

  /** Booking QUESTIONS. Every one must KEEP its read. */
  const STATUS_ASKS = [
    "minha mesa está confirmada?",
    "minha reserva está confirmada?",
    "qual minha reserva?",
    "confirmaram a minha mesa?",
    // the PRETERITE frames — a booking already made, asked about
    "reservei uma mesa ontem, deu certo?",
    "fiz uma reserva pro sábado, está de pé?",
    "vocês reservaram minha mesa?",
    // the `de mesa` complement a windowed regex would have swallowed
    "minha reserva de mesa segue valendo?",
  ];

  it("DIRECTION 1 — a create imperative loses the read span AND the deterministic route", () => {
    for (const text of CREATE_IMPERATIVES) {
      expect(hasReservationCreateImperative(text), text).toBe(true);
      expect(classifyRequestSpans(text), text).not.toContain("RESERVATION_STATUS_Q");
      // THE DELIVERABLE: the classify-only gate declines, so the turn reaches the
      // model/mutation path where `reservation.create` can actually be minted.
      expect(classifyOnlyRequiredTypes(text), text).toBeUndefined();
    }
  });

  it("DIRECTION 2 — a status ask KEEPS the read span AND the deterministic route", () => {
    for (const text of STATUS_ASKS) {
      expect(hasReservationCreateImperative(text), text).toBe(false);
      expect(classifyRequestSpans(text), text).toContain("RESERVATION_STATUS_Q");
      const required = classifyOnlyRequiredTypes(text);
      expect(required, text).toBeDefined();
      expect(required?.has("RESERVATION_STATUS"), text).toBe(true);
    }
  });

  // The create net must not reach the family FE-T17's left guard exists for.
  // `preservar` CONTAINS `reservar` and `preserve` CONTAINS `reserve`, so these
  // are the two spellings that would break first if the guard were ever dropped.
  it("the create net does NOT fire on the preserv* family or on 'reservatório'", () => {
    for (const text of [
      "preservar",
      "preserve o meio ambiente",
      "vamos preservar o meio ambiente",
      "preservativo",
      "o reservatório está vazando",
    ]) {
      expect(hasReservationCreateImperative(text), text).toBe(false);
    }
  });

  // BKL-217 must stay exactly where it was: these carry a SHARED-net root, so they
  // are off the read path for a reason this ticket did not touch. If a future edit
  // moves the create net's job onto the shared net, this keeps the split honest.
  it("BKL-217's cancel/modify coverage is UNCHANGED (shared net, not the create net)", () => {
    for (const text of [
      "cancela minha reserva",
      "cancelar minha reserva das 18:30",
      "muda minha reserva para 20h",
      "troca minha reserva para 4 pessoas",
      "cancela a minha mesa",
    ]) {
      expect(hasMutationImperative(text), text).toBe(true);
      expect(hasReservationCreateImperative(text), text).toBe(false);
      expect(classifyRequestSpans(text), text).not.toContain("RESERVATION_STATUS_Q");
    }
  });

  // THE OPS-PLANE BOUNDARY. `hasMutationImperative` is shared with
  // ops-write-twin-rescue.ts, which has no reservation-create surface. Widening it
  // would silently change staff-plane question-vs-mutation routing, so the create
  // net is OR'd into classifyRequestSpans' LOCAL gate only. This pins that split:
  // the shared predicate must stay blind to a pure booking request.
  it("the SHARED mutation net is left untouched by the create family (ops plane unaffected)", () => {
    for (const text of CREATE_IMPERATIVES) {
      expect(hasMutationImperative(text), text).toBe(false);
    }
  });

  // The FP sweep, as a test rather than a claim in a PR description. Swept against
  // the 697-line in-repo utterance corpus and the 201-row live catalog vocabulary
  // (Postgres :5433): 14 corpus hits, all of them genuine booking requests, and
  // ZERO catalog hits. These four are the catalog-shaped strings a `mesa`/`reserv`
  // net would collide with if it were widened carelessly.
  it("FP boundary — ordinary catalog and menu vocabulary never reads as a booking", () => {
    for (const text of [
      "quanto custa a costela bovina defumada?",
      "vocês têm sobremesa hoje?",
      "quero uma coca gelada e uma porção de fritas",
      "o que tem no cardápio?",
    ]) {
      expect(hasReservationCreateImperative(text), text).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-27 — the `mud` root's PAST-TENSE lookahead: a preterite READ is not a command.
//
// THE DEFECT, measured at c9e871c4: `mud` was the one EDIT root with no past-tense
// lookahead, so `hasMutationImperative("meu histórico de pedidos mudou?")` was TRUE
// and `classifyRequestSpans` returned `[]` — a genuine READ, phrased in the preterite,
// classified as a command and stripped of every read span. `"meu pedido mudou?"` lost
// ORDER_STATUS_Q the same way. The fix shape was already in the file one line below:
// `fech(?!ad|ament|ou|am)` has always excluded its own `ou` preterite.
//
// EVERY CASE BELOW IS A PAIR ON ONE AXIS — the verb form — with the OBJECT held
// constant, so a treatment that passes for an unrelated reason fails its control.
// Both halves of each pair assert `hasMutationImperative` directly AND the span, so
// neither half can go vacuous if a span net moves underneath it.
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyRequestSpans — F-27 the `mud` past-tense lookahead", () => {
  /**
   * [preterite READ, imperative COMMAND, the span the read must keep].
   * Every utterance here is FRESH pt-BR authored for this ticket: each was checked
   * for exact-match absence from the frozen 6889-utterance in-repo harvest, so none
   * is lifted from a fixture the net was tuned against.
   */
  const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
    // THE HEADLINE — the filed utterance and its singular sibling.
    ["meu histórico de pedidos mudou?", "muda meu histórico de pedidos", "ORDER_HISTORY_Q"],
    ["meu pedido mudou?", "muda meu pedido", "ORDER_STATUS_Q"],
    // The same axis across the other classify-only-eligible read families, so the fix
    // is pinned as a property of the NET and not of one span.
    ["meu pagamento mudou?", "muda meu pagamento", "PAYMENT_STATUS_Q"],
    ["minha reserva mudou?", "muda minha reserva", "RESERVATION_STATUS_Q"],
    ["o que mudou no meu carrinho?", "muda o meu carrinho", "CART_CONTENTS_Q"],
    ["o cardápio mudou?", "muda o cardápio", "MENU_OVERVIEW_Q"],
  ];

  it("TREATMENT — a preterite READ is not a mutation, keeps its span AND the route", () => {
    for (const [read, , span] of PAIRS) {
      expect(hasMutationImperative(read), read).toBe(false);
      expect(classifyRequestSpans(read), read).toContain(span);
      // THE DELIVERABLE: the classify-only route ACCEPTS the turn, so the read is
      // answered deterministically instead of the whole turn being dropped.
      expect(classifyOnlyRequiredTypes(read), read).toBeDefined();
    }
  });

  it("CONTROL — the imperative on the SAME object still routes to mutation", () => {
    for (const [, command, span] of PAIRS) {
      expect(hasMutationImperative(command), command).toBe(true);
      expect(classifyRequestSpans(command), command).not.toContain(span);
      expect(classifyOnlyRequiredTypes(command), command).toBeUndefined();
    }
  });

  // The ticket's own named control, verbatim, plus the rest of the imperative family.
  // These are the forms pt-BR actually uses to give an order, and the lookahead must
  // not reach any of them — `(?!ou|ad|aram)` cannot, since none continues with those
  // three suffixes. `muda o preço do brisket` and `muda meu pedido pra entrega` are
  // ATTESTED corpus mutations, not authored probes.
  it("the whole IMPERATIVE family is untouched (muda / mudar / mude / mudem)", () => {
    for (const text of [
      "muda o preço do brisket",
      "muda meu pedido pra entrega",
      "mudar o endereço de entrega",
      "mude o horário de funcionamento",
      "mudem a reserva para 20h",
    ]) {
      expect(hasMutationImperative(text), text).toBe(true);
      expect(classifyOnlyRequiredTypes(text), text).toBeUndefined();
    }
  });

  // ONE ARM PER LOOKAHEAD ALTERNATIVE. `ou` is covered by every PAIR above; these two
  // cover `ad` and `aram`, which no other case in this file reaches. Deleting either
  // alternative from the lookahead reds exactly its own row here.
  it("ARM `ad` — the PARTICIPLE is a status report, not a command", () => {
    for (const [text, span] of [
      ["meu pedido foi mudado?", "ORDER_STATUS_Q"],
      ["minha reserva foi mudada?", "RESERVATION_STATUS_Q"],
    ] as const) {
      expect(hasMutationImperative(text), text).toBe(false);
      expect(classifyRequestSpans(text), text).toContain(span);
    }
  });

  it("ARM `aram` — the 3rd-person PLURAL preterite is a question, not a command", () => {
    for (const [text, span] of [
      ["meus pedidos mudaram?", "ORDER_HISTORY_Q"],
      ["vocês mudaram meu pedido?", "ORDER_STATUS_Q"],
    ] as const) {
      expect(hasMutationImperative(text), text).toBe(false);
      expect(classifyRequestSpans(text), text).toContain(span);
    }
  });

  // THE FALSE-NEGATIVE GUARD, and the half a carelessly-widened lookahead breaks
  // first. These three forms were CONSIDERED and REJECTED for the lookahead (see
  // `hasMutationImperative`'s docblock): `ei` because BKL-271 kept `cancelei` and the
  // 1st-person amend frame is real; `anç` because BKL-271 kept `cancelamento` and
  // "quero uma mudança no meu pedido" is that same request; `am` because there is no
  // attested `mudam` read to buy. Each MUST still classify as a mutation — a future
  // edit that folds any of them in reds here rather than silently dropping an edit.
  it("REJECTED arms still fire — mudei / mudança / mudam stay mutations", () => {
    for (const text of [
      "mudei de ideia, cancela o pedido",
      "mudei de ideia",
      "quero uma mudança no meu pedido",
      "vocês mudam o preço da costela?",
    ]) {
      expect(hasMutationImperative(text), text).toBe(true);
    }
  });

  // THE ROLL CALL, hand-written and by NAME — not derived from the regex source, so a
  // deleted alternative cannot delete its own coverage. Three arms, three names.
  it("the lookahead declares exactly THREE arms, and each one is behaviourally live", () => {
    const ARMS = {
      ou: "meu pedido mudou?",
      ad: "meu pedido foi mudado?",
      aram: "meus pedidos mudaram?",
    } as const;
    expect(Object.keys(ARMS)).toEqual(["ou", "ad", "aram"]);
    for (const [arm, probe] of Object.entries(ARMS)) {
      expect(hasMutationImperative(probe), `${arm}: ${probe}`).toBe(false);
      // and the minimally-different COMMAND on the same stem is still caught, so the
      // arm is a narrowing of `mud` rather than its deletion.
      expect(hasMutationImperative(probe.replace(/mud\w+/, "muda")), arm).toBe(true);
    }
  });

  // THE 20-ROOT ROLL CALL — one probe per root across all FOUR literals, by NAME
  // and hand-written. It carries two jobs at once:
  //
  //   1. F-27's blast radius: every OTHER root is unmoved by the lookahead.
  //   2. THE SPLIT GUARD. `hasMutationImperative` is spelled as four literals for
  //      Sonar S5843 (see its docblock). A re-split, a "tidy" back into one, or a
  //      root dropped in the shuffle reds HERE, by the name of the root that went
  //      missing — which no corpus-level identity check can do, because a corpus can
  //      only witness the roots it happens to contain.
  //
  // The roll call is hand-written on purpose: deriving it from the regex source would
  // mean a deleted root deletes its own coverage.
  it("the 20-root ROLL CALL — every root in all four literals still fires", () => {
    const ROOTS: Readonly<Record<string, string>> = {
      // MEMBERSHIP — which items are in the order
      adicion: "adiciona uma coca no carrinho",
      acrescent: "acrescenta batata frita",
      remov: "remove a costela do pedido",
      tir: "tira o refrigerante",
      "colo[cq]": "coloca 2 cocas no carrinho",
      "p[õo]e": "põe mais uma porção",
      ponh: "ponha o brisket no lugar",
      // AMEND — change what is already there
      mud: "muda a costela para 3 unidades",
      "tro[cq]": "troca a costela por brisket",
      limp: "limpa o carrinho",
      esvazi: "esvazia o carrinho",
      aument: "aumenta pra 3 unidades",
      diminu: "diminui pra 1 unidade",
      // RECORD-EDIT (F-31) — change a stored record, not the order
      atualiz: "atualiza meus dados",
      corrig: "corrige a quantidade",
      cadastr: "cadastra minha chave pix",
      alter: "altera minha reserva",
      // LIFECYCLE
      cancel: "cancela meu pedido",
      fech: "fecha o pedido",
      finaliz: "finaliza a compra",
    };
    expect(Object.keys(ROOTS)).toHaveLength(20);
    for (const [root, probe] of Object.entries(ROOTS)) {
      expect(hasMutationImperative(probe), `${root}: ${probe}`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-31 — an ADDRESS CHANGE is a MUTATION, not a store-info read.
//
// THE DEFECT, measured on dev at bc250411: a customer asking to change THEIR
// delivery address was answered with the RESTAURANT's address. `endere[çc]o` is a
// STORE_INFO_Q marker and STORE_INFO is classify-only-eligible, so the turn was
// answered deterministically and the edit request was silently dropped — a
// wrong-FAMILY render, not a mild over-inclusion.
//
// THIS BLOCK REPLACES #537's CHANGE DETECTOR, which pinned the nine degraded rows at
// their measured values and named its own exit ("DELETE this describe block, do not
// update its expectations"). The exit condition is met, so it was DELETED rather than
// re-baselined, and what stands here asserts the FIXED behaviour instead.
//
// THE FAMILY NEEDED BOTH HALVES, which is why there are two describes:
//
//   · SIX phrasings carry a verb, and are fixed by the RECORD-EDIT roots joining
//     `hasMutationImperative` (`atualiz`/`corrig`/`cadastr`/`alter`).
//   · THREE carry NO verb at all ("meu endereço mudou", "meu endereço agora é …",
//     "meu novo endereço é …"). No root can reach them, and forcing them through
//     `hasMutationImperative` would be a FALSE claim about the text AND would carry a
//     customer-plane read discrimination onto the two other consumers of that shared
//     predicate. They are fixed by the SELF-SCOPED ADDRESS conjunct on STORE_INFO_Q's
//     guard, and asserted as such — the ledger stays honest about which half did what.
//
// In both halves the DELIVERABLE is the same and is asserted directly: the turn no
// longer carries STORE_INFO_Q, and `classifyOnlyRequiredTypes` declines it, so the
// address change reaches the model/mutation path instead of a confident non-answer.
// ─────────────────────────────────────────────────────────────────────────────
describe("F-31 — the address-change family reaches the mutation path", () => {
  /**
   * The SIX verb-bearing phrasings, each paired with the root that catches it, so a
   * root dropped in a future edit reds by the NAME of what it was supposed to catch.
   * The last row is the one F-27 moved into the family: `mudou` is still correctly NOT
   * an imperative, and it is `atualiza` — not the preterite — that carries the turn.
   */
  const FAMILY: ReadonlyArray<readonly [string, string]> = [
    ["atualiza meu endereço por favor", "atualiz"],
    ["atualiza meu endereço", "atualiz"],
    ["quero atualizar meu endereço", "atualiz"],
    ["corrige meu endereço", "corrig"],
    ["cadastra meu endereço novo", "cadastr"],
    ["quero alterar meu endereço", "alter"],
    ["meu endereço mudou, atualiza por favor", "atualiz"],
  ];

  it("TREATMENT — every verb-bearing phrasing is a MUTATION and loses the store read", () => {
    for (const [text, root] of FAMILY) {
      expect(hasMutationImperative(text), `${root}: ${text}`).toBe(true);
      expect(classifyRequestSpans(text), text).not.toContain("STORE_INFO_Q");
      expect(classifyOnlyRequiredTypes(text), text).toBeUndefined();
    }
  });

  // The three that no verb root can reach. They must NOT become "imperatives" — the
  // shared predicate keeps telling the truth about them — and the fix must still land.
  const VERBLESS = [
    "meu endereço mudou",
    "meu endereço agora é rua das flores 123",
    "meu novo endereço é rua das flores 123",
  ];

  it("TREATMENT — the VERBLESS declaratives lose the store read WITHOUT being called imperatives", () => {
    for (const text of VERBLESS) {
      // Deliberately still FALSE: there is no mutation verb in any of these, and
      // `hasMutationImperative` is shared with the ops plane and the BKL-262 Stage-2
      // recovery. The span guard is what fixes them.
      expect(hasMutationImperative(text), text).toBe(false);
      expect(classifyRequestSpans(text), text).not.toContain("STORE_INFO_Q");
      expect(classifyOnlyRequiredTypes(text), text).toBeUndefined();
    }
  });

  // THE CONTROL FOR EVERY ROW ABOVE. A nearby STORE read must still read — this is
  // BKL-136's own must-fire list verbatim, plus two phrasings chosen because they are
  // the ones a careless address guard breaks first: the STORE's own move ("vocês
  // mudaram de endereço?" — a preterite, so `mud(?!…|aram)` also keeps it off the
  // mutation path) and a DEFINITE, NON-possessed address ask.
  it("CONTROL — the store's OWN address still reads, and still routes classify-only", () => {
    for (const text of [
      "onde fica o restaurante?",
      "qual o endereço de vocês?",
      "tem estacionamento?",
      "posso estacionar aí?",
      "como chego até vocês?",
      "qual a localização?",
      "vocês mudaram de endereço?",
      "qual o endereço do restaurante?",
    ]) {
      expect(hasMutationImperative(text), text).toBe(false);
      expect(classifyRequestSpans(text), text).toContain("STORE_INFO_Q");
      expect([...(classifyOnlyRequiredTypes(text) ?? [])], text).toContain("STORE_INFO");
    }
  });

  // The two ATTESTED corpus address mutations. They carried a root before F-31 and
  // still do — the fix must not be the reason they route, or this file would lose the
  // evidence that the OLD net covered them.
  it("UNMOVED — the attested address mutations still route through their own root", () => {
    for (const text of ["muda o endereço de entrega", "muda o endereço do restaurante"]) {
      expect(hasMutationImperative(text), text).toBe(true);
      expect(classifyOnlyRequiredTypes(text), text).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-31 — the RECORD-EDIT roots, per root and PER LOOKAHEAD ARM.
//
// Each root was decided IN on its own TP/FP sweep over the frozen 183,325-row harvest
// (the #531/#537 method) — the bar `hasReservationCreateImperative` set when it
// REJECTED `marc`/`agend` rather than let them ride someone else's evidence. The full
// per-root evidence is in `hasMutationImperative`'s docblock; what is pinned here is
// the BEHAVIOUR each decision buys, and one live read per lookahead arm.
// ─────────────────────────────────────────────────────────────────────────────
describe("hasMutationImperative — F-31 the RECORD-EDIT roots", () => {
  /**
   * TRUE POSITIVES, and every one is an ATTESTED corpus utterance, not an authored
   * probe — a real customer/staff request that was riding a classify-only READ before
   * F-31. The span each one LOST is named, so the row cannot go vacuous if a span net
   * moves underneath it.
   */
  const ATTESTED_TPS: ReadonlyArray<readonly [string, string]> = [
    ["coca pra 5, atualiza o carrinho", "CART_CONTENTS_Q"],
    ["hambúrguer pra 2 no pedido 910226, atualiza", "ORDER_STATUS_Q"],
    ["quero atualizar minhas preferências, sou vegano", "MENU_DIETARY_Q"],
    ['Por favor, atualize o status do pedido mais recente para "pronto".', "ORDER_STATUS_Q"],
    ["sobre o pedido 12345, quero corrigir a quantidade", "ORDER_STATUS_Q"],
    ["quero cadastrar minha chave pix", "PAYMENT_STATUS_Q"],
    ["quero alterar minha reserva", "RESERVATION_STATUS_Q"],
    ["por gentileza, altere a quantidade do pedido 12345", "ORDER_STATUS_Q"],
    ["Gostaria de alterar minha reserva para 3 pessoas, por favor.", "RESERVATION_STATUS_Q"],
    ["Solicito a alteração do número de pessoas da minha reserva para 4.", "RESERVATION_STATUS_Q"],
  ];

  it("ATTESTED true positives — a real edit request stops riding a classify-only read", () => {
    for (const [text, lostSpan] of ATTESTED_TPS) {
      expect(hasMutationImperative(text), text).toBe(true);
      expect(classifyRequestSpans(text), text).not.toContain(lostSpan);
      expect(classifyOnlyRequiredTypes(text), text).toBeUndefined();
    }
  });

  // ONE ARM PER LOOKAHEAD ALTERNATIVE, hand-written and by NAME. Every probe is a
  // READ that is LIVE — it carries the named span TODAY — so deleting the arm it
  // belongs to reds exactly this row and nothing else. Two of the six (`corrig`'s
  // `id` and `alter`'s `n`) have ZERO span-bearing corpus attestation and are
  // AUTHORED; that is stated in the docblock rather than dressed up, and the probe is
  // what keeps the arm from being unfalsifiable.
  const ARMS: ReadonlyArray<readonly [string, string, string]> = [
    ["atualiz(?!ad)", "meu pedido foi atualizado?", "ORDER_STATUS_Q"],
    ["atualiz(?!ad) [2]", "minha reserva foi atualizada?", "RESERVATION_STATUS_Q"],
    ["corrig(?!id)", "meu pedido foi corrigido?", "ORDER_STATUS_Q"],
    ["corrig(?!id) [2]", "minha reserva foi corrigida?", "RESERVATION_STATUS_Q"],
    // ATTESTED: a live read-harness fixture. A bare `cadastr` kills its span.
    ["cadastr(?!…|ad)", "quais sao minhas reservas cadastradas", "RESERVATION_STATUS_Q"],
    // ATTESTED: an extraction-corpus utterance. `cadastro` is the NOUN here.
    [
      "cadastr(?!o|…)",
      "posso passar meu email e cpf agora pro cadastro do pix?",
      "PAYMENT_STATUS_Q",
    ],
    ["alter(?!n|…)", "tem alguma alternativa vegetariana?", "MENU_DIETARY_Q"],
    ["alter(?!…|ad)", "minha reserva foi alterada?", "RESERVATION_STATUS_Q"],
  ];

  it("the ARM ROLL CALL — every lookahead alternative keeps a LIVE read alive", () => {
    expect(ARMS).toHaveLength(8);
    for (const [arm, probe, span] of ARMS) {
      expect(hasMutationImperative(probe), `${arm}: ${probe}`).toBe(false);
      expect(classifyRequestSpans(probe), `${arm}: ${probe}`).toContain(span);
      expect(classifyOnlyRequiredTypes(probe), `${arm}: ${probe}`).toBeDefined();
    }
  });

  // THE FALSE-NEGATIVE GUARD, and the half a carelessly-widened lookahead breaks
  // first. `alteração`/`atualização` are REQUEST nouns — BKL-271 kept `cancelamento`
  // and F-27 kept `mudança` for exactly this reason, and "Solicito a alteração…" is
  // an ATTESTED corpus request. The 1st-person preterites are the `cancelei`/`mudei`
  // amend frame. A future edit that folds any of them into a lookahead reds here
  // rather than silently dropping a customer's edit.
  it("REJECTED arms still fire — alteração / atualização / alterei / atualizei stay mutations", () => {
    for (const text of [
      "quero uma alteração no meu pedido",
      "solicito a atualização do meu pedido",
      "alterei o pedido",
      "atualizei meus dados",
      "vocês alteram o cardápio?",
    ]) {
      expect(hasMutationImperative(text), text).toBe(true);
    }
  });

  // THE OPS-PLANE BOUNDARY, stated as a behaviour rather than a comment. The roots
  // live in the SHARED predicate on purpose — a staff record-edit is a mutation on
  // both planes — so `ops-write-twin-rescue.ts` conjunct 4 must see them too. That is
  // the conjunct working: a genuine refused mutation surfaces its refusal instead of
  // being answered with today's status. The READ counterpart must stay a read.
  it("OPS plane — a staff record-edit is a mutation, its status QUESTION is not", () => {
    for (const text of [
      "atualiza o status do pedido pra em rota",
      "altera o preço do brisket para 95",
      "corrige o horário de amanhã",
    ]) {
      expect(hasMutationImperative(text), text).toBe(true);
    }
    for (const text of [
      "o status do pedido foi atualizado?",
      "o preço do brisket foi alterado?",
      "o horário de amanhã foi corrigido?",
    ]) {
      expect(hasMutationImperative(text), text).toBe(false);
    }
  });
});

// BKL-139 — CART_CONTENTS_Q (anchored marker; read-vs-mutation split). The marker
// fires on a cart-READ question and is SUPPRESSED by a cart-mutation verb, so
// classify-only never mis-frames a cart write ("adicione ao carrinho") as a read.
describe("classifyRequestSpans — BKL-139 CART_CONTENTS_Q (read-only, anchored)", () => {
  it("MUST-FIRE on cart-contents READ questions", () => {
    for (const text of [
      "o que tem no meu carrinho?",
      "quanto está meu carrinho?",
      "ver meu carrinho",
      "minha sacola",
      "o que tem na cesta?",
      "quais itens tem no carrinho",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("CART_CONTENTS_Q");
    }
  });

  it("'o que tem no meu carrinho?' → CART_CONTENTS_Q → requires the complementary pair (BKL-163)", () => {
    const spans = classifyRequestSpans("o que tem no meu carrinho?");
    expect(spans).toContain("CART_CONTENTS_Q");
    const required = decomposeRequiredClaims(spans);
    // BKL-163 — the row requires BOTH complements: exactly one can validate per
    // turn (their evidence keys are presence-complementary), so requiring both is
    // what lets an empty cart render the friendly VALIDATED "vazio" instead of the
    // honest-UNKNOWN degrade — never a contradiction.
    expect([...required].sort()).toEqual(["CART_CONTENTS", "CART_EMPTY"]);
  });

  it("BKL-136 — store-location/parking questions → STORE_INFO_Q → requires STORE_INFO", () => {
    for (const text of [
      "onde fica o restaurante?",
      "qual o endereço de vocês?",
      "tem estacionamento?",
      "posso estacionar aí?",
      "como chego até vocês?",
      "qual a localização?",
    ]) {
      const spans = classifyRequestSpans(text);
      expect(spans, text).toContain("STORE_INFO_Q");
      expect([...decomposeRequiredClaims(spans)], text).toContain("STORE_INFO");
    }
  });

  it("BKL-136 — MUST-NOT-FIRE when the location word targets a RESOURCE, not the store", () => {
    // "onde fica meu PEDIDO" is an order-status ask — a VALIDATED store address
    // there would be a confident non-answer to a different question.
    for (const text of [
      "onde fica meu pedido?",
      "qual o endereço de entrega do meu pedido?",
      "onde está minha reserva?",
      "endereço de cobrança do pagamento",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("STORE_INFO_Q");
    }
  });

  it("MUST-NOT-FIRE on cart MUTATIONS (the read-vs-write split — BKL-153 + BKL-201)", () => {
    for (const text of [
      "adicione uma coca ao carrinho",
      "acrescenta um refri no carrinho",
      "remova a farofa do carrinho",
      "coloca mais uma costela no carrinho",
      "limpa o carrinho",
      "esvazia minha sacola",
      "troca o item do carrinho",
      // BKL-201 — live-caught (SCN-046): "tira"/"muda" leaked through the old net
      // (which lacked tir/mud), so the removal/change rendered the cart list and the
      // mutation was silently dropped.
      "tira o refrigerante do carrinho",
      "tira a coca da minha sacola",
      "muda pra 2 refrigerantes no carrinho",
      "diminui a quantidade no carrinho",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("CART_CONTENTS_Q");
    }
  });

  it("MUST-NOT-FIRE on gratitude / order-status / payment turns (no cart word)", () => {
    for (const text of [
      "obrigado pelo atendimento",
      "muito obrigada!",
      "cadê meu pedido?",
      "qual o status do meu pagamento?",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("CART_CONTENTS_Q");
    }
  });
});

// BKL-201 — imperative MUTATION verbs must not let a write turn ride a classify-only
// READ span. #348 made the MENU family + STORE_INFO classify-only-eligible, so the same
// read-vs-mutation split the cart span enforces now guards the menu/store spans: a write
// ("muda o preço", "tira do cardápio") must reach the model/mutation path, never render
// the read and silently drop the mutation.
describe("classifyRequestSpans — BKL-201 imperative mutations suppress classify-only READ spans", () => {
  it("MUST-NOT-FIRE the menu/store read spans on an imperative mutation", () => {
    const cases: Array<[string, string]> = [
      ["muda o preço do brisket", "MENU_ITEM_PRICE_Q"],
      ["aumenta o preço do combo", "MENU_ITEM_PRICE_Q"],
      ["diminui o valor da costela", "MENU_ITEM_PRICE_Q"],
      ["tira o brisket do cardápio", "MENU_OVERVIEW_Q"],
      ["remove a costela do menu", "MENU_OVERVIEW_Q"],
      ["muda o endereço do restaurante", "STORE_INFO_Q"],
    ];
    for (const [text, span] of cases) {
      expect(classifyRequestSpans(text), text).not.toContain(span);
    }
  });

  it("STILL-FIRES the menu/store read spans on READ imperatives (mostra/ver) and interrogatives", () => {
    // A READ imperative ("me mostra", "quero ver") is NOT a mutation — the split must
    // key off mutation verbs only, never suppress a legitimate read.
    expect(classifyRequestSpans("me mostra o cardápio"), "mostra").toContain(
      "MENU_OVERVIEW_Q",
    );
    expect(classifyRequestSpans("quanto custa o brisket"), "price read").toContain(
      "MENU_ITEM_PRICE_Q",
    );
    expect(classifyRequestSpans("onde fica o restaurante?"), "store read").toContain(
      "STORE_INFO_Q",
    );
  });

  it("word-boundary anchored — 'tir'/'mud' never false-match inside innocent words", () => {
    // "retirar" (pickup), "partir", "sentir" contain 'tir' mid-word; none is a cart
    // mutation, so a cart READ that co-occurs with them must still fire.
    expect(
      classifyRequestSpans("quero ver o carrinho antes de partir"),
      "partir",
    ).toContain("CART_CONTENTS_Q");
  });
});

// FE-D03 slice C — ORDER_HISTORY_Q / PAYMENT_HISTORY_Q: history/list phrasing fires the
// list span and SUPPRESSES the co-fired singular status span (a history ask is not a
// single-subject status ask — the list type replaces the ≥2-owned CLARIFY). The singular
// family stays untouched on singular phrasing (both directions pinned).
describe("classifyRequestSpans — FE-D03 history spans (suppress the singular)", () => {
  it("MUST-FIRE ORDER_HISTORY_Q on history/plural order phrasing", () => {
    for (const text of [
      "meu histórico de pedidos",
      "quero ver o histórico dos meus pedidos",
      "meus últimos pedidos",
      "me mostra todos os meus pedidos",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("ORDER_HISTORY_Q");
    }
  });

  it("MUST-FIRE PAYMENT_HISTORY_Q on history/plural payment phrasing", () => {
    for (const text of [
      "meu histórico de pagamentos",
      "meus últimos pagamentos",
      "histórico de pagamentos por favor",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("PAYMENT_HISTORY_Q");
    }
  });

  it("SUPPRESSES the singular: 'meus pedidos' → ORDER_HISTORY_Q, NOT ORDER_STATUS_Q", () => {
    const spans = classifyRequestSpans("meus pedidos");
    expect(spans).toContain("ORDER_HISTORY_Q");
    expect(spans).not.toContain("ORDER_STATUS_Q");
    expect([...decomposeRequiredClaims(spans)]).toEqual(["ORDER_HISTORY"]);
  });

  it("SUPPRESSES the singular: 'meus pagamentos' → PAYMENT_HISTORY_Q, NOT PAYMENT_STATUS_Q", () => {
    const spans = classifyRequestSpans("meus pagamentos");
    expect(spans).toContain("PAYMENT_HISTORY_Q");
    expect(spans).not.toContain("PAYMENT_STATUS_Q");
    expect([...decomposeRequiredClaims(spans)]).toEqual(["PAYMENT_HISTORY"]);
  });

  it("MUST-NOT-FIRE on singular status asks (the singular family stays)", () => {
    const order = classifyRequestSpans("cadê meu pedido?");
    expect(order).toContain("ORDER_STATUS_Q");
    expect(order).not.toContain("ORDER_HISTORY_Q");
    const payment = classifyRequestSpans("meu pagamento foi aprovado?");
    expect(payment).toContain("PAYMENT_STATUS_Q");
    expect(payment).not.toContain("PAYMENT_HISTORY_Q");
  });
});

// F-8 — the two history spans carry the `!mutationImperative` guard every other
// classify-only-eligible READ span has. Before the fix, `classifyRequestSpans("cancela
// meus pedidos")` returned ["ORDER_HISTORY_Q"], and because ORDER_HISTORY is
// classify-only-eligible the whole turn took the deterministic route: the history READ
// was answered and the order.cancel was SILENTLY DROPPED with zero model call. The
// singular sibling already declined (BKL-206 guards ORDER_STATUS_Q) — this closes the
// asymmetry, the same read-vs-mutation split #349/BKL-201 (cart), BKL-206 (status) and
// BKL-217 (reservation) closed on their own spans.
//
// EVERY case below is a PAIR ON ONE AXIS: identical text except the mutation imperative.
// The control MUST still classify as the history read, or the treatment proves nothing —
// a guard that suppressed the whole span family would pass the negative arm alone.
describe("classifyRequestSpans — F-8 history spans take the mutation-imperative guard", () => {
  it("ORDER: 'cancela meus pedidos' does NOT classify as the history read; the plain ask does", () => {
    // TREATMENT — the filed utterance. Not merely missing ORDER_HISTORY_Q: NO read span
    // fires at all, so the turn goes to the model/mutation path where the cancel lives.
    expect(classifyRequestSpans("cancela meus pedidos")).toEqual([]);
    // CONTROL — same axis, a plain history ask, which must be untouched.
    expect(classifyRequestSpans("quais meus últimos pedidos?")).toContain("ORDER_HISTORY_Q");
  });

  it("PAYMENT: 'cancela meus pagamentos' does NOT classify as the history read; the plain ask does", () => {
    expect(classifyRequestSpans("cancela meus pagamentos")).toEqual([]);
    expect(classifyRequestSpans("quais meus últimos pagamentos?")).toContain(
      "PAYMENT_HISTORY_Q",
    );
  });

  // The MINIMAL pair — the two members differ by exactly the leading imperative token, so
  // nothing but the mutation verb can explain the difference in outcome.
  it("the axis is the imperative alone: 'meus pedidos' fires, 'cancela meus pedidos' does not", () => {
    expect(classifyRequestSpans("meus pedidos")).toEqual(["ORDER_HISTORY_Q"]);
    expect(classifyRequestSpans("cancela meus pedidos")).toEqual([]);
    expect(classifyRequestSpans("meus pagamentos")).toEqual(["PAYMENT_HISTORY_Q"]);
    expect(classifyRequestSpans("cancela meus pagamentos")).toEqual([]);
  });

  // The guard reads the SAME local gate as every sibling span, so the whole mutation
  // family is covered, not just `cancel`. One row per root family that reaches these nets.
  it.each([
    ["cancelar meus últimos pedidos", "ORDER_HISTORY_Q"],
    ["cancele todos os meus pedidos", "ORDER_HISTORY_Q"],
    ["quero o cancelamento dos meus pedidos", "ORDER_HISTORY_Q"],
    ["remove meus pedidos", "ORDER_HISTORY_Q"],
    ["limpa meu histórico de pedidos", "ORDER_HISTORY_Q"],
    ["cancela meu histórico de pedidos", "ORDER_HISTORY_Q"],
    ["cancela o histórico de pagamentos", "PAYMENT_HISTORY_Q"],
  ])("a mutation imperative keeps %s off the history span", (text, span) => {
    expect(classifyRequestSpans(text), text).not.toContain(span);
  });

  // BKL-271's `cancel(?!ad)` lookahead is what makes this guard safe to add: the STATUS
  // PARTICIPLE is not an imperative, so a genuine history question about cancelled orders
  // still classifies as the read. Without that lookahead this guard would have eaten them.
  it.each([
    "meus pedidos foram cancelados?",
    "meus últimos pedidos estão cancelados?",
    "quais dos meus pedidos foram cancelados?",
  ])("the cancelad* PARTICIPLE is a READ and still fires ORDER_HISTORY_Q: %s", (text) => {
    expect(classifyRequestSpans(text), text).toContain("ORDER_HISTORY_Q");
  });

  // The SPLICE is unaffected: under a mutation imperative the singular sibling was never
  // pushed either (BKL-206 gates it on the same boolean), so skipping the history branch
  // cannot leave an orphaned ORDER_STATUS_Q/PAYMENT_STATUS_Q behind.
  it("suppressing the history span leaves NO singular sibling behind", () => {
    for (const text of ["cancela meus pedidos", "cancela meus pagamentos"]) {
      const spans = classifyRequestSpans(text);
      expect(spans, text).not.toContain("ORDER_STATUS_Q");
      expect(spans, text).not.toContain("PAYMENT_STATUS_Q");
    }
  });

  // The 47 other history-firing utterances in the repo-wide harvest are unchanged. This
  // pins the ones that carry a mutation ROOT SUBSTRING without an imperative reading, plus
  // the plain family, so a widened guard cannot pass this suite.
  it.each([
    ["meu histórico de pedidos", "ORDER_HISTORY_Q"],
    ["meus últimos pedidos", "ORDER_HISTORY_Q"],
    ["quero ver o histórico dos meus pedidos", "ORDER_HISTORY_Q"],
    ["me mostra todos os meus pedidos", "ORDER_HISTORY_Q"],
    ["pedidos no meu histórico", "ORDER_HISTORY_Q"],
    ["qual o status dos meus pedidos?", "ORDER_HISTORY_Q"],
    ["meu histórico de pagamentos", "PAYMENT_HISTORY_Q"],
    ["meus últimos pagamentos", "PAYMENT_HISTORY_Q"],
    ["histórico de pagamentos por favor", "PAYMENT_HISTORY_Q"],
    ["qual o status dos meus pagamentos?", "PAYMENT_HISTORY_Q"],
  ])("UNCHANGED by the guard: %s still fires %s", (text, span) => {
    expect(classifyRequestSpans(text), text).toContain(span);
  });
});

describe("classifyRequestSpans — BKL-204 capability questions don't force the owner read", () => {
  it("delivery COVERAGE questions do NOT fire ORDER_STATUS_Q (capability, not the customer's order)", () => {
    for (const text of [
      "vocês entregam no CEP 13560-000?",
      "fazem entrega no centro?",
      "entregam na minha região?",
      "vocês entregam pra Ibaté?",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("ORDER_STATUS_Q");
    }
  });

  it("delivery FEE questions do NOT fire ORDER_STATUS_Q", () => {
    for (const text of [
      "quanto custa a entrega?",
      "quanto fica a entrega pro centro?",
      "qual o valor da entrega?",
      "qual a taxa de entrega?",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("ORDER_STATUS_Q");
    }
  });

  it("payment-method ACCEPTANCE questions do NOT fire PAYMENT_STATUS_Q", () => {
    for (const text of [
      "aceitam vale-refeição? e PIX parcelado?",
      "aceitam pix?",
      "quais as formas de pagamento?",
      "vocês aceitam cartão de crédito?",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("PAYMENT_STATUS_Q");
    }
  });

  it("GENUINE self-status asks STILL fire (the possessive / order-number self-reference)", () => {
    // A possessive keeps the DUAL tokens firing…
    expect(classifyRequestSpans("cadê minha entrega?")).toContain("ORDER_STATUS_Q");
    expect(classifyRequestSpans("a entrega do meu pedido saiu?")).toContain(
      "ORDER_STATUS_Q",
    );
    expect(classifyRequestSpans("paguei no pix, meu pagamento caiu?")).toContain(
      "PAYMENT_STATUS_Q",
    );
    // …and an explicit order number is a self-reference (BKL-203's own case).
    expect(classifyRequestSpans("status do pedido 933869?")).toContain(
      "ORDER_STATUS_Q",
    );
  });

  it("STRONG tokens fire regardless of a capability-shaped tail (a named order wins)", () => {
    // "meu pedido" (possessive) never reads as a capability question.
    expect(classifyRequestSpans("cadê meu pedido, vocês entregam rápido?")).toContain(
      "ORDER_STATUS_Q",
    );
  });
});

// ── BKL-221 — BARE delivery-PROGRESS phrasings ────────────────────────────────
// The registered defect: a customer who owns ≥2 orders asks how theirs is coming
// along WITHOUT naming it, no span fires, classify-only declines, the model's
// extraction leg REFUSES with `system.extraction_failure`, and the customer gets
// an ugly degrade instead of the ≥2-owned candidates CLARIFY that BKL-203/204
// built for exactly this turn.
//
// SCOPE NOTE, measured rather than assumed: the phrasing the row was FILED with
// ("meu pedido já saiu para entrega?") FIRES on dev today — later work put
// `pedido` and `sa[ií]u` in the net. What is still missing is the genuinely BARE
// form, with no order noun and no preterite verb. The tests below pin the gap
// that actually exists, not the one the row's title describes.
// ── The Sonar S5843 restructure, pinned at the SOURCE level ──────────────────
// Three nets were split at a top-level alternation, or composed from named parts,
// to fit the regex-complexity budget. Neither transformation can change what a
// pattern matches — but only while the parts still concatenate back to the SAME
// STRING, and nothing about a split enforces that on its own.
//
// So the pre-restructure sources are frozen here verbatim. This is a stronger
// statement than any corpus differential: if the reassembly is byte-identical,
// it is not an equivalent regex, it is THE SAME regex, and no behavioural
// argument is needed. A differential over 196k strings was run once as
// belt-and-braces; this is the part that keeps holding after the PR merges.
//
// `String.raw` so the expected sources read exactly as they appear in the module
// (a normal literal would need every backslash doubled, which is precisely how a
// transcription error would slip in unnoticed).
describe("span nets — the S5843 restructure is source-identical to the literals it replaced", () => {
  it("ORDER_ARRIVAL: the two split halves rejoin to the original literal", () => {
    expect(__SPAN_NET_SOURCES_FOR_TEST.orderArrival).toBe(
      String.raw`(?<![a-z])a\s+caminho(?![a-z])|(?<![a-z])(?:foi|est[áa]|j[áa])\s+entregue(?![a-z])`,
    );
  });

  it("ORDER_ETA: the four composed parts concatenate to the original literal", () => {
    expect(__SPAN_NET_SOURCES_FOR_TEST.orderEta).toBe(
      String.raw`(?:falta|demora|tempo)[^.!?]{0,20}(?:para|pra)\s+chegar(?!\s+(?:a[íi]|at[ée]|no\s+restaurante|na\s+loja))`,
    );
  });

  // inv.18 v2 / R2-S9 — this net moved into `menu-overview.claim.ts` as THREE generated
  // arms, and the ASSERTION BELOW WAS NOT TOUCHED. That is the point worth stating: every
  // other pin in this describe was written when its net migrated, freezing the literal as
  // it stood at that moment, so the expected value and the migration have the same author.
  // This one predates its own migration by six slices, and the adoption changed neither the
  // string nor a character of this case. It is the only net in the corpus for which "the
  // reassembly is byte-identical" is asserted against a value nobody could have adjusted to
  // fit.
  it("MENU_OVERVIEW: the three split arms rejoin to the original literal", () => {
    expect(__SPAN_NET_SOURCES_FOR_TEST.menuOverview).toBe(
      String.raw`\bcard[áa]pio\b|\bmenu\b|o que (voc[êe]s )?(t[êe]m|servem)(?!\s+n[oa]s?\b|\s+em\b)( (pra|para) comer)?|quais (os |as )?(pratos|op[çc][õo]es)`,
    );
    // …and the three arms really are three, in the order the classifier `||`-ed them.
    expect(MENU_OVERVIEW_CLOSURE.markers).toHaveLength(3);
    expect(MENU_OVERVIEW_CLOSURE.markers[0]!.source).toBe(String.raw`\bcard[áa]pio\b|\bmenu\b`);
    // The BKL-205 NEGATIVE LOOKAHEAD lives INSIDE arm 2 and travelled with it — the entire
    // fix for a measured WRONG-FAMILY render, and invisible to any false-positive sweep.
    expect(MENU_OVERVIEW_CLOSURE.markers[1]!.source).toBe(
      String.raw`o que (voc[êe]s )?(t[êe]m|servem)(?!\s+n[oa]s?\b|\s+em\b)( (pra|para) comer)?`,
    );
    expect(MENU_OVERVIEW_CLOSURE.markers[2]!.source).toBe(
      String.raw`quais (os |as )?(pratos|op[çc][õo]es)`,
    );
  });

  // inv.18 v2 / R2-S9 — the DELIVERY_COVERAGE_Q net moved into
  // `delivery-coverage.claim.ts` as TEN marker regexes: the largest net in the arc, and the
  // one whose depth-0 split was MEASURED to rejoin before a byte of it moved. Same
  // statement as its predecessors, made about the biggest alternation: if this reassembly
  // is byte-identical to the pre-migration literal, it is not an equivalent regex, it is
  // THE SAME regex.
  it("DELIVERY_COVERAGE: the ten generated marker arms rejoin to the original literal", () => {
    expect(__SPAN_NET_SOURCES_FOR_TEST.deliveryCoverage).toBe(
      String.raw`voc[êe]s\s+entregam|(?:faz|fazem)\s+entrega|entregam?\s+(?:em|no|na|nos|nas|pra|para|at[ée])(?![a-z])|(?:onde|at[ée]\s+onde)\s+(?:voc[êe]s\s+)?entregam|(?:[áa]rea|regi[õo]es?|regi[ãa]o|zona)\s+de\s+entrega|atende[m]?\s+(?:em|no|na|nos|nas)(?![a-z])|taxa\s+de\s+(?:entrega|frete)|(?:valor|pre[çc]o)\s+d[oa]\s+(?:entrega|frete)|quanto\s+(?:custa|fica|sai|[ée])\s+(?:a\s+entrega|o\s+frete)|quanto\s+tempo\s+(?:demora|leva)\s+(?:a\s+)?(?:entrega|pra\s+entregar)`,
    );
    // Exactly ten — an eleventh would be new net surface smuggled in as a "move".
    expect(DELIVERY_COVERAGE_CLOSURE.markers).toHaveLength(10);
  });

  // inv.18 v2 / R2-S9 — the coupon NOUN moved into `coupon-valid.claim.ts` as ONE arm. The
  // DEGENERATE reassembly (the R2-S6 `cartContents` shape): with a single arm the join is
  // the arm's own source, so this is a relocation and byte-identity says so. It was
  // MEASURED to be the only available shape — no conjunct of this span's predicate splits
  // into rejoinable arms, since every one is a single lookbehind-anchored literal.
  it("COUPON_VALID: the one generated marker arm is the coupon NOUN, verbatim", () => {
    expect(__SPAN_NET_SOURCES_FOR_TEST.couponNoun).toBe(
      String.raw`(?<![a-z])(?:cupom|cupons|cup[ãa]o|vouchers?|c[óo]digos?\s+(?:de\s+)?(?:desconto|promo[çc][ãa]o|promocional))`,
    );
    expect(COUPON_VALID_CLOSURE.markers).toHaveLength(1);
    // The load-bearing half of byte-identity here is the QUALIFICATION of `código`: a bare
    // "código" is deliberately NOT a coupon noun IN THIS NET. Asserted behaviourally too,
    // since the string alone does not make the consequence visible.
    //
    // F-13 did NOT touch this arm, and that is the point of leaving this pin exactly as it
    // stood: the bare-`código` phrasing is reached by a hand-written BRIDGE conjunct
    // (`código` IMMEDIATELY followed by the extracted code), never by widening the DECLARED
    // net — a `markers` array is disjunctive, so an added bare arm would have made the
    // declared net assert that "qual o código do meu pedido?" is coupon-topical. The bridge
    // therefore carries behavioural pins of its own (see the F-13 describe below); this
    // value is blind to it by construction, exactly as it is blind to the three guards.
    expect(isCouponValidityAsk("qual o código do meu pedido?")).toBe(false);
    expect(isCouponValidityAsk("o código de desconto BEMVINDO15 vale?")).toBe(true);
  });

  // inv.18 v2 / R2-S9 — the PAIRING_Q net moved into `menu-pairings.claim.ts` as TWO arms.
  // Like RESERVATION_STATUS this is NOT a split of a pre-existing alternation: the two arms
  // were ALREADY separate literals `||`-ed inside `classifyPairingAsk`, so the migration
  // relocated them verbatim. Pinned PER ARM, and here that is not merely "strictly tighter"
  // — it is the ONLY thing standing behind a RUNTIME positional contract (arm 0 is the
  // substitution vocabulary, and `classifyPairingAsk` tests it first).
  it("PAIRING: each generated marker arm is byte-identical, IN THE ORDER the classifier tests", () => {
    // Arm 0 — SUBSTITUTION. Tested FIRST; it wins a tie.
    expect(MENU_PAIRINGS_CLOSURE.markers[0]!.source).toBe(
      String.raw`(?<![a-z])(?:no\s+lugar|em\s+vez|ao\s+inv[ée]s|substitui(?:r|ção|cao)?|substitut[oa]s?|troc(?:o|ar|a)\s+por|parecid[oa]\s+com|similar\s+a|acabou|esgotad[oa]|sem\s+estoque|n[ãa]o\s+tem\s+mais)`,
    );
    // Arm 1 — PAIRING.
    expect(MENU_PAIRINGS_CLOSURE.markers[1]!.source).toBe(
      String.raw`(?<![a-z])(?:combina(?:m|ç[ãa]o|coes|ções)?|vai\s+bem|v[ãa]o\s+bem|acompanha(?:m|mento)?s?|harmoniza(?:m)?|junto\s+com|pedir\s+junto|pra\s+acompanhar|para\s+acompanhar|sugest[ãa]o|sugere|recomenda)`,
    );
    expect(MENU_PAIRINGS_CLOSURE.markers).toHaveLength(2);
    // …and the joined form, so the shared non-empty/well-formed backstop covers this net.
    expect(__SPAN_NET_SOURCES_FOR_TEST.pairing).toBe(
      `${MENU_PAIRINGS_CLOSURE.markers[0]!.source}|${MENU_PAIRINGS_CLOSURE.markers[1]!.source}`,
    );
  });

  // inv.18 v2 / R2-S1 — the STORE_INFO_Q net moved into `store-info.claim.ts` as SEVEN
  // marker regexes and is consumed as `markers.some((m) => m.test(t))`. A `.some()` over
  // the arms and a `.test()` on the alternation are the same predicate, but that argument
  // is only worth as much as the arms still being the same arms — so the pre-migration
  // literal is frozen here exactly as it stood in `classifyRequestSpans`.
  it("STORE_INFO: the seven generated marker arms rejoin to the original literal", () => {
    expect(__SPAN_NET_SOURCES_FOR_TEST.storeInfo).toBe(
      String.raw`onde (fica|é|estão|est[áa]|se localiza)|endere[çc]o|localiza[çc][ãa]o|localizad|estacionamento|estacionar|como (chego|chegar)`,
    );
  });

  // inv.18 v2 / R2-S2 — the MENU_ITEM_PRICE_Q net moved into `menu-item-price.claim.ts`
  // as FOUR marker regexes, consumed the same `markers.some((m) => m.test(t))` way. Same
  // statement as STORE_INFO above; the pre-migration literal is frozen here exactly as it
  // stood in `classifyRequestSpans`. What did NOT move is the GUARD conjunction
  // (`notOrderScoped && !mutationImperative`) — the compiler models markers, not
  // suppression contexts — so the "quanto custa a entrega/o pedido" and "muda o preço"
  // negatives keep being asserted by the span cases elsewhere in this file.
  it("MENU_ITEM_PRICE: the four generated marker arms rejoin to the original literal", () => {
    expect(__SPAN_NET_SOURCES_FOR_TEST.menuItemPrice).toBe(
      String.raw`quanto custa|quanto (custam|é|fica|sai|tá|ta)|qual (o |é o )?pre[çc]o|pre[çc]o d[aoe]`,
    );
  });

  // inv.18 v2 / R2-S3 — the MENU_ITEM_CONTENTS_Q and MENU_DIETARY_Q nets moved into
  // `menu-item-contents.claim.ts` / `menu-dietary.claim.ts` as FOUR and TWO marker
  // regexes, consumed the same `markers.some((m) => m.test(t))` way. Same statement as
  // MENU_ITEM_PRICE above; each pre-migration literal is frozen here exactly as it stood
  // in `classifyRequestSpans`. What did NOT move is either GUARD conjunction
  // (`notOrderScoped && !mutationImperative`, plus `!isMenuOverview` on the CONTENTS span)
  // — the compiler models markers, not suppression contexts — so the "o que tem no
  // carrinho/cardápio", "tira o prato vegetariano" and allergen-boundary negatives keep
  // being asserted by the span cases in `menu-claims.test.ts`.
  it("MENU_ITEM_CONTENTS: the four generated marker arms rejoin to the original literal", () => {
    // BKL-205's accented `v[êe]m` / `t[êe]m` are INSIDE arms 1 and 3: byte-identity is the
    // only thing that keeps them, since dropping an accent empties the true-positive set
    // on the real phrasing without failing any false-positive sweep.
    expect(__SPAN_NET_SOURCES_FOR_TEST.menuItemContents).toBe(
      String.raw`o que (v[êe]m|t[êe]m|acompanha)|do que [ée] (é |)feit|que v[êe]m (n|em)|composi[çc][ãa]o d`,
    );
  });

  it("MENU_DIETARY: the two generated marker arms rejoin to the original literal", () => {
    // The ANCHORING ASYMMETRY is load-bearing and is what this byte-identity pins: arm 1
    // is UNANCHORED (it must match inside "comida vegetariano"), arm 2 IS word-bounded.
    expect(__SPAN_NET_SOURCES_FOR_TEST.menuDietary).toBe(
      String.raw`vegetarian[ao]?|\bvegan[ao]?\b`,
    );
  });

  // inv.18 v2 / R2-S4 — the RESERVATION_STATUS_Q net moved into
  // `reservation-status.claim.ts` as TWO marker regexes, consumed the same
  // `markers.some((m) => m.test(t))` way. This is the ONLY net in this file that was
  // never a single alternation: the two arms were already separate regex literals `||`-ed
  // in `classifyRequestSpans`, so they are pinned PER ARM rather than as a reassembled
  // whole. Per-arm is strictly tighter here, and it has to be: arm 1 contains top-level-
  // looking `|`s INSIDE its `(a|ar|ad|…)` group, so a joined string could not witness
  // where the arm boundary sits — a re-split at one of those inner `|`s would leave the
  // joined value byte-identical while producing two DIFFERENT (indeed invalid-in-spirit)
  // regexes that `.some()` no longer evaluates as the original predicate.
  it("RESERVATION_STATUS: each generated marker arm is byte-identical to its pre-migration literal", () => {
    // Arm 1 — LEFT-anchored only. The `(?<![a-z])` lookbehind is what closes the
    // preserv* family ("preservar"/"preservam"/"preservação"/"preservativo" all contain
    // "reserva" as a substring), and `(?!at)` is what closes "reservatório". Both are
    // invisible in a match/no-match sweep of ordinary phrasings, so byte-identity is the
    // only guard: dropping either lookaround still fires on every true positive.
    // Deliberately NOT right-anchored — it must keep matching "reservas"/"reservado".
    expect(RESERVATION_STATUS_CLOSURE.markers[0]!.source).toBe(
      String.raw`(?<![a-z])reserv(?!at)(a|ar|ad|am|as|ando|ei|ou)`,
    );
    // Arm 2 (BKL-219/224) — the `mesa` synonym, anchored on BOTH sides so it never
    // matches mid-word ("mesada").
    expect(RESERVATION_STATUS_CLOSURE.markers[1]!.source).toBe(
      String.raw`(?<![a-z])mesas?(?![a-z])`,
    );
    // Exactly two arms — a third would be new net surface smuggled in as a "move".
    expect(RESERVATION_STATUS_CLOSURE.markers).toHaveLength(2);
    // …and the joined form, so the shared non-empty/well-formed backstop below covers
    // this net too and the ORDER of the two arms is pinned.
    expect(__SPAN_NET_SOURCES_FOR_TEST.reservationStatus).toBe(
      String.raw`(?<![a-z])reserv(?!at)(a|ar|ad|am|as|ando|ei|ou)|(?<![a-z])mesas?(?![a-z])`,
    );
  });

  // The generated closure row itself — span class + required set — is what discharges
  // INV-4 for this Triad-scoped type. A generated row that named a DIFFERENT span class
  // would silently orphan the classifier arm (which now pushes
  // `RESERVATION_STATUS_CLOSURE.spanClass`, so both sides would move together and no
  // other assertion in this file would notice).
  it("RESERVATION_STATUS: the generated closure row is the pre-migration row", () => {
    expect(RESERVATION_STATUS_CLOSURE.spanClass).toBe("RESERVATION_STATUS_Q");
    expect(RESERVATION_STATUS_CLOSURE.requires).toEqual(["RESERVATION_STATUS"]);
    expect(REQUIRED_CLAIM_CLOSURE.RESERVATION_STATUS_Q).toEqual(["RESERVATION_STATUS"]);
  });

  // inv.18 v2 / R2-S5 — the two HISTORY nets moved into `order-history.claim.ts` /
  // `payment-history.claim.ts`. Unlike the reservation net these WERE single flat
  // alternations, so the reassembled joined value is a real byte-identity statement about
  // the pre-migration literal — but every arm of both nets contains `|`s inside its own
  // group, so the joined form alone cannot witness the split points and the per-arm pins
  // are what carry the proof. Both are asserted.
  it("ORDER_HISTORY: each generated marker arm is byte-identical to its pre-migration literal", () => {
    // Arm 1 — `histórico` … `pedido`, in that order, within a no-sentence-boundary
    // proximity window. The `[óo]` CHARACTER CLASS is the load-bearing part: an
    // ASCII-only `historico` stem would still pass every unaccented sweep while having an
    // EMPTY true-positive set on how a customer actually writes it (the
    // BKL-205/BKL-270/BKL-271 accent lesson, third recurrence).
    expect(ORDER_HISTORY_CLOSURE.markers[0]!.source).toBe(
      String.raw`hist[óo]rico[^.!?]{0,25}pedido`,
    );
    // Arm 2 — the REVERSED order ("pedidos no meu histórico"). This arm is what the
    // payment net does NOT have; the asymmetry is pre-existing and byte-identity is what
    // stops a later "make the pair symmetric" edit from silently changing one net.
    expect(ORDER_HISTORY_CLOSURE.markers[1]!.source).toBe(
      String.raw`pedido[^.!?]{0,25}hist[óo]rico`,
    );
    // Arm 3 — the possessive/superlative plural, LEFT-anchored, with the same accent
    // class on `[úu]ltimos`.
    expect(ORDER_HISTORY_CLOSURE.markers[2]!.source).toBe(
      String.raw`(?<![a-z])(meus|todos os meus|[úu]ltimos)\s+pedidos`,
    );
    // Exactly three arms — a fourth would be new net surface smuggled in as a "move".
    expect(ORDER_HISTORY_CLOSURE.markers).toHaveLength(3);
    // …and the joined form IS the pre-migration literal, character for character.
    expect(__SPAN_NET_SOURCES_FOR_TEST.orderHistory).toBe(
      String.raw`hist[óo]rico[^.!?]{0,25}pedido|pedido[^.!?]{0,25}hist[óo]rico|(?<![a-z])(meus|todos os meus|[úu]ltimos)\s+pedidos`,
    );
  });

  it("PAYMENT_HISTORY: each generated marker arm is byte-identical to its pre-migration literal", () => {
    // Arm 1 — `histórico` … EITHER noun, the second folded into a group rather than
    // given its own arm (this net's structural difference from the order twin, together
    // with having no reversed arm).
    expect(PAYMENT_HISTORY_CLOSURE.markers[0]!.source).toBe(
      String.raw`hist[óo]rico[^.!?]{0,25}(pagamento|pagar)`,
    );
    // Arm 2 — the possessive/superlative plural, LEFT-anchored.
    expect(PAYMENT_HISTORY_CLOSURE.markers[1]!.source).toBe(
      String.raw`(?<![a-z])(meus|todos os meus|[úu]ltimos)\s+pagamentos`,
    );
    // Exactly TWO arms — one fewer than the order net, deliberately.
    expect(PAYMENT_HISTORY_CLOSURE.markers).toHaveLength(2);
    expect(__SPAN_NET_SOURCES_FOR_TEST.paymentHistory).toBe(
      String.raw`hist[óo]rico[^.!?]{0,25}(pagamento|pagar)|(?<![a-z])(meus|todos os meus|[úu]ltimos)\s+pagamentos`,
    );
  });

  // R2-S5 FINDING, closed here. The marker revert-to-red probe measured that dropping the
  // order net's REVERSED arm 2 was caught by the byte pin above and by NOTHING ELSE: no
  // pre-existing or new behavioural case covered the reversed phrasing, so the arm was
  // byte-pin-only. And the degrade is not benign — with arm 2 gone,
  // "pedidos no meu histórico" does not fall through to arm 1 (which requires
  // histórico BEFORE pedido) or arm 3 (which requires the "meus pedidos" adjacency); it
  // classifies to ORDER_STATUS_Q instead, i.e. the SINGULAR span, which is precisely the
  // FE-D03 defect the list-shaped type exists to replace. A behavioural must-fire is
  // strictly stronger than a byte pin for that, because it survives a legitimate future
  // re-spelling of the arm.
  it.each([
    "pedidos no meu histórico",
    "pedido historico",
    "quais pedidos aparecem no meu histórico?",
  ])("MUST-FIRE ORDER_HISTORY_Q on the REVERSED pedido→histórico phrasing: %s", (text) => {
    const classes = classifyRequestSpans(text);
    expect(classes).toContain("ORDER_HISTORY_Q");
    // …and the singular sibling is spliced, which is the half that proves the reversed arm
    // reached the history branch rather than merely coexisting with the order-phrasing net.
    expect(classes).not.toContain("ORDER_STATUS_Q");
  });

  it("the two history nets are NOT interchangeable (the arm-count asymmetry is real)", () => {
    // Stated as its own case because both per-arm pins above could be satisfied by a
    // copy-paste of one net into the other's file if the nouns were swapped — the counts
    // differing is the fact that makes them genuinely two nets.
    expect(ORDER_HISTORY_CLOSURE.markers).toHaveLength(3);
    expect(PAYMENT_HISTORY_CLOSURE.markers).toHaveLength(2);
    expect(__SPAN_NET_SOURCES_FOR_TEST.orderHistory).not.toBe(
      __SPAN_NET_SOURCES_FOR_TEST.paymentHistory,
    );
  });

  it("the generated history closure rows are the pre-migration rows", () => {
    expect(ORDER_HISTORY_CLOSURE.spanClass).toBe("ORDER_HISTORY_Q");
    expect(ORDER_HISTORY_CLOSURE.requires).toEqual(["ORDER_HISTORY"]);
    expect(REQUIRED_CLAIM_CLOSURE.ORDER_HISTORY_Q).toEqual(["ORDER_HISTORY"]);
    expect(PAYMENT_HISTORY_CLOSURE.spanClass).toBe("PAYMENT_HISTORY_Q");
    expect(PAYMENT_HISTORY_CLOSURE.requires).toEqual(["PAYMENT_HISTORY"]);
    expect(REQUIRED_CLAIM_CLOSURE.PAYMENT_HISTORY_Q).toEqual(["PAYMENT_HISTORY"]);
  });

  // R2-S6 — the CART_CONTENTS_Q net. The DEGENERATE reassembly case: the pre-migration
  // `cartRef` was ONE regex literal, so there is a single arm and `markers.some(m =>
  // m.test(t))` is the very `.test(t)` the const ran. Byte-identity is still what holds the
  // two properties an "equivalent" rewrite would lose — the LEFT anchor and the
  // SPELLED-OUT plurals.
  it("CART_CONTENTS: the generated marker is byte-identical to its pre-migration literal", () => {
    expect(CART_CONTENTS_CLOSURE.markers[0]!.source).toBe(
      String.raw`(?<![a-z])(carrinho|carrinhos|cesta|cestas|sacola|sacolas)`,
    );
    // ONE arm — so the joined reassembly IS the arm, with no ambiguity about a split point.
    expect(CART_CONTENTS_CLOSURE.markers).toHaveLength(1);
    expect(__SPAN_NET_SOURCES_FOR_TEST.cartContents).toBe(
      CART_CONTENTS_CLOSURE.markers[0]!.source,
    );
    expect(__SPAN_NET_SOURCES_FOR_TEST.cartContents).toBe(
      String.raw`(?<![a-z])(carrinho|carrinhos|cesta|cestas|sacola|sacolas)`,
    );
  });

  // THE ONE LOAD-BEARING PROPERTY, stated BEHAVIOURALLY so it survives a legitimate future
  // re-spelling of the arm — the R2-S5 lesson (a byte-pin-only arm is one re-spelling away
  // from an unnoticed degrade). Every negative below genuinely CONTAINS a cart stem preceded
  // by a letter, so each row is the anchor doing work rather than a string with no stem in
  // it; the positives are the control that the net can fire at all.
  it("CART_CONTENTS: the LEFT anchor keeps a cart word from matching mid-word", () => {
    for (const text of ["acarrinhoquente", "umacestadefrutas", "minhasacolanova"]) {
      expect(text, "the negative must actually contain a cart stem").toMatch(
        /carrinho|cesta|sacola/,
      );
      expect(classifyRequestSpans(text), text).not.toContain("CART_CONTENTS_Q");
    }
    for (const text of ["meu carrinho", "minha cesta", "minha sacola"]) {
      expect(classifyRequestSpans(text), text).toContain("CART_CONTENTS_Q");
    }
  });

  // A MUST-FIRE CORPUS PIN, and deliberately NOT labelled a plural-arm test.
  //
  // MEASURED (R2-S6 revert-to-red 4b): the three plural alternatives are BYTE-PIN-ONLY. The
  // net has no RIGHT anchor, so `carrinho` already matches inside "carrinhos" — deleting
  // `carrinhos`/`cestas`/`sacolas` leaves every row here GREEN and is caught by the byte pin
  // above and nothing else. Writing this as "each spelled-out plural fires on its own" would
  // therefore have been a VACUOUS test wearing a discriminating name (the access-class
  // vacuity shape). What it honestly is: all six spellings customers actually use must
  // classify, whatever the arm's internal spelling becomes.
  it("CART_CONTENTS: all six cart-word spellings classify (must-fire corpus)", () => {
    for (const text of [
      "meu carrinho",
      "meus carrinhos",
      "minha cesta",
      "minhas cestas",
      "minha sacola",
      "minhas sacolas",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("CART_CONTENTS_Q");
    }
  });

  it("the generated CART closure row is the pre-migration SHARED row", () => {
    expect(CART_CONTENTS_CLOSURE.spanClass).toBe("CART_CONTENTS_Q");
    // THE SHARED ROW: one generated contribution, two required types. Every other adopted
    // row's `requires` is `[self]`; this one names its presence-complement twin, which is
    // what discharges CART_EMPTY's INV-4 obligation (cart-empty.claim.ts declares no row).
    expect(CART_CONTENTS_CLOSURE.requires).toEqual(["CART_CONTENTS", "CART_EMPTY"]);
    expect(REQUIRED_CLAIM_CLOSURE.CART_CONTENTS_Q).toEqual(["CART_CONTENTS", "CART_EMPTY"]);
    // …and the live table row IS the generated array, not a copy of it — so the row cannot
    // be edited here without editing the source.
    expect(REQUIRED_CLAIM_CLOSURE.CART_CONTENTS_Q).toBe(CART_CONTENTS_CLOSURE.requires);
  });

  // ── R2-S7 — THE STATUS SIBLINGS' nets, split THREE ways by PROVENANCE ─────────────
  //
  // These two are the first migrations where the span's runtime predicate is NOT the marker
  // net alone: each span is a DISJUNCTION of a strong-token net with one or two
  // GUARD-CONJOINED dual-use tokens. Only the strong net compiled. So the pins below come in
  // two kinds, and both are needed:
  //
  //   (a) BYTE pins on what DID migrate — the arms, per provenance group.
  //   (b) BEHAVIOURAL pins on what did NOT — the guards. Those live in their own describe
  //       below, because a byte pin cannot see a guard at all: delete `!capabilityQuestion`
  //       and every assertion in THIS block stays green.
  it("ORDER_STATUS: the five generated STRONG arms rejoin to the pre-migration literal", () => {
    expect(__SPAN_NET_SOURCES_FOR_TEST.orderStatusStrong).toBe(
      String.raw`pedido|preparo|sa[ií]u|chegou|cad[êe]`,
    );
    // The net is EIGHT arms across THREE provenances (5 split from one literal + the 2
    // already-separate BKL-221 arrival literals + 1 composed ETA sequence). Pinning the total
    // is what keeps the three slice-addressed pins from silently overlapping or leaving a new
    // arm unpinned: add a ninth arm anywhere and this row goes red.
    expect(ORDER_FULFILLMENT_STAGE_CLOSURE.markers).toHaveLength(8);
  });

  // The RELOCATED arms, pinned INDIVIDUALLY. The two existing ORDER_ARRIVAL / ORDER_ETA cases
  // above already assert the pre-migration VALUES and now read them off the generated closure
  // — that they still pass, unedited, is the migration's central claim. These add the
  // per-arm statement a joined string cannot make (a two-arm join cannot witness its own
  // boundary), which is the R2-S4/R2-S5 discipline for arms that were never one literal.
  it("ORDER_STATUS: each RELOCATED arm is byte-identical to the const it replaced", () => {
    const m = ORDER_FULFILLMENT_STAGE_CLOSURE.markers;
    expect(m[5]!.source, "ORDER_ON_THE_WAY_RE").toBe(
      String.raw`(?<![a-z])a\s+caminho(?![a-z])`,
    );
    expect(m[6]!.source, "ORDER_DELIVERED_RE").toBe(
      String.raw`(?<![a-z])(?:foi|est[áa]|j[áa])\s+entregue(?![a-z])`,
    );
    expect(m[7]!.source, "ORDER_ETA_RE").toBe(
      String.raw`(?:falta|demora|tempo)[^.!?]{0,20}(?:para|pra)\s+chegar(?!\s+(?:a[íi]|at[ée]|no\s+restaurante|na\s+loja))`,
    );
    // No arm may carry FLAGS. `markers.some((m) => m.test(t))` replaced a chain of `.test`
    // calls on flagless literals; a `/g` arm would make `.test` STATEFUL via lastIndex, so the
    // same utterance would classify differently on a second call. Nothing else in the repo
    // would notice.
    for (const [i, arm] of m.entries()) expect(arm.flags, `arm ${i}`).toBe("");
  });

  it("PAYMENT_STATUS: the five generated STRONG arms rejoin to the pre-migration literal", () => {
    expect(__SPAN_NET_SOURCES_FOR_TEST.paymentStatusStrong).toBe(
      String.raw`pago|cobran[çc]a|pagar|paguei|aprovad`,
    );
    // FIVE arms and no more — the two DUAL-USE tokens (`pagamento`, `pix`) are deliberately
    // NOT here. Each of them classifies only in conjunction with the ABSENCE of a
    // capability/payment-methods frame, so folding either in as a bare arm would fire the
    // owner-scoped MONEY read on "quais as formas de pagamento?" / "vocês aceitam pix?" (the
    // BKL-204 defect) — and this length pin is what would catch that being tried.
    expect(PAYMENT_STATUS_CLOSURE.markers).toHaveLength(5);
    for (const [i, arm] of PAYMENT_STATUS_CLOSURE.markers.entries()) {
      expect(arm.flags, `arm ${i}`).toBe("");
    }
    for (const arm of PAYMENT_STATUS_CLOSURE.markers) {
      expect(arm.source, "a dual-use token must not have become an arm").not.toMatch(
        /^(pagamento|pix)$/,
      );
    }
  });

  it("the generated STATUS closure rows are the pre-migration hand-written rows", () => {
    expect(ORDER_FULFILLMENT_STAGE_CLOSURE.spanClass).toBe("ORDER_STATUS_Q");
    expect(ORDER_FULFILLMENT_STAGE_CLOSURE.requires).toEqual(["ORDER_FULFILLMENT_STAGE"]);
    expect(PAYMENT_STATUS_CLOSURE.spanClass).toBe("PAYMENT_STATUS_Q");
    expect(PAYMENT_STATUS_CLOSURE.requires).toEqual(["PAYMENT_STATUS"]);
    // The live table rows ARE the generated arrays, not copies — so neither row can be edited
    // at the table without editing its source.
    expect(REQUIRED_CLAIM_CLOSURE.ORDER_STATUS_Q).toBe(
      ORDER_FULFILLMENT_STAGE_CLOSURE.requires,
    );
    expect(REQUIRED_CLAIM_CLOSURE.PAYMENT_STATUS_Q).toBe(PAYMENT_STATUS_CLOSURE.requires);
  });

  // THE HAND-WRITTEN ROW THE RULE LEAVES BEHIND, and the asymmetry it creates.
  //
  // R2-S6's rule: a source declares a closure row iff it OWNS the span. NO type owns PICKUP_Q
  // (its net is its own, it is named after no type, and it requires two types neither of which
  // is "the pickup type"), so that row stays hand-written — which makes
  // ORDER_FULFILLMENT_STAGE the first adopted type named by TWO rows, one generated and one
  // not. This case pins the shape so a future edit cannot quietly fold PICKUP_Q into a source.
  it("PICKUP_Q stays HAND-WRITTEN and no source declares it", () => {
    expect(REQUIRED_CLAIM_CLOSURE.PICKUP_Q).toEqual([
      "STORE_OPEN_NOW",
      "ORDER_FULFILLMENT_STAGE",
    ]);
    // NOT the generated array — a hand-written literal, unlike every adopted row above.
    expect(REQUIRED_CLAIM_CLOSURE.PICKUP_Q).not.toBe(
      ORDER_FULFILLMENT_STAGE_CLOSURE.requires,
    );
    for (const closure of [
      ORDER_FULFILLMENT_STAGE_CLOSURE,
      PAYMENT_STATUS_CLOSURE,
      STORE_OPEN_NOW_CLOSURE,
    ]) {
      expect(closure.spanClass, "no source may claim a span it does not own").not.toBe(
        "PICKUP_Q",
      );
    }
    // …and the type really is reachable through BOTH rows, which is the fact that masks
    // INV-4's forward direction for it (see order-fulfillment-stage.claim.ts's header). Stated
    // here so the masking is a recorded measurement rather than a surprise in a future
    // INV-4 debugging session.
    const rowsNamingOrder = Object.entries(REQUIRED_CLAIM_CLOSURE).filter(([, v]) =>
      (v as readonly string[]).includes("ORDER_FULFILLMENT_STAGE"),
    );
    expect(rowsNamingOrder.map(([k]) => k).sort()).toEqual(["ORDER_STATUS_Q", "PICKUP_Q"]);
    // Its sibling has exactly ONE row, so for PAYMENT_STATUS the forward direction is still a
    // live de-sync detector — the contrast is the point.
    const rowsNamingPayment = Object.entries(REQUIRED_CLAIM_CLOSURE).filter(([, v]) =>
      (v as readonly string[]).includes("PAYMENT_STATUS"),
    );
    expect(rowsNamingPayment.map(([k]) => k)).toEqual(["PAYMENT_STATUS_Q"]);
  });

  // ── THE SPLICE: the half that did NOT migrate. ────────────────────────────────────
  //
  // Each history span REMOVES its singular sibling from the accumulated class list. That
  // is a SEQUENCING fact about `classifyRequestSpans`, not a marker fact, so it stayed
  // hand-written — and staying hand-written is exactly why it needs pinning HERE: nothing
  // in the generated closure, the drift guard, or the marker pins above can see it. A
  // regression that deleted the two `classes.splice(...)` calls would leave every
  // assertion in this file green except these.
  describe("R2-S5 — the singular-sibling SPLICE (hand-written, not generated)", () => {
    it.each([
      ["qual o status dos meus pedidos?", "ORDER_HISTORY_Q", "ORDER_STATUS_Q"],
      ["qual o status dos meus pagamentos?", "PAYMENT_HISTORY_Q", "PAYMENT_STATUS_Q"],
      ["status do meu histórico de pedidos", "ORDER_HISTORY_Q", "ORDER_STATUS_Q"],
      ["status do meu histórico de pagamentos", "PAYMENT_HISTORY_Q", "PAYMENT_STATUS_Q"],
    ] as const)(
      "%s → keeps %s and SPLICES OUT %s",
      (text, kept, spliced) => {
        const classes = classifyRequestSpans(text);
        expect(classes).toContain(kept);
        // The load-bearing half. Without the splice the singular sibling survives and the
        // turn carries a required companion about a DIFFERENT (single-subject) resource —
        // which forces the >=2-owned CLARIFY the list-shaped type exists to replace.
        expect(classes).not.toContain(spliced);
      },
    );

    it("BOTH splices compose, and the surviving ORDER is the sequencing fact", () => {
      // The index arithmetic matters: the first splice shifts the array before the second
      // runs. Pinning the exact resulting order is what makes this a test of the
      // sequencing rather than of set membership.
      expect(classifyRequestSpans("qual o status de tudo: meus pedidos e meus pagamentos?")).toEqual(
        ["ORDER_HISTORY_Q", "PAYMENT_HISTORY_Q"],
      );
      expect(classifyRequestSpans("meus pedidos e meus pagamentos")).toEqual([
        "ORDER_HISTORY_Q",
        "PAYMENT_HISTORY_Q",
      ]);
    });

    // The OTHER direction, which is what keeps the splice from being a blanket
    // suppression: a SINGULAR ask carries no history marker, so its singular span must
    // survive untouched. Without these rows a "fix" that spliced unconditionally would
    // pass every case above.
    it.each([
      ["cadê meu pedido?", "ORDER_STATUS_Q"],
      ["onde está meu pedido?", "ORDER_STATUS_Q"],
      ["qual o status do meu pedido?", "ORDER_STATUS_Q"],
      ["meu pagamento foi aprovado?", "PAYMENT_STATUS_Q"],
      ["qual o status do meu pagamento?", "PAYMENT_STATUS_Q"],
    ] as const)("a SINGULAR ask keeps its span: %s → %s", (text, kept) => {
      const classes = classifyRequestSpans(text);
      expect(classes).toContain(kept);
      expect(classes).not.toContain("ORDER_HISTORY_Q");
      expect(classes).not.toContain("PAYMENT_HISTORY_Q");
    });

    it("a BARE status ask still over-includes BOTH singulars (no history marker)", () => {
      // The bare-"status" fallback is upstream of both splices; with no history marker
      // present neither fires, so the pre-migration over-inclusion is intact.
      expect(classifyRequestSpans("qual o status?")).toEqual([
        "ORDER_STATUS_Q",
        "PAYMENT_STATUS_Q",
      ]);
    });
  });

  // Guards the guard: a typo that emptied a part would make the assertions above
  // compare two wrong-but-equal strings only if the expectation were derived from
  // the code, which it is not — but an accidentally EMPTY reassembly is still worth
  // ruling out explicitly, since `''` is the one value that could silently satisfy
  // a future refactor of this very test.
  //
  // R2-S3 — the shared length floor moved 40 → 20 because it is bounded by the SHORTEST
  // legitimate net, and `menuDietary` (30 chars, two deliberately narrow stems) is now
  // that net. The backstop did NOT get blunter: 20 still fails a collapse of that shortest
  // net to EITHER single arm (15 / 14 chars), which is a sharper discrimination than 40
  // ever provided for the long nets. Every net's exact source is pinned byte-for-byte by
  // its own case above; this case exists only to catch a degenerate reassembly if one of
  // those pins is ever refactored away.
  it("the reassembled sources are non-empty and well-formed regexes", () => {
    for (const [name, source] of Object.entries(__SPAN_NET_SOURCES_FOR_TEST)) {
      expect(source, name).not.toBe("");
      expect(source.length, name).toBeGreaterThan(20);
      expect(() => new RegExp(source), name).not.toThrow();
    }
  });

  // ── R2-S7 — THE GUARD HALVES, pinned BEHAVIOURALLY because bytes cannot see them ───
  //
  // The status spans are the first migrations where the marker net is a PROPER PART of the
  // runtime predicate. Everything above is a byte pin, and every byte pin above stays GREEN if
  // the three guard conjuncts (`!capabilityQuestion` ×2, `!paymentMethodsQuestion`) are
  // deleted — so without this block the slice would have moved the markers into a source and
  // left the half that actually decides mis-routing unguarded.
  //
  // Each case is a CONTROL/TREATMENT pair over the SAME dual-use token, which is what makes it
  // a test of the guard rather than of the token: the capability phrasing must NOT fire the
  // owner-scoped span, and a self-referential phrasing carrying the SAME token MUST.
  describe("R2-S7 — the DUAL-USE guards stayed at the classifier (not markers)", () => {
    it.each([
      // token   capability phrasing (must NOT fire)              self-status (MUST fire)
      ["entrega", "qual a taxa de entrega?", "cadê minha entrega?", "ORDER_STATUS_Q"],
      ["entrega", "quanto custa a entrega?", "minha entrega está atrasada", "ORDER_STATUS_Q"],
      ["pix", "vocês aceitam pix?", "paguei com pix, deu certo?", "PAYMENT_STATUS_Q"],
    ] as const)(
      "%s: the CAPABILITY phrasing does not fire %s, the self-status one does",
      (token, capability, selfStatus, span) => {
        expect(capability, "the control must carry the dual-use token").toContain(token);
        expect(selfStatus, "the treatment must carry the SAME token").toContain(token);
        expect(classifyRequestSpans(capability), capability).not.toContain(span);
        expect(classifyRequestSpans(selfStatus), selfStatus).toContain(span);
      },
    );

    it("pagamento: the payment-METHODS frame does not fire PAYMENT_STATUS_Q", () => {
      // The `!paymentMethodsQuestion` conjunct. `pagamento` is a STRONG token everywhere
      // EXCEPT inside "formas/opções de pagamento", where it names the concept — so unlike the
      // two above, this guard is not the BKL-204 capability net but a frame of its own.
      for (const text of ["quais as formas de pagamento?", "quais as opções de pagamento?"]) {
        expect(text).toContain("pagamento");
        expect(classifyRequestSpans(text), text).not.toContain("PAYMENT_STATUS_Q");
      }
      // The control: the same token in a self-status frame fires.
      expect(classifyRequestSpans("meu pagamento foi aprovado?")).toContain(
        "PAYMENT_STATUS_Q",
      );
    });

    it("neither dual-use token can fire its span through the GENERATED net alone", () => {
      // The mechanism assertion behind all of the above, and the one that stays true if the
      // phrasings are ever re-worded: the generated arms must not MATCH the bare dual-use
      // tokens at all. If a future edit added `entrega` or `pix` as an arm, the guards would
      // become unreachable and every case above would still pass on the OTHER conjunct.
      for (const token of ["entrega", "pix"]) {
        expect(
          ORDER_FULFILLMENT_STAGE_CLOSURE.markers.some((m) => m.test(token)),
          `ORDER net must not match bare "${token}"`,
        ).toBe(false);
        expect(
          PAYMENT_STATUS_CLOSURE.markers.some((m) => m.test(token)),
          `PAYMENT net must not match bare "${token}"`,
        ).toBe(false);
      }
      // `pagamento` likewise — it reaches the span only through its own guarded branch.
      expect(PAYMENT_STATUS_CLOSURE.markers.some((m) => m.test("pagamento"))).toBe(false);
    });

    it("the mutation gate still routes a status-shaped MUTATION off both spans", () => {
      // BKL-206/BKL-238 — `!mutationImperative`, the other guard that did not migrate. These
      // utterances match the generated nets (they contain `pedido` / `pagar`), so the ONLY
      // thing keeping them off the read spans is the gate.
      for (const text of [
        "cancela meu pedido",
        "quero fechar o pedido e pagar com pix",
        "finaliza meu pedido",
      ]) {
        expect(
          ORDER_FULFILLMENT_STAGE_CLOSURE.markers.some((m) => m.test(text)) ||
            PAYMENT_STATUS_CLOSURE.markers.some((m) => m.test(text)),
          `${text} must match a generated net, or this row proves nothing`,
        ).toBe(true);
        const classes = classifyRequestSpans(text);
        expect(classes, text).not.toContain("ORDER_STATUS_Q");
        expect(classes, text).not.toContain("PAYMENT_STATUS_Q");
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inv.18 v2 / R2-S8 — STORE_HOURS_FOR_DATE_Q, the first span whose predicate is a
// CONJUNCTION rather than a flat net. `scheduleContext` became the generated marker
// array; `dateAnchor` stayed a hand-written guard at `classifyRequestSpans`. These
// cases pin the generated half byte-exactly AND pin the fact that doing so proves
// almost nothing about the span — which is the point of the block.
// ─────────────────────────────────────────────────────────────────────────────
describe("STORE_HOURS_FOR_DATE — the generated marker half of a CONJUNCTIVE span (R2-S8)", () => {
  it("the nine generated marker arms rejoin to the pre-migration scheduleContext literal", () => {
    // The same statement its seven predecessors make: if the reassembly is byte-identical
    // to the literal it replaced, it is not an equivalent regex, it is THE SAME regex.
    expect(__SPAN_NET_SOURCES_FOR_TEST.storeHoursForDate).toBe(
      String.raw`hor[áa]rio|que horas|abre|abrem|abert|fecha|funciona|expediente|atend`,
    );
    // Exactly nine arms — a tenth would be new net surface smuggled in as a "move".
    expect(STORE_HOURS_FOR_DATE_CLOSURE.markers).toHaveLength(9);
    // The accent CLASS, called out on its own: `horário` is how the attested SCN-002
    // utterance is actually spelled, so an ASCII-only stem would empty the true-positive
    // set on real phrasing while passing every false-positive sweep (the
    // BKL-205/BKL-270/BKL-271 lesson, now on its fifth recurrence).
    expect(STORE_HOURS_FOR_DATE_CLOSURE.markers[0]!.source).toBe(String.raw`hor[áa]rio`);
    // Every arm is a bare, flagless literal — no arm acquired an anchor or a flag in the
    // move (a `g` flag in particular would make `.test` stateful across calls).
    for (const m of STORE_HOURS_FOR_DATE_CLOSURE.markers) expect(m.flags).toBe("");
  });

  it("the generated closure row is the pre-migration row", () => {
    expect(STORE_HOURS_FOR_DATE_CLOSURE.spanClass).toBe("STORE_HOURS_FOR_DATE_Q");
    expect(STORE_HOURS_FOR_DATE_CLOSURE.requires).toEqual(["STORE_HOURS_FOR_DATE"]);
    expect(REQUIRED_CLAIM_CLOSURE.STORE_HOURS_FOR_DATE_Q).toEqual(["STORE_HOURS_FOR_DATE"]);
  });

  it("THE BYTE PIN IS GUARD-BLIND: the net alone matches every bare hours question", () => {
    // ── WHY THIS CASE EXISTS ────────────────────────────────────────────────────
    // Every earlier slice's byte pin covers a WHOLE span net, so byte-identity there is
    // close to a behavioural statement. Here it covers ONE CONJUNCT. This case measures
    // the gap directly: the generated net MATCHES utterances that must NEVER reach this
    // span, and the only thing keeping them off it is the hand-written `dateAnchor`
    // conjunct. So the pin above staying green is consistent with the span being wholly
    // broken — and the must-not-fire cases in the BKL-138 block above (plus the turn-seam
    // control in `../../__tests__/r2s8-hours-for-date-claims.e2e.test.ts`) are what
    // actually guard it. Stated as an assertion rather than a comment because a comment
    // claiming a safety property is worth nothing once someone edits the net.
    for (const text of [
      "qual o horário de funcionamento?",
      "que horas fecham?",
      "vocês funcionam?",
      "vocês atendem por telefone?",
      "o expediente é longo?",
    ]) {
      expect(
        STORE_HOURS_FOR_DATE_CLOSURE.markers.some((m) => m.test(text)),
        `the generated net must MATCH ${text}, or this case proves nothing`,
      ).toBe(true);
      // …and yet the SPAN does not fire, because the guard conjunct is absent.
      expect(classifyRequestSpans(text), text).not.toContain("STORE_HOURS_FOR_DATE_Q");
    }
  });

  it("the guard conjunct is the DATE half, and it is not reachable through the net", () => {
    // The mirror mechanism assertion (the R2-S7 dual-use-token idiom): if a future edit
    // ever added a weekday arm to the generated markers, the guard would become
    // unreachable and every must-not-fire case above would still pass on the OTHER
    // conjunct. Assert the net cannot match a bare date anchor.
    for (const token of [
      "domingo",
      "segunda",
      "terça",
      "quarta",
      "quinta",
      "sexta",
      "sábado",
      "amanhã",
      "feriado",
    ]) {
      expect(
        STORE_HOURS_FOR_DATE_CLOSURE.markers.some((m) => m.test(token)),
        `the generated net must not match the bare date anchor "${token}"`,
      ).toBe(false);
    }
  });

  it("both conjuncts together are what fire the span (the positive direction)", () => {
    // The non-vacuity partner of the two cases above: each pairing is a date anchor the
    // net cannot match, plus a schedule word the guard cannot match, and only together do
    // they classify. Without this the block would be satisfiable by a span that never
    // fires at all.
    for (const [anchor, word] of [
      ["domingo", "horário"],
      ["amanhã", "que horas"],
      ["sábado", "funciona"],
      ["feriado", "abert"],
      ["terça", "expediente"],
      ["quinta", "atende"],
    ] as const) {
      const text = `${word} ${anchor}?`;
      expect(classifyRequestSpans(text), text).toContain("STORE_HOURS_FOR_DATE_Q");
    }
  });
});

// ── R2-S9 — THE FIXED-SUBJECT BATCH: generated rows, and the guards a byte pin CANNOT
//    see ─────────────────────────────────────────────────────────────────────────────
//
// Every net adopted in this batch is only PART of its span's runtime predicate; the rest is
// a hand-written GUARD, and R2-S8's central lesson is that a marker byte pin is GUARD-BLIND
// BY CONSTRUCTION — delete the guard and the pin stays green while the span misfires
// wholesale. So each family gets must-fire / must-not-fire cases here, chosen so that
// deleting its specific guard turns THIS block red and nothing else.
describe("R2-S9 — the generated closure rows ARE the pre-migration rows", () => {
  it.each([
    ["DELIVERY_COVERAGE_Q", DELIVERY_COVERAGE_CLOSURE, ["DELIVERY_COVERAGE", "DELIVERY_NO_COVERAGE"]],
    ["COUPON_VALIDITY_Q", COUPON_VALID_CLOSURE, ["COUPON_VALID", "COUPON_INVALID"]],
    ["PAIRING_Q", MENU_PAIRINGS_CLOSURE, ["MENU_PAIRINGS", "MENU_SUBSTITUTIONS"]],
    ["MENU_OVERVIEW_Q", MENU_OVERVIEW_CLOSURE, ["MENU_OVERVIEW"]],
  ] as const)("%s: span class + required set survive the migration", (span, closure, requires) => {
    expect(closure.spanClass).toBe(span);
    expect(closure.requires).toEqual(requires);
    expect(REQUIRED_CLAIM_CLOSURE[span]).toEqual(requires);
    // The live table row IS the generated array, not a copy — so the row cannot be edited
    // at the table without editing its source.
    expect(REQUIRED_CLAIM_CLOSURE[span]).toBe(closure.requires);
  });

  // The shared-row rule's other half, at the table: for each pair exactly ONE span class
  // exists and it names both members. Derived from PRESENCE_COMPLEMENT_PAIRS so a future
  // pair inherits the case.
  it("each presence-complement pair has exactly ONE row, naming both members", () => {
    for (const [a, b] of PRESENCE_COMPLEMENT_PAIRS) {
      const rows = Object.entries(REQUIRED_CLAIM_CLOSURE).filter(
        ([, types]) => (types as readonly string[]).includes(a) || (types as readonly string[]).includes(b),
      );
      expect(rows, `${a}/${b}`).toHaveLength(1);
      expect(rows[0]![1]).toEqual([a, b]);
    }
    expect(PRESENCE_COMPLEMENT_PAIRS).toHaveLength(4);
  });
});

describe("R2-S9 — DELIVERY: the generated net fires, the HAND-WRITTEN guard suppresses", () => {
  // MUST-FIRE — one probe per generated arm, so the "ten arms" pin is not satisfiable by a
  // net that classifies nothing.
  it.each([
    "vocês entregam em Ibaté?",
    "fazem entrega para São Carlos?",
    "entregam no CEP 14815000?",
    "onde vocês entregam?",
    "qual a área de entrega?",
    "atendem no centro?",
    "qual a taxa de entrega?",
    "qual o valor da entrega?",
    "quanto custa a entrega?",
    "quanto tempo demora a entrega?",
  ])("MUST-FIRE: %s", (text) => {
    expect(classifyRequestSpans(text)).toContain("DELIVERY_COVERAGE_Q");
    expect(isDeliveryCoverageAsk(text)).toBe(true);
  });

  // MUST-NOT-FIRE — the SELF-REFERENCE guard, which lives in `isDeliveryCoverageAsk` and is
  // NOT part of the generated contribution. Delete it and every one of these becomes a
  // store-policy coverage question while the ten-arm byte pin stays green: the customer's
  // own in-flight delivery would be answered with the delivery ZONE.
  it.each([
    "cadê minha entrega?",
    "meu pedido saiu para entrega?",
    "minha entrega está atrasada",
    "o pedido nº 1234 já saiu para entrega?",
  ])("MUST-NOT-FIRE (self-reference): %s", (text) => {
    expect(isDeliveryCoverageAsk(text)).toBe(false);
    expect(classifyRequestSpans(text)).not.toContain("DELIVERY_COVERAGE_Q");
  });

  it("MUST-NOT-FIRE (mutation imperative): a delivery-address change stays a mutation", () => {
    expect(classifyRequestSpans("muda o endereço de entrega")).not.toContain(
      "DELIVERY_COVERAGE_Q",
    );
  });
});

describe("R2-S9 — COUPON: the generated NOUN fires, the HAND-WRITTEN guards discriminate", () => {
  it.each([
    "o cupom X1234 vale?",
    "esse cupom BEMVINDO15 ainda funciona?",
    "os cupons ainda estão valendo?",
    "o voucher expirou?",
    "código promocional ainda ativo?",
    "código de desconto BEMVINDO15 funciona?",
  ])("MUST-FIRE: %s", (text) => {
    expect(classifyRequestSpans(text)).toContain("COUPON_VALIDITY_Q");
  });

  // The APPLY-IMPERATIVE guard. It is a hand-written conjunct, so the noun byte pin is
  // blind to it: delete it and "aplica o cupom X" rides the READ span, classify-only
  // answers a validity question, and the customer's MUTATION is silently dropped — the
  // SCN-046 failure shape.
  it.each([
    "aplica o cupom BEMVINDO15",
    "usa esse código no meu carrinho",
    "coloca o cupom X1234",
  ])("MUST-NOT-FIRE (apply imperative): %s", (text) => {
    expect(isCouponValidityAsk(text)).toBe(false);
    expect(classifyRequestSpans(text)).not.toContain("COUPON_VALIDITY_Q");
  });

  // …and the MODAL frame that RE-ENABLES the read. This is the pair the two guards form:
  // dropping the modal disabler would exclude the most natural phrasing of the very
  // question the family exists to answer, which is the opposite failure and equally
  // invisible to the byte pin.
  it.each(["posso usar o cupom BEMVINDO15?", "dá pra usar esse cupom ainda?"])(
    "MUST-FIRE (modal frame beats the apply guard): %s",
    (text) => {
      expect(isCouponValidityAsk(text)).toBe(true);
      expect(classifyRequestSpans(text)).toContain("COUPON_VALIDITY_Q");
    },
  );

  it("MUST-NOT-FIRE: coupon-adjacent chatter with no validity word and no code", () => {
    expect(isCouponValidityAsk("ganhei um cupom, que legal")).toBe(false);
  });

  // ── F-13 — the two halves of the coupon span-net defect, FIXED TOGETHER ──────────
  //
  // These pins were written by R2-S9 as CHANGE-DETECTORS documenting a pre-existing
  // defect it was not allowed to fix (an ADOPTION may not widen a span net). They are
  // UPDATED here, not routed around: each one now asserts the FIXED behaviour of the
  // half it used to describe, and the joint constraint they were designed to enforce
  // is asserted directly by the third test below.
  //
  // (a) LE2-019's OWN documented example utterance had an EMPTY true-positive set.
  //     `claim-registry.ts`'s SpanClass comment advertises the family as fired by
  //     `"o cupom X1234 vale?"` AND `"esse código BEMVINDO15 ainda funciona?"`. The
  //     second one never fired: the coupon NOUN requires `código` to be QUALIFIED
  //     ("código DE DESCONTO/promoção/promocional"), because a bare "código" would
  //     swallow "qual o código do meu pedido?" — an ORDER question, and that exclusion
  //     is CORRECT and is kept. What was missing was a bridge for a bare `código`
  //     FOLLOWED BY AN EXTRACTABLE CODE, the phrasing the doc itself uses. Measured
  //     before the fix, the advertised utterance did not merely miss the coupon family:
  //     it classified as `[STORE_OPEN_NOW_Q]` and required `STORE_OPEN_NOW` — a coupon
  //     question answered as a question about opening hours.
  //
  // (b) `funciona` is a STORE_OPEN_NOW marker ("vocês funcionam?"), so a coupon question
  //     phrased with the most natural pt-BR validity verb ALSO fired STORE_OPEN_NOW_Q
  //     and force-required STORE_OPEN_NOW as a §O#15 companion — the coupon answer held
  //     hostage to a schedule read it has nothing to do with (the BKL-152 coupling shape
  //     on a pair that had no suppression rule).
  //
  // WHY THEY SHIPPED TOGETHER, which is the property the third test pins: fixing (a)
  // alone would have made the advertised phrasing fire AND immediately inherit (b)'s
  // spurious companion, converting a silently-dead phrasing into one whose answer is
  // hostage. Neither half is sufficient, and the joint assertion is the only one that
  // says so.
  it("F-13(a): the doc's own 'código <CODE>' example FIRES the coupon span", () => {
    expect(isCouponValidityAsk("esse código BEMVINDO15 ainda funciona?")).toBe(true);
    expect(classifyRequestSpans("esse código BEMVINDO15 ainda funciona?")).toContain(
      "COUPON_VALIDITY_Q",
    );
    // …and the QUALIFICATION rule the gap was a consequence of is untouched and still
    // CORRECT on its own terms: a bare `código` belonging to something ELSE always says
    // so BETWEEN the noun and the identifier, so the bridge's adjacency requirement —
    // not a blacklist of foreign resource nouns — is what keeps these out.
    expect(isCouponValidityAsk("qual o código do meu pedido?")).toBe(false);
    expect(isCouponValidityAsk("qual o código do meu pedido ABC123?")).toBe(false);
    expect(isCouponValidityAsk("me manda o código de rastreio BR123456")).toBe(false);
    expect(isCouponValidityAsk("o código da minha reserva R1234 ainda vale?")).toBe(false);
    expect(isCouponValidityAsk("código de desconto BEMVINDO15 funciona?")).toBe(true);
    // The bridge does NOT hand an apply IMPERATIVE a read span — the SCN-046 guard is
    // downstream of the topic gate and still bites on the newly-reachable phrasing.
    expect(isCouponValidityAsk("coloca o código BEMVINDO15")).toBe(false);
  });

  it("F-13(b): 'funciona' no longer drags STORE_OPEN_NOW into a coupon turn's required set", () => {
    const spans = classifyRequestSpans("esse cupom BEMVINDO15 ainda funciona?");
    expect(spans).toContain("COUPON_VALIDITY_Q");
    // The spurious companion is GONE. Nothing about a coupon's validity depends on the
    // store being open, and the schedule span's only evidence here was a token the coupon
    // validity vocabulary also owns.
    expect(spans).not.toContain("STORE_OPEN_NOW_Q");
    expect([...decomposeRequiredClaims(spans)]).toEqual(["COUPON_VALID", "COUPON_INVALID"]);
    // THE CONTROL that makes this a statement about `funciona` and not about coupons: the
    // same question with a different validity verb requires the same pair, as it always did.
    expect([...decomposeRequiredClaims(classifyRequestSpans("o cupom X1234 vale?"))]).toEqual([
      "COUPON_VALID",
      "COUPON_INVALID",
    ]);
  });

  // THE JOINT CONSTRAINT, asserted as one statement about ONE utterance. Reverting
  // EITHER half moves this assertion: without (a) the utterance is not a coupon ask at
  // all (and, worse, is a schedule ask); without (b) it is a coupon ask whose answer is
  // hostage to STORE_OPEN_NOW. Only both together produce this row.
  it("F-13: the advertised phrasing fires the COUPON family and drags NOTHING with it", () => {
    const spans = classifyRequestSpans("esse código BEMVINDO15 ainda funciona?");
    expect(spans).toEqual(["COUPON_VALIDITY_Q"]);
    expect([...decomposeRequiredClaims(spans)]).toEqual(["COUPON_VALID", "COUPON_INVALID"]);
  });

  // ── F-13 — THE DIRECTIONAL CONTROLS ─────────────────────────────────────────────
  //
  // A suppression is only worth its risk if it leaves the thing it suppresses working
  // everywhere else. These are the cases that must be UNCHANGED, and they are what
  // separates "the schedule reading is spurious HERE" from "coupons switch off hours".
  it.each([
    "funciona a loja?",
    "vocês funcionam?",
    "vocês funcionam hoje?",
    "que horas funciona?",
    "qual o horário de funcionamento?",
    "vocês estão abertos?",
  ])("F-13 CONTROL: a genuine schedule ask keeps STORE_OPEN_NOW — %j", (text) => {
    const spans = classifyRequestSpans(text);
    expect(spans).toContain("STORE_OPEN_NOW_Q");
    expect(spans).not.toContain("COUPON_VALIDITY_Q");
    expect([...decomposeRequiredClaims(spans)]).toContain("STORE_OPEN_NOW");
  });

  // THE CONTROL THE COARSE RULE WOULD HAVE FAILED, and the reason the suppression is
  // conditioned on the MATCHED MARKER rather than on "a coupon span is present". A
  // genuine TWO-question utterance still owes both answers: dropping the schedule half
  // because a coupon was also asked about is the P4 silent-drop direction — nothing
  // untrue is said, but half the question is answered as though it were the whole.
  it("F-13 CONTROL: a genuine BOTH-ask keeps its schedule companion", () => {
    const spans = classifyRequestSpans(
      "esse código BEMVINDO15 ainda funciona? vocês estão abertos?",
    );
    expect(spans).toContain("COUPON_VALIDITY_Q");
    expect(spans).toContain("STORE_OPEN_NOW_Q");
    expect([...decomposeRequiredClaims(spans)].sort()).toEqual([
      "COUPON_INVALID",
      "COUPON_VALID",
      "STORE_OPEN_NOW",
    ]);
  });

  // The BKL-152 sibling suppression is untouched — the two are DISJOINT (that one keys
  // on a date-for span, this one on the coupon reading), and a date-anchored hours
  // question is not a coupon question in either direction.
  it("F-13: the BKL-152 date-anchor suppression is unaffected", () => {
    const spans = classifyRequestSpans("que horas vocês abrem amanhã?");
    expect(spans).toContain("STORE_HOURS_FOR_DATE_Q");
    expect(spans).not.toContain("COUPON_VALIDITY_Q");
    expect([...decomposeRequiredClaims(spans)]).toEqual(["STORE_HOURS_FOR_DATE"]);
  });

  // F-13 — the SPAN/RENDER divergence the raw-text call closed. `isCodeShapedToken`
  // accepts an ALL-CAPS token with no digit ("FRETEGRATIS"), a rule a pre-lowercased
  // argument silently deletes. `classifyRequestSpans` used to pass its lowercased copy
  // while `claims-renderer-adapter.ts` passed the raw `requestText`, so ONE predicate
  // returned TWO answers for the same utterance, selected by the caller (measured:
  // `couponAsk=true` / `spans=[]`). Both call sites now pass the raw text.
  it("F-13: an ALL-CAPS code reaches the SPAN, not only the render seam", () => {
    expect(isCouponValidityAsk("cupom FRETEGRATIS?")).toBe(true);
    expect(classifyRequestSpans("cupom FRETEGRATIS?")).toContain("COUPON_VALIDITY_Q");
    expect(classifyRequestSpans("esse código FRETEGRATIS ainda funciona?")).toEqual([
      "COUPON_VALIDITY_Q",
    ]);
  });
});

describe("R2-S9 — PAIRING: the ORDERED arms, and what a swap would silently do", () => {
  it.each(["o que combina com brisket?", "o que acompanha o brisket?", "o que você sugere?"])(
    "MUST-FIRE (pairing arm): %s",
    (text) => {
      expect(classifyRequestSpans(text)).toContain("PAIRING_Q");
      expect(classifyPairingAsk(text)).toBe("pairs-with");
    },
  );

  it.each([
    "não tem costela, o que peço no lugar?",
    "o que substitui a costela?",
    "acabou o brisket, e agora?",
  ])("MUST-FIRE (substitution arm): %s", (text) => {
    expect(classifyRequestSpans(text)).toContain("PAIRING_Q");
    expect(classifyPairingAsk(text)).toBe("substitutes-for");
  });

  // THE POSITIONAL CONTRACT, asserted behaviourally. `classifyPairingAsk` reads
  // `markers[0]` as the substitution net; swap the two arms in the source and this
  // utterance — which carries BOTH vocabularies and is ONE question — starts resolving
  // `pairs-with`, answering a customer who has just been told they cannot have what they
  // asked for with a suggestion to have it alongside something. The joined byte pin cannot
  // see that; only the per-arm pins and this case can.
  it("the BORROWED-VOCABULARY single ask resolves by PRECEDENCE, not by luck", () => {
    expect(classifyPairingAsk("o que vai bem no lugar da costela")).toBe("substitutes-for");
    expect(isBothPairingAsk("o que vai bem no lugar da costela")).toBe(false);
    expect(isPairingAsk("o que vai bem no lugar da costela")).toBe(true);
  });

  // The both-ask DEGRADE — a hand-written CLAUSE COUNT, which no `markers` array can hold.
  it("a genuine TWO-question utterance is recognized (the degrade, not a half-answer)", () => {
    expect(
      isBothPairingAsk("o que combina com a costela bovina e o que posso pôr no lugar?"),
    ).toBe(true);
    // …and the span still FIRES, so the question stays accounted for by §O#15 rather than
    // falling through to a prose path.
    expect(
      classifyRequestSpans("o que combina com a costela bovina e o que posso pôr no lugar?"),
    ).toContain("PAIRING_Q");
  });

  it("MUST-NOT-FIRE (mutation imperative): an ADD is not a question about what goes with what", () => {
    expect(classifyRequestSpans("põe uma farofa junto do brisket")).not.toContain("PAIRING_Q");
  });
});

describe("R2-S9 — MENU_OVERVIEW: the generated arms, and the BKL-205 ORDERING they cannot pin", () => {
  it.each([
    "o que tem no cardápio?",
    "o que tem no menu de hoje?",
    "me mostra o cardápio",
    "o que vocês têm?",
    "o que tem pra comer?",
    "quais os pratos?",
    "quais as opções?",
  ])("MUST-FIRE: %s", (text) => {
    expect(classifyRequestSpans(text)).toContain("MENU_OVERVIEW_Q");
  });

  // ARM 1 vs ARM 2, the contrast BKL-205 installed: the menu WORD wins even under a
  // locative, while the bare interrogative does not. Both halves matter — an "equivalent"
  // rewrite that moved the lookahead onto the whole net would break the first.
  it("the menu WORD fires under a locative; the BARE ask does NOT", () => {
    expect(classifyRequestSpans("o que tem no cardápio?")).toContain("MENU_OVERVIEW_Q");
    expect(classifyRequestSpans("o que tem no brisket?")).not.toContain("MENU_OVERVIEW_Q");
  });

  // THE SPECIFICITY ORDERING — sequencing between two DIFFERENT types, hand-written, and
  // the half no byte pin can reach. Delete `!isMenuOverview` from the per-ITEM contents
  // span and the generated marker net is unchanged while these go red: a per-item question
  // gets the whole catalogue as a CONFIDENT answer (a wrong-FAMILY render, the one
  // direction the demote-only argument does not cover).
  it.each([
    ["o que tem no brisket?", "MENU_ITEM_CONTENTS_Q"],
    ["o que têm no combo família?", "MENU_ITEM_CONTENTS_Q"],
    ["o que vem no combo?", "MENU_ITEM_CONTENTS_Q"],
  ] as const)("%s routes to %s, NOT the overview", (text, expected) => {
    const classes = classifyRequestSpans(text);
    expect(classes).toContain(expected);
    expect(classes).not.toContain("MENU_OVERVIEW_Q");
  });

  it("…and the reverse: a whole-menu ask is DISJOINT from the per-item contents span", () => {
    const classes = classifyRequestSpans("o que tem no cardápio?");
    expect(classes).toContain("MENU_OVERVIEW_Q");
    expect(classes).not.toContain("MENU_ITEM_CONTENTS_Q");
  });

  it("MUST-NOT-FIRE (order-scoped / mutation guards, both hand-written)", () => {
    expect(classifyRequestSpans("o que tem no meu carrinho?")).not.toContain("MENU_OVERVIEW_Q");
    expect(classifyRequestSpans("tira o brisket do cardápio")).not.toContain("MENU_OVERVIEW_Q");
  });
});

describe("classifyRequestSpans — BKL-221 bare delivery-progress phrasings", () => {
  it("MUST-FIRE on the bare progress asks (measured ∅ before this ticket)", () => {
    for (const text of [
      "está a caminho?",
      "já está a caminho?",
      "meu lanche está a caminho?",
      "falta muito para chegar?",
      "quanto tempo falta para chegar?",
      "quanto tempo pra chegar?",
      "já foi entregue?",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("ORDER_STATUS_Q");
    }
  });

  it("the phrasings that ALREADY worked are unchanged (this widens, never replaces)", () => {
    for (const text of [
      "meu pedido já saiu para entrega?",
      "meu pedido chegou?",
      "já saiu para entrega?",
      "cadê meu pedido?",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("ORDER_STATUS_Q");
    }
  });

  // The BKL-204 boundary, in the direction that matters: a question about what the
  // STORE does must never force the customer's OWN owner-scoped order read. None of
  // the three new stems is capability vocabulary, and this asserts it rather than
  // assuming it.
  it("MUST-NOT-FIRE on delivery CAPABILITY questions (the BKL-204 boundary holds)", () => {
    for (const text of [
      "vocês entregam?",
      "vocês entregam em Ibaté?",
      "vocês fazem entrega?",
      "vocês entregam a domicílio?",
      "qual a taxa de entrega?",
      "vocês entregam rápido?",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("ORDER_STATUS_Q");
    }
  });

  // THE CROSS-NET INTERACTION THIS TICKET HAD TO GET RIGHT. A bare `cheg` stem was
  // the obvious spelling and is WRONG: `como chegar` is the STORE_INFO_Q directions
  // vocabulary, so the stem would have fired an owner-scoped ORDER read on a
  // customer asking for the address — a WRONG-FAMILY render, which the demote-only
  // argument does not cover. The frame anchor (falta/demora/tempo … para chegar) is
  // what keeps the two apart, and these assertions are what stop a future
  // "simplification" back to the bare stem.
  it("MUST-NOT-FIRE on DIRECTIONS questions (the rejected bare `cheg` stem's collision)", () => {
    for (const text of [
      "como chegar no restaurante?",
      "como chego até vocês?",
      "qual o caminho para chegar no restaurante?",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("ORDER_STATUS_Q");
    }
    // …and the directions family still answers, rather than merely not misfiring.
    expect(classifyRequestSpans("como chegar no restaurante?")).toContain(
      "STORE_INFO_Q",
    );
  });

  // The REJECTED stems, pinned as still-∅ so the rejection is a fact about the
  // code and not just a paragraph in a comment (the BKL-270 rejected-vocabulary
  // discipline). Both are genuinely subject-free; "demorar" is additionally the
  // exact wording of the delivery-ETA capability ask.
  it("the REJECTED stems stay OUT (subject-free phrasings keep the model path)", () => {
    expect(classifyRequestSpans("vai demorar muito?")).not.toContain("ORDER_STATUS_Q");
    expect(classifyRequestSpans("já está pronto?")).not.toContain("ORDER_STATUS_Q");
  });

  // ── The two false positives the vocabulary sweep CAUGHT in the first cut ──────
  // Both were live in an earlier draft of this net and are pinned here because a
  // comment explaining a closed hole does not fail when the hole reopens.

  // The head anchor (falta/demora/tempo) is NOT sufficient on its own: this
  // satisfies it while asking how long the CUSTOMER takes to travel. What
  // separates the senses is the DESTINATION — "chegar aí"/"chegar até vocês" is
  // the customer moving; bare "chegar" is the food arriving.
  it("MUST-NOT-FIRE on a TRAVEL-time ask (the destination lookahead)", () => {
    for (const text of [
      "quanto tempo para chegar aí de carro?",
      "quanto tempo demora para chegar até vocês?",
      "quanto tempo para chegar no restaurante?",
    ]) {
      expect(classifyRequestSpans(text), text).not.toContain("ORDER_STATUS_Q");
    }
    // …while the ARRIVAL sense, which differs ONLY in the destination, still fires.
    expect(classifyRequestSpans("quanto tempo falta para chegar?")).toContain(
      "ORDER_STATUS_Q",
    );
  });

  // A bare `entregue` fires on a customer PLACING an order — and `quero` is
  // deliberately not a mutation root, so nothing upstream suppresses it. The
  // question frame (foi/está/já) is what keeps the status ask and drops the order.
  it("MUST-NOT-FIRE on an order-PLACING utterance carrying `entregue`", () => {
    expect(classifyRequestSpans("quero uma picanha entregue agora")).not.toContain(
      "ORDER_STATUS_Q",
    );
    // …and on the OPS status-VALUE sense, where `entregue` names the enum, not a
    // question ("marca"/"marc" is in no mutation root, so this is not otherwise
    // suppressed).
    expect(classifyRequestSpans("já entregou, marca como entregue")).not.toContain(
      "ORDER_STATUS_Q",
    );
    // …while the customer's actual question still fires.
    expect(classifyRequestSpans("já foi entregue?")).toContain("ORDER_STATUS_Q");
  });

  // BKL-206 — the read-vs-mutation split is upstream of the new tokens too.
  it("MUST-NOT-FIRE when a mutation verb co-occurs (the shared gate still wins)", () => {
    expect(classifyRequestSpans("cancela meu pedido que está a caminho")).not.toContain(
      "ORDER_STATUS_Q",
    );
  });

  // ── The POSITION-SENSITIVITY of the travel-destination lookahead ─────────────
  // These pin a property, not a phrasing, and the property is what makes the
  // arrival net safe to restructure: the exclusion is anchored at the position of
  // the "para chegar" it follows, NOT applied to the utterance as a whole.
  //
  // Concretely — an utterance carrying BOTH senses must still fire, because ONE
  // occurrence is a genuine arrival ask. Any refactor that lifts the lookahead out
  // into a separate `&& !TRAVEL_RE.test(t)` check reads the whole string and
  // returns false here. That refactor is the obvious way to "simplify" this net,
  // it looks equivalent, and these cases are the reason it is not. (S5843 was
  // instead addressed by composing the SAME pattern from named parts — see the
  // net's own comment.)
  it("the travel exclusion is POSITIONAL: a both-senses utterance still fires", () => {
    for (const text of [
      "quanto tempo para chegar aí, e falta muito para chegar?",
      "falta muito para chegar? quanto tempo para chegar até vocês?",
      "quanto tempo para chegar no restaurante e quanto tempo falta para chegar",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("ORDER_STATUS_Q");
    }
  });

  it("both arrival stems in ONE utterance still fire (the split is a union)", () => {
    expect(classifyRequestSpans("está a caminho? já foi entregue?")).toContain(
      "ORDER_STATUS_Q",
    );
  });

  // #8 — the new tokens are ownership-gated like every other order-status match, so
  // a stray fire on someone who owns no order cannot degrade an answerable turn.
  it("the new tokens stay #8 ownership-gated (a guest forces NO order companion)", () => {
    const spans = classifyRequestSpans("está a caminho?");
    expect(spans).toContain("ORDER_STATUS_Q");
    const guest = decomposeRequiredClaims(spans, {
      hasActiveOrder: false,
      hasActivePayment: false,
    });
    expect(guest.has("ORDER_FULFILLMENT_STAGE")).toBe(false);
  });
});

describe("classifyRequestSpans — BKL-206 order/payment MUTATION imperatives don't ride the status reads", () => {
  it("'cancela meu pedido' (imperative) does NOT fire ORDER_STATUS_Q → routes to the mutation path", () => {
    const spans = classifyRequestSpans("cancela meu pedido");
    expect(spans).not.toContain("ORDER_STATUS_Q");
    expect(spans).not.toContain("PAYMENT_STATUS_Q");
  });

  it("'cancela o pedido 933869' (imperative + named order) still routes to mutation, not status", () => {
    expect(classifyRequestSpans("cancela o pedido 933869")).not.toContain(
      "ORDER_STATUS_Q",
    );
  });

  it("an amend imperative on a placed order does NOT read status ('muda meu pedido pra entrega')", () => {
    expect(classifyRequestSpans("muda meu pedido pra entrega")).not.toContain(
      "ORDER_STATUS_Q",
    );
  });

  it("'como cancelo meu pedido?' (interrogative how-to) routes to the model path (gets help), not a status read", () => {
    // The how-to question is not a status ask; suppressing the read routes it to
    // the model, which answers "how do I cancel" — it is not dead-ended.
    const spans = classifyRequestSpans("como cancelo meu pedido?");
    expect(spans).not.toContain("ORDER_STATUS_Q");
  });

  it("a GENUINE status ask still fires (no mutation verb) — the fix is surgical", () => {
    expect(classifyRequestSpans("cadê meu pedido?")).toContain("ORDER_STATUS_Q");
    expect(classifyRequestSpans("status do pedido 933869?")).toContain(
      "ORDER_STATUS_Q",
    );
    expect(classifyRequestSpans("meu pagamento foi aprovado?")).toContain(
      "PAYMENT_STATUS_Q",
    );
  });

  it("a bare 'status' with a cancel imperative does NOT fire the status fallback", () => {
    // "cancela o status atual" — a mutation must not ride the bare-"status" over-include.
    expect(classifyRequestSpans("cancela o status atual do pedido")).not.toContain(
      "ORDER_STATUS_Q",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKL-238 — the CHECKOUT verbs join the same mutation-imperative net BKL-206 gave
// `cancel`. A checkout utterance carries the vocabulary of BOTH owner-scoped status
// reads ("pedido" → ORDER_STATUS_Q; "pagar"/"pago" is a STRONG payment token and a
// bare "pix" pushes too → PAYMENT_STATUS_Q), so before the fix EVERY checkout turn
// forced the {ORDER_FULFILLMENT_STAGE, PAYMENT_STATUS} closure — unsatisfiable at
// checkout time, since the payment does not exist yet — and the turn degraded
// RENDER→UNKNOWN with the mutation silently dropped (live-caught as SCN-049).
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyRequestSpans — BKL-238 checkout imperatives don't ride the status reads", () => {
  // The SCN-049 shape and its neighbours: the checkout verb is what must win, even
  // when the utterance also names the order AND the payment method.
  const CHECKOUT_MUTATIONS: readonly string[] = [
    "quero fechar o pedido e pagar com pix", // SCN-049 — the exact bitten shape
    "quero fechar o pedido",
    "fecha o pedido no pix",
    "pode fechar a conta",
    "bora fechar, vou pagar com pix",
    "fechar pedido",
    "finaliza meu pedido",
    "quero finalizar o pedido com pix",
    "finalize o pedido, vou pagar no pix",
    "já escolhi, fecho o pedido agora",
  ];

  it.each(CHECKOUT_MUTATIONS)(
    "%j fires NEITHER status read → takes the mutation path",
    (text) => {
      const spans = classifyRequestSpans(text);
      expect(spans).not.toContain("ORDER_STATUS_Q");
      expect(spans).not.toContain("PAYMENT_STATUS_Q");
    },
  );

  it("the SCN-049 utterance no longer forces the unsatisfiable PAYMENT_STATUS closure", () => {
    // The defect end-to-end, in closure terms. Pre-fix the spans were
    // ["ORDER_STATUS_Q","PAYMENT_STATUS_Q"], whose closure a checkout turn can never
    // satisfy (there is no settled payment to validate yet) — so completeness failed
    // and the turn degraded RENDER→UNKNOWN. Post-fix nothing is required of it.
    const spans = classifyRequestSpans("quero fechar o pedido e pagar com pix");
    const required = decomposeRequiredClaims(spans);
    expect([...required]).toEqual([]);
    expect(checkRequiredClaimCompleteness(required, new Map()).complete).toBe(true);

    // …and this is what it used to be: the closure the checkout turn dead-ended in.
    const preFix = decomposeRequiredClaims(["ORDER_STATUS_Q", "PAYMENT_STATUS_Q"]);
    const stillDegrades = checkRequiredClaimCompleteness(preFix, new Map());
    expect(stillDegrades.complete).toBe(false);
    expect(stillDegrades.unsatisfied).toEqual([
      "ORDER_FULFILLMENT_STAGE",
      "PAYMENT_STATUS",
    ]);
  });

  // ── NEGATIVE CONTROLS: the fix must be additive-only ────────────────────────
  it("a GENUINE payment/order status ask still fires (no checkout verb) — surgical", () => {
    expect(classifyRequestSpans("meu pagamento foi aprovado?")).toContain(
      "PAYMENT_STATUS_Q",
    );
    expect(classifyRequestSpans("já paguei, cadê meu pedido?")).toContain(
      "PAYMENT_STATUS_Q",
    );
    expect(classifyRequestSpans("cadê meu pedido?")).toContain("ORDER_STATUS_Q");
    expect(classifyRequestSpans("status do pedido 933869?")).toContain(
      "ORDER_STATUS_Q",
    );
  });

  it("the `finalizad*` PARTICIPLE is a status ask, not a checkout mutation", () => {
    // "meu pedido foi finalizado?" asks whether the order COMPLETED — a read. The
    // `finaliz(?!ad)` lookahead is what keeps it out of the mutation net.
    for (const text of [
      "meu pedido foi finalizado?",
      "o pedido 933869 já está finalizado?",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("ORDER_STATUS_Q");
    }
  });

  it("the `fech*` STORE-CLOSED family is untouched (STORE_OPEN_NOW still fires)", () => {
    // fechado(s) / fechamento / fecham / fechou are the hours-and-open-state READ
    // vocabulary — the `fech(?!ad|ament|ou|am)` lookahead keeps every one of them out
    // of the mutation net, and the schedule spans they DO fire are unchanged.
    for (const text of [
      "vocês estão fechados?",
      "o restaurante tá fechado agora?",
      "qual o horário de fechamento?",
      "que horas vocês fecham?",
    ]) {
      expect(classifyRequestSpans(text), text).toContain("STORE_OPEN_NOW_Q");
    }
  });

  it("a store-hours read that shares the bare verb form still classifies correctly", () => {
    // "que horas fecha?" is the one hours phrasing that shares the bare imperative
    // form ("fecha o pedido"), so it DOES trip the net — harmlessly: STORE_OPEN_NOW_Q
    // is not one of the `!mutationImperative`-gated classify-only spans, and an
    // over-fire only ever routes a read to the model path (the BKL-201 fail-SAFE
    // direction), never produces a wrong render.
    expect(classifyRequestSpans("que horas fecha?")).toContain("STORE_OPEN_NOW_Q");
  });

  it("READ imperatives and other reads keep firing (the net stays mutation-only)", () => {
    expect(classifyRequestSpans("me mostra o cardápio")).toContain("MENU_OVERVIEW_Q");
    expect(classifyRequestSpans("quanto custa o brisket")).toContain(
      "MENU_ITEM_PRICE_Q",
    );
    expect(classifyRequestSpans("o que tem no meu carrinho?")).toContain(
      "CART_CONTENTS_Q",
    );
    expect(classifyRequestSpans("minha reserva está confirmada?")).toContain(
      "RESERVATION_STATUS_Q",
    );
  });
});

describe("required-claim decomposer — conservative-over-decomposing", () => {
  it("UNIONs across multiple span-classes (over-include, never under-include)", () => {
    const required = decomposeRequiredClaims(["PAYMENT_STATUS_Q", "PICKUP_Q"]);
    expect(required.has("PAYMENT_STATUS")).toBe(true);
    expect(required.has("STORE_OPEN_NOW")).toBe(true);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
  });

  it("an UNRECOGNIZED span-class forces NO companion (no over-suppression)", () => {
    expect(isSpanClass("NOT_A_CLASS")).toBe(false);
    expect(decomposeRequiredClaims(["NOT_A_CLASS"]).size).toBe(0);
    // A recognized class alongside an unrecognized one still contributes its set.
    expect([...decomposeRequiredClaims(["NOT_A_CLASS", "ORDER_STATUS_Q"])]).toEqual([
      "ORDER_FULFILLMENT_STAGE",
    ]);
  });

  it("an empty span-class list requires nothing (a greeting/smalltalk turn)", () => {
    expect(decomposeRequiredClaims([]).size).toBe(0);
  });
});

describe("required-claim completeness — quantifies over the REQUIRED set (SDD §O#15)", () => {
  const required = decomposeRequiredClaims(["PICKUP_Q"]); // {STORE_OPEN_NOW, ORDER_FULFILLMENT_STAGE}
  const resolved = (
    entries: ReadonlyArray<[RegistryClaimType, ClaimVerdict]>,
  ): ReadonlyMap<string, ClaimVerdict> => new Map(entries);

  it("COMPLETE only when EVERY required type is VALIDATED", () => {
    const r = checkRequiredClaimCompleteness(
      required,
      resolved([
        ["STORE_OPEN_NOW", "VALIDATED"],
        ["ORDER_FULFILLMENT_STAGE", "VALIDATED"],
      ]),
    );
    expect(r.complete).toBe(true);
    expect(r.unsatisfied).toEqual([]);
  });

  it("an ABSENT required companion DEGRADES (the 'render the easy half' hole)", () => {
    // The planner validated only STORE_OPEN_NOW and never produced the order stage.
    const r = checkRequiredClaimCompleteness(
      required,
      resolved([["STORE_OPEN_NOW", "VALIDATED"]]),
    );
    expect(r.complete).toBe(false);
    expect(r.unsatisfied).toEqual(["ORDER_FULFILLMENT_STAGE"]);
  });

  it("a required companion resolving UNKNOWN or REFUSED DEGRADES", () => {
    const unknownCase = checkRequiredClaimCompleteness(
      required,
      resolved([
        ["STORE_OPEN_NOW", "VALIDATED"],
        ["ORDER_FULFILLMENT_STAGE", "UNKNOWN"],
      ]),
    );
    expect(unknownCase.complete).toBe(false);
    const refusedCase = checkRequiredClaimCompleteness(
      required,
      resolved([
        ["STORE_OPEN_NOW", "REFUSED"],
        ["ORDER_FULFILLMENT_STAGE", "VALIDATED"],
      ]),
    );
    expect(refusedCase.complete).toBe(false);
    expect(refusedCase.unsatisfied).toEqual(["STORE_OPEN_NOW"]);
  });

  it("an EMPTY required set is trivially complete (nothing to render incompletely)", () => {
    const r = checkRequiredClaimCompleteness(new Set(), new Map());
    expect(r.complete).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKL-163 (reopened) — the CART presence-complement pair. The CART_CONTENTS_Q
// closure row requires BOTH members, but by construction exactly ONE can ever
// VALIDATE (complementary `cart_contents:`/`cart_empty:` evidence off the SAME
// read). The strict every-type rule made cart completeness structurally
// unsatisfiable — every cart turn (empty OR full) degraded RENDER→UNKNOWN (the
// live SCN-030 non-render). A pair member's requirement is satisfied by its
// PARTNER validating; non-pair types keep the strict rule (last test pins it).
// ─────────────────────────────────────────────────────────────────────────────
describe("required-claim completeness — presence-complement pair (BKL-163)", () => {
  const cartRequired = decomposeRequiredClaims(["CART_CONTENTS_Q"]); // {CART_CONTENTS, CART_EMPTY}
  const resolved = (
    entries: ReadonlyArray<[RegistryClaimType, ClaimVerdict]>,
  ): ReadonlyMap<string, ClaimVerdict> => new Map(entries);

  it("the closure row really does require the whole pair (the precondition)", () => {
    expect(cartRequired.has("CART_CONTENTS")).toBe(true);
    expect(cartRequired.has("CART_EMPTY")).toBe(true);
  });

  it("EMPTY cart: CART_EMPTY VALIDATED alone satisfies the pair (the SCN-030 turn renders)", () => {
    // The partner resolved UNKNOWN (its cart_contents evidence is ABSENT on an
    // empty cart) — the exact live trace that degraded before this fix.
    const r = checkRequiredClaimCompleteness(
      cartRequired,
      resolved([
        ["CART_EMPTY", "VALIDATED"],
        ["CART_CONTENTS", "UNKNOWN"],
      ]),
    );
    expect(r.complete).toBe(true);
    expect(r.unsatisfied).toEqual([]);
  });

  it("FULL cart: CART_CONTENTS VALIDATED alone satisfies the pair (the with-items regression)", () => {
    const r = checkRequiredClaimCompleteness(
      cartRequired,
      resolved([["CART_CONTENTS", "VALIDATED"]]),
    );
    expect(r.complete).toBe(true);
    expect(r.unsatisfied).toEqual([]);
  });

  it("NEITHER member VALIDATED still DEGRADES (an unavailable/failed cart read stays honest)", () => {
    const r = checkRequiredClaimCompleteness(
      cartRequired,
      resolved([["CART_CONTENTS", "UNKNOWN"]]),
    );
    expect(r.complete).toBe(false);
    expect(r.unsatisfied).toEqual(["CART_CONTENTS", "CART_EMPTY"]);
  });

  it("NON-pair companions keep the strict rule (no accidental widening of §O#15)", () => {
    // The PICKUP_Q pair {STORE_OPEN_NOW, ORDER_FULFILLMENT_STAGE} is NOT a
    // presence-complement pair: one validating must NOT satisfy the other.
    const r = checkRequiredClaimCompleteness(
      decomposeRequiredClaims(["PICKUP_Q"]),
      resolved([["STORE_OPEN_NOW", "VALIDATED"]]),
    );
    expect(r.complete).toBe(false);
    expect(r.unsatisfied).toEqual(["ORDER_FULFILLMENT_STAGE"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LE2-013 — THE DELIVERY PAIR IS A PRESENCE-COMPLEMENT PAIR TOO.
//
// LE2-002 built DELIVERY_COVERAGE / DELIVERY_NO_COVERAGE "on the CART_CONTENTS/
// CART_EMPTY precedent" (its own commit message) and gave DELIVERY_COVERAGE_Q a
// closure row requiring BOTH — but never registered the pair in
// PRESENCE_COMPLEMENT_PAIRS. The investigator records `delivery:coverage` only on a
// zone match and `delivery:no_coverage` only on a POSITIVE out-of-zone
// determination, so exactly one can ever VALIDATE: completeness was STRUCTURALLY
// unsatisfiable and EVERY coverage turn degraded RENDER→UNKNOWN, on BOTH planes.
// Byte-for-byte the BKL-163 cart bug.
//
// WHY CI STAYED GREEN: LE2-002's turn-seam tests call `renderer-from-claims`
// `render(...)` directly, which is one layer BELOW this gate (the gate is applied
// by `claims-renderer-adapter.ts`). LE2-013's ops turn-seam suite drives the real
// adapter through a real `handleTurn`, which is what surfaced it. NON-VACUOUS: with
// the pair unregistered, the first two cases below report `complete: false`.
// ─────────────────────────────────────────────────────────────────────────────
describe("required-claim completeness — the DELIVERY presence-complement pair (LE2-013)", () => {
  const required = decomposeRequiredClaims(["DELIVERY_COVERAGE_Q"]);
  const resolved = (
    entries: ReadonlyArray<[RegistryClaimType, ClaimVerdict]>,
  ): ReadonlyMap<string, ClaimVerdict> => new Map(entries);

  it("the closure row really does require the whole pair (the precondition)", () => {
    expect(required.has("DELIVERY_COVERAGE")).toBe(true);
    expect(required.has("DELIVERY_NO_COVERAGE")).toBe(true);
  });

  it("COVERED: DELIVERY_COVERAGE VALIDATED alone satisfies the pair (the Ibaté turn renders)", () => {
    const r = checkRequiredClaimCompleteness(
      required,
      resolved([
        ["DELIVERY_COVERAGE", "VALIDATED"],
        ["DELIVERY_NO_COVERAGE", "UNKNOWN"],
      ]),
    );
    expect(r.complete).toBe(true);
    expect(r.unsatisfied).toEqual([]);
  });

  it("OUT OF ZONE: DELIVERY_NO_COVERAGE VALIDATED alone satisfies the pair", () => {
    const r = checkRequiredClaimCompleteness(
      required,
      resolved([
        ["DELIVERY_NO_COVERAGE", "VALIDATED"],
        ["DELIVERY_COVERAGE", "UNKNOWN"],
      ]),
    );
    expect(r.complete).toBe(true);
    expect(r.unsatisfied).toEqual([]);
  });

  it("NEITHER member VALIDATED still DEGRADES (an unreadable zone projection stays honest)", () => {
    // Inv 7 preserved: "could not check" must not become a coverage answer in
    // either direction just because the pair is now complement-aware.
    const r = checkRequiredClaimCompleteness(
      required,
      resolved([["DELIVERY_COVERAGE", "UNKNOWN"]]),
    );
    expect(r.complete).toBe(false);
    expect(r.unsatisfied).toEqual(["DELIVERY_COVERAGE", "DELIVERY_NO_COVERAGE"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 — the polysemous "status" must route by its DISCRIMINATOR (payment vs order),
// not unconditionally to ORDER. NON-VACUOUS: with the old `/pedido|cad[êe]|status/`
// → ORDER_STATUS_Q rule, "status do meu pagamento" wrongly carried ORDER_STATUS_Q.
// ─────────────────────────────────────────────────────────────────────────────
describe("classifyRequestSpans — F2 'status' polysemy disambiguation (§O#8/§O#15)", () => {
  it("'qual o status do meu pagamento?' → PAYMENT_STATUS_Q (NOT misrouted to ORDER)", () => {
    const spans = classifyRequestSpans("qual o status do meu pagamento?");
    expect(spans).toContain("PAYMENT_STATUS_Q");
    expect(spans).not.toContain("ORDER_STATUS_Q");
    // …and it decomposes to PAYMENT_STATUS, never ORDER_FULFILLMENT_STAGE.
    const required = decomposeRequiredClaims(spans);
    expect(required.has("PAYMENT_STATUS")).toBe(true);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(false);
  });

  it("'qual o status do meu pedido?' → ORDER_STATUS_Q (NOT payment)", () => {
    const spans = classifyRequestSpans("qual o status do meu pedido?");
    expect(spans).toContain("ORDER_STATUS_Q");
    expect(spans).not.toContain("PAYMENT_STATUS_Q");
    const required = decomposeRequiredClaims(spans);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(required.has("PAYMENT_STATUS")).toBe(false);
  });

  it("a BARE 'status' with no discriminator → BOTH companions (conservative over-decompose)", () => {
    const spans = classifyRequestSpans("qual o status?");
    expect(spans).toContain("ORDER_STATUS_Q");
    expect(spans).toContain("PAYMENT_STATUS_Q");
    const required = decomposeRequiredClaims(spans);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(required.has("PAYMENT_STATUS")).toBe(true);
  });

  it("payment phrasing variants (pix / cobrança / pagar) route to PAYMENT_STATUS_Q", () => {
    for (const text of [
      "já caiu meu pix?",
      "qual o valor da cobrança?",
      "como faço para pagar?",
    ]) {
      expect(classifyRequestSpans(text)).toContain("PAYMENT_STATUS_Q");
    }
  });

  it("order/delivery phrasing (entrega / chegou / preparo) routes to ORDER_STATUS_Q", () => {
    for (const text of [
      "cadê minha entrega?",
      "meu pedido já chegou?",
      "ainda está em preparo?",
    ]) {
      expect(classifyRequestSpans(text)).toContain("ORDER_STATUS_Q");
    }
  });

  it("a payment+order compound 'status do pedido e do pagamento' keeps BOTH (over-include)", () => {
    const spans = classifyRequestSpans("qual o status do pedido e do pagamento?");
    expect(spans).toContain("ORDER_STATUS_Q");
    expect(spans).toContain("PAYMENT_STATUS_Q");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #8 — OWNERSHIP-AWARE required companions. A companion about a resource the
// customer PROVABLY does not own (an active order / active payment) is DROPPED, so
// it can no longer degrade a legitimately-VALIDATED answer. Gate fires ONLY on a
// positive first-party `false`; undefined ownership / a `true` flag preserves the
// pre-#8 over-including behavior byte-for-byte (demote-only under doubt).
// ─────────────────────────────────────────────────────────────────────────────
describe("required-claim decomposer — #8 ownership-aware companions", () => {
  const GUEST_OWNS_NOTHING: ActiveResourceOwnership = {
    hasActiveOrder: false,
    hasActivePayment: false,
  };

  it("#8a a GUEST's pickup-phrased hours question requires STORE_OPEN_NOW ONLY (no forced ORDER companion → not degraded)", () => {
    // "posso pegar uma marmita aí agora?" — a guest with no order. The pickup
    // marker classifies PICKUP_Q, whose closure forces {STORE_OPEN_NOW,
    // ORDER_FULFILLMENT_STAGE}. Before #8 the forced ORDER companion resolved
    // ABSENT and degraded the VALIDATED store-hours answer to UNKNOWN.
    const spans = classifyRequestSpans("posso pegar uma marmita aí agora?");
    expect(spans).toContain("PICKUP_Q");

    const required = decomposeRequiredClaims(spans, GUEST_OWNS_NOTHING);
    expect(required.has("STORE_OPEN_NOW")).toBe(true); // public config — never gated.
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(false); // guest owns no order.
    expect([...required]).toEqual(["STORE_OPEN_NOW"]);

    // …and with the store-hours claim VALIDATED the turn is NOT degraded.
    const completeness = checkRequiredClaimCompleteness(
      required,
      new Map([["STORE_OPEN_NOW", "VALIDATED"]]),
    );
    expect(completeness.complete).toBe(true);
  });

  it("#8b a bare 'status' from a customer with NO active payment requires ORDER only (no forced PAYMENT companion → not degraded)", () => {
    // Customer HAS an active order but NO active payment row. Bare "status"
    // over-includes both ORDER_STATUS_Q + PAYMENT_STATUS_Q; before #8 the forced
    // PAYMENT companion resolved ABSENT and degraded the order-status answer.
    const spans = classifyRequestSpans("qual o status?");
    const ownership: ActiveResourceOwnership = {
      hasActiveOrder: true,
      hasActivePayment: false,
    };

    const required = decomposeRequiredClaims(spans, ownership);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(required.has("PAYMENT_STATUS")).toBe(false); // no active payment → not forced.

    const completeness = checkRequiredClaimCompleteness(
      required,
      new Map([["ORDER_FULFILLMENT_STAGE", "VALIDATED"]]),
    );
    expect(completeness.complete).toBe(true);
  });

  it("keeps a gated companion when the customer DOES own the resource (over-include preserved)", () => {
    // An authenticated customer WITH an active order asking a pickup question
    // legitimately needs BOTH the store-open and the order-stage companion.
    const spans = classifyRequestSpans("posso pegar meu pedido agora?");
    const required = decomposeRequiredClaims(spans, {
      hasActiveOrder: true,
      hasActivePayment: false,
    });
    expect(required.has("STORE_OPEN_NOW")).toBe(true);
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
  });

  it("STORE_OPEN_NOW is NEVER ownership-gated (public config, owned by nobody)", () => {
    const required = decomposeRequiredClaims(
      ["STORE_OPEN_NOW_Q"],
      GUEST_OWNS_NOTHING,
    );
    expect([...required]).toEqual(["STORE_OPEN_NOW"]);
  });

  it("OMITTED ownership is byte-identical to the pre-#8 over-including decomposer", () => {
    // No signal threaded → nothing dropped → the full conservative union stands.
    expect([...decomposeRequiredClaims(["PICKUP_Q"])]).toEqual([
      "STORE_OPEN_NOW",
      "ORDER_FULFILLMENT_STAGE",
    ]);
    const bare = decomposeRequiredClaims(classifyRequestSpans("qual o status?"));
    expect(bare.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(bare.has("PAYMENT_STATUS")).toBe(true);
  });

  it("drops ONLY the companion whose flag is a positive false (independent gating)", () => {
    // hasActiveOrder true, hasActivePayment false → ORDER kept, PAYMENT dropped.
    const spans = classifyRequestSpans("qual o status?");
    const onlyOrder = decomposeRequiredClaims(spans, {
      hasActiveOrder: true,
      hasActivePayment: false,
    });
    expect(onlyOrder.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(onlyOrder.has("PAYMENT_STATUS")).toBe(false);
    // …and the mirror case.
    const onlyPayment = decomposeRequiredClaims(spans, {
      hasActiveOrder: false,
      hasActivePayment: true,
    });
    expect(onlyPayment.has("ORDER_FULFILLMENT_STAGE")).toBe(false);
    expect(onlyPayment.has("PAYMENT_STATUS")).toBe(true);
  });
});


describe("BKL-209 — deterministic medical-EMERGENCY net (§O#9 safety)", () => {
  const EMERGENCIES = [
    "estou tendo uma reação alérgica",
    "acho que é uma reação alérgica ao amendoim, minha garganta está fechando",
    "não consigo respirar",
    "to passando mal depois de comer aqui",
    "minha língua está inchando",
    "socorro, acho que é anafilaxia",
    "preciso de uma ambulância",
    "estou com falta de ar e o rosto inchou",
    "engasguei e não consigo respirar direito",
  ];
  for (const text of EMERGENCIES) {
    it(`fires on distress phrasing: "${text}"`, () => {
      expect(isMedicalEmergencyAsk(text)).toBe(true);
      expect(detectMedicalEmergencyMarkers(text)).toEqual(["medical-emergency"]);
    });
  }

  // The BOUNDARY: allergen-INFO questions must NOT fire the emergency net — they
  // keep the BKL-184 conservative abstain+offer path. A missed emergency is the
  // only unsafe direction, but over-firing on plain info questions would degrade
  // every allergen question to an emergency escalate.
  const INFO_NOT_EMERGENCY = [
    "tem amendoim?",
    "o brownie tem leite?",
    "sou alérgico a lactose, tem no cardápio algo sem?",
    "quais pratos são sem glúten?",
    "tem nozes nesse doce?",
  ];
  for (const text of INFO_NOT_EMERGENCY) {
    it(`does NOT fire on allergen-INFO: "${text}"`, () => {
      expect(isMedicalEmergencyAsk(text)).toBe(false);
      expect(detectMedicalEmergencyMarkers(text)).toEqual([]);
      // …and the allergen-info net still routes it to the BKL-184 path.
      expect(isAllergenFamilyAsk(text)).toBe(true);
    });
  }

  it("an ordinary non-safety request fires neither net", () => {
    expect(isMedicalEmergencyAsk("qual o horário de domingo?")).toBe(false);
    expect(detectMedicalEmergencyMarkers("qual o horário de domingo?")).toEqual([]);
  });
});

// BKL-271 — the mutation-root nets false-matched the PREFIX "por" inside ordinary
// READ vocabulary, and every classify-only READ span is gated on `!mutationImperative`,
// so those turns lost ALL their spans and fell off the deterministic path entirely
// (the failure BKL-273/LE2-029 established is NOT fail-safe: with no span, §O#15 has
// nothing to complete and the model authors the sentence itself).
//
// Root-specific fixes, each with its true-positive control pinned alongside:
//   `p[õo]r`  -> `p[õô]r(?![a-zà-ÿ])` + the real forms (ponh)  — the ticket
//   `cancel`  -> `cancel(?!ad)`                                — status participle
//   `coloc`   -> `colo[cq]`   and  `troc` -> `tro[cq]`         — c→q orthography
describe("classifyRequestSpans — BKL-271 mutation-root false positives", () => {
  // (a) pulled pork is core BBQ vocabulary AND a seeded product (handle `pulled-pork`).
  // It is NOT an alias-gazetteer surface, so the raw bytes reach this classifier.
  it("MUST-FIRE the menu reads on a pulled-pork ask ('por' inside 'pork')", () => {
    expect(classifyRequestSpans("o que vem no pulled pork?")).toContain(
      "MENU_ITEM_CONTENTS_Q",
    );
    expect(classifyRequestSpans("quanto custa o pulled pork?")).toContain(
      "MENU_ITEM_PRICE_Q",
    );
  });

  // (b) `porção` is the variant title of six seeded products. It is the case a naive
  // ASCII trailing guard `(?![a-z])` does NOT close — `ç` (U+00E7) sits outside [a-z].
  it("MUST-FIRE the price read on a 'porção' ask (ç is outside [a-z])", () => {
    expect(classifyRequestSpans("qual o preço da porção de linguiça?")).toContain(
      "MENU_ITEM_PRICE_Q",
    );
  });

  // (b) the BARE preposition. "por favor" / "por gentileza" are politeness markers that
  // attach to reads and writes alike — 77% of this repo's word-initial "por" bigrams —
  // so matching them suppressed the read span on every polite utterance.
  it("MUST-FIRE the reads on bare-'por' question and politeness forms", () => {
    const cases: Array<[string, string]> = [
      ["quanto custa por pessoa?", "MENU_ITEM_PRICE_Q"],
      ["me mostra o cardápio, por favor", "MENU_OVERVIEW_Q"],
      ["onde fica o restaurante, por favor?", "STORE_INFO_Q"],
      ["o que tem no meu carrinho, por gentileza?", "CART_CONTENTS_Q"],
      ["meu pedido já saiu por acaso?", "ORDER_STATUS_Q"],
    ];
    for (const [text, span] of cases) {
      expect(classifyRequestSpans(text), text).toContain(span);
    }
  });

  // (c) TRUE-POSITIVE controls for the PUT family. The IMPERATIVE forms carry the
  // mutation and must still suppress — `p[õo]e` unchanged, `ponh` newly covered.
  it("STILL-SUPPRESSES on genuine põe/ponha imperatives", () => {
    for (const text of [
      "põe uma coca no carrinho",
      "poe mais farofa no pedido",
      "ponha uma coca no meu carrinho",
      "ponha mais um brisket junto",
    ]) {
      expect(classifyRequestSpans(text), text).toEqual([]);
    }
  });

  // (c) …and the counter-direction that forced the branch to be DELETED rather than
  // re-pointed at `ô`: the INFINITIVE `pôr` is not a mutation verb in this domain. It
  // arrives in the modal frame "o que posso pôr no lugar?" — a SUBSTITUTION question,
  // which LE2-029's committed pairing e2e pins as a READ. Spelling the root `p[õô]r`
  // to "finally match pôr" makes that turn a mutation and takes the e2e red.
  it("MUST-FIRE the pairing read on the 'posso pôr no lugar' substitution ask", () => {
    expect(classifyRequestSpans("o que posso pôr no lugar da costela?")).toContain(
      "PAIRING_Q",
    );
  });

  // (d) `cancel(?!ad)` — the participle is a STATUS ask, the imperative is a mutation.
  it("MUST-FIRE the status reads on a 'cancelado/cancelada' participle ask", () => {
    expect(classifyRequestSpans("meu pedido foi cancelado?")).toContain("ORDER_STATUS_Q");
    expect(classifyRequestSpans("minha reserva está cancelada?")).toContain(
      "RESERVATION_STATUS_Q",
    );
  });

  it("STILL-SUPPRESSES on the cancel IMPERATIVE family (past the (?!ad) guard)", () => {
    for (const text of [
      "cancela meu pedido",
      "cancelar a minha reserva",
      "cancele o pedido por favor",
      "quero o cancelamento do meu pedido",
    ]) {
      expect(classifyRequestSpans(text), text).toEqual([]);
    }
  });

  // (d) `colo[cq]` / `tro[cq]` — pt-BR conjugation swaps c→q before -e, so "coloque" and
  // "troque" escaped the old `coloc`/`troc` roots. "coloque uma coca no carrinho" fired
  // CART_CONTENTS_Q: the read rendered and the add was SILENTLY DROPPED (BKL-201's own
  // defect, still live). "troque … POR …" is load-bearing for this ticket — it only
  // suppressed before via the "por" false positive being fixed here.
  it("STILL-SUPPRESSES on the c→q imperative forms (coloque / troque)", () => {
    for (const text of [
      "coloque uma coca no carrinho",
      "troque a costela por brisket no meu carrinho",
      "coloquei o item errado no carrinho",
    ]) {
      expect(classifyRequestSpans(text), text).toEqual([]);
    }
  });

  // The roots the audit left DELIBERATELY untouched must keep their coverage — these
  // pin that this ticket narrowed only the four roots it names.
  it("STILL-SUPPRESSES on every UNCHANGED edit/lifecycle root", () => {
    for (const text of [
      "adiciona uma coca no carrinho",
      "acrescenta farofa no pedido",
      "remove a costela do carrinho",
      "tira o refrigerante do carrinho",
      "muda o endereço do restaurante",
      "limpa o meu carrinho",
      "esvazia o carrinho",
      "aumenta a quantidade no carrinho",
      "diminui a quantidade no carrinho",
      "fecha o meu pedido",
      "finaliza o meu pedido",
    ]) {
      expect(classifyRequestSpans(text), text).toEqual([]);
    }
  });
});
