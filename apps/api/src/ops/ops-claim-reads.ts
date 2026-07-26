// ops-claim-reads.ts — the RESOLVERS for the ops-scoped claim types (LE2 ticket
// 12). One `TurnReadGatherer` that the ops `ClaimsPlaneExtension` hands to the
// INVESTIGATE stage, producing the ledger evidence `ops-claim-registry.ts`'s
// `requiredEvidence` keys name.
//
// ── No new read paths (ticket constraint) ────────────────────────────────────
// Every ops read here runs THROUGH the existing ops read roster — the SAME
// `opsReadToolExecutors` map the ops conductor advertises to its planner
// (`ops_snapshot` / `ops_sales_analytics`, the BKL-100/BKL-149 deterministic read
// machinery). This module owns NO query, NO service construction and NO DB/HTTP/
// Redis handle; it calls an executor and folds its return into a pt-BR scalar.
//
// ── Additive, never a replacement ────────────────────────────────────────────
// The gatherer is `customer first-party reads ∪ ops reads`. LE2-011 proved the
// STORE_OPEN_NOW chain end-to-end on the ops plane off the DEFAULT gatherer; a
// replacement would silently break it. The base gatherer is injectable so tests
// can stub the customer half without touching the ops half.
//
// ── The three honesty rules ──────────────────────────────────────────────────
//   1. SPAN-GATED. A read only runs when a DETERMINISTIC pt-BR span for its type
//      fired on this turn's text, so small talk costs nothing and an unrelated
//      staff turn records no ops evidence (whose absence is itself honest — the
//      claim then resolves ABSENT → UNKNOWN, never a stale figure).
//   2. AN EMPTY READ THAT SUCCEEDED IS A FACT. Zero orders / no escalations / no
//      reservations record a PRESENT scalar ("nenhum até agora" / "nenhuma") and
//      VALIDATE — the operator gets a grounded "none", not an honest-ignorance
//      abstain (ticket AC 2).
//   3. AN UNAVAILABLE READ IS NOT A ZERO. The ops composers degrade PER SIGNAL to
//      zero fallbacks and name the fallen signals in `degraded[]`. Rendering those
//      zeros would be the exact "silent R$ 0 / 0 pedidos lies to the operator"
//      class BKL-100 closed. So a degraded signal — or a shape that fails the
//      shared structural guard, or an executor that threw, or an executor missing
//      from the roster — makes the read THROW, which the investigator records as a
//      ledger ERROR (Inv 7: "could not check" ≠ "absent"). The claim can then only
//      reach UNKNOWN and the turn degrades through the skeleton's safe-unknown
//      gate with ZERO invented digits (ticket AC 3).
//
// pt-BR per Hard Rule #4.

import type { CognitiveState } from "@claustrum/core";
import {
  OPS_SNAPSHOT_READ_TOOL,
  OPS_SALES_ANALYTICS_READ_TOOL,
} from "@ibatexas/pack-ops";
import {
  createFirstPartyTurnReads,
  type TurnRead,
  type TurnReadGatherer,
} from "../claustrum/ibatexas-investigator.js";
import {
  isOpsSnapshot,
  isSalesAnalytics,
  reservationStatusLabel,
} from "./ops-read-render.js";
import type { OpsSnapshot } from "./ops-snapshot-compose.js";
import type { SalesAnalytics } from "./sales-analytics-compose.js";
import type { OpsReadToolExecutor } from "./ops-conductor.js";
import {
  OPS_ORDERS_TODAY,
  OPS_ORDERS_TODAY_FIELD,
  OPS_ORDERS_TODAY_KEY,
  OPS_PENDING_ESCALATIONS,
  OPS_PENDING_ESCALATIONS_FIELD,
  OPS_PENDING_ESCALATIONS_KEY,
  OPS_RESERVATIONS_TODAY,
  OPS_RESERVATIONS_TODAY_FIELD,
  OPS_RESERVATIONS_TODAY_KEY,
  type OpsClaimType,
} from "./ops-claim-registry.js";

