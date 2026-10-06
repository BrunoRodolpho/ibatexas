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
import { resolveQueriedScheduleDate } from "./schedule-date-resolver.js";
import {
  resolveMenuItem,
  resolveMenuOverviewText,
  resolveDietaryOptionsText,
  detectDietaryPreferenceTags,
  composeMenuPriceText,
  composeMenuContentsText,
} from "./menu-item-resolver.js";
import { resolveStoreInfoText } from "./store-info-resolver.js";
import {
  DELIVERY_COVERAGE_KEY,
  DELIVERY_NEEDS_CEP_MARKER_KEY,
  DELIVERY_NO_COVERAGE_KEY,
  resolveDeliveryCoverage,
} from "./delivery-coverage-resolver.js";
import {
  MENU_PAIRINGS_KEY,
  MENU_SUBSTITUTIONS_KEY,
  resolvePairings,
} from "./pairing-resolver.js";
import {
  COUPON_INVALID_KEY,
  COUPON_NEEDS_CODE_MARKER_KEY,
  COUPON_VALID_KEY,
  resolveCouponValidity,
} from "./coupon-validity-resolver.js";
import {
  classifyRequestSpans,
  isDietQualifiedAsk,
} from "./required-claim-decomposer.js";
import {
  buildDietarySuppressionIndex,
  isDietarySuppressedKey,
} from "./dietary-posture.js";

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
// STORE_HOURS evidence key (BKL-121). Aligned VERBATIM with the registry's
// STORE_HOURS `requiredEvidence[0].key` + `valueBinding.key` (claim-registry.ts) so
// the kernel validates today's-hours value against the recorded ledger entry.
const STORE_HOURS_KEY = "schedule:store_hours";
// STORE_HOURS FALSIFIER key (BKL-121 / D1) — TODAY's holiday. Aligned VERBATIM with
// the registry's STORE_HOURS `falsifiers[].key`. Recorded ONLY when today IS a
// holiday; a non-holiday leaves the key ABSENT so the falsifier does not fire.
const HOLIDAY_KEY = "schedule:holiday";
// BKL-138 STORE_HOURS_FOR_DATE — the DATE-SUFFIXED keys, aligned VERBATIM with the
// registry's `perResourceKey` parameterization (`${base}:${subject}` where subject =
// the QUERIED ISO date; claim-registry.ts `parameterizeKeysBySubject`). Recorded ONLY
// when a date subject was extracted from the request this turn (mirrors the
// conditional per-resource order/payment reads). The `:{date}` suffix is what keeps a
// future-date read from ever colliding with the BARE today STORE_HOURS/holiday keys.
const STORE_HOURS_FOR_DATE_KEY = (isoDate: string): string =>
  `schedule:store_hours:${isoDate}`;
const HOLIDAY_FOR_DATE_KEY = (isoDate: string): string => `schedule:holiday:${isoDate}`;
const OVERRIDE_FOR_DATE_KEY = (isoDate: string): string =>
  `schedule:schedule_override:${isoDate}`;
// BKL-142 MENU_ITEM_PRICE / MENU_ITEM_CONTENTS — the PRODUCT-ID-SUFFIXED keys, aligned
// VERBATIM with the registry's `perResourceKey` parameterization (`${base}:${subject}`
// where subject = the RESOLVED product id; claim-registry.ts). Recorded ONLY when a
// menu span fired AND the item resolved this turn (the same resolveMenuItem the claim
// planner drives, so key == candidate subject by construction).
const MENU_ITEM_PRICE_KEY = (productId: string): string => `menu:item_price:${productId}`;
const MENU_ITEM_CONTENTS_KEY = (productId: string): string =>
  `menu:item_contents:${productId}`;
// BKL-142 — MENU_OVERVIEW is FIXED-SUBJECT (single-key, like STORE_HOURS): no `:{id}`
// suffix. The menu-wide overview read is recorded under this bare key.
const MENU_OVERVIEW_KEY = "menu:overview";
// BKL-214 — MENU_DIETARY is PUBLIC per-item keyed by the dietary TAG (vegetariano/vegano),
// mirroring MENU_ITEM_PRICE's per-resource key. The investigator records the read under
// `menu:dietary:{tag}` only after deterministic tag detection, so the LEDGER names the
// admissible tag (classify-only's presentPublicItemIds picks it up).
const MENU_DIETARY_KEY = (tag: string): string => `menu:dietary:${tag}`;
// BKL-136 — the fixed public store-info key (claim-registry.ts STORE_INFO evidence).
const STORE_INFO_KEY = "store:info";
const ORDER_FULFILLMENT_KEY = (orderId: string): string =>
  `order_fulfillment_stage:${orderId}`;
const PAYMENT_STATUS_KEY = (orderId: string): string => `payment_status:${orderId}`;
const RESERVATION_KEY = (reservationId: string): string =>
  `reservation_status:${reservationId}`;
// BKL-006 FALSIFIER keys. Each is the registry BASE falsifier key suffixed with the
// SAME `:{subject}` the registry's `parameterizeKeysBySubject` (claim-registry.ts)
// applies to that type — so the recorded ledger key equals the parameterized
// falsifier key the kernel's `resolveAgainstFalsifiers` looks up. A suffix mismatch
// would leave the arm SILENTLY INERT (the ledger-key-lockstep pin test resolves
// these through the REAL `selectCandidateClaim` output to catch exactly that). The
// PAYMENT_STATUS subject is the ORDER id (its `payment_status` key is keyed by
// orderId), so its refund/chargeback falsifiers are keyed by orderId too.
// REVIEW FIX 2026-07-17: order_cancelled / reservation_cancelled keys were
// REMOVED with their reads — same-row tautology vs the base read (they demoted
// every truthful cancelled render while catching nothing the base missed); the
// registry declarations stay deliberately unread (see claim-registry.ts; BKL-160
// tracks rendering cancellation as a first-class claim).
const PAYMENT_REFUND_KEY = (orderId: string): string => `payment_refund:${orderId}`;
const PAYMENT_CHARGEBACK_KEY = (orderId: string): string =>
  `payment_chargeback:${orderId}`;
