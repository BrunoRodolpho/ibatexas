// ops-snapshot-compose.ts — the shared situational-snapshot composition.
//
// Extracted from `routes/admin/ops-snapshot.ts` (NEW-040) so ONE implementation
// backs BOTH consumers:
//   - GET /api/admin/ops/snapshot (the manager HTTP overview), and
//   - the ops-actor conductor's `ops_snapshot` READ tool (NEW-032 slice B) —
//     the LLM-visible situational read answering "como foi o dia? / como tá a
//     cozinha?".
//
// It reimplements NO domain read: it calls each EXISTING @ibatexas/domain read
// service ONCE and folds its return into a compact COUNT/summary sub-object. The
// four service accessors are INJECTED so the read is unit-testable with fakes
// (no DB); the route + the executor pass the real `@ibatexas/domain` factories.
//
// Resilience (a situational overview must survive one bad signal): the four
// reads are INDEPENDENT, so they run concurrently under `Promise.allSettled`
// (NOT `Promise.all`). If ONE read rejects, `unwrap` LOGS it and substitutes
// that signal's zero/empty fallback, so the snapshot still returns with the
// other three summaries intact. One bad signal must never fail the whole
// overview.

import type {
  createOpsAlertService,
  createIncidentService,
  createKitchenService,
  createDayCloseService,
} from "@ibatexas/domain";

// ── View-composition types (NOT domain state) ───────────────────────────────

/** Non-terminal ops-alert tally per severity band. */
export interface SeverityTally {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
}

/** Open ops-alerts summary — the inbox badge count + a small severity tally. */
export interface OpsAlertsSummary {
  readonly open: number;
  readonly bySeverity: SeverityTally;
}

/** Open conversation-incidents summary — the attention-badge count. */
export interface IncidentsSummary {
  readonly open: number;
}

/** One queue-depth bucket (kept local; `status` widened to string). */
export interface OpsQueueDepthEntry {
  readonly status: string;
  readonly count: number;
}

/** Kitchen load summary — active count + oldest wait + per-status depth. */
export interface KitchenSummary {
  readonly activeTickets: number;
  readonly oldestTicketAgeMs: number;
  readonly queueDepth: readonly OpsQueueDepthEntry[];
}

/** Today's caixa — compact headline money figures (integer centavos). */
export interface CaixaSummary {
  readonly date: string;
  readonly ordersCount: number;
  readonly grossCentavos: number;
  readonly settledCentavos: number;
  readonly refundedCentavos: number;
  readonly netCentavos: number;
}

/** The composed manager situational snapshot. */
export interface OpsSnapshot {
  /** The instant the snapshot was assembled (ISO). */
  readonly now: string;
  readonly opsAlerts: OpsAlertsSummary;
  readonly incidents: IncidentsSummary;
  readonly kitchen: KitchenSummary;
  readonly caixa: CaixaSummary;
  /**
   * BKL-100 — the signal names that FAILED to read this turn and degraded to
   * their zero/empty fallback (a subset of `"opsAlerts" | "incidents" |
   * "kitchen" | "caixa"`). A renderer MUST render a degraded signal as
   * "indisponível", NEVER as its fallback ZEROS: a silent zero is
   * indistinguishable from a real "0 pedidos / caixa zerado" and lies to the
   * operator. Empty ⇒ every signal read cleanly. Additive: the /api/admin/ops/
   * snapshot route sends the whole object (no response schema), so it now also
   * carries this field.
   */
  readonly degraded: readonly string[];
}

// ── Injected dependencies ────────────────────────────────────────────────────

/** Minimal logger surface — only `.error` is used (a degraded signal). */
export interface OpsSnapshotLog {
  error(obj: unknown, msg?: string): void;
}

/**
 * The four read-service accessors + the restaurant-tz `today` + a logger. Each
 * accessor is a lazy getter (the route memoizes construction; the executor
 * builds a fresh one per call) — kept as functions so a partial `@ibatexas/
 * domain` mock is only touched when its signal actually reads.
 */
export interface OpsSnapshotComposeDeps {
  readonly opsAlerts: () => ReturnType<typeof createOpsAlertService>;
  readonly incidents: () => ReturnType<typeof createIncidentService>;
  readonly kitchen: () => ReturnType<typeof createKitchenService>;
  readonly dayClose: () => ReturnType<typeof createDayCloseService>;
  /** Today in the restaurant timezone (YYYY-MM-DD). */
  readonly today: string;
  readonly log: OpsSnapshotLog;
}

// ── Resilient accessor (DRY — one place for settle→summary-or-fallback) ──────

