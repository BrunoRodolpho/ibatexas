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
import { CART_CONTENTS_CLOSURE } from "../claimdefs/cart-contents.generated.js";
import { ORDER_FULFILLMENT_STAGE_CLOSURE } from "../claimdefs/order-fulfillment-stage.generated.js";
import { ORDER_HISTORY_CLOSURE } from "../claimdefs/order-history.generated.js";
import { PAYMENT_HISTORY_CLOSURE } from "../claimdefs/payment-history.generated.js";
import { PAYMENT_STATUS_CLOSURE } from "../claimdefs/payment-status.generated.js";
import { RESERVATION_STATUS_CLOSURE } from "../claimdefs/reservation-status.generated.js";
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
  isMedicalEmergencyAsk,
  isSpanClass,
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
// BKL-152-EDGE — EXACT weekday==today suppression (@claustrum/core 0.8.0
// `resolvedQueryDate` carrier / `DateAnchorSignal`). The pure #301 rule above
// suppresses STORE_OPEN_NOW for ANY date-anchored hours question — including a
// named weekday that resolves to TODAY, where the open-now companion IS relevant.
// When the carrier seam is ACTIVE the decomposer reads the clock-resolved date:
// SUPPRESS only for a CONFIRMED NON-TODAY day (resolvedQueryDate PRESENT); KEEP when
// the resolved day is TODAY (resolvedQueryDate ABSENT under an active seam). Seam
// INACTIVE (or no dateAnchor arg at all) → the pure #301 rule, byte-identical.
// ─────────────────────────────────────────────────────────────────────────────
describe("required-claim decomposer — BKL-152-edge exact date-anchor (0.8.0 carrier)", () => {
  const dateSpans = ["STORE_OPEN_NOW_Q", "STORE_HOURS_FOR_DATE_Q"] as const;

  it("seam ACTIVE + resolvedQueryDate PRESENT (confirmed non-today) → SUPPRESS STORE_OPEN_NOW", () => {
    const required = decomposeRequiredClaims([...dateSpans], undefined, {
      seamActive: true,
      resolvedQueryDate: "2026-07-25",
    });
    expect([...required]).toEqual(["STORE_HOURS_FOR_DATE"]);
    expect(required.has("STORE_OPEN_NOW")).toBe(false);
  });

  it("seam ACTIVE + resolvedQueryDate ABSENT (weekday==today) → KEEP STORE_OPEN_NOW", () => {
    const required = decomposeRequiredClaims([...dateSpans], undefined, {
      seamActive: true,
    });
    expect(required.has("STORE_OPEN_NOW")).toBe(true);
    expect(required.has("STORE_HOURS_FOR_DATE")).toBe(true);
  });

  it("seam INACTIVE ({seamActive:false}) → pure #301 SUPPRESS (byte-identical fallback)", () => {
    expect([
      ...decomposeRequiredClaims([...dateSpans], undefined, { seamActive: false }),
    ]).toEqual(["STORE_HOURS_FOR_DATE"]);
  });

  it("no dateAnchor arg (1-arg call) → pure #301 SUPPRESS (existing callers unchanged)", () => {
    expect([...decomposeRequiredClaims([...dateSpans])]).toEqual([
      "STORE_HOURS_FOR_DATE",
    ]);
  });

  it("PICKUP wins over the date suppression regardless of the seam (today OR non-today)", () => {
    const today = decomposeRequiredClaims(["PICKUP_Q", ...dateSpans], undefined, {
      seamActive: true,
    });
    const nonToday = decomposeRequiredClaims(["PICKUP_Q", ...dateSpans], undefined, {
      seamActive: true,
      resolvedQueryDate: "2026-07-25",
    });
    expect(today.has("STORE_OPEN_NOW")).toBe(true);
    expect(nonToday.has("STORE_OPEN_NOW")).toBe(true);
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

  it("MENU_OVERVIEW: the three split arms rejoin to the original literal", () => {
    expect(__SPAN_NET_SOURCES_FOR_TEST.menuOverview).toBe(
      String.raw`\bcard[áa]pio\b|\bmenu\b|o que (voc[êe]s )?(t[êe]m|servem)(?!\s+n[oa]s?\b|\s+em\b)( (pra|para) comer)?|quais (os |as )?(pratos|op[çc][õo]es)`,
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
