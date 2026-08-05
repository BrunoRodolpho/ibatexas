// turn-reads.ts — the FIRST-PARTY, OWNER-SCOPED read backend the INVESTIGATE
// stage gathers evidence from (SDD §M / §N; Inv 2/7/13; v1.1 §7). It replaces the
// B-PR1 placeholder (`defaultTurnReads`, which merely echoed UNTRUSTED_DATA tool
// inputs) with REAL reads against the SAME domain query services the tool
// handlers use, so the per-turn Evidence Ledger carries concrete values with
// their TRUE provenance — not LLM-derived free text.
//
// Trustworthiness-Triad scope (Track A): schedule (STORE_OPEN_NOW / STORE_HOURS),
// order (ORDER_FULFILLMENT_STAGE), payment (PAYMENT_STATUS — owner-scoped), and
// reservation. The gatherer that turns these into `TurnRead`s lives in
// ibatexas-investigator.ts; this module owns the BACKEND (the reads themselves)
// plus the pure resource-id extraction the gatherer drives off.
//
// ── OWNER-SCOPING / the PAYMENT_STATUS IDOR close (Inv 2/13 — money-safety) ──
// The claim registry declares `PAYMENT_STATUS` with `ownershipPolicy: "required"`
// (claim-registry.ts), but the raw payment read `getActiveByOrderId(orderId)` is
// keyed ONLY on `orderId` — given a forged/other-principal orderId it would
// return ANOTHER customer's payment. `readPaymentStatus` closes that IDOR by
// flowing ownership THROUGH the OWNER-SCOPED order read (the same gate
// loadPaymentCtx uses): the order is read with `{ customerId }` and re-checked
// (`order.customerId === customerId`); a cross-owner / NULL-owner order resolves
// to `null`, so the payment is NEVER read. "no owner" ≠ "any owner" → refused,
// never leaked. The order + reservation reads are owner-scoped the same way.
//
// ── PROVENANCE under the PUBLISHED 2-value LedgerTaint (@adjudicate/core@1.6.0) ──
// A genuine first-party DB / config read is `"TRUSTED"`. The 3-value
// `FIRST_PARTY` lives only in the unpublished R1-led kernel — do NOT fake it
// against the 2-value type (see the ibatexas-investigator `TurnRead.origin`
// TODO). A derived / customer-supplied value is NEVER labeled `"TRUSTED"` here.

import {
  createOrderQueryService,
  createPaymentQueryService,
  createReservationService,
} from "@ibatexas/domain";
import {
  getScheduleSignal,
  getTodayHoursText,
  getHoursTextForDate,
  loadSchedule,
  medusaStore,
  reaisToCentavos,
  type ScheduleSignal,
} from "@ibatexas/tools";
import type { HolidayEntry, ScheduleOverrideEntry } from "@ibatexas/types";
// FE-D03 slice C — the pt-BR status label maps for the deterministic ORDER_HISTORY /
// PAYMENT_HISTORY summary composers (never hardcode a pt-BR status string, Hard Rule 4).
import {
  ORDER_STATUS_LABELS_PT,
  PAYMENT_STATUS_LABELS_PT,
  RESERVATION_STATUS_LABELS_PT_CUSTOMER,
} from "@ibatexas/types";
// F-9 — the ONE owner of "which cart is this conversation working on?". This
// file's CART_CONTENTS read is the site whose ABSENT-vs-UNAVAILABLE distinction
// makes that resolution a trichotomy rather than a `string | null`.
import { resolveActiveCart } from "./active-cart-resolution.js";
// (BKL-006 falsifier predicates moved into the domain service's findFirst
// probes — see findRefundBearingByOrderId/findDisputedByOrderId; no status-enum
// comparison happens in this file anymore.)

// ── Read value shapes (concrete; the renderer fills 1:1 from validated claims) ─

/** STORE_OPEN_NOW / STORE_HOURS — the deterministic, config-derived schedule fact. */
export type ScheduleRead = ScheduleSignal;

/**
 * STORE_OPEN_NOW FALSIFIER (Plan 1 Phase 3 / F1; W6 CE#3) — the day's
 * ScheduleOverride. A per-date exception (`isOpen` + `blocks`) that CONTRADICTS
 * the weekly-schedule-derived open/closed signal: `getScheduleSignal` is computed
 * ONLY from `days` + `holidays` (schedule-helpers.ts) and does NOT account for
 * per-date overrides, so a present override means the signal cannot be trusted →
 * the kernel's `resolveAgainstFalsifiers` demotes STORE_OPEN_NOW to UNKNOWN. Read
 * ONLY for TODAY (the turn's tz date); a day with NO override resolves to absence
 * (the falsifier does not fire) — never a fabricated "no override" present value.
 */
export type ScheduleOverrideRead = ScheduleOverrideEntry;

/**
 * STORE_HOURS — TODAY's operating-hours as ONE scalar pt-BR string (BKL-121 / D2).
 * Config-derived from the REAL weekly `days[today]` window (via `getTodayHoursText`);
 * NEVER an invented/hardcoded hour (BKL-026). The renderer fills its `hoursText`
 * proposition 1:1 from this (Inv 6). A schedule-load failure is a read ERROR (Inv 7),
 * never a fabricated value — see {@link TriadReadBackend.readStoreHours}.
 */
export interface StoreHoursRead {
  readonly hoursText: string;
}

/**
 * STORE_HOURS_FOR_DATE — the QUERIED calendar day's operating-hours as ONE scalar
 * pt-BR string (BKL-138; the day-parameterized twin of {@link StoreHoursRead}).
 * Config-derived from the REAL weekly `days[dowOf(isoDate)]` window via
 * {@link getHoursTextForDate}; NEVER an invented hour (BKL-026). Recorded under the
 * date-suffixed key `schedule:store_hours:{isoDate}`. A schedule-load failure is a
 * read ERROR (Inv 7), never a fabricated value — see
 * {@link TriadReadBackend.readHoursForDate}.
 */
export type StoreHoursForDateRead = StoreHoursRead;

/**
 * STORE_HOURS FALSIFIER (BKL-121 / D1) — TODAY's {@link HolidayEntry}. The
 * weekly-schedule-derived {@link StoreHoursRead} does NOT account for a per-date
 * holiday, so a present holiday CONTRADICTS today's regular hours → the kernel's
 * `resolveAgainstFalsifiers` demotes STORE_HOURS to UNKNOWN. Read ONLY for TODAY;
 * a day with NO holiday resolves to absence (the falsifier does not fire) — never a
 * fabricated "no holiday" present value. (The other STORE_HOURS falsifier, a present
 * ScheduleOverride, REUSES {@link ScheduleOverrideRead} verbatim.)
 */
export type HolidayRead = HolidayEntry;

