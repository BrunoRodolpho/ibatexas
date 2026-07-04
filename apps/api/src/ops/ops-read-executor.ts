// ops-read-executor.ts — the `ops_snapshot` planner READ-tool executor (NEW-032).
//
// The claustrum planner's one-hop enrichment loop runs an advertised read via an
// injected `readToolExecutors` map (same seam the chat plane's
// IBATEXAS_READ_TOOL_EXECUTORS uses). This module builds the ONE ops read
// executor — the situational snapshot — over the shared `composeOpsSnapshot`.
//
// It is registered in TWO maps:
//   - the OPS conductor planner's `readToolExecutors` — where `ops_snapshot` is
//     ADVERTISED (staff session) and therefore REACHABLE; and
//   - the CHAT plane's IBATEXAS_READ_TOOL_EXECUTORS — where it is NEVER
//     advertised (deriveIbatexasPlannerContext pins staffId:null) but MUST be
//     registered so the fail-closed readToolRosterDrift boot gate's STAFF probe
//     stays green (opsCapabilityPlanner is in IBATEXAS_COMPOSED_CAPABILITY_
//     PLANNERS, so that probe now sees `ops_snapshot` advertised).
//
// The snapshot is staff-data read-only (alerts + incidents + kitchen + caixa) —
// no owner scope, no customer identity, no mutation — so registering it on the
// chat map is safe even though it is unreachable there.

import type { CognitiveState } from "@claustrum/core";
import {
  createOpsAlertService,
  createIncidentService,
  createKitchenService,
  createDayCloseService,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { logger } from "../lib/logger.js";
import { todayInRestaurantTz } from "../routes/admin/_date-defaults.js";
import { composeOpsSnapshot, type OpsSnapshot } from "./ops-snapshot-compose.js";

/** The advertised read-tool NAME (mirrors pack-ops OPS_SNAPSHOT_READ_TOOL). */
export const OPS_SNAPSHOT_READ_TOOL = "ops_snapshot";

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
      today: todayInRestaurantTz(),
      log: logger,
    });
}
