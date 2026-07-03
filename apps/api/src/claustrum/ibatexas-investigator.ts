// ibatexas-investigator.ts — the INVESTIGATE stage host (SDD §M / §Q.6; v1.1 §7;
// Inv 7). Implements the published @claustrum/core `InvestigatorPort`: it WRITES
// this turn's resolved reads INTO the per-turn Evidence Ledger that the Conductor
// threads onward to CLAIMS-VALIDATE. The topology is one-directional (SDD §F):
// Read/Action FEED the ledger; the Claims kernel reads it OUT. The investigator
// never reads claims back — it only records evidence (and read errors).
//
// SCOPE — bootstrap seam, FLAG DEFAULT-OFF: this module is wired into the
// composition root but only RUNS when ENABLE_CLAIMS_PIPELINE is on (the shadow
// claims path; activation/render-from-claims is W5b). Track-A INPUT precondition:
// the default gatherer is now the REAL owner-scoped first-party read backend
// (`createFirstPartyTurnReads` over `turn-reads.ts`) — concrete values, TRUE
// provenance, real `fetchedAt`, and distinguishable fail-closed error states —
// replacing the B-PR1 `defaultTurnReads` placeholder that echoed UNTRUSTED_DATA
// tool inputs. The W5b claim DECOMPOSER (request span → candidate claim) is NOT
// here; this stage only GATHERS the triad evidence.
//
// Inv 7 (load-bearing — error ≠ absence; fail CLOSED): a read that ERRORS is
// recorded via `ledger.recordError(key, reason)`, a DISTINCT ledger state from a
// read ABSENCE (a never-recorded key). A silently-omitted failed read would let a
// missing safety read look like "nothing to say" instead of "we could not check".
//
// The investigator OWNS THE CLOCK (the ledger is clockless — `fetchedAt` is
// supplied BY this stage, per the published InvestigatorPort doc): `now()` is
// injected (default `Date.now`) so the recorded timestamps are deterministic in
// tests.

import type {
  EvidenceEntryInput,
  LedgerTaint,
  OriginProvenance,
  SourceMode,
} from "@adjudicate/core";
import type { InvestigateInput, InvestigatorPort } from "@claustrum/core";
import {
  createDomainTriadReadBackend,
  extractTurnResourceIds,
  type TriadReadBackend,
} from "./turn-reads.js";

/**
 * Map the read-layer 2-value {@link LedgerTaint} onto the 3-value
 * {@link OriginProvenance} the R1-led kernel (`@adjudicate/core` >= 1.7.0)
 * requires — the FALLBACK when a read does NOT explicitly declare its origin.
 *
 * FAIL-CLOSED: a read-layer `"TRUSTED"` maps to `TRUSTED_THIRD_PARTY`, NEVER
 * `FIRST_PARTY` — only a read that EXPLICITLY declares `originProvenance:
 * "FIRST_PARTY"` (a genuine first-party DB/config read; see
 * {@link createFirstPartyTurnReads}) earns it; nothing is auto-promoted.
 * `UNTRUSTED_DATA` stays `UNTRUSTED_DATA` and never washes up.
 *
 * Plan 1 Phase 3: the new kernel is LINKED, so genuine first-party reads now
 * carry the 3-value `FIRST_PARTY` directly (via `TurnRead.originProvenance`),
 * unblocking the `first_party_only` provenance conjunct (PAYMENT_STATUS). This
 * map remains the fail-closed default for reads that do not declare an origin.
 */
function originProvenanceOf(taint: LedgerTaint): OriginProvenance {
  return taint === "UNTRUSTED_DATA" ? "UNTRUSTED_DATA" : "TRUSTED_THIRD_PARTY";
}

/**
 * One read the investigator records into the per-turn Evidence Ledger.
 *
 * `origin` is the trust label applied AT MINT against the PUBLISHED 2-value
 * `LedgerTaint`: a first-party DB read is `"TRUSTED"`; an untrusted / free-text
 * (LLM- or customer-derived) read is `"UNTRUSTED_DATA"`.
 *
 * Plan 1 Phase 3: the 3-value `OriginProvenance` (with `FIRST_PARTY`) kernel is
 * now LINKED (`@adjudicate/core` >= 1.7.0). A genuine first-party DB/config read
 * declares `originProvenance: "FIRST_PARTY"` directly (unblocking the
 * `first_party_only` PAYMENT_STATUS conjunct); a read that omits it falls back to
 * the fail-closed {@link originProvenanceOf} map (`TRUSTED` →
 * `TRUSTED_THIRD_PARTY`) — nothing is auto-promoted to first-party.
 */
