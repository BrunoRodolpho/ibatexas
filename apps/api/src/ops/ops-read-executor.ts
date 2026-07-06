// ops-read-executor.ts — the ops planner READ-tool executors (NEW-032, NEW-012).
//
// The claustrum planner's one-hop enrichment loop runs an advertised read via an
// injected `readToolExecutors` map (same seam the chat plane's
// IBATEXAS_READ_TOOL_EXECUTORS uses). This module builds the ops read executors:
//   - `ops_snapshot` (NEW-032) — the situational snapshot over the shared
//     `composeOpsSnapshot` (alerts + incidents + kitchen + caixa); and
//   - `ops_sales_analytics` (NEW-012) — today's sales over the shared
//     `composeSalesAnalytics` (orders/revenue/AOV + carts + new customers + WA
//     funnel).
//
// Each is registered in TWO maps:
//   - the OPS conductor planner's `readToolExecutors` — where the read is
//     ADVERTISED (staff session) and therefore REACHABLE; and
//   - the CHAT plane's IBATEXAS_READ_TOOL_EXECUTORS — where it is NEVER
//     advertised (deriveIbatexasPlannerContext pins staffId:null) but MUST be
//     registered so the fail-closed readToolRosterDrift boot gate's STAFF probe
//     stays green (opsCapabilityPlanner is in IBATEXAS_COMPOSED_CAPABILITY_
//     PLANNERS, so that probe sees both reads advertised).
//
// Both reads are staff-data read-only — no owner scope, no customer identity, no
// mutation, no money authority — so registering them on the chat map is safe
// even though they are unreachable there.

import type { CognitiveState } from "@claustrum/core";
import {
  createOpsAlertService,
  createIncidentService,
  createKitchenService,
  createDayCloseService,
  createReservationService,
  prisma,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { getRedisClient, medusaAdmin } from "@ibatexas/tools";
import { logger } from "../lib/logger.js";
import { todayInRestaurantTz } from "../routes/admin/_date-defaults.js";
import { composeOpsSnapshot, type OpsSnapshot } from "./ops-snapshot-compose.js";
import {
  composeSalesAnalytics,
  type SalesAnalytics,
} from "./sales-analytics-compose.js";

/** The advertised read-tool NAME (mirrors pack-ops OPS_SNAPSHOT_READ_TOOL). */
export const OPS_SNAPSHOT_READ_TOOL = "ops_snapshot";

/** The sales-analytics read-tool NAME (mirrors pack-ops OPS_SALES_ANALYTICS_READ_TOOL). */
export const OPS_SALES_ANALYTICS_READ_TOOL = "ops_sales_analytics";

/**
 * Build the `ops_snapshot` read executor. The input/state are IGNORED (the
 * snapshot is a fixed staff-data situational read — no per-turn parameters, no
 * owner scope); the executor lazily constructs each `@ibatexas/domain` read
 * service and folds the four signals via the shared `composeOpsSnapshot`. Never
 * throws out of a single signal (composeOpsSnapshot degrades per-signal).
 */
export function createOpsSnapshotReadExecutor(): (
  input: unknown,
  state: CognitiveState,
) => Promise<OpsSnapshot> {
  return async () =>
    composeOpsSnapshot({
      opsAlerts: () => createOpsAlertService({ auditSink: getAuditSink() }),
      incidents: () => createIncidentService(),
      kitchen: () => createKitchenService(),
      dayClose: () => createDayCloseService(),
      reservations: () => createReservationService(),
      today: todayInRestaurantTz(),
      log: logger,
    });
}

/**
 * Build the `ops_sales_analytics` read executor (NEW-012). Like the snapshot
 * above, the input/state are IGNORED (a fixed staff-data sales read — no
 * per-turn parameters, no owner scope); it binds the real reads the analytics-
 * summary route uses (`medusaAdmin` orders HTTP, `prisma.customer.count`, the
 * Redis WA-funnel metrics) into the shared `composeSalesAnalytics`, which
 * degrades per-signal (never throws out of one bad read).
 */
export function createSalesAnalyticsReadExecutor(): (
  input: unknown,
  state: CognitiveState,
) => Promise<SalesAnalytics> {
  return async () =>
    composeSalesAnalytics({
      medusaAdmin: (path) => medusaAdmin(path),
      countNewCustomers: (since) =>
        prisma.customer.count({ where: { createdAt: { gte: since } } }),
      redisGet: async (key) => (await getRedisClient()).get(key),
      now: new Date(),
      log: logger,
    });
}
