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
const ORDER_FULFILLMENT_KEY = (orderId: string): string =>
  `order_fulfillment_stage:${orderId}`;
const PAYMENT_STATUS_KEY = (orderId: string): string => `payment_status:${orderId}`;
const RESERVATION_KEY = (reservationId: string): string =>
  `reservation_status:${reservationId}`;

const GUEST_ID_RE = /^(guest|anon|anonymous):/i;

/** A real customer id (not a guest/empty marker) — owner-scoped reads need one. */
function isAuthenticatedCustomer(customerId: string): boolean {
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
  backend: TriadReadBackend = createDomainTriadReadBackend(),
): TurnReadGatherer {
  return (input: InvestigateInput): TurnRead[] => {
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
      read: () => backend.readSchedule(),
    });

    if (!isAuthenticatedCustomer(customerId)) return reads;

    const { orderIds, reservationIds } = extractTurnResourceIds({
      envelopes: input.plan.envelopes,
      readToolCalls: input.plan.readToolCalls,
    });

    for (const orderId of orderIds) {
      reads.push({
        key: ORDER_FULFILLMENT_KEY(orderId),
        source: "order.getById",
        origin: "TRUSTED",
        // Owner-scoped first-party DB read → 3-value FIRST_PARTY (Plan 1 Phase 3).
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => {
          const v = await backend.readOrderFulfillment(orderId, customerId);
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
          const v = await backend.readPaymentStatus(orderId, customerId);
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
          const v = await backend.readReservation(reservationId, customerId);
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

      for (const r of reads) {
        let value: unknown;
        try {
          value = await r.read();
        } catch (err) {
          // Inv 7 — a read ERROR is a DISTINCT, recorded ledger state, never a
          // silent omission (which would be a read ABSENCE). Fail CLOSED.
          ledger.recordError(r.key, reasonOf(err));
          continue;
        }

        const entry: EvidenceEntryInput = {
          key: r.key,
          value,
          source: r.source,
          // The investigator owns the clock; the ledger needs none.
          fetchedAt: now(),
          sourceMode: r.sourceMode ?? "live",
          taint: r.origin,
          // 3-value originProvenance (R1-led kernel >= 1.7.0): the read's EXPLICIT
          // origin when declared (a genuine first-party read → FIRST_PARTY),
          // otherwise the fail-closed map (TRUSTED → TRUSTED_THIRD_PARTY).
          originProvenance: r.originProvenance ?? originProvenanceOf(r.origin),
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