export interface TurnRead {
  /** The evidence key this read binds (the ledger / claims kernel key). */
  readonly key: string;
  /** Human/system-readable descriptor of which read produced the value. */
  readonly source: string;
  /** Read-layer 2-value trust at mint (`LedgerTaint`) → the entry's `taint`. */
  readonly origin: LedgerTaint;
  /**
   * The 3-value C3 origin axis (`FIRST_PARTY | TRUSTED_THIRD_PARTY |
   * UNTRUSTED_DATA`) → the entry's `originProvenance`. EXPLICIT for a genuine
   * first-party read; omitted ⟹ the fail-closed {@link originProvenanceOf}
   * fallback (never auto-promoted to `FIRST_PARTY`).
   */
  readonly originProvenance?: OriginProvenance;
  /** `"live"` (read this turn) vs `"cache"`. Defaults to `"live"`. */
  readonly sourceMode?: SourceMode;
  /**
   * Produce the read VALUE. May throw / reject — a thrown read is recorded as a
   * read ERROR (Inv 7), NEVER silently omitted.
   */
  readonly read: () => unknown;
}

/**
 * Sentinel a {@link TurnRead}'s `read` may return to mean "this read found
 * NOTHING this turn" — a genuine ABSENCE, distinct from BOTH a recorded value and
 * a read ERROR (Inv 7). The investigator SKIPS it (neither `record` nor
 * `recordError`), leaving the key ABSENT in the ledger. Used by the STORE_OPEN_NOW
 * falsifier read (F1): a day with no ScheduleOverride must leave
 * `schedule:schedule_override` ABSENT so the cross-key falsifier does NOT fire
 * (only a PRESENT falsifier value is a live contradiction — soundness.ts /
 * `resolveAgainstFalsifiers`); recording a fabricated "no override" present value
 * would wrongly poison EVERY no-override turn to UNKNOWN.
 */
export const ABSENT_READ: unique symbol = Symbol("ABSENT_READ");

/**
 * Derive this turn's reads from the resolved cognition + plan. INJECTED so the
 * host can wire the real first-party read backends later; defaults to
 * {@link defaultTurnReads}.
 */
export type TurnReadGatherer = (
  input: InvestigateInput,
) => ReadonlyArray<TurnRead> | Promise<ReadonlyArray<TurnRead>>;

export interface IbatexasInvestigatorDeps {
  /** This turn's read source. Defaults to {@link createFirstPartyTurnReads} (the
   *  REAL owner-scoped first-party reads); inject to stub the backend in tests. */
  readonly gatherReads?: TurnReadGatherer;
  /**
   * The clock the investigator stamps `fetchedAt` with (the ledger is clockless;
   * the investigator owns the clock — published InvestigatorPort doc). Defaults
   * to `Date.now`.
   */
  readonly now?: () => number;
}

/**
 * The LEGACY placeholder gatherer (B-PR1): derives one read per read-only tool
 * call the planner made this turn (`plan.readToolCalls`). A read-tool input is
 * LLM/customer-derived, so it is labeled `"UNTRUSTED_DATA"` — never a validating
 * value (Inv 3). SUPERSEDED by {@link createFirstPartyTurnReads} (the production
 * default); kept exported as an escape hatch / for the legacy contract test. Pure.
 */
export function defaultTurnReads(input: InvestigateInput): TurnRead[] {
  const calls = input.plan.readToolCalls ?? [];
  return calls.map((call, i) => ({
    key: `read:${call.name}:${i}`,
    source: call.name,
    // A read-tool input is LLM/customer-derived — never a validating value (Inv
    // 3 is enforced downstream by the soundness predicate; here it is recorded
    // faithfully as UNTRUSTED_DATA).
    origin: "UNTRUSTED_DATA" as LedgerTaint,
    sourceMode: "live" as SourceMode,
    read: () => call.input,
  }));
}