/** ORDER_FULFILLMENT_STAGE — the owner-scoped order's current fulfillment stage.
 *  BKL-189: carries the order's human-facing `displayId` (from the SAME memoized
 *  owner-scoped projection read — zero extra reads) so the classify-only ambiguity
 *  branch can label disambiguation candidates "#displayId" synchronously off the
 *  ledger. Additive: the C6 valueBinding paths are untouched. */
export interface OrderFulfillmentRead {
  readonly orderId: string;
  readonly displayId: number;
  readonly fulfillmentStatus: string | null;
}

/** PAYMENT_STATUS — the owner-scoped order's active-payment status (IDOR-closed).
 *  BKL-189: `displayId` for the same reason as {@link OrderFulfillmentRead} — the
 *  payment ambiguity's subject IS an orderId, and a payment-only turn records no
 *  fulfillment entries to borrow the label from. */
export interface PaymentStatusRead {
  readonly orderId: string;
  readonly displayId: number;
  readonly status: string;
  readonly method: string | null;
}

/** The owner-scoped reservation's current status. */
export interface ReservationRead {
  readonly reservationId: string;
  readonly status: string;
  readonly partySize: number;
  /**
   * BKL-185 — the DETERMINISTICALLY pre-composed pt-BR status line the
   * RESERVATION_STATUS template renders (the C6-bound scalar, ORDER_HISTORY's
   * serialized-scalar idiom): `"confirmada — 19/07 às 18:30, para 2 pessoas"`
   * when the slot detail is present, or EXACTLY the bare `status` when it is
   * not — so the detail-absent render is byte-identical to the pre-BKL-185
   * status-only form. Pure string composition off the DTO (no clock, no tz
   * math); never model-authored.
   */
  readonly statusLine: string;
}

/**
 * BKL-185 — compose the reservation status line. Pure. The status word is
 * LOCALIZED here from the single-source CUSTOMER register (BKL-016 — the same
 * pt-BR wording the pre-BKL-185 render-time enum localization produced; raw
 * fallback for an unmapped member, never a crash), because the composed scalar
 * is the C6-bound value the template renders VERBATIM (the ORDER_HISTORY
 * pre-composed pt-BR serialized-scalar idiom — enum lookup cannot localize a
 * composed string). Date arrives as the DTO's ISO `YYYY-MM-DD` (sliced, never
 * parsed through a clock/tz); `startTime` is the slot's literal `HH:MM`. Any
 * missing piece degrades to the bare localized status — byte-identical to the
 * pre-enrichment render.
 */
export function composeReservationStatusLine(args: {
  readonly status: string;
  readonly partySize: number;
  readonly isoDate?: string;
  readonly startTime?: string;
}): string {
  const { status, partySize, isoDate, startTime } = args;
  const localized =
    (RESERVATION_STATUS_LABELS_PT_CUSTOMER as Readonly<Record<string, string>>)[
      status
    ] ?? status;
  const dateParts = isoDate?.split("-");
  if (
    dateParts === undefined ||
    dateParts.length !== 3 ||
    startTime === undefined ||
    startTime.length === 0
  ) {
    return localized;
  }
  const [, month, day] = dateParts;
  if (month === undefined || day === undefined) return localized;
  const pessoas = partySize === 1 ? "1 pessoa" : `${partySize} pessoas`;
  return `${localized} — ${day}/${month} às ${startTime}, para ${pessoas}`;
}

// ── BKL-006 owner-scoped FALSIFIER read shapes (refund / chargeback / cancel) ──
//
// Each is the per-subject companion of an already-DECLARED registry falsifier
// (claim-registry.ts): PAYMENT_STATUS's `payment_refund` + `payment_chargeback`,
// ORDER_FULFILLMENT_STAGE's `order_cancelled`, RESERVATION_STATUS's
// `reservation_cancelled`. The registry declared them `falsifierComplete` but no
// investigator read populated them, so the runtime arm was structurally INERT — a
// refunded/disputed payment could VALIDATE `pago` while the claims flag is ON. These
// reads make the arm LIVE. The boolean discriminant (`refunded`/`disputed`/
// `cancelled`) is present-vs-absent for the ledger: the investigator records the
// value PRESENT only when it is `true`, and leaves the key ABSENT (so the falsifier
// does NOT fire) when `false` — never a fabricated "no refund" present value (the
// anti-pattern warned about in ibatexas-investigator.ts). A cross-owner / absent
// resource resolves to `null` here (the SAME owner-scope idiom as the other reads),
// which the investigator records as a fail-closed read ERROR (Inv 7), NEVER an
// absence — an unreadable falsifier cannot be proven not to have fired.

/**
 * PAYMENT_STATUS falsifier — a refund on the order's payment(s). `refunded` iff any
 * payment for the order carries a refund signal: `refundedAmountCentavos > 0` OR
 * status ∈ {`partially_refunded`, `refunded`}. RATIFIED (BKL-006): a PARTIAL refund
 * DOES fire (`partially_refunded` / a non-zero refunded amount) — demote-only to
 * UNKNOWN is safe, and a partially-refunded/refunded money state is exactly the
 * ambiguous case a confident automated `pago` must not assert. A FULL refund makes
 * the row terminal (`getActiveByOrderId` excludes it) → the BASE `payment_status`
 * read already errors → UNKNOWN, so this falsifier is the belt for the NON-terminal
 * refund/partial signal.
 */
export interface PaymentRefundRead {
  readonly orderId: string;
  readonly refunded: boolean;
  readonly refundedAmountCentavos: number;
  /** The refund-bearing payment's status (for audit); "" when none fired. */
  readonly status: string;
}

/**
 * PAYMENT_STATUS falsifier — a chargeback/dispute on the order's payment(s).
 * `disputed` iff any payment for the order has status `disputed` (the platform's
 * chargeback signal — a dispute the customer/bank raised; it later resolves to
 * `paid` if won or `refunded` if lost). A present dispute contradicts a confident
 * `pago` → demote to UNKNOWN.
 */
export interface PaymentChargebackRead {
  readonly orderId: string;
  readonly disputed: boolean;
  /** The disputed payment's status (for audit); "" when none fired. */
  readonly status: string;
}

// REVIEW FIX (PRs #275/#277 adversarial review, 2026-07-17): the order_cancelled /
// reservation_cancelled falsifier READS shipped in #277 were REMOVED as a
// shared-read tautology — they derived from the SAME memoized row (same instant,
// same freshness) as the base ORDER_FULFILLMENT_STAGE / RESERVATION_STATUS reads,
// so they could never catch staleness the base didn't already see, while actively
// demoting every TRUTHFUL "cancelado/cancelada" render to UNKNOWN. The registry
// falsifier declarations remain (deliberately unread — see claim-registry.ts);
// rendering cancellation as a first-class claim is BKL-160. The refund/chargeback
// falsifiers below are KEPT: they carry value-distinct signals (a refund on a
// still-'paid' row) the base read does not assert.