/**
 * Map a settled read to its value, or LOG + substitute the fallback on
 * rejection. This is the whole resilience contract in one helper: a single
 * signal's failure degrades to a zero/empty sub-summary, never a throw. On
 * rejection it ALSO records the signal name in `degraded` (BKL-100) so the
 * renderer can distinguish a real zero from an unavailable read.
 */
function unwrap<T>(
  settled: PromiseSettledResult<T>,
  fallback: T,
  signal: string,
  log: OpsSnapshotLog,
  degraded: string[],
): T {
  if (settled.status === "fulfilled") {
    return settled.value;
  }
  log.error(
    { err: settled.reason, signal },
    "ops-snapshot: signal read failed — degrading to fallback sub-summary",
  );
  degraded.push(signal);
  return fallback;
}

/** Tally non-terminal (OPEN + ACKNOWLEDGED) alerts by severity band. */
function tallyOpenBySeverity(
  alerts: ReadonlyArray<{ status: string; severity: string }>,
): SeverityTally {
  const tally = { low: 0, medium: 0, high: 0 };
  for (const a of alerts) {
    if (a.status !== "OPEN" && a.status !== "ACKNOWLEDGED") continue;
    if (a.severity === "low" || a.severity === "medium" || a.severity === "high") {
      tally[a.severity] += 1;
    }
  }
  return tally;
}

/**
 * Compose the situational snapshot from the four INDEPENDENT reads. Never
 * throws — a single failing signal degrades to its zero/empty fallback.
 */
export async function composeOpsSnapshot(
  deps: OpsSnapshotComposeDeps,
): Promise<OpsSnapshot> {
  const { today, log } = deps;

  // Four INDEPENDENT reads, concurrent. Each async IIFE both reads AND folds its
  // result into the compact summary, so `allSettled` captures a read OR a
  // mapping failure and `unwrap` degrades exactly that one signal.
  const [alertsR, incidentsR, kitchenR, caixaR] = await Promise.allSettled([
    // 1. Open ops-alerts — openCount is the INDEPENDENT NON_TERMINAL badge.
    (async (): Promise<OpsAlertsSummary> => {
      const { alerts, openCount } = await deps.opsAlerts().list({});
      return { open: openCount, bySeverity: tallyOpenBySeverity(alerts) };
    })(),
    // 2. Open incidents — `openCount` is the NON_TERMINAL (OPEN + ACKNOWLEDGED)
    //    attention badge, mirroring opsAlerts.open (NOT the OPEN-only stats.open).
    (async (): Promise<IncidentsSummary> => {
      const { openCount } = await deps.incidents().list({});
      return { open: openCount };
    })(),
    // 3. Kitchen load — active count + oldest wait (tickets are oldest-first,
    //    so tickets[0]) + per-status depth. NOT the full ticket list.
    (async (): Promise<KitchenSummary> => {
      const board = await deps.kitchen().getTickets();
      return {
        activeTickets: board.totalActive,
        oldestTicketAgeMs: board.tickets[0]?.ticketAgeMs ?? 0,
        queueDepth: board.queueDepth,
      };
    })(),
    // 4. Today's caixa — compact headline money figures (integer centavos).
    (async (): Promise<CaixaSummary> => {
      const s = await deps.dayClose().getDaySummary(today);
      return {
        date: s.date,
        ordersCount: s.orders.count,
        grossCentavos: s.orders.grossCentavos,
        settledCentavos: s.settled.totalCentavos,
        refundedCentavos: s.refunds.totalCentavos,
        netCentavos: s.netCentavos,
      };
    })(),
  ]);

  // Populated by the `unwrap` calls below (object properties evaluate top-to-
  // bottom, and `degraded` is read LAST) — so by the time it is spread it holds
  // every signal that fell back.
  const degraded: string[] = [];
  return {
    now: new Date().toISOString(),
    opsAlerts: unwrap(
      alertsR,
      { open: 0, bySeverity: { low: 0, medium: 0, high: 0 } },
      "opsAlerts",
      log,
      degraded,
    ),
    incidents: unwrap(incidentsR, { open: 0 }, "incidents", log, degraded),
    kitchen: unwrap(
      kitchenR,
      { activeTickets: 0, oldestTicketAgeMs: 0, queueDepth: [] },
      "kitchen",
      log,
      degraded,
    ),
    caixa: unwrap(
      caixaR,
      {
        date: today,
        ordersCount: 0,
        grossCentavos: 0,
        settledCentavos: 0,
        refundedCentavos: 0,
        netCentavos: 0,
      },
      "caixa",
      log,
      degraded,
    ),
    degraded,
  };
}
