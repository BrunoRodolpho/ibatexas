// ops-alert-reconcile.ts — shared raise/AUTO-resolve helper for the deterministic
// ops watchdogs (NEW-025 / BKL-080). A watchdog computes ONE per-sweep count for a
// single global condition (stuck-order cancellations, PIX expiries, stale-defer
// timeouts); this reconciles that against the ops-alert plane: RAISE (fold) a
// governed `ops.alert.open` while the count is over threshold, AUTO-resolve the
// open alert once the condition clears. Mirrors the DLQ-depth watchdog's
// per-condition raise/resolve, factored out so the three sweep jobs share it.
//
// Every mutation is a SYSTEM-actor `ops.alert.*` IntentEnvelope (buildSystemEnvelope)
// governed by the SYSTEM-only ops-alert policy bundle (CLAUDE.md #9). The caller
// wraps this in try/catch so an ops-alert failure NEVER breaks the watchdog's
// core detect-and-act job (defense-in-depth: the alert is observability).

import type { OpsAlertOpenPayload, OpsAlertService } from "@ibatexas/domain";
import { buildSystemEnvelope } from "../subscribers/__shared__/system-actor-envelope.js";

/**
 * Severity band for a per-sweep count crossing `threshold`. Only ever evaluated
 * when the count is at/over threshold (the raise gate), so there is no `low`:
 *   - `high`   ≥ 3× threshold (a serious spike)
 *   - `medium` otherwise (crossed — worth surfacing)
 */
export function sweepCountSeverity(
  count: number,
  threshold: number,
): "medium" | "high" {
  return count >= threshold * 3 ? "high" : "medium";
}

/**
 * Reconcile a single-condition ops-alert against the current sweep observation.
 * `over` = the condition is at/over threshold THIS sweep.
 *   - `over` → RAISE (or fold) the `open` alert (one OPEN row per `open.dedupeKey`).
 *   - not `over` → AUTO-resolve the condition's open alert if one exists (no-op otherwise).
 * `now` distinguishes each sweep's audited envelope (a stable per-condition dedupeKey
 * still folds the row; the nonce varies so each observation is its own audit event).
 */
export async function reconcileSweepOpsAlert(args: {
  readonly svc: OpsAlertService;
  readonly over: boolean;
  readonly open: OpsAlertOpenPayload;
  readonly sourceSubject: string;
  readonly now: number;
  readonly log?: { warn?: (...a: unknown[]) => void };
}): Promise<void> {
  const { svc, over, open, sourceSubject, now, log } = args;

  if (over) {
    const envelope = buildSystemEnvelope({
      kind: "ops.alert.open" as const,
      payload: open,
      sourceSubject,
      eventId: `${open.dedupeKey}:${now}`,
    });
    const outcome = await svc.openAlertFromEnvelope(envelope, {});
    if (outcome.decision.kind !== "EXECUTE") {
      log?.warn?.(
        { dedupeKey: open.dedupeKey, decision: outcome.decision.kind },
        "[ops-alert] open not authorized — skipping",
      );
    }
    return;
  }

  // Condition cleared → AUTO-resolve the open alert for THIS exact condition.
  const { alerts } = await svc.list({ cause: open.cause, limit: 500 });
  const openRow = alerts.find(
    (a) =>
      (a.status === "OPEN" || a.status === "ACKNOWLEDGED") &&
      a.dedupeKey === open.dedupeKey,
  );
  if (openRow) {
    const envelope = buildSystemEnvelope({
      kind: "ops.alert.resolve" as const,
      payload: { id: openRow.id, resolvedBy: "system", resolutionType: "AUTO" as const },
      sourceSubject,
      eventId: `${open.dedupeKey}:resolve:${now}`,
    });
    await svc.resolveAlertFromEnvelope(envelope, {});
  }
}