// Evidence keys for the Trustworthiness-Triad reads (stable; the W5b claim
// decomposer + registry bind candidate claims to these). Namespaced so a triad
// read can never collide with a legacy `read:<tool>:<i>` key.
const SCHEDULE_KEY = "schedule:store_open_now";
// STORE_OPEN_NOW FALSIFIER key (F1; W6 CE#3). Aligned VERBATIM with the registry's
// STORE_OPEN_NOW `falsifiers[].key` (claim-registry.ts) so the kernel's
// `resolveAgainstFalsifiers` finds the recorded override and demotes a present-
// override turn to UNKNOWN. Recorded ONLY when an override actually exists today.
const SCHEDULE_OVERRIDE_KEY = "schedule:schedule_override";
const ORDER_FULFILLMENT_KEY = (orderId: string): string =>
  `order_fulfillment_stage:${orderId}`;
const PAYMENT_STATUS_KEY = (orderId: string): string => `payment_status:${orderId}`;
const RESERVATION_KEY = (reservationId: string): string =>
  `reservation_status:${reservationId}`;

const GUEST_ID_RE = /^(guest|anon|anonymous):/i;

/** A real customer id (not a guest/empty marker) — owner-scoped reads need one.
 *  Exported so the BKL-073 provable-empty seam (ibatexas-claims-kernel-deps.ts)
 *  applies the SAME guest gate — a guest provably owns nothing. */
export function isAuthenticatedCustomer(customerId: string): boolean {
  return customerId.trim() !== "" && !GUEST_ID_RE.test(customerId);
}

/**
 * Thrown when an OWNER-SCOPED read could not be satisfied for the requesting
 * customer (cross-owner, NULL-owner, or absent resource). The investigator
 * records it as a fail-closed read ERROR (Inv 7 — "could not check", a DISTINCT
 * state from a fabricated value), so a cross-owner PAYMENT_STATUS read is
 * refused/empty rather than leaking another customer's data.
 */
export class OwnerScopedReadUnavailable extends Error {
  constructor(kind: string, resourceId: string) {
    super(`${kind} unavailable for this customer (not owned or absent): ${resourceId}`);
    this.name = "OwnerScopedReadUnavailable";
  }
}

/**
 * The PRODUCTION read gatherer: REAL first-party reads for the Trustworthiness-
 * Triad scope (Track A) via the owner-scoped {@link TriadReadBackend}.
 *
 *   - schedule (STORE_OPEN_NOW / STORE_HOURS) — always read; public, first-party
 *     config ⇒ `"TRUSTED"`.
 *   - order (ORDER_FULFILLMENT_STAGE), payment (PAYMENT_STATUS), reservation —
 *     read per resource id referenced by this turn's RESOLVED plan, OWNER-SCOPED
 *     to `input.customerId`. A first-party DB read ⇒ `"TRUSTED"`; a cross-owner /
 *     absent read throws {@link OwnerScopedReadUnavailable} ⇒ recorded as a
 *     fail-closed read error (the PAYMENT_STATUS IDOR close).
 *
 * Provenance is the PUBLISHED 2-value `LedgerTaint` — a genuine first-party read
 * is `"TRUSTED"`; the 3-value `FIRST_PARTY` is PENDING the R1 kernel (NOT faked
 * here — see the `TurnRead.origin` TODO). Owner-scoped resource reads are skipped
 * for a guest/unauthenticated turn (no owned resources to read).
 *
 * NOT the W5b claim decomposer (request span → claim mapping); it only GATHERS the
 * triad evidence the downstream candidate claims are validated against.
 */