// BKL-139 CART_CONTENTS key. Keyed by the AUTHENTICATED customerId (the cart is
// 1-per-customer, resolved server-side from the session's conversationId — never a
// model id), so the subject is the customerId in lockstep with parameterizeKeysBySubject.
// (The declared `cart_cleared` falsifier is deliberately UNREAD — see the cart block.)
const CART_CONTENTS_KEY = (customerId: string): string => `cart_contents:${customerId}`;
// FE-D03 slice C ORDER_HISTORY / PAYMENT_HISTORY keys. Keyed by the AUTHENTICATED
// customerId (the list is per-customer, owner-scoped via listByCustomer) — the subject
// is the customerId in lockstep with parameterizeKeysBySubject. The declared
// order_history_changed / payment_history_changed falsifiers are deliberately UNREAD
// (see the history block + registry: a must_read_this_turn snapshot is already current).
const ORDER_HISTORY_KEY = (customerId: string): string => `order_history:${customerId}`;
const PAYMENT_HISTORY_KEY = (customerId: string): string => `payment_history:${customerId}`;

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
  opts?: {
    /** Clock for the BKL-138 date resolver (default `Date.now`); inject to freeze it. */
    readonly now?: () => number;
    /** Restaurant timezone for the BKL-138 date resolver (default env / São Paulo). */
    readonly tz?: string;
  },
): TurnReadGatherer {
  const now = opts?.now ?? (() => Date.now());
  const tz = opts?.tz ?? process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo";
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

    // STORE_HOURS (BKL-121) — TODAY's operating-hours string. Public first-party
    // config; always relevant, no owner needed (runs for guests too). A schedule-load
    // failure THROWS in `readStoreHours` → recorded as a fail-closed read ERROR (Inv 7:
    // "não consegui conferir o horário"), NEVER a fabricated hours string. On success
    // the recorded entry is the base the kernel's STORE_HOURS value-binding validates
    // against, and the base `resolveAgainstFalsifiers` demotes when a falsifier fires.
    reads.push({
      key: STORE_HOURS_KEY,
      source: "schedule.getTodayHoursText",
      origin: "TRUSTED",
      originProvenance: "FIRST_PARTY",
      sourceMode: "live",
      read: () => b.readStoreHours(),
    });

    // STORE_HOURS FALSIFIER (BKL-121 / D1) — TODAY's holiday. Recorded PRESENT ONLY
    // when today is a holiday (the weekly hours cannot be trusted on a holiday);
    // otherwise ABSENT_READ → the investigator SKIPS it → the key stays ABSENT → the
    // holiday falsifier does NOT fire. A present holiday → `schedule:holiday` present
    // → the kernel demotes STORE_HOURS to UNKNOWN. Public first-party config; no owner
    // — placed BEFORE the authenticated-customer gate. (The OTHER STORE_HOURS
    // falsifier, a present ScheduleOverride, is ALREADY recorded above under
    // `schedule:schedule_override` — reused, not re-read.)
    reads.push({
      key: HOLIDAY_KEY,
      source: "schedule.readHoliday",
      origin: "TRUSTED",
      originProvenance: "FIRST_PARTY",
      sourceMode: "live",
      read: async () => (await b.readHoliday()) ?? ABSENT_READ,
    });

    // BKL-138 STORE_HOURS_FOR_DATE (SCN-002/003) — the DAY-SPECIFIC hours + its per-date
    // falsifiers. GATED on a resolvable date subject in THIS turn's request (mirrors the
    // conditional per-resource order/payment reads driven off `extractTurnResourceIds`):
    // the SAME deterministic resolver the claim planner uses derives the QUERIED ISO date
    // from `perception.text`, so the ledger key matches the candidate subject by
    // construction (never the 4B's date arithmetic). A message with no date anchor
    // resolves to `null` → NONE of these reads run (no per-turn cost added to an ordinary
    // message; the today STORE_HOURS chain above is byte-untouched). Public first-party
    // config; no owner → placed BEFORE the authenticated-customer gate (answers guests too).
    const queried = resolveQueriedScheduleDate(
      input.cognition.perception.text,
      tz,
      new Date(now()),
    );
    if (queried !== null) {
      const isoDate = queried.isoDate;
      // Evidence — the queried date's operating-hours. A schedule-load failure THROWS in
      // `readHoursForDate` → recorded as a fail-closed read ERROR (Inv 7), never a
      // fabricated hours string. On success this is the base the kernel's
      // STORE_HOURS_FOR_DATE value-binding validates against.
      reads.push({
        key: STORE_HOURS_FOR_DATE_KEY(isoDate),
        source: "schedule.getHoursTextForDate",
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: () => b.readHoursForDate(isoDate),
      });
      // FALSIFIER — a holiday ON THE QUERIED date (present iff that date is a holiday);
      // absence → ABSENT_READ → the falsifier does NOT fire. This is the SCN-003
      // soundness pin: the date-suffixed key means TODAY's holiday (recorded above under
      // the BARE `schedule:holiday`) can never demote a clean future-date answer.
      reads.push({
        key: HOLIDAY_FOR_DATE_KEY(isoDate),
        source: "schedule.readHolidayForDate",
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => (await b.readHolidayForDate(isoDate)) ?? ABSENT_READ,
      });
      // FALSIFIER — a per-date ScheduleOverride ON THE QUERIED date; absence → ABSENT_READ.
      reads.push({
        key: OVERRIDE_FOR_DATE_KEY(isoDate),
        source: "schedule.readScheduleOverrideForDate",
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => (await b.readScheduleOverrideForDate(isoDate)) ?? ABSENT_READ,
      });
    }

    // BKL-142 MENU_ITEM_PRICE / MENU_ITEM_CONTENTS — PUBLIC per-item catalog reads.
    // GATED on a MENU_ITEM_PRICE_Q / MENU_ITEM_CONTENTS_Q span (the SAME
    // classifyRequestSpans classifier the claim planner + decomposer use), mirroring the
    // STORE_HOURS_FOR_DATE date-gate: a non-menu turn adds NO catalog cost. The subject
    // is the RESOLVED product id (the SHARED resolveMenuItem over perception.text — same
    // turnId+text ⇒ same product as the claim planner, so the ledger key matches the
    // candidate subject by construction). No lexically-related product → `undefined` →
    // NO reads → the claim resolves ABSENT → honest UNKNOWN, never a wrong item/price.
    // Public first-party catalog; no owner → placed BEFORE the authenticated-customer
    // gate (answers guests too). The `menu:item_unpublished` W6 falsifier is
    // DELIBERATELY UNREAD (claim-registry.ts) — never pushed here.
    const menuSpans = classifyRequestSpans(input.cognition.perception.text);
    const wantsMenuPrice = menuSpans.includes("MENU_ITEM_PRICE_Q");
    const wantsMenuContents = menuSpans.includes("MENU_ITEM_CONTENTS_Q");
    if (wantsMenuPrice || wantsMenuContents) {
      const resolved = await resolveMenuItem(
        input.cognition.turnId,
        input.cognition.perception.text,
        {
          channel: input.cognition.perception.channel,
          sessionId: input.cognition.conversationId,
          customerId,
        },
      );
      if (resolved !== undefined) {
        if (wantsMenuPrice) {
          // Compose the C6-bound scalar ONCE, up front (byte-equal to the claim
          // planner's derived value — same composer, same resolved product).
          const priceText = composeMenuPriceText(resolved);
          reads.push({
            key: MENU_ITEM_PRICE_KEY(resolved.id),
            source: "catalog.itemPrice",
            origin: "TRUSTED",
            originProvenance: "FIRST_PARTY",
            sourceMode: "live",
            read: async () => ({ priceText }),
          });
        }
        if (wantsMenuContents) {
          // BKL-273 — the SAME request text the claim planner passes (its
          // `state.perception.text`), so the allergen guard decides identically on
          // both sides and the recorded/derived C6 values stay byte-equal.
          const contentsText = composeMenuContentsText(
            resolved,
            input.cognition.perception.text,
          );
          // No first-party description → record NO evidence → honest UNKNOWN (never a
          // fabricated blurb). Only push when the catalog actually has contents text.
          if (contentsText !== undefined) {
            reads.push({
              key: MENU_ITEM_CONTENTS_KEY(resolved.id),
              source: "catalog.itemContents",
              origin: "TRUSTED",
              originProvenance: "FIRST_PARTY",
              sourceMode: "live",
              read: async () => ({ contentsText }),
            });
          }
        }
      }
    }

    // BKL-142 — MENU_OVERVIEW: the menu-WIDE overview ("o que tem no cardápio?").
    // GATED on a MENU_OVERVIEW_Q span. FIXED subject (no resolveMenuItem — the read is a
    // wildcard catalog LISTING, not a per-item lookup), keyed by the bare `menu:overview`
    // key. Public first-party catalog → placed BEFORE the authenticated-customer gate
    // (answers guests too). Empty/unreadable catalog → resolveMenuOverviewText undefined
    // → NO evidence → honest UNKNOWN (never a fabricated menu). The `menu:item_unpublished`
    // W6 falsifier is DELIBERATELY UNREAD (claim-registry.ts) — never pushed here.
    if (menuSpans.includes("MENU_OVERVIEW_Q")) {
      const overviewText = await resolveMenuOverviewText(
        input.cognition.turnId,
        input.cognition.perception.text,
        {
          channel: input.cognition.perception.channel,
          sessionId: input.cognition.conversationId,
          customerId,
        },
      );
      if (overviewText !== undefined) {
        reads.push({
          key: MENU_OVERVIEW_KEY,
          source: "catalog.overview",
          origin: "TRUSTED",
          originProvenance: "FIRST_PARTY",
          sourceMode: "live",
          read: async () => ({ overviewText }),
        });
      }
    }

    // BKL-214 — MENU_DIETARY: the dietary-PREFERENCE read ("tem opção vegetariana?").
    // GATED on a MENU_DIETARY_Q span. The tag(s) are detected DETERMINISTICALLY from the
    // text (vegetariano/vegano — allergen-adjacent diets are excluded upstream by the span
    // gate). For each detected tag, a faceted read of the tagged products; an empty tag →
    // resolveDietaryOptionsText undefined → NO evidence → honest UNKNOWN (never a
    // fabricated "we have vegetarian options"). Public first-party → BEFORE the
    // authenticated gate (answers guests too). Keyed per-tag like the menu-item reads.
    if (menuSpans.includes("MENU_DIETARY_Q")) {
      const tags = detectDietaryPreferenceTags(input.cognition.perception.text);
      for (const tag of tags) {
        const dietaryText = await resolveDietaryOptionsText(
          input.cognition.turnId,
          tag,
          input.cognition.perception.text,
          {
            channel: input.cognition.perception.channel,
            sessionId: input.cognition.conversationId,
            customerId,
          },
        );
        if (dietaryText !== undefined) {
          reads.push({
            key: MENU_DIETARY_KEY(tag),
            source: "catalog.dietary",
            origin: "TRUSTED",
            originProvenance: "FIRST_PARTY",
            sourceMode: "live",
            read: async () => ({ dietaryText }),
          });
        }
      }
    }

    // BKL-136 STORE_INFO — the store address/parking read, GATED on a STORE_INFO_Q
    // span. FIXED subject (single `store:info` key, like MENU_OVERVIEW), public
    // first-party config → placed BEFORE the authenticated-customer gate (answers
    // guests too). The shared per-turn-memoized resolver composes the scalar from
    // OWNER-ATTESTED Medusa store.metadata; absent/blank metadata or an unreadable
    // store → `undefined` → NO evidence → honest UNKNOWN (never a fabricated
    // address). The `store:info_changed` W6 falsifier is DELIBERATELY UNREAD
    // (claim-registry.ts) — never pushed here.
    if (menuSpans.includes("STORE_INFO_Q")) {
      const infoText = await resolveStoreInfoText(input.cognition.turnId);
      if (infoText !== undefined) {
        reads.push({
          key: STORE_INFO_KEY,
          source: "store.info",
          origin: "TRUSTED",
          originProvenance: "FIRST_PARTY",
          sourceMode: "live",
          read: async () => ({ infoText }),
        });
      }
    }

    // LE2-002 / NEW-007 DELIVERY_COVERAGE / DELIVERY_NO_COVERAGE — the delivery
    // coverage read ("vocês entregam em Ibaté?"), GATED on a DELIVERY_COVERAGE_Q
    // span. FIXED subject (single keys, like STORE_INFO / MENU_OVERVIEW), PUBLIC
    // store policy → placed BEFORE the authenticated-customer gate (a coverage
    // question is the most common GUEST question there is — a first-time customer
    // asks it before they have any account at all).
    //
    // The shared per-turn-memoized resolver goes through the delivery-zones
    // projection (zone-NAME arm) or the EXISTING estimation tool (CEP arm) — no new
    // DB path — and returns exactly one of four states. This block is the honesty
    // wiring for all four, and the ONLY place the complementary pair is recorded:
    //
    //   · covered      → `delivery:coverage` PRESENT with the composed scalar.
    //   · not_covered  → `delivery:no_coverage` PRESENT (a POSITIVE out-of-zone
    //                    determination is a FACT — a VALIDATED negative render).
    //   · needs_cep    → NEITHER claim key; the needs-CEP MARKER instead, which
    //                    forces the CLARIFY-for-CEP ask downstream. Never a
    //                    nearest-neighbour guess.
    //   · unknown      → NOTHING recorded at all → both claims resolve ABSENT →
    //                    honest UNKNOWN. Inv 7: "could not check" is a DISTINCT
    //                    state from "we don't deliver", and it must never render as
    //                    the negative.
    //
    // Exactly one of the two claim keys can ever be PRESENT, so the pair can never
    // render a contradiction. The `delivery:zones_changed` W6 falsifier is
    // DELIBERATELY UNREAD (claim-registry.ts) — never pushed here.
    if (menuSpans.includes("DELIVERY_COVERAGE_Q")) {
      const coverage = await resolveDeliveryCoverage(
        input.cognition.turnId,
        input.cognition.perception.text,
      );
      if (coverage.kind === "covered") {
        const coverageText = coverage.coverageText;
        reads.push({
          key: DELIVERY_COVERAGE_KEY,
          source: "delivery.coverage",
          origin: "TRUSTED",
          originProvenance: "FIRST_PARTY",
          sourceMode: "live",
          read: async () => ({ coverageText }),
        });
      } else if (coverage.kind === "not_covered") {
        const noCoverageText = coverage.noCoverageText;
        reads.push({
          key: DELIVERY_NO_COVERAGE_KEY,
          source: "delivery.coverage",
          origin: "TRUSTED",
          originProvenance: "FIRST_PARTY",
          sourceMode: "live",
          read: async () => ({ noCoverageText }),
        });
      } else if (coverage.kind === "needs_cep") {
        reads.push({
          key: DELIVERY_NEEDS_CEP_MARKER_KEY,
          source: "delivery.coverage.marker",
          origin: "TRUSTED",
          originProvenance: "FIRST_PARTY",
          sourceMode: "live",
          read: async () => ({ needsCep: true }),
        });
      }
      // `unknown` — deliberately records NOTHING (see the block header).
    }

    // LE2-019 / spec Decision 18 COUPON_VALID / COUPON_INVALID — the coupon
    // validity read ("o cupom X1234 vale?"), GATED on a COUPON_VALIDITY_Q span.
    // FIXED subject (single keys, like DELIVERY_COVERAGE / STORE_INFO), PUBLIC
    // store policy → placed BEFORE the authenticated-customer gate: a coupon is
    // valid or not regardless of who is asking, and a first-time customer holding
    // a flyer code has no account yet.
    //
    // The shared per-turn-memoized resolver goes through the EXISTING `medusaAdmin`
    // transport at the EXISTING `/admin/promotions?code=` path and the SHARED
    // usability predicate — no new store path — and returns exactly one of four
    // states. This block is the honesty wiring for all four, and the ONLY place the
    // complementary pair is recorded:
    //
    //   · valid      → `coupon:valid` PRESENT with the composed terms scalar.
    //   · invalid    → `coupon:invalid` PRESENT (a POSITIVE not-usable determination
    //                  off a SUCCESSFUL lookup is a FACT — a VALIDATED negative).
    //   · needs_code → NEITHER claim key; the needs-CODE MARKER instead, which
    //                  forces the CLARIFY-for-code ask downstream. Never a guess at
    //                  which coupon was meant.
    //   · unknown    → NOTHING recorded at all → both claims resolve ABSENT →
    //                  honest UNKNOWN. Inv 7: "could not check" is a DISTINCT state
    //                  from "your coupon is invalid", and it must never render as
    //                  the negative. (This is exactly where this read DIVERGES from
    //                  the display route POST /api/coupons/validate, which may
    //                  collapse a failed lookup to `valid: false`.)
    //
    // Exactly one of the two claim keys can ever be PRESENT, so the pair can never
    // render a contradiction. The `coupon:promotions_changed` W6 falsifier is
    // DELIBERATELY UNREAD (claim-registry.ts) — never pushed here.
    //
    // DECISION 14: a READ only. Nothing here applies a coupon, touches a cart, or
    // builds an intent envelope.
    if (menuSpans.includes("COUPON_VALIDITY_Q")) {
      const coupon = await resolveCouponValidity(
        input.cognition.turnId,
        input.cognition.perception.text,
      );
      if (coupon.kind === "valid") {
        const validityText = coupon.validityText;
        reads.push({
          key: COUPON_VALID_KEY,
          source: "promotions.validity",
          origin: "TRUSTED",
          originProvenance: "FIRST_PARTY",
          sourceMode: "live",
          read: async () => ({ validityText }),
        });
      } else if (coupon.kind === "invalid") {
        const invalidityText = coupon.invalidityText;
        reads.push({
          key: COUPON_INVALID_KEY,
          source: "promotions.validity",
          origin: "TRUSTED",
          originProvenance: "FIRST_PARTY",
          sourceMode: "live",
          read: async () => ({ invalidityText }),
        });
      } else if (coupon.kind === "needs_code") {
        reads.push({
          key: COUPON_NEEDS_CODE_MARKER_KEY,
          source: "promotions.validity.marker",
          origin: "TRUSTED",
          originProvenance: "FIRST_PARTY",
          sourceMode: "live",
          read: async () => ({ needsCode: true }),
        });
      }
      // `unknown` — deliberately records NOTHING (see the block header).
    }

    // LE2-029 MENU_PAIRINGS / MENU_SUBSTITUTIONS — the pairing read ("o que
    // combina com brisket?"), GATED on a PAIRING_Q span. FIXED subject (single
    // keys, like COUPON_VALID), PUBLIC store knowledge -> placed BEFORE the
    // authenticated-customer gate: what the house serves together is the same
    // answer regardless of who is asking, and a first-time visitor deciding what
    // to order has no account yet.
    //
    // The shared per-turn-memoized resolver reads the AUTHORED catalog graph and
    // resolves every handle it is about to speak through the EXISTING
    // `resolveMenuItem` catalog read -- so the suggestion names live product
    // titles, never handles, and an edge pointing at something the store no longer
    // sells is dropped rather than voiced. Three states, and this block is the
    // honesty wiring for all three:
    //
    //   - pairings      -> `menu:pairings` PRESENT with the composed scalar.
    //   - substitutions -> `menu:substitutions` PRESENT.
    //   - unknown       -> NOTHING recorded -> both claims resolve ABSENT ->
    //                     honest UNKNOWN. This covers the ticket's "unknown item
    //                     OR empty pairing data", and deliberately has NO
    //                     validated-negative twin: the graph is a PARTIAL authored
    //                     seed, so "no edge" is "not written down yet", never
    //                     "nothing goes with this".
    //
    // Exactly one of the two claim keys can ever be PRESENT, so the pair can never
    // render a contradiction. The `menu:pairings_changed` W6 falsifier is
    // DELIBERATELY UNREAD (claim-registry.ts) -- never pushed here.
    //
    // A READ only: nothing here adds an item, touches a cart, or builds an intent
    // envelope.
    if (menuSpans.includes("PAIRING_Q")) {
      const pairing = await resolvePairings(
        input.cognition.turnId,
        input.cognition.perception.text,
        {
          channel: input.cognition.perception.channel,
          sessionId: input.cognition.conversationId,
          customerId,
        },
      );
      if (pairing.kind === "pairings") {
        const suggestionsText = pairing.suggestionsText;
        reads.push({
          key: MENU_PAIRINGS_KEY,
          source: "catalog.pairings",
          origin: "TRUSTED",
          originProvenance: "FIRST_PARTY",
          sourceMode: "live",
          read: async () => ({ suggestionsText }),
        });
      } else if (pairing.kind === "substitutions") {
        const substitutionsText = pairing.substitutionsText;
        reads.push({
          key: MENU_SUBSTITUTIONS_KEY,
          source: "catalog.pairings",
          origin: "TRUSTED",
          originProvenance: "FIRST_PARTY",
          sourceMode: "live",
          read: async () => ({ substitutionsText }),
        });
      }
      // `unknown` -- deliberately records NOTHING (see the block header).
    }

    if (!isAuthenticatedCustomer(customerId)) return reads;

    // BKL-139 CART_CONTENTS — the authenticated customer's IN-PROGRESS cart, keyed by
    // the customerId subject (the cart is 1-per-customer, resolved server-side from the
    // session's conversationId — IDOR-safe by session-scoping, never a model cart id).
    // A guest never reaches here (gated above) → cart_contents absent → honest UNKNOWN
    // (the fail-closed ownership ruling). GATED on a CART_CONTENTS_Q span in THIS turn's
    // request (the SAME deterministic classifier the decomposer/classify-only path uses,
    // mirroring the STORE_HOURS_FOR_DATE date-gate): a non-cart turn adds NO Medusa/Redis
    // cost and records no cart keys. Both reads (cart_contents + the active_cart marker)
    // share the per-turn cart memo (one Medusa fetch). `readCartContents` returns `null`
    // ONLY on an UNAVAILABLE read (Redis/Medusa error) → OwnerScopedReadUnavailable →
    // fail-closed ERROR (Inv 7); an empty/absent cart returns `hasItems: false` →
    // ABSENT_READ → honest UNKNOWN.
    const asksAboutCart = classifyRequestSpans(input.cognition.perception.text).includes(
      "CART_CONTENTS_Q",
    );
    const conversationId = input.cognition.conversationId;
    if (asksAboutCart) {
      reads.push({
        key: CART_CONTENTS_KEY(customerId),
        source: "cart.readCartContents",
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => {
          const v = await b.readCartContents(conversationId, customerId);
          if (v === null) throw new OwnerScopedReadUnavailable("cart_contents", customerId);
          // PRESENT only when the cart actually has items — an empty/absent cart leaves
          // the key ABSENT (honest UNKNOWN), never a fabricated summary.
          return v.hasItems ? { itemsSummaryText: v.itemsSummaryText } : ABSENT_READ;
        },
      });
      // CART_CONTENTS falsifier `cart_cleared` — DECLARED in the registry (so
      // CART_CONTENTS escapes the W6 UNKNOWN-only cap) but DELIBERATELY UNREAD: a
      // same-cart-row "cleared" signal is tautological AND inert (a cleared/checked-out
      // cart already resolves `hasItems: false` ⇒ `cart_contents` ABSENT ⇒ there is no
      // present base to demote). Wiring it would only re-introduce the shared-read
      // tautology the order_cancelled/reservation_cancelled review-fix removed. So there
      // is no cart_cleared read here — the key stays absent and the arm never fires.
      // CART provable-empty marker — observability/audit parity with the
      // active_orders/active_payments/active_reservations markers (FE-T17b idiom). NOT
      // (yet) consumed by a completeness-drop rule: CART_CONTENTS is required only by
      // its own CART_CONTENTS_Q span — no unrelated span force-requires it — so the
      // wrongly-forced-companion problem the order/payment markers solve does not exist
      // for the cart today. Its key matches NO OWNER_SCOPED_KEY_PREFIXES → never an
      // owner resource. A failed read records state error (Inv 7 — "could not check").
      reads.push({
        key: `active_cart:${customerId}`,
        source: "cart.readCartContents.marker",
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => {
          const v = await b.readCartContents(conversationId, customerId);
          if (v === null) throw new OwnerScopedReadUnavailable("active_cart", customerId);
          return { hasItems: v.hasItems };
        },
      });
      // BKL-163 CART_EMPTY — the provable-empty CLAIM key (the FE-T17b marker idiom
      // inverted into evidence): PRESENT ONLY when the cart read resolved
      // `hasItems: false`, so presence IS the provable-empty proposition and the
      // CART_CONTENTS/CART_EMPTY pair is complementary by construction (exactly one
      // can validate in a turn). The `emptinessText` scalar is CODE-COMPOSED (the
      // literal "vazio" the template's C6-bound slot renders), never model-authored.
      // Shares the per-turn cart memo (no extra Medusa/Redis cost). `null` (an
      // UNAVAILABLE read) → OwnerScopedReadUnavailable → fail-closed ERROR (Inv 7);
      // a cart WITH items → ABSENT_READ (no present base — CART_EMPTY resolves
      // honest UNKNOWN and is dropped when CART_CONTENTS validates).
      reads.push({
        key: `cart_empty:${customerId}`,
        source: "cart.readCartContents.empty",
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => {
          const v = await b.readCartContents(conversationId, customerId);
          if (v === null) throw new OwnerScopedReadUnavailable("cart_empty", customerId);
          return v.hasItems ? ABSENT_READ : { emptinessText: "vazio" };
        },
      });
    }

    // FE-D03 slice C ORDER_HISTORY / PAYMENT_HISTORY — the owner-scoped LIST reads,
    // keyed by the authenticated customerId. GATED on the *_HISTORY_Q span (same
    // deterministic classifier + span-gate discipline as CART_CONTENTS): a non-history
    // turn adds no DB cost and records no history keys. Each records PRESENT only when
    // the customer has rows (hasHistory) — an empty history leaves the key ABSENT →
    // honest UNKNOWN; a DB read failure REJECTS → fail-closed ERROR (Inv 7). A guest
    // never reaches here (gated above) → honest UNKNOWN. The declared
    // order_history_changed / payment_history_changed falsifiers are deliberately UNREAD
    // (registry note): the summary is a must_read_this_turn snapshot already reflecting
    // each row's current status, so a same-read "changed" signal is tautological/inert.
    const spans = classifyRequestSpans(input.cognition.perception.text);
    if (spans.includes("ORDER_HISTORY_Q")) {
      reads.push({
        key: ORDER_HISTORY_KEY(customerId),
        source: "order.readOrderHistory",
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => {
          const v = await b.readOrderHistory(customerId);
          return v.hasHistory ? { historySummaryText: v.historySummaryText } : ABSENT_READ;
        },
      });
    }
    if (spans.includes("PAYMENT_HISTORY_Q")) {
      reads.push({
        key: PAYMENT_HISTORY_KEY(customerId),
        source: "payment.readPaymentHistory",
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => {
          const v = await b.readPaymentHistory(customerId);
          return v.hasHistory ? { historySummaryText: v.historySummaryText } : ABSENT_READ;
        },
      });
    }

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

    // BKL-079 PAYMENT PROVABLE-EMPTY MARKER — the EXACT MIRROR of the order marker
    // above, for the PAYMENT dimension. A pure SIGNAL carrier, NOT an owner resource:
    // its key `active_payments:{customerId}` matches NO OWNER_SCOPED_KEY_PREFIXES
    // (`order_fulfillment_stage:` / `payment_status:` / `reservation_status:`), so no
    // claim binds it and it never attributes ownership. On a SUCCESSFUL enumeration it
    // records `{count}` PRESENT — INCLUDING count 0, the provable-empty witness the
    // seam's Rule B′ consumes to DROP the payment companion. On FAILURE it THROWS the
    // reason → `recordError` → ledger state "error" (Inv 7 — "could not check" is NOT
    // "provably empty"; the seam then emits NO sentinel and the payment companion is
    // KEPT → honest UNKNOWN, never "render the easy half"). Owner-scoped / IDOR-safe:
    // keyed ONLY by the authenticated `customerId` (countActivePayments' customerId
    // join), never a model/session id. (countActivePayments counts ALL of the
    // customer's payments — so count===0 is a STRICTER, still-sound provable-empty
    // witness than an active-only count; see turn-reads.ts.)
    let activePayments: { ok: true; count: number } | { ok: false; reason: string };
    try {
      activePayments = { ok: true, count: await b.countActivePayments(customerId) };
    } catch (err) {
      activePayments = { ok: false, reason: reasonOf(err) };
    }
    reads.push({
      key: `active_payments:${customerId}`,
      source: "payment.countActivePayments",
      origin: "TRUSTED",
      originProvenance: "FIRST_PARTY",
      sourceMode: "live",
      read: () => {
        if (!activePayments.ok) throw new Error(activePayments.reason);
        return { count: activePayments.count };
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

      // BKL-006 FALSIFIERS (W6 CE#3 runtime arm) — the PAYMENT_STATUS falsifiers
      // the registry DECLARED but no read populated, so the arm was structurally
      // INERT (a refunded/disputed payment could VALIDATE `pago` while the claims
      // flag is ON — the latent risk BKL-006 closes). Each is recorded PRESENT
      // ONLY when the falsifying fact actually exists (refund / chargeback); a
      // checked-and-NONE read returns ABSENT_READ → the investigator SKIPS it →
      // the key stays ABSENT → `resolveAgainstFalsifiers` does NOT fire (never a
      // fabricated "no refund" present value — the anti-pattern in the ABSENT_READ
      // doc above). A cross-owner / absent read throws OwnerScopedReadUnavailable
      // → fail-closed read ERROR (Inv 7): an unreadable falsifier cannot be proven
      // not to have fired, so it demotes the base to UNKNOWN (symmetric with the
      // base-key error axis) — never leaks another customer's data. DEMOTE-ONLY.
      // REVIEW FIX 2026-07-17: the order_cancelled read that shipped here in #277
      // was REMOVED — it derived from the SAME memoized order row as the base
      // ORDER_FULFILLMENT_STAGE read (same instant, same freshness), so it could
      // never catch staleness the base missed, while demoting every TRUTHFUL
      // "cancelado" render to UNKNOWN. Refund/chargeback stay: value-distinct
      // signals (a refund on a still-'paid' row) the base does not assert.
      reads.push({
        key: PAYMENT_REFUND_KEY(orderId),
        source: "payment.readPaymentRefund",
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => {
          const v = await b.readPaymentRefund(orderId, customerId);
          if (v === null) throw new OwnerScopedReadUnavailable("payment_refund", orderId);
          return v.refunded ? v : ABSENT_READ;
        },
      });
      reads.push({
        key: PAYMENT_CHARGEBACK_KEY(orderId),
        source: "payment.readPaymentChargeback",
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => {
          const v = await b.readPaymentChargeback(orderId, customerId);
          if (v === null)
            throw new OwnerScopedReadUnavailable("payment_chargeback", orderId);
          return v.disputed ? v : ABSENT_READ;
        },
      });
    }

    // FE-T17b (live-disproof follow-up; DISPROVEN 2026-07-16, turnIds 30c78409-…
    // / 91adbe43-…) — the RESERVATION mirror of the FIX 2 order-discovery fallback
    // above. `get_my_reservations` is a no-param LIST call (its input carries no
    // `reservationId`), so `extractTurnResourceIds` structurally NEVER populates
    // `reservationIds` for a status question — unlike an order/payment question,
    // where the model at least ATTEMPTS to extract an id into a read-tool param.
    // Without this fallback the reservation per-resource loop below iterates an
    // ALWAYS-EMPTY list, no `reservation_status:{id}` entry is ever recorded, and
    // RESERVATION_STATUS can never acquire evidence — proposal, registry row, and
    // template were all correct, but the claim was structurally unreachable.
    // Independently enumerate the AUTHENTICATED customer's OWN active reservations
    // (owner-scoped — keyed ONLY by `customerId`) and union them in, so the ledger
    // carries the owner's real reservations regardless of the model's (necessarily
    // absent) extraction. IDOR-safe: every id here is the customer's own; the
    // per-resource read below stays owner-scoped too. Same defensive shape as the
    // order fallback: a failed enumeration degrades to the (empty) model-extracted
    // ids rather than throwing the turn — the honest-abstain path this closes for
    // (zero reservations → this stays `[]` → no ledger entry → SAFE_UNKNOWN) is
    // unaffected by an enumeration failure either.
    let activeReservations: { ok: true; ids: string[] } | { ok: false; reason: string };
    try {
      activeReservations = { ok: true, ids: await b.listActiveReservationIds(customerId) };
    } catch (err) {
      activeReservations = { ok: false, reason: reasonOf(err) };
    }
    const ownedActiveReservationIds = activeReservations.ok ? activeReservations.ids : [];
    const allReservationIds: string[] = [...reservationIds];
    for (const id of ownedActiveReservationIds) {
      if (!allReservationIds.includes(id)) allReservationIds.push(id);
    }

    // FE-T17b — the EXACT MIRROR of the BKL-073/BKL-079 provable-empty markers, for
    // the RESERVATION dimension. A pure SIGNAL carrier, NOT an owner resource: its
    // key `active_reservations:{customerId}` matches NO OWNER_SCOPED_KEY_PREFIXES
    // (`order_fulfillment_stage:` / `payment_status:` / `reservation_status:`), so
    // it never attributes ownership. Recorded for observability/audit parity with
    // the order/payment markers; NOT (yet) consumed by a completeness-drop rule
    // (RESERVATION_STATUS is required only by its own RESERVATION_STATUS_Q span —
    // no unrelated span class force-requires it the way PICKUP_Q forces
    // ORDER_FULFILLMENT_STAGE — so the #8/BKL-073-style "drop a wrongly-forced
    // companion" problem does not exist for reservations today; wiring this into
    // `activeResourcesFromLedger` is a separate, not-yet-requested change).
    reads.push({
      key: `active_reservations:${customerId}`,
      source: "reservation.listActiveReservationIds",
      origin: "TRUSTED",
      originProvenance: "FIRST_PARTY",
      sourceMode: "live",
      read: () => {
        if (!activeReservations.ok) throw new Error(activeReservations.reason);
        return { count: activeReservations.ids.length };
      },
    });

    for (const reservationId of allReservationIds) {
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
      // REVIEW FIX 2026-07-17: the reservation_cancelled falsifier read that
      // shipped here in #277 was REMOVED — same-row tautology with the base
      // RESERVATION_STATUS read (shared per-turn getById memo), demoting every
      // truthful "cancelada" render while catching nothing the base missed. The
      // registry declaration stays deliberately unread (claim-registry.ts; BKL-160).
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
  // BKL-270 — derived from the registry ONCE per investigator, not per turn: the
  // registry is a module constant, so the set cannot change between turns, and a
  // per-turn rebuild would put a loop over every spec on the hot path of every read.
  // Scoped to the CUSTOMER registry deliberately: the three ops reads all declare
  // `answer-anyway`, so they contribute no suppressed keys, and scoping to the wider
  // plane here would be a no-op that implied otherwise.
  const dietarySuppressedKeys = buildDietarySuppressionIndex();

  return {
    async investigate(input: InvestigateInput): Promise<void> {
      const { ledger } = input;
      const gathered = await gatherReads(input);

      // ── BKL-270: the registry-declared DIETARY-POSTURE guard, on the READ ────
      //
      // When the turn NAMES a dietary restriction, drop every read whose evidence
      // key is required only by claim types declaring `dietaryPosture: "abstain"`.
      // Nothing is recorded ⇒ the kernel resolves the key ABSENT ⇒ the claim yields
      // UNKNOWN ⇒ the renderer emits the ratified BKL-184 self-report + staff
      // handoff. Exactly the LE2-029 / BKL-273 shape, but driven by the registry
      // instead of hand-applied per family — which is the whole point of the ticket:
      // before this, every NEW read family was one omission away from a leak.
      //
      // THREE placement decisions, each deliberate:
      //
      //   · HERE and not in `createFirstPartyTurnReads` — the ops plane's gatherer
      //     UNIONS its own reads onto the customer gatherer's output
      //     (`ops-claim-reads.ts`), so a guard inside the customer gatherer would
      //     silently miss every `ops:*` read. This is the one seam both planes pass
      //     through.
      //   · BEFORE the settle below, not in the write loop — a suppressed read must
      //     never EXECUTE. Running it and discarding the value would still hit the
      //     catalog egress and still populate the per-turn memos, which is precisely
      //     what BKL-273 was careful to avoid.
      //   · On the READ, never on the SPAN — the span still fires, so the question
      //     stays inside §O#15 completeness. LE2-029 measured the alternative: guard
      //     the span and the turn falls off the deterministic path, whereupon the
      //     responder authors the dietary prose itself. That negative result is
      //     carried, not rediscovered.
      //
      // `answer-with-abstention` keys are NOT here (see `buildDietarySuppressionIndex`):
      // CART_CONTENTS renders, and appends its abstention at the copy layer.
      const reads = isDietQualifiedAsk(input.cognition.perception.text)
        ? gathered.filter((r) => !isDietarySuppressedKey(r.key, dietarySuppressedKeys))
        : gathered;

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
