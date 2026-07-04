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
  loadSchedule,
  type ScheduleSignal,
} from "@ibatexas/tools";
import type { ScheduleOverrideEntry } from "@ibatexas/types";

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

/** ORDER_FULFILLMENT_STAGE — the owner-scoped order's current fulfillment stage. */
export interface OrderFulfillmentRead {
  readonly orderId: string;
  readonly fulfillmentStatus: string | null;
}

/** PAYMENT_STATUS — the owner-scoped order's active-payment status (IDOR-closed). */
export interface PaymentStatusRead {
  readonly orderId: string;
  readonly status: string;
  readonly method: string | null;
}

/** The owner-scoped reservation's current status. */
export interface ReservationRead {
  readonly reservationId: string;
  readonly status: string;
  readonly partySize: number;
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
const ACTIVE_FULFILLMENT_STAGES: ReadonlySet<string> = new Set<string>([
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "in_delivery",
]);

/** Today's local date as "YYYY-MM-DD" in `tz` (mirrors schedule-helpers' private
 *  `getLocalDateStr`; en-CA yields YYYY-MM-DD). The override is keyed by date. */
function localDateStr(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
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

  return {
    readSchedule,
    readScheduleOverride,

    async readOrderFulfillment(orderId, customerId) {
      // Owner-scoped (SDD §N P0-3, Inv 2): getById with `{ customerId }` returns
      // the projection ONLY when the customer owns it; the post-check is
      // defense-in-depth (mirrors loadOrderCtx). Shares the per-turn order memo.
      const order = await readOwnerScopedOrderOnce(orderId, customerId);
      if (order === null || order.customerId !== customerId) return null;
      return {
        orderId,
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
        status: String(active.status),
        method: active.method ?? null,
      };
    },

    async readReservation(reservationId, customerId) {
      // getById is owner-scoped: it asserts ownership and throws on a cross-owner
      // id — caught → `null` (refused), never another customer's reservation.
      const r = await createReservationService()
        .getById(reservationId, customerId)
        .catch(() => null);
      if (r === null) return null;
      return {
        reservationId,
        status: String(r.status),
        partySize: r.partySize,
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