/**
 * CART_CONTENTS (BKL-139 / FE-D03) — the authenticated customer's IN-PROGRESS cart,
 * as a DETERMINISTICALLY PRE-COMPOSED summary scalar (the STORE_HOURS_FOR_DATE
 * `hoursText` precedent for a list-shaped read under the single-scalar kernel).
 *
 *   - `itemsSummaryText` — the pt-BR summary ("2x Costela, 1x Farofa — total
 *     R$123,00"). Composed IN CODE from item titles/quantities + the cart total in
 *     INTEGER CENTAVOS (Hard Rule 2); NEVER model-authored (FE-D04 / BKL-149). Empty
 *     string when the cart has no active items.
 *   - `hasItems` — the cart has ≥1 active, non-completed line (present-vs-absent
 *     discriminant: the investigator records `cart_contents` PRESENT only when `true`,
 *     else leaves it ABSENT → honest UNKNOWN). A cleared/checked-out cart
 *     (`completed_at` set) has NO active items ⇒ `hasItems: false`.
 *
 * NOTE (cart_cleared falsifier): the registry DECLARES `cart_cleared` (so CART_CONTENTS
 * escapes the W6 UNKNOWN-only cap), but there is NO `cleared` field here and no wired
 * read — a same-cart-row "cleared" signal is tautological AND inert (a cleared cart
 * already yields `hasItems: false` ⇒ `cart_contents` ABSENT ⇒ nothing to demote). This
 * mirrors the deliberately-unread `order_cancelled` / `reservation_cancelled` falsifiers.
 */
export interface CartContentsRead {
  readonly itemsSummaryText: string;
  readonly hasItems: boolean;
}

/**
 * ORDER_HISTORY / PAYMENT_HISTORY (FE-D03 slice C) — the authenticated customer's
 * owner-scoped LIST read, as a DETERMINISTICALLY PRE-COMPOSED bounded most-recent-N
 * summary scalar (the CART_CONTENTS serialized-scalar idiom for a list-shaped read).
 *
 *   - `historySummaryText` — the pt-BR summary ("Pedido #1042 (entregue, R$89,00), …
 *     — mostrando os N mais recentes"). Composed IN CODE from the owner-scoped
 *     listByCustomer rows: display numbers + INTEGER-CENTAVOS totals (Hard Rule 2) +
 *     pt-BR status labels; NEVER model-authored. Empty string when the customer has no
 *     rows.
 *   - `hasHistory` — the customer has ≥1 row (present-vs-absent discriminant: the
 *     investigator records the key PRESENT only when `true`, else ABSENT → honest
 *     UNKNOWN, mirroring the CART_CONTENTS empty-cart path).
 */
export interface HistoryRead {
  readonly historySummaryText: string;
  readonly hasHistory: boolean;
}

/**
 * The first-party read backend for the Trustworthiness-Triad scope. Every
 * resource read is OWNER-SCOPED to `customerId`; a cross-owner / absent resource
 * resolves to `null` (the caller records that as a fail-closed read error — Inv 7
 * — never a fabricated value). Injectable so the gatherer / tests can stub the
 * backends without a DB.
 */