export function createFirstPartyTurnReads(
  backend?: TriadReadBackend,
): TurnReadGatherer {
  return async (input: InvestigateInput): Promise<TurnRead[]> => {
    // PER-TURN backend when using the default: its owner-scoped order read + the
    // read-through schedule load memoize WITHIN this turn (single-flight, NO
    // cross-turn cache — createDomainTriadReadBackend's memo lives on the instance).
    // An injected backend (tests) is used as-is.
    const b = backend ?? createDomainTriadReadBackend();
    const customerId = input.customerId;
    const reads: TurnRead[] = [];

    // Schedule — public first-party config; always relevant, no owner needed.
    reads.push({
      key: SCHEDULE_KEY,
      source: "schedule.getScheduleSignal",
      origin: "TRUSTED",
      // First-party config-derived read (Plan 1 Phase 3) → 3-value FIRST_PARTY.
      originProvenance: "FIRST_PARTY",
      sourceMode: "live",
      read: () => b.readSchedule(),
    });

    // STORE_OPEN_NOW FALSIFIER (F1; W6 CE#3) — TODAY's ScheduleOverride. Recorded
    // as a PRESENT ledger entry ONLY when an override exists this turn; otherwise
    // the read returns ABSENT_READ → the investigator SKIPS it → the key stays
    // ABSENT → `resolveAgainstFalsifiers` does NOT fire. A present override →
    // `schedule:schedule_override` present in the ledger → the kernel demotes
    // STORE_OPEN_NOW to UNKNOWN (the open/closed signal cannot account for a
    // per-date override — schedule-helpers reads only days + holidays). Public
    // first-party config; no owner — so it runs for guests too (placed BEFORE the
    // authenticated-customer gate).
    reads.push({
      key: SCHEDULE_OVERRIDE_KEY,
      source: "schedule.readScheduleOverride",
      origin: "TRUSTED",
      originProvenance: "FIRST_PARTY",
      // The registry falsifier declares `must_read_this_turn` → record it LIVE.
      sourceMode: "live",
      read: async () => (await b.readScheduleOverride()) ?? ABSENT_READ,
    });

    if (!isAuthenticatedCustomer(customerId)) return reads;

    const { orderIds, reservationIds } = extractTurnResourceIds({
      envelopes: input.plan.envelopes,
      readToolCalls: input.plan.readToolCalls,
    });

    // FIX 2 (BUG 2 close) — the 4B routinely fails to extract a correct orderId
    // into the read-tool param (empty/missing/hallucinated), so the model-driven
    // `orderIds` alone often miss the owner's real order ⇒ the owner-scoped read
    // never runs ⇒ no owned resource ⇒ the legit owner is REFUSED. Independently
    // enumerate the AUTHENTICATED customer's OWN active orders (owner-scoped — keyed
    // ONLY by `customerId`) and union them in, so the ledger carries the owner's
    // real orders regardless of the model's extraction. IDOR-safe: every id here is
    // the customer's own; the per-resource reads below stay owner-scoped too.
    //
    // BKL-073 — capture the enumeration's SUCCESS-vs-FAILURE (not just `.catch([])`)
    // so a SUCCESSFUL empty enumeration (count 0 — a PROVABLE empty) is
    // distinguishable from one that ERRORED ("could not check"). The union behavior
    // is IDENTICAL on both paths: a failure degrades to the model-extracted ids
    // (never throws the turn), exactly as the old `.catch(() => [])` did.
    let activeOrders: { ok: true; ids: string[] } | { ok: false; reason: string };
    try {
      activeOrders = { ok: true, ids: await b.listActiveOrderIds(customerId) };
    } catch (err) {
      activeOrders = { ok: false, reason: reasonOf(err) };
    }
    const ownedActiveOrderIds = activeOrders.ok ? activeOrders.ids : [];
    const allOrderIds: string[] = [...orderIds];
    for (const id of ownedActiveOrderIds) {
      if (!allOrderIds.includes(id)) allOrderIds.push(id);
    }

    // BKL-073 PROVABLE-EMPTY MARKER — a pure SIGNAL carrier, NOT an owner resource:
    // its key `active_orders:{customerId}` matches NO OWNER_SCOPED_KEY_PREFIXES
    // (`order_fulfillment_stage:` / `payment_status:` / `reservation_status:`), so no
    // claim binds it and it never attributes ownership. On a SUCCESSFUL enumeration
    // it records `{count}` PRESENT — INCLUDING count 0, the provable-empty witness
    // the seam's Rule B consumes to DROP the order companion. On FAILURE it THROWS
    // the reason → `recordError` → ledger state "error" (Inv 7 — "could not check"
    // is NOT "provably empty"; the seam then emits NO sentinel and the order
    // companion is KEPT → honest UNKNOWN, never "render the easy half").
    reads.push({
      key: `active_orders:${customerId}`,
      source: "order.listActiveOrderIds",
      origin: "TRUSTED",
      originProvenance: "FIRST_PARTY",
      sourceMode: "live",
      read: () => {
        if (!activeOrders.ok) throw new Error(activeOrders.reason);
        return { count: activeOrders.ids.length };
      },
    });

    for (const orderId of allOrderIds) {
      reads.push({
        key: ORDER_FULFILLMENT_KEY(orderId),
        source: "order.getById",
        origin: "TRUSTED",
        // Owner-scoped first-party DB read → 3-value FIRST_PARTY (Plan 1 Phase 3).
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => {
          const v = await b.readOrderFulfillment(orderId, customerId);
          if (v === null) throw new OwnerScopedReadUnavailable("order_fulfillment_stage", orderId);
          return v;
        },
      });
      reads.push({
        key: PAYMENT_STATUS_KEY(orderId),
        source: "payment.getActiveByOrderId",
        origin: "TRUSTED",
        // Owner-scoped first-party money read → FIRST_PARTY (satisfies the
        // PAYMENT_STATUS `first_party_only` provenance conjunct; Plan 1 Phase 3).
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => {
          // OWNER-SCOPED (IDOR close): a cross-owner orderId yields null → error,
          // never another customer's payment status.
          const v = await b.readPaymentStatus(orderId, customerId);
          if (v === null) throw new OwnerScopedReadUnavailable("payment_status", orderId);
          return v;
        },
      });
    }

    for (const reservationId of reservationIds) {
      reads.push({
        key: RESERVATION_KEY(reservationId),
        source: "reservation.getById",
        origin: "TRUSTED",
        // Owner-scoped first-party DB read → 3-value FIRST_PARTY (Plan 1 Phase 3).
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => {
          const v = await b.readReservation(reservationId, customerId);
          if (v === null) throw new OwnerScopedReadUnavailable("reservation_status", reservationId);
          return v;
        },
      });
    }

    return reads;
  };
}

