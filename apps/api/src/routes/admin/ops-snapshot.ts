// admin/ops-snapshot.ts — manager-gated ops situational-snapshot (NEW-040).
//
// A single READ-ONLY manager-awareness endpoint that COMPOSES the four ops
// signals built this session — it introduces NO model, NO migration, NO
// mutation and reimplements NO read. It just calls each EXISTING domain read
// service ONCE and folds its return into a compact COUNT/summary sub-object:
//
//   GET /api/admin/ops/snapshot → OpsSnapshot {
//     now, opsAlerts:{open,bySeverity}, incidents:{open},
//     kitchen:{activeTickets,oldestTicketAgeMs,queueDepth}, caixa:{…headline}
//   }
//
// This is the read foundation the future NEW-032 ops-actor persona consumes
// (and a useful manager ops-overview on its own). The `OpsSnapshot` shape is
// kept LOCAL to this route — it is a view-composition, not domain state.
//
// ── Resilience (a situational overview must survive one bad signal) ──────────
//
// The four reads are INDEPENDENT, so they run concurrently under
// `Promise.allSettled` (NOT `Promise.all`). Each promise resolves to its
// already-built summary; if ONE service read rejects (e.g. a projection
// hiccup) the shared `unwrap` accessor LOGS it and substitutes that signal's
// zero/empty fallback, so the endpoint still returns 200 with the other three
// summaries intact. One bad signal must never 500 the whole overview.
//
// Mirrors admin/kitchen.ts / analytics-reports.ts: `withTypeProvider`, lazy
// service construction, a `requireManagerRole` preHandler that fail-closes 403.

import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  createOpsAlertService,
  createIncidentService,
  createKitchenService,
  createDayCloseService,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { todayInRestaurantTz } from "./_date-defaults.js";

// ── Local view-composition types (NOT domain state) ─────────────────────────

/** Non-terminal ops-alert tally per severity band. */
interface SeverityTally {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
}

/** Open ops-alerts summary — the inbox badge count + a small severity tally. */
interface OpsAlertsSummary {
  readonly open: number;
  readonly bySeverity: SeverityTally;
}

/** Open conversation-incidents summary — the attention-badge count. */
interface IncidentsSummary {
  readonly open: number;
}

/** One queue-depth bucket (kept local; `status` widened to string). */
interface OpsQueueDepthEntry {
  readonly status: string;
  readonly count: number;
}

/** Kitchen load summary — active count + oldest wait + per-status depth. */
interface KitchenSummary {
  readonly activeTickets: number;
  readonly oldestTicketAgeMs: number;
  readonly queueDepth: readonly OpsQueueDepthEntry[];
}

/** Today's caixa — compact headline money figures (integer centavos). */
interface CaixaSummary {
  readonly date: string;
  readonly ordersCount: number;
  readonly grossCentavos: number;
  readonly settledCentavos: number;
  readonly refundedCentavos: number;
  readonly netCentavos: number;
}

/** The composed manager situational snapshot. */
interface OpsSnapshot {
  /** The instant the snapshot was assembled (ISO). */
  readonly now: string;
  readonly opsAlerts: OpsAlertsSummary;
  readonly incidents: IncidentsSummary;
  readonly kitchen: KitchenSummary;
  readonly caixa: CaixaSummary;
}

// ── Resilient accessor (DRY — one place for the settle→summary-or-fallback) ──

/**
 * Map a settled read to its value, or LOG + substitute the fallback on
 * rejection. This is the whole resilience contract in one helper: a single
 * signal's failure degrades to a zero/empty sub-summary, never a 500.
 */
function unwrap<T>(
  settled: PromiseSettledResult<T>,
  fallback: T,
  signal: string,
  log: FastifyBaseLogger,
): T {
  if (settled.status === "fulfilled") {
    return settled.value;
  }
  log.error(
    { err: settled.reason, signal },
    "ops-snapshot: signal read failed — degrading to fallback sub-summary",
  );
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

export async function adminOpsSnapshotRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Lazily construct on first request (NOT at registration) so a test mounting
  // the admin plugin with a partial `@ibatexas/domain` mock doesn't trip over a
  // missing factory at register time (mirrors kitchen.ts / ops-alerts.ts).
  let opsAlertSvc: ReturnType<typeof createOpsAlertService> | undefined;
  let incidentSvc: ReturnType<typeof createIncidentService> | undefined;
  let kitchenSvc: ReturnType<typeof createKitchenService> | undefined;
  let dayCloseSvc: ReturnType<typeof createDayCloseService> | undefined;
  const opsAlerts = () => (opsAlertSvc ??= createOpsAlertService({ auditSink: getAuditSink() }));
  const incidents = () => (incidentSvc ??= createIncidentService());
  const kitchen = () => (kitchenSvc ??= createKitchenService());
  const dayClose = () => (dayCloseSvc ??= createDayCloseService());

  // ── GET /api/admin/ops/snapshot — the composed situational overview ─────────
  app.get(
    "/api/admin/ops/snapshot",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Panorama operacional (alertas, incidentes, cozinha, caixa)",
      },
    },
    async (request, reply) => {
      const today = todayInRestaurantTz();

      // Four INDEPENDENT reads, concurrent. Each async IIFE both reads AND folds
      // its result into the compact summary, so `allSettled` captures a read OR
      // a mapping failure and `unwrap` degrades exactly that one signal.
      const [alertsR, incidentsR, kitchenR, caixaR] = await Promise.allSettled([
        // 1. Open ops-alerts — openCount is the INDEPENDENT NON_TERMINAL badge.
        (async (): Promise<OpsAlertsSummary> => {
          const { alerts, openCount } = await opsAlerts().list({});
          return { open: openCount, bySeverity: tallyOpenBySeverity(alerts) };
        })(),
        // 2. Open incidents — `openCount` is the NON_TERMINAL (OPEN + ACKNOWLEDGED)
        //    attention badge, mirroring opsAlerts.open (NOT the OPEN-only stats.open).
        (async (): Promise<IncidentsSummary> => {
          const { openCount } = await incidents().list({});
          return { open: openCount };
        })(),
        // 3. Kitchen load — active count + oldest wait (tickets are oldest-first,
        //    so tickets[0]) + per-status depth. NOT the full ticket list.
        (async (): Promise<KitchenSummary> => {
          const board = await kitchen().getTickets();
          return {
            activeTickets: board.totalActive,
            oldestTicketAgeMs: board.tickets[0]?.ticketAgeMs ?? 0,
            queueDepth: board.queueDepth,
          };
        })(),
        // 4. Today's caixa — compact headline money figures (integer centavos).
        (async (): Promise<CaixaSummary> => {
          const s = await dayClose().getDaySummary(today);
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

      const snapshot: OpsSnapshot = {
        now: new Date().toISOString(),
        opsAlerts: unwrap(
          alertsR,
          { open: 0, bySeverity: { low: 0, medium: 0, high: 0 } },
          "opsAlerts",
          request.log,
        ),
        incidents: unwrap(incidentsR, { open: 0 }, "incidents", request.log),
        kitchen: unwrap(
          kitchenR,
          { activeTickets: 0, oldestTicketAgeMs: 0, queueDepth: [] },
          "kitchen",
          request.log,
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
          request.log,
        ),
      };

      return reply.send(snapshot);
    },
  );
}