// ── Deterministic pt-BR span detection ───────────────────────────────────────

/** Strip diacritics + lowercase (the `ops-read-render.ts` normalization idiom). */
function normalizePtBr(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** "hoje" / "do dia" — the current-business-day anchor both day-scoped types need. */
const TODAY_ANCHOR = /\bhoje\b|\bdo dia\b|\bde hoje\b/;

/**
 * The per-type markers. DELIBERATELY TIGHT: this net decides whether a read RUNS,
 * so a loose marker costs a real DB/HTTP round trip on every staff turn AND (via
 * a spurious present ledger entry) could let an unrelated question pick up a
 * store figure. A miss is the SAFE direction — no evidence ⇒ the claim resolves
 * ABSENT ⇒ honest UNKNOWN, never a wrong number.
 *
 *   · ORDERS_TODAY — an order noun AND a today anchor ("quantos pedidos hoje?",
 *     "quantos pedidos tivemos hoje?", "quantas vendas do dia?").
 *   · PENDING_ESCALATIONS — the escalation family, or an explicitly-pending
 *     alert/incident/pendência ask. No today anchor: an open queue is open NOW.
 *   · RESERVATIONS_TODAY — a reservation noun AND a today anchor. The reservation
 *     noun is boundary-anchored so the unrelated `preserv*` family never fires it
 *     (the FE-T17 review fix, applied here too).
 */
const OPS_CLAIM_SPAN_MARKERS: ReadonlyArray<{
  readonly type: OpsClaimType;
  readonly test: (normalized: string) => boolean;
}> = [
  {
    type: OPS_ORDERS_TODAY,
    test: (t) => /(?<![a-z])pedidos?\b|(?<![a-z])vendas?\b/.test(t) && TODAY_ANCHOR.test(t),
  },
  {
    type: OPS_PENDING_ESCALATIONS,
    test: (t) =>
      /(?<![a-z])escala(c|ç)|(?<![a-z])escalad|(?<![a-z])escalona/.test(t) ||
      (/(?<![a-z])(alerta|incidente|pendencia)s?\b/.test(t) &&
        /(?<![a-z])(pendente|aberta|aberto)s?\b|\btem\b|\bhá\b|\bha\b/.test(t)),
  },
  {
    type: OPS_RESERVATIONS_TODAY,
    test: (t) => /(?<![a-z])reservas?\b/.test(t) && TODAY_ANCHOR.test(t),
  },
];

/**
 * The ops claim types this request text asks about (DETERMINISTIC, pure). The
 * SAME net drives the resolvers below, so an ops candidate's evidence key is
 * present exactly when the operator actually asked — the claim planner's tag can
 * never conjure evidence for a question that was not asked. Empty for small talk.
 */
export function detectOpsClaimSpans(text: string): ReadonlySet<OpsClaimType> {
  const normalized = normalizePtBr(text);
  const found = new Set<OpsClaimType>();
  for (const marker of OPS_CLAIM_SPAN_MARKERS) {
    if (marker.test(normalized)) found.add(marker.type);
  }
  return found;
}

// ── Scalar composition (deterministic pt-BR; NEVER model-authored) ───────────

/**
 * Thrown when an ops read cannot be TRUSTED to state a figure — a degraded
 * signal, an unrecognizable shape, or a missing executor. The investigator records
 * it as a ledger ERROR (Inv 7), which is what keeps a fallback ZERO from ever
 * rendering as a real count.
 */
export class OpsReadUnavailable extends Error {
  constructor(signal: string, reason: string) {
    super(`ops read "${signal}" unavailable: ${reason}`);
    this.name = "OpsReadUnavailable";
  }
}

/** Guard: throw unless the composer's `degraded[]` is clean for `signal`. */
function assertSignalRead(degraded: readonly string[], signal: string): void {
  if (degraded.includes(signal)) {
    throw new OpsReadUnavailable(signal, "signal degraded to its zero fallback");
  }
}

/**
 * "quantos pedidos hoje?" → the day's order COUNT. A SUCCESSFUL zero is the
 * grounded "none" answer (AC 2); a degraded `orders` signal throws (AC 3) — the
 * fallback `ordersCount: 0` is indistinguishable from a real slow day and must
 * never be asserted. Pure given the read.
 */
export function composeOrdersTodayText(sales: SalesAnalytics): string {
  assertSignalRead(sales.degraded, "orders");
  const count = sales.orders.ordersCount;
  return count === 0 ? "nenhum até agora" : String(count);
}

/**
 * "tem escalação pendente?" → the store's OPEN operational attention queue.
 *
 * GROUNDED IN WHAT THE ROSTER PROVES: the ops read roster exposes the two durable
 * open-attention queues — ops ALERTS (`ops_stuck_order`, `ops_pix_expiry_backlog`,
 * `ops_dlq_depth`, …) and conversation INCIDENTS. The Redis human-handoff queue
 * behind `/api/admin/escalations` is a THIRD, different set that the roster does
 * not carry, and reading it would be a new read path (forbidden). So the scalar
 * NAMES exactly what it counted ("N alertas … e M incidentes") rather than
 * implying a queue it did not read — the proposition is true of its own referents.
 *
 * BOTH signals must have read cleanly: a partial answer ("3 alertas" while
 * incidents degraded) would understate a pending queue, which on this surface is
 * the dangerous direction. Pure given the read.
 */
export function composeEscalationsText(snapshot: OpsSnapshot): string {
  assertSignalRead(snapshot.degraded, "opsAlerts");
  assertSignalRead(snapshot.degraded, "incidents");
  const alerts = snapshot.opsAlerts.open;
  const incidents = snapshot.incidents.open;
  if (alerts === 0 && incidents === 0) return "nenhuma";
  const parts: string[] = [];
  if (alerts > 0) {
    const sev = snapshot.opsAlerts.bySeverity;
    parts.push(
      `${alerts} ${alerts === 1 ? "alerta" : "alertas"} ` +
        `(${sev.high} de alta, ${sev.medium} de média, ${sev.low} de baixa)`,
    );
  }
  if (incidents > 0) {
    parts.push(`${incidents} ${incidents === 1 ? "incidente" : "incidentes"}`);
  }
  return parts.join(" e ");
}

/**
 * "quais reservas hoje?" → today's reservation total + the per-status tally, in
 * the SAME pt-BR the panorama render speaks (`reservationStatusLabel`). A
 * SUCCESSFUL zero renders the grounded "nenhuma" (AC 2); a degraded `reservations`
 * signal throws (AC 3). Pure given the read.
 */
export function composeReservationsTodayText(snapshot: OpsSnapshot): string {
  assertSignalRead(snapshot.degraded, "reservations");
  const { total, byStatus } = snapshot.reservations;
  if (total === 0) return "nenhuma";
  const tally = byStatus
    .map((b) => `${reservationStatusLabel(b.status)} ${b.count}`)
    .join(", ");
  return tally.length > 0 ? `${total} (${tally})` : String(total);
}

// ── The gatherer ─────────────────────────────────────────────────────────────

export interface OpsClaimTurnReadsDeps {
  /**
   * The ops read roster — the SAME `opsReadToolExecutors` map the conductor
   * advertises to its planner. MUST be the RAW map, never the conductor's
   * capture-wrapping wrapper: a capture would make the per-turn read buffer
   * non-empty and lattice rule 3c would then hand the turn to the BKL-100
   * deterministic panorama render instead of the ops CLAIM render. The capture
   * buffer answers "what did the MODEL ask to read"; these resolvers are the
   * investigator's own deterministic evidence gathering.
   */
  readonly executors: Readonly<Record<string, OpsReadToolExecutor>>;
  /**
   * The customer/base first-party reads to UNION with. Defaults to the real
   * `createFirstPartyTurnReads()` — the SAME gatherer `buildClaimsSeams` uses by
   * default, so the ops plane keeps every customer-scoped chain LE2-011 proved on
   * it (notably STORE_OPEN_NOW) verbatim.
   */
  readonly baseReads?: TurnReadGatherer;
}

/**
 * Build the OPS plane's `TurnReadGatherer`: the base first-party reads PLUS one
 * ops read per DETECTED ops span. Each ops executor is invoked AT MOST ONCE per
 * turn (memoized per gather call), so the two `ops_snapshot`-backed types share a
 * single snapshot read — the same figure backs both claims, and there is no way
 * for two reads of the same turn to disagree.
 */
export function createOpsClaimTurnReads(
  deps: OpsClaimTurnReadsDeps,
): TurnReadGatherer {
  const baseReads = deps.baseReads ?? createFirstPartyTurnReads();

  return async (input) => {
    const base = await baseReads(input);
    const wanted = detectOpsClaimSpans(input.cognition.perception.text);
    if (wanted.size === 0) return base;

    // Per-gather memos: ONE call per executor per turn, shared by every claim that
    // reads from it. The promise is created lazily so an undetected span costs
    // nothing.
    const memo = new Map<string, Promise<unknown>>();
    const runRead = async (name: string, state: CognitiveState): Promise<unknown> => {
      const cached = memo.get(name);
      if (cached !== undefined) return cached;
      const execute = deps.executors[name];
      if (execute === undefined) {
        // A roster gap is "could not check", never "nothing to report" (Inv 7).
        const failed = Promise.reject(
          new OpsReadUnavailable(name, "no executor registered on the ops read roster"),
        );
        // Pre-attach a no-op catch so an unconsumed memo can never surface as an
        // unhandled rejection; the consumer below still awaits and sees the throw.
        failed.catch(() => {});
        memo.set(name, failed);
        return failed;
      }
      const pending = execute({}, state);
      memo.set(name, pending);
      return pending;
    };

    const readSnapshot = async (state: CognitiveState): Promise<OpsSnapshot> => {
      const result = await runRead(OPS_SNAPSHOT_READ_TOOL, state);
      if (!isOpsSnapshot(result)) {
        throw new OpsReadUnavailable(OPS_SNAPSHOT_READ_TOOL, "unrecognized read shape");
      }
      return result;
    };
    const readSales = async (state: CognitiveState): Promise<SalesAnalytics> => {
      const result = await runRead(OPS_SALES_ANALYTICS_READ_TOOL, state);
      if (!isSalesAnalytics(result)) {
        throw new OpsReadUnavailable(
          OPS_SALES_ANALYTICS_READ_TOOL,
          "unrecognized read shape",
        );
      }
      return result;
    };

    const state = input.cognition;
    const opsReads: TurnRead[] = [];

    if (wanted.has(OPS_ORDERS_TODAY)) {
      opsReads.push({
        key: OPS_ORDERS_TODAY_KEY,
        source: OPS_SALES_ANALYTICS_READ_TOOL,
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => ({
          [OPS_ORDERS_TODAY_FIELD]: composeOrdersTodayText(await readSales(state)),
        }),
      });
    }
    if (wanted.has(OPS_PENDING_ESCALATIONS)) {
      opsReads.push({
        key: OPS_PENDING_ESCALATIONS_KEY,
        source: OPS_SNAPSHOT_READ_TOOL,
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => ({
          [OPS_PENDING_ESCALATIONS_FIELD]: composeEscalationsText(
            await readSnapshot(state),
          ),
        }),
      });
    }
    if (wanted.has(OPS_RESERVATIONS_TODAY)) {
      opsReads.push({
        key: OPS_RESERVATIONS_TODAY_KEY,
        source: OPS_SNAPSHOT_READ_TOOL,
        origin: "TRUSTED",
        originProvenance: "FIRST_PARTY",
        sourceMode: "live",
        read: async () => ({
          [OPS_RESERVATIONS_TODAY_FIELD]: composeReservationsTodayText(
            await readSnapshot(state),
          ),
        }),
      });
    }

    return [...base, ...opsReads];
  };
}