/**
 * Create the ibatexas INVESTIGATE stage (the published `InvestigatorPort`).
 *
 * `investigate` gathers this turn's reads and WRITES each into `input.ledger`:
 * a successful read → `ledger.record(...)`; a thrown/failed read →
 * `ledger.recordError(key, reason)` (Inv 7 — error ≠ absence, fail CLOSED).
 * Returns `void` — the ledger IS the output (threaded onward; no second copy).
 */
export function createIbatexasInvestigator(
  deps: IbatexasInvestigatorDeps = {},
): InvestigatorPort {
  const gatherReads = deps.gatherReads ?? createFirstPartyTurnReads();
  const now = deps.now ?? (() => Date.now());

  return {
    async investigate(input: InvestigateInput): Promise<void> {
      const { ledger } = input;
      const reads = await gatherReads(input);

      // The reads are INDEPENDENT — each hits its own owner-scoped resource and
      // none reads the ledger or another read's result (the shared order/schedule
      // loads are single-flight-memoized in the per-turn backend), so execute them
      // CONCURRENTLY rather than awaiting serially. Each read is isolated in its
      // own try/catch and resolves to a settled OUTCOME: a rejected read becomes an
      // error marker, so ONE failure never throws the turn (Inv 7 — this Promise.all
      // never rejects). `fetchedAt` is stamped at read completion (the investigator
      // owns the clock).
      const outcomes = await Promise.all(
        reads.map(async (r) => {
          try {
            return { r, ok: true as const, value: await r.read(), fetchedAt: now() };
          } catch (err) {
            return { r, ok: false as const, reason: reasonOf(err) };
          }
        }),
      );

      // Apply ledger writes AFTER settling, in the ORIGINAL `reads` order, so the
      // ledger state is DETERMINISTIC regardless of read completion order.
      for (const o of outcomes) {
        if (!o.ok) {
          // Inv 7 — a read ERROR is a DISTINCT, recorded ledger state, never a
          // silent omission (which would be a read ABSENCE). Fail CLOSED.
          ledger.recordError(o.r.key, o.reason);
          continue;
        }

        // ABSENCE (F1) — a read that found NOTHING (the ABSENT_READ sentinel) is a
        // genuine ledger ABSENCE: neither a recorded value nor an error (Inv 7).
        // Skip it so the key stays absent (e.g. no ScheduleOverride today → the
        // falsifier does not fire).
        if (o.value === ABSENT_READ) continue;

        const entry: EvidenceEntryInput = {
          key: o.r.key,
          value: o.value,
          source: o.r.source,
          // The investigator owns the clock; the ledger needs none. Stamped at the
          // moment this read completed (above).
          fetchedAt: o.fetchedAt,
          sourceMode: o.r.sourceMode ?? "live",
          taint: o.r.origin,
          // 3-value originProvenance (R1-led kernel >= 1.7.0): the read's EXPLICIT
          // origin when declared (a genuine first-party read → FIRST_PARTY),
          // otherwise the fail-closed map (TRUSTED → TRUSTED_THIRD_PARTY).
          originProvenance: o.r.originProvenance ?? originProvenanceOf(o.r.origin),
        };
        ledger.record(entry);
      }
    },
  };
}

/** Render a thrown value as a stable, non-throwing reason string (audit). */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