export interface TriadReadBackend {
  /** First-party schedule signal (STORE_OPEN_NOW / STORE_HOURS). Public; no owner. */
  readSchedule(): Promise<ScheduleRead>;
  /**
   * STORE_OPEN_NOW FALSIFIER read (F1): TODAY's {@link ScheduleOverrideRead}, or
   * `null` when no override exists for the turn's date (absence — the falsifier
   * does NOT fire). Public first-party config; no owner.
   */
  readScheduleOverride(): Promise<ScheduleOverrideRead | null>;
  /**
   * First-party STORE_HOURS read (BKL-121): TODAY's operating-hours
   * {@link StoreHoursRead}. Public first-party config; no owner. THROWS (rejects)
   * when the schedule is unavailable, so the investigator records a fail-closed read
   * ERROR (Inv 7) — never a fabricated hours string.
   */
  readStoreHours(): Promise<StoreHoursRead>;
  /**
   * STORE_HOURS FALSIFIER read (BKL-121 / D1): TODAY's {@link HolidayRead}, or `null`
   * when no holiday falls on the turn's date (absence — the falsifier does NOT fire).
   * Public first-party config; no owner.
   */
  readHoliday(): Promise<HolidayRead | null>;
  /**
   * BKL-138 — the DAY-SPECIFIC hours read for a SPECIFIC ISO date (STORE_HOURS_FOR_DATE):
   * the QUERIED day's {@link StoreHoursForDateRead}. Public first-party config; no owner.
   * THROWS (rejects) when the schedule is unavailable, so the investigator records a
   * fail-closed read ERROR (Inv 7) — never a fabricated hours string.
   */
  readHoursForDate(isoDate: string): Promise<StoreHoursForDateRead>;
  /**
   * BKL-138 STORE_HOURS_FOR_DATE FALSIFIER read — the holiday ON the QUERIED date, or
   * `null` when none (absence → the falsifier does NOT fire). Read for the SPECIFIC
   * `isoDate`, NOT today, so TODAY's holiday can never poison a future-date answer.
   */
  readHolidayForDate(isoDate: string): Promise<HolidayRead | null>;
  /**
   * BKL-138 STORE_HOURS_FOR_DATE FALSIFIER read — the ScheduleOverride ON the QUERIED
   * date, or `null` when none (absence → the falsifier does NOT fire). Read for the
   * SPECIFIC `isoDate`, NOT today.
   */
  readScheduleOverrideForDate(isoDate: string): Promise<ScheduleOverrideRead | null>;
  /** Owner-scoped ORDER_FULFILLMENT_STAGE read; `null` when not owned / absent. */
  readOrderFulfillment(
    orderId: string,
    customerId: string,
  ): Promise<OrderFulfillmentRead | null>;
  /** Owner-scoped PAYMENT_STATUS read (IDOR-closed); `null` when not owned / absent. */
  readPaymentStatus(
    orderId: string,
    customerId: string,
  ): Promise<PaymentStatusRead | null>;
  /** Owner-scoped reservation read; `null` when not owned / absent. */
  readReservation(
    reservationId: string,
    customerId: string,
  ): Promise<ReservationRead | null>;
  /**
   * BKL-006 PAYMENT_STATUS falsifier — the owner-scoped refund read (IDOR-closed via
   * the same order gate as {@link readPaymentStatus}). Returns a
   * {@link PaymentRefundRead} whose `refunded` boolean says whether a refund fired;
   * `null` when the order is NOT owned / absent (the caller records that as a
   * fail-closed read error — never a fabricated "no refund").
   */
  readPaymentRefund(
    orderId: string,
    customerId: string,
  ): Promise<PaymentRefundRead | null>;
  /**
   * BKL-006 PAYMENT_STATUS falsifier — the owner-scoped chargeback/dispute read
   * (IDOR-closed via the same order gate). `disputed` says whether a dispute fired;
   * `null` when not owned / absent.
   */
  readPaymentChargeback(
    orderId: string,
    customerId: string,
  ): Promise<PaymentChargebackRead | null>;
  /**
   * BKL-139 CART_CONTENTS — the authenticated customer's IN-PROGRESS cart. Resolved
   * SERVER-SIDE from the session's `conversationId` (never a model cart id →
   * IDOR-safe by session-scoping). `null` ONLY on an UNAVAILABLE read (Redis/Medusa
   * error → fail-closed ERROR); an empty/absent cart returns `{ hasItems: false }`.
   */
  readCartContents(
    conversationId: string,
    customerId: string,
  ): Promise<CartContentsRead | null>;
  /**
   * FE-D03 slice C ORDER_HISTORY — the authenticated customer's owner-scoped order
   * list (`listByCustomer`, most-recent-first, bounded). `hasHistory: false` when the
   * customer has no orders. A DB read failure REJECTS (recorded as a fail-closed
   * ERROR, Inv 7) — there is no cross-owner case (the key is the customerId itself).
   */
  readOrderHistory(customerId: string): Promise<HistoryRead>;
  /**
   * FE-D03 slice C PAYMENT_HISTORY — the authenticated customer's owner-scoped payment
   * list (`listByCustomer`, most-recent-first, bounded; billing HISTORY incl. terminal
   * rows). `hasHistory: false` when none; a DB failure REJECTS → fail-closed ERROR.
   */
  readPaymentHistory(customerId: string): Promise<HistoryRead>;
  /**
   * Enumerate the AUTHENTICATED customer's OWN, RELEVANT (non-terminal) order ids
   * (FIX 2 — owner-scoped subject resolution; the BUG-2 close). OWNER-SCOPED by
   * construction: the underlying `listByCustomer(customerId)` filters on
   * `customerId`, so only the customer's own orders are ever returned — no
   * model/session id is involved. "Relevant" = a non-terminal fulfillment stage
   * (an order a customer would ask the status of), so a long delivered/canceled
   * history does not force a perpetual CLARIFY. Returns `[]` for a customer with no
   * active orders.
   */
  listActiveOrderIds(customerId: string): Promise<string[]>;
  /**
   * FE-T17b — the RESERVATION mirror of {@link listActiveOrderIds} (live-disproof
   * follow-up; PR #249's investigator wiring closes the discovery gap that made
   * RESERVATION_STATUS structurally unreachable — see the investigator's FIX-2
   * discovery-fallback union for the mechanism). Enumerate the AUTHENTICATED
   * customer's OWN, RELEVANT (non-terminal) reservation ids. OWNER-SCOPED by
   * construction: the underlying `listByCustomer(customerId)` filters on
   * `customerId`, so only the customer's own reservations are ever returned —
   * never a model/session id. "Relevant" = a non-terminal reservation status (one
   * the customer would ask the status of — pending/confirmed/seated), so a long
   * completed/cancelled/no-show history does not force a perpetual CLARIFY.
   * Returns `[]` for a customer with no active reservations.
   */
  listActiveReservationIds(customerId: string): Promise<string[]>;
  /**
   * Count the AUTHENTICATED customer's OWN payments (BKL-079 — the PAYMENT mirror of
   * {@link listActiveOrderIds}; the provable-empty enumeration count). OWNER-SCOPED
   * by construction: the underlying `countByCustomer(customerId)` counts via the
   * `where: { order: { customerId } }` join, so ONLY the customer's own payments are
   * ever counted — no model/session id is involved. Returns `0` for a customer with
   * no payment rows. The count is a pure SIGNAL for the provable-empty seam (Rule
   * B′); it drives no read.
   *
   * SOUNDNESS NOTE (load-bearing): `countByCustomer` counts ALL of the customer's
   * payments, INCLUDING terminal (settled/refunded/failed) rows — it is NOT
   * active-only (see payment-query.service.ts `countByCustomer`). That makes
   * `count === 0` a STRICTER provable-empty witness than an active-only count would
   * be: zero payments TOTAL ⟹ certainly zero ACTIVE payments (active ⊆ all), so a
   * count-0 DROP is conservative and SOUND — it can only UNDER-fire (a customer with
   * only terminal payments keeps the companion → honest UNKNOWN), never over-drop.
   * See `activeResourcesFromLedger` Rule B′ (ibatexas-claims-kernel-deps.ts).
   */
  countActivePayments(customerId: string): Promise<number>;
}

/**
 * The non-terminal ("active") fulfillment stages — an order in one of these is a
 * RELEVANT owned order for FIX 2 enumeration (the kind a customer asks the status
 * of). `delivered` / `canceled` are TERMINAL and excluded. Mirrors the
 * `OrderFulfillmentStatus` enum (packages/domain/prisma/schema.prisma).
 */
export const ACTIVE_FULFILLMENT_STAGES: ReadonlySet<string> = new Set<string>([
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "in_delivery",
]);

/**
 * FE-T17b — the non-terminal ("active") reservation statuses, the RESERVATION
 * mirror of {@link ACTIVE_FULFILLMENT_STAGES}. A reservation in one of these is a
 * RELEVANT owned reservation for the discovery-fallback enumeration (the kind a
 * customer asks the status of — one that hasn't concluded yet): `pending`
 * (awaiting confirmation), `confirmed` (upcoming), `seated` (currently dining).
 * `completed` / `cancelled` / `no_show` are TERMINAL/historical and excluded —
 * mirroring why orders exclude `delivered` / `canceled`: a customer asking "what
 * is my reservation" almost always means an upcoming or in-progress one, and
 * including a long completed/cancelled/no-show history would force ambiguity
 * (CLARIFY) rather than the honest answer for the one that still matters. Mirrors
 * the `ReservationStatus` enum (@ibatexas/types · packages/domain/prisma).
 */
const ACTIVE_RESERVATION_STATUSES: ReadonlySet<string> = new Set<string>([
  "pending",
  "confirmed",
  "seated",
]);

/** Today's local date as "YYYY-MM-DD" in `tz` (mirrors schedule-helpers' private
 *  `getLocalDateStr`; en-CA yields YYYY-MM-DD). The override is keyed by date. */
function localDateStr(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

// ── BKL-139 CART_CONTENTS — the DETERMINISTIC money-summary composer ────────────
//
// Composes the cart summary IN CODE from item titles/quantities + the cart total in
// INTEGER CENTAVOS (Hard Rule 2), so no model-authored digit can ever reach the
// rendered proposition (FE-D04 10x-slip class / BKL-149). PURE — no float money math
// (the reais/centavos split is integer-only).

/** A raw Medusa `/store/carts/:id` line the summary reads (title + quantity). */
interface RawCartLine {
  readonly title?: string;
  readonly quantity?: number;
}
interface RawCart {
  readonly items?: ReadonlyArray<RawCartLine>;
  readonly total?: number;
  readonly completed_at?: string | null;
}

/** Format INTEGER centavos as pt-BR "R$123,00" — integer-only (no float money).
 *  Exported for the BKL-139 composer unit test (no model-authored digit). */
export function formatCentavosBRL(centavos: number): string {
  const reais = Math.trunc(centavos / 100);
  const cents = Math.abs(centavos % 100);
  return `R$${reais},${String(cents).padStart(2, "0")}`;
}

/**
 * Compose the pt-BR cart summary ("2x Costela, 1x Farofa — total R$123,00") from the
 * raw Medusa cart lines + total. The total is formatted from INTEGER CENTAVOS
 * (reais→centavos at the boundary); item titles are first-party Medusa data, never
 * model text. PURE. Exported for the BKL-139 composer unit test.
 */
export function composeCartItemsSummary(items: ReadonlyArray<RawCartLine>, totalCentavos: number): string {
  const parts = items
    .filter((i) => (i.quantity ?? 0) > 0 && typeof i.title === "string" && i.title.trim() !== "")
    .map((i) => `${i.quantity}x ${i.title}`);
  const itemsPart = parts.join(", ");
  return `${itemsPart} — total ${formatCentavosBRL(totalCentavos)}`;
}

// ── FE-D03 slice C — the DETERMINISTIC ORDER_HISTORY / PAYMENT_HISTORY composers ─────
//
// A list-shaped read rendered as ONE C6 scalar (the CART_CONTENTS idiom): compose a
// bounded most-recent-N pt-BR summary IN CODE from the owner-scoped listByCustomer rows
// — display numbers + INTEGER-CENTAVOS money (Hard Rule 2) + the canonical pt-BR status
// labels — so no model-authored digit or label reaches the rendered proposition. PURE.

/** The bounded most-recent-N window a history summary renders (the listByCustomer
 *  calls are ALSO bounded — this caps the RENDERED lines). */
export const HISTORY_SUMMARY_LIMIT = 5;

/** One order row the ORDER_HISTORY summary reads (owner-scoped OrderProjection). */
interface OrderHistoryRow {
  readonly displayId: number;
  readonly fulfillmentStatus: string;
  readonly totalInCentavos: number;
}
/** One payment row the PAYMENT_HISTORY summary reads (owner-scoped Payment). */
interface PaymentHistoryRow {
  readonly amountInCentavos: number;
  readonly method: string;
  readonly status: string;
}

/** pt-BR fulfillment label for a status string (canonical map; falls back to the raw
 *  status rather than inventing one — never a fabricated label). */
function orderStatusLabel(status: string): string {
  return (ORDER_STATUS_LABELS_PT as Record<string, string>)[status] ?? status;
}
function paymentStatusLabel(status: string): string {
  return (PAYMENT_STATUS_LABELS_PT as Record<string, string>)[status] ?? status;
}

/** " — mostrando os N mais recentes" / " — mostrando o mais recente" suffix. */
function historyTailSuffix(shown: number): string {
  return shown === 1
    ? " — mostrando o mais recente"
    : ` — mostrando os ${shown} mais recentes`;
}

/**
 * Compose the pt-BR ORDER history summary ("Pedido #1042 (entregue, R$89,00), Pedido
 * #1039 (preparando, R$123,00) — mostrando os 2 mais recentes") from the owner-scoped
 * order rows (already most-recent-first). Bounded to {@link HISTORY_SUMMARY_LIMIT}.
 * Money from INTEGER CENTAVOS; labels from the canonical map. PURE. Exported for the
 * composer unit test.
 */
export function composeOrderHistorySummary(rows: ReadonlyArray<OrderHistoryRow>): string {
  const shown = rows.slice(0, HISTORY_SUMMARY_LIMIT);
  const parts = shown.map(
    (o) =>
      `Pedido #${o.displayId} (${orderStatusLabel(o.fulfillmentStatus)}, ${formatCentavosBRL(o.totalInCentavos)})`,
  );
  return `${parts.join(", ")}${historyTailSuffix(shown.length)}`;
}

/**
 * Compose the pt-BR PAYMENT history summary ("Pagamento de R$89,00 (pix, pago),
 * Pagamento de R$40,00 (pix, reembolsado) — mostrando os 2 mais recentes") from the
 * owner-scoped payment rows (already most-recent-first). Bounded, integer-centavos,
 * canonical labels. PURE. Exported for the composer unit test.
 */
export function composePaymentHistorySummary(
  rows: ReadonlyArray<PaymentHistoryRow>,
): string {
  const shown = rows.slice(0, HISTORY_SUMMARY_LIMIT);
  const parts = shown.map(
    (p) =>
      `Pagamento de ${formatCentavosBRL(p.amountInCentavos)} (${p.method}, ${paymentStatusLabel(p.status)})`,
  );
  return `${parts.join(", ")}${historyTailSuffix(shown.length)}`;
}

export interface DomainTriadReadBackendDeps {
  /** Override the schedule read (testing). Defaults to the built-in first-party
   *  read: the (per-turn memoized) read-through schedule + env tz →
   *  {@link getScheduleSignal}. */
  readonly schedule?: () => Promise<ScheduleRead>;
  /** Override the schedule-override read (testing). Defaults to the built-in
   *  first-party read: TODAY's ScheduleOverride matched on the turn's tz date. The
   *  open/closed signal and this falsifier share ONE {@link loadSchedule} per turn
   *  (see the factory's per-turn memo). `null` when no override exists today. */
  readonly scheduleOverride?: () => Promise<ScheduleOverrideRead | null>;
  /** Override the STORE_HOURS read (testing). Defaults to the built-in first-party
   *  read: today's operating-hours string from the (per-turn memoized) schedule via
   *  {@link getTodayHoursText}. Rejects when the schedule is unavailable (Inv 7). */
  readonly storeHours?: () => Promise<StoreHoursRead>;
  /** Override the holiday-falsifier read (testing). Defaults to the built-in
   *  first-party read: TODAY's holiday matched on the turn's tz date; `null` when
   *  none. Shares the SAME per-turn {@link loadSchedule} memo. */
  readonly holiday?: () => Promise<HolidayRead | null>;
  /** BKL-138 — override the DAY-SPECIFIC hours read (testing). Defaults to the built-in
   *  first-party read: the queried date's hours from the (per-turn memoized) schedule
   *  via {@link getHoursTextForDate}. Rejects when the schedule is unavailable (Inv 7). */
  readonly hoursForDate?: (isoDate: string) => Promise<StoreHoursForDateRead>;
  /** BKL-138 — override the DAY-SPECIFIC holiday-falsifier read (testing). Defaults to
   *  the built-in first-party read: the holiday ON `isoDate`; `null` when none. */
  readonly holidayForDate?: (isoDate: string) => Promise<HolidayRead | null>;
  /** BKL-138 — override the DAY-SPECIFIC override-falsifier read (testing). Defaults to
   *  the built-in first-party read: the ScheduleOverride ON `isoDate`; `null` when none. */
  readonly scheduleOverrideForDate?: (
    isoDate: string,
  ) => Promise<ScheduleOverrideRead | null>;
}

/**
 * Build the production {@link TriadReadBackend} over the `@ibatexas/domain` query
 * services. Owner-scoping is enforced on every resource read (see module header).
 *
 * PER-TURN by construction — a FRESH instance is built for each turn (see
 * {@link createFirstPartyTurnReads}), so its in-turn memoization is NOT a
 * cross-turn cache. Two identical reads that the same turn would otherwise run
 * twice now run ONCE (single-flight — safe under the now-parallel investigator):
 *   - the OWNER-SCOPED order `getById` shared by ORDER_FULFILLMENT_STAGE +
 *     PAYMENT_STATUS (both gate on the identical `getById(orderId,{customerId})`);
 *   - the read-through schedule load shared by the open/closed signal + the
 *     STORE_OPEN_NOW override falsifier.
 */
export function createDomainTriadReadBackend(
  deps: DomainTriadReadBackendDeps = {},
): TriadReadBackend {
  const tz = process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo";

  // Per-turn memo: the Redis read-through schedule load runs ONCE even though BOTH
  // the open/closed signal AND the STORE_OPEN_NOW override falsifier derive from
  // it. Caches the in-flight PROMISE, so concurrent reads share a single load.
  let scheduleP: ReturnType<typeof loadSchedule> | undefined;
  const loadScheduleOnce = (): ReturnType<typeof loadSchedule> =>
    (scheduleP ??= loadSchedule());

  const readSchedule =
    deps.schedule ?? (async () => getScheduleSignal(await loadScheduleOnce(), tz));
  const readScheduleOverride =
    deps.scheduleOverride ??
    (async (): Promise<ScheduleOverrideRead | null> => {
      const today = localDateStr(tz);
      return (await loadScheduleOnce()).overrides.find((o) => o.date === today) ?? null;
    });

  // STORE_HOURS (BKL-121) — today's operating-hours string, derived from the SAME
  // per-turn schedule memo. `getTodayHoursText` reads ONLY the real weekly window
  // fields (never invents an hour, BKL-026). A `null` result (schedule unavailable)
  // THROWS → the investigator records a fail-closed read ERROR (Inv 7), never a
  // fabricated hours string.
  const readStoreHours =
    deps.storeHours ??
    (async (): Promise<StoreHoursRead> => {
      const hoursText = getTodayHoursText(await loadScheduleOnce(), tz);
      if (hoursText === null) {
        throw new Error("store_hours unavailable: schedule not loaded this turn");
      }
      return { hoursText };
    });

  // STORE_HOURS FALSIFIER (BKL-121 / D1) — TODAY's holiday (present iff today is a
  // holiday), matched on the turn's tz date from the SAME per-turn schedule memo.
  // `null` (absence) → the falsifier does NOT fire.
  const readHoliday =
    deps.holiday ??
    (async (): Promise<HolidayRead | null> => {
      const today = localDateStr(tz);
      return (await loadScheduleOnce()).holidays.find((h) => h.date === today) ?? null;
    });

  // BKL-138 STORE_HOURS_FOR_DATE — the QUERIED date's hours + its per-date falsifiers,
  // all derived from the SAME per-turn schedule memo and matched on the EXPLICIT
  // `isoDate` (never today). `getHoursTextForDate` reads ONLY the real weekly window
  // (never invents an hour, BKL-026); a `null` (schedule unavailable) THROWS → the
  // investigator records a fail-closed read ERROR (Inv 7). The holiday/override reads
  // resolve to `null` (absence → the falsifier does not fire) when the queried date
  // carries none — so TODAY's holiday can never demote a clean future-date answer.
  const readHoursForDate =
    deps.hoursForDate ??
    (async (isoDate: string): Promise<StoreHoursForDateRead> => {
      const hoursText = getHoursTextForDate(await loadScheduleOnce(), tz, isoDate);
      if (hoursText === null) {
        throw new Error(
          `store_hours_for_date unavailable: schedule not loaded this turn (${isoDate})`,
        );
      }
      return { hoursText };
    });
  const readHolidayForDate =
    deps.holidayForDate ??
    (async (isoDate: string): Promise<HolidayRead | null> =>
      (await loadScheduleOnce()).holidays.find((h) => h.date === isoDate) ?? null);
  const readScheduleOverrideForDate =
    deps.scheduleOverrideForDate ??
    (async (isoDate: string): Promise<ScheduleOverrideRead | null> =>
      (await loadScheduleOnce()).overrides.find((o) => o.date === isoDate) ?? null);

  // Per-turn memo of the OWNER-SCOPED order read: ORDER_FULFILLMENT_STAGE and
  // PAYMENT_STATUS both gate on the IDENTICAL getById(orderId, { customerId }), so
  // run it ONCE per (owner, order) this turn. The cache key is OWNER-SCOPED and
  // encodes BOTH ids unambiguously (JSON tuple — no delimiter can be forged into a
  // collision), so a cross-owner / forged orderId can NEVER reuse another
  // customer's cached order: the IDOR close (Inv 2/13) is preserved. Caches the
  // PROMISE (single in-flight read under the parallel investigator).
  const orderReads = new Map<
    string,
    ReturnType<ReturnType<typeof createOrderQueryService>["getById"]>
  >();
  const readOwnerScopedOrderOnce = (orderId: string, customerId: string) => {
    const cacheKey = JSON.stringify([customerId, orderId]);
    let p = orderReads.get(cacheKey);
    if (p === undefined) {
      p = createOrderQueryService().getById(orderId, { customerId });
      orderReads.set(cacheKey, p);
    }
    return p;
  };

  // BKL-006 — the refund/chargeback falsifier reads are IDOR-gated through the
  // SAME owner-scoped order memo as the base PAYMENT_STATUS read: a cross-owner /
  // absent order returns `null` (→ fail-closed read error at the investigator)
  // and the payment table is NEVER queried. REVIEW FIX (BKL-159, 2026-07-17):
  // the shared listByOrderId page scan (a $transaction with an unused count,
  // truncated to the most-recent 20 rows) was replaced by predicate-shaped
  // findFirst probes in the domain service — complete by construction (a
  // where-clause sees every row) and cheaper (no transaction, no count).

  // Per-turn memo of the OWNER-SCOPED reservation read. `getById` is
  // owner-scoped (asserts ownership, throws on a cross-owner id) → caught →
  // `null` (refused), never another customer's reservation. Caches the
  // in-flight PROMISE (single-flight under the parallel investigator).
  const reservationReads = new Map<
    string,
    Promise<
      | Awaited<ReturnType<ReturnType<typeof createReservationService>["getById"]>>
      | null
    >
  >();
  const readOwnerScopedReservationOnce = (
    reservationId: string,
    customerId: string,
  ) => {
    const cacheKey = JSON.stringify([customerId, reservationId]);
    let p = reservationReads.get(cacheKey);
    if (p === undefined) {
      p = createReservationService()
        .getById(reservationId, customerId)
        .catch(() => null);
      reservationReads.set(cacheKey, p);
    }
    return p;
  };

  // BKL-139 — per-turn memo of the CART read (single-flight under the parallel
  // investigator; the cart_contents read + the active_cart marker share it, ONE Medusa
  // fetch per turn). Caches the in-flight PROMISE. `null` = the read was UNAVAILABLE
  // (Redis/Medusa error); a resolved value carries the `hasItems` discriminant.
  const cartReads = new Map<string, Promise<CartContentsRead | null>>();
  const readCartContentsOnce = (conversationId: string, customerId: string) => {
    const cacheKey = JSON.stringify([customerId, conversationId]);
    let p = cartReads.get(cacheKey);
    if (p === undefined) {
      p = (async (): Promise<CartContentsRead | null> => {
        // A2 (IDOR) — resolve the session's OWN active cart id through
        // `active-cart-resolution.ts` (the ONE owner of that lookup, shared with
        // resolve-and-assemble / get_cart), NEVER a model-supplied cart id.
        //
        // THIS SITE IS THE REASON THE RESOLUTION IS A TRICHOTOMY. A Redis failure is
        // an UNAVAILABLE read → null → fail-closed ERROR (Inv 7), while no active
        // cart is a genuine ABSENCE (honest UNKNOWN) → `hasItems: false`. Collapsing
        // them would render "seu carrinho está vazio" at a customer whose cart we
        // simply could not read, which is a confident wrong answer.
        const resolution = await resolveActiveCart({ sessionId: conversationId });
        if (resolution.outcome === "unavailable") return null;
        if (resolution.outcome === "absent") return { itemsSummaryText: "", hasItems: false };
        const cartId = resolution.cartId;
        // Fetch ONLY the session-resolved cart. A Medusa failure is UNAVAILABLE → null.
        let cart: RawCart | null;
        try {
          const data = (await medusaStore(`/store/carts/${cartId}`)) as { cart?: RawCart };
          cart = data.cart ?? null;
        } catch {
          return null;
        }
        if (cart === null) return { itemsSummaryText: "", hasItems: false };
        // A cleared/checked-out cart (`completed_at` set) has NO active items — so it
        // resolves `hasItems: false` (ABSENT → honest UNKNOWN), never a stale summary.
        const cleared = cart.completed_at != null;
        const items = cart.items ?? [];
        const hasItems = !cleared && items.length > 0;
        const totalCentavos = reaisToCentavos(cart.total ?? 0);
        return {
          itemsSummaryText: hasItems ? composeCartItemsSummary(items, totalCentavos) : "",
          hasItems,
        };
      })();
      cartReads.set(cacheKey, p);
    }
    return p;
  };

  return {
    readSchedule,
    readScheduleOverride,
    readStoreHours,
    readHoliday,
    readHoursForDate,
    readHolidayForDate,
    readScheduleOverrideForDate,

    async readOrderFulfillment(orderId, customerId) {
      // Owner-scoped (SDD §N P0-3, Inv 2): getById with `{ customerId }` returns
      // the projection ONLY when the customer owns it; the post-check is
      // defense-in-depth (mirrors loadOrderCtx). Shares the per-turn order memo.
      const order = await readOwnerScopedOrderOnce(orderId, customerId);
      if (order === null || order.customerId !== customerId) return null;
      return {
        orderId,
        displayId: order.displayId,
        fulfillmentStatus:
          order.fulfillmentStatus === null ? null : String(order.fulfillmentStatus),
      };
    },

    async readPaymentStatus(orderId, customerId) {
      // IDOR close: gate the (orderId-only) payment read on the OWNER-SCOPED order
      // read. Ownership flows through the order (same gate as loadPaymentCtx, and
      // the SAME per-turn memoized read `readOrderFulfillment` uses) — a cross-owner
      // orderId never reaches getActiveByOrderId.
      const order = await readOwnerScopedOrderOnce(orderId, customerId);
      if (order === null || order.customerId !== customerId) return null;
      const active = await createPaymentQueryService().getActiveByOrderId(orderId);
      if (active === null || active.status === null) return null;
      return {
        orderId,
        displayId: order.displayId,
        status: String(active.status),
        method: active.method ?? null,
      };
    },

    async readReservation(reservationId, customerId) {
      // getById is owner-scoped: it asserts ownership and throws on a cross-owner
      // id — caught → `null` (refused), never another customer's reservation.
      // Shares the per-turn reservation memo with the cancellation falsifier.
      const r = await readOwnerScopedReservationOnce(reservationId, customerId);
      if (r === null) return null;
      const status = String(r.status);
      return {
        reservationId,
        status,
        partySize: r.partySize,
        // BKL-185 — the C6-bound enriched scalar (bare `status` when the slot
        // detail is missing → byte-identical to the pre-enrichment render).
        statusLine: composeReservationStatusLine({
          status,
          partySize: r.partySize,
          isoDate: r.timeSlot?.date,
          startTime: r.timeSlot?.startTime,
        }),
      };
    },

    async readPaymentRefund(orderId, customerId) {
      // BKL-006 — owner-scoped refund falsifier. Same IDOR gate as readPaymentStatus
      // (the payment scan runs ONLY when the order is owned); `null` = not owned →
      // the investigator records a fail-closed read error, never a fabricated "no
      // refund". A refund FIRES iff any payment for the order has a refunded amount or
      // a refund status. RATIFIED (BKL-006): a PARTIAL refund fires — demote-only to
      // UNKNOWN is safe (see PaymentRefundRead). A `refunded: false` result leaves the
      // ledger key ABSENT at the investigator (the falsifier does not fire).
      const order = await readOwnerScopedOrderOnce(orderId, customerId);
      if (order === null || order.customerId !== customerId) return null;
      const refundBearing =
        await createPaymentQueryService().findRefundBearingByOrderId(orderId);
      return {
        orderId,
        refunded: refundBearing !== null,
        refundedAmountCentavos: refundBearing?.refundedAmountCentavos ?? 0,
        status: refundBearing === null ? "" : String(refundBearing.status),
      };
    },

    async readPaymentChargeback(orderId, customerId) {
      // BKL-006 — owner-scoped chargeback falsifier. Same IDOR gate as the refund
      // read; `null` = not owned → fail-closed read error. FIRES iff any payment
      // for the order is `disputed` (the platform's chargeback signal).
      const order = await readOwnerScopedOrderOnce(orderId, customerId);
      if (order === null || order.customerId !== customerId) return null;
      const disputed =
        await createPaymentQueryService().findDisputedByOrderId(orderId);
      return {
        orderId,
        disputed: disputed !== null,
        status: disputed === null ? "" : String(disputed.status),
      };
    },

    async readCartContents(conversationId, customerId) {
      // BKL-139 — the session-scoped cart read (per-turn memoized). IDOR-safe by
      // construction: the cart is resolved from the session's conversationId, never a
      // model id.
      return readCartContentsOnce(conversationId, customerId);
    },

    async readOrderHistory(customerId) {
      // FE-D03 slice C — OWNER-SCOPED order list (listByCustomer filters on customerId,
      // most-recent-first). The summary is composed deterministically in code. A DB
      // failure REJECTS → the investigator records a fail-closed ERROR (Inv 7).
      const { orders } = await createOrderQueryService().listByCustomer(customerId, {
        limit: HISTORY_SUMMARY_LIMIT,
      });
      const rows: OrderHistoryRow[] = orders.map((o) => ({
        displayId: o.displayId,
        fulfillmentStatus: String(o.fulfillmentStatus),
        totalInCentavos: o.totalInCentavos,
      }));
      return {
        hasHistory: rows.length > 0,
        historySummaryText: rows.length > 0 ? composeOrderHistorySummary(rows) : "",
      };
    },

    async readPaymentHistory(customerId) {
      // FE-D03 slice C — OWNER-SCOPED payment list (listByCustomer joins on
      // order.customerId, most-recent-first; billing HISTORY incl. terminal rows). A DB
      // failure REJECTS → fail-closed ERROR.
      const payments = await createPaymentQueryService().listByCustomer(customerId, {
        limit: HISTORY_SUMMARY_LIMIT,
      });
      const rows: PaymentHistoryRow[] = payments.map((p) => ({
        amountInCentavos: p.amountInCentavos,
        method: String(p.method),
        status: String(p.status),
      }));
      return {
        hasHistory: rows.length > 0,
        historySummaryText: rows.length > 0 ? composePaymentHistorySummary(rows) : "",
      };
    },

    async listActiveOrderIds(customerId) {
      // OWNER-SCOPED (FIX 2): `listByCustomer` filters on `customerId`, so this only
      // ever returns the AUTHENTICATED customer's own orders — never a model/session
      // id, never another owner's order. Bounded + filtered to non-terminal stages.
      const { orders } = await createOrderQueryService().listByCustomer(customerId, {
        limit: 20,
      });
      return orders
        .filter((o) => ACTIVE_FULFILLMENT_STAGES.has(String(o.fulfillmentStatus)))
        .map((o) => o.id);
    },

    async listActiveReservationIds(customerId) {
      // OWNER-SCOPED (FE-T17b): `listByCustomer` filters on `customerId`, so this
      // only ever returns the AUTHENTICATED customer's own reservations — never a
      // model/session id, never another owner's reservation.
      //
      // REVIEW FIX (pagination-burying) — the status filter MUST be applied
      // SERVER-SIDE, not only client-side after the fetch. `listByCustomer`
      // orders `timeSlot.date` DESC (farthest-future FIRST), so with only a
      // client-side filter, a customer with >20 future-dated NON-active
      // reservations (e.g. cancelled) sorts ahead of a near-future ACTIVE one —
      // the active row falls off the `take: 20` page before the client-side
      // filter ever sees it, producing a silent false abstain. Passing
      // `status: [...ACTIVE_RESERVATION_STATUSES]` makes the DB apply the status
      // filter BEFORE `take`, so the limit is spent only on rows that could
      // actually be relevant. The client-side filter below is kept as
      // belt-and-braces (defense in depth — never trust a single layer to
      // enforce "active-only"), not as the primary filtering mechanism.
      const { reservations } = await createReservationService().listByCustomer(
        customerId,
        { limit: 20, status: [...ACTIVE_RESERVATION_STATUSES] },
      );
      return reservations
        .filter((r) => ACTIVE_RESERVATION_STATUSES.has(String(r.status)))
        .map((r) => r.id);
    },

    async countActivePayments(customerId) {
      // OWNER-SCOPED (BKL-079): countByCustomer counts via `where: { order: {
      // customerId } }`, so this only ever counts the AUTHENTICATED customer's own
      // payments — never a model/session id. See the interface SOUNDNESS NOTE: it
      // counts ALL (incl. terminal) payments, which makes count===0 a STRICTER
      // (conservative, sound) provable-empty witness for the seam's Rule B′.
      return createPaymentQueryService().countByCustomer(customerId);
    },
  };
}

// ── Pure resource-id extraction ───────────────────────────────────────────────

/** The owner-scoped resource ids referenced by this turn's resolved plan. */
export interface TurnResourceIds {
  readonly orderIds: readonly string[];
  readonly reservationIds: readonly string[];
}

function stringField(obj: unknown, key: string): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Extract the owner-scoped resource ids (orderId / reservationId) referenced by
 * this turn — from the RESOLVED plan envelopes' payloads and the planner's
 * read-tool-call inputs. Pure; dedups while preserving first-seen order.
 *
 * The ids may be LLM/customer-derived — that is SAFE because every resource read
 * they drive is OWNER-SCOPED (a forged id resolves to `null`, never leaks). This
 * is NOT the W5b claim DECOMPOSER (request span → claim mapping); it only collects
 * the resource handles the triad reads need.
 */
export function extractTurnResourceIds(args: {
  readonly envelopes?: ReadonlyArray<{ readonly payload?: unknown }>;
  readonly readToolCalls?: ReadonlyArray<{ readonly input?: unknown }>;
}): TurnResourceIds {
  const orderIds: string[] = [];
  const reservationIds: string[] = [];
  const pushUnique = (arr: string[], v: string | undefined): void => {
    if (v !== undefined && !arr.includes(v)) arr.push(v);
  };
  for (const env of args.envelopes ?? []) {
    pushUnique(orderIds, stringField(env.payload, "orderId"));
    pushUnique(reservationIds, stringField(env.payload, "reservationId"));
  }
  for (const call of args.readToolCalls ?? []) {
    pushUnique(orderIds, stringField(call.input, "orderId"));
    pushUnique(reservationIds, stringField(call.input, "reservationId"));
  }
  return { orderIds, reservationIds };
}
