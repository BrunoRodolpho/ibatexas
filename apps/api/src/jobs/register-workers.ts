// Register all BullMQ workers and repeatable job schedules.
// Called once from server startup after all routes are registered.

import type { FastifyBaseLogger } from "fastify";
import { startAbandonedCartChecker } from "./abandoned-cart-checker.js";
import { startNoShowChecker } from "./no-show-checker.js";
import { startOutboxRetry } from "./outbox-retry.js";
import { startReviewPromptPoller } from "./review-prompt-poller.js";
import { startReservationReminder } from "./reservation-reminder.js";
import { startPixExpiryChecker } from "./pix-expiry-checker.js";
import { startProactiveEngagement } from "./proactive-engagement.js";
import { startFollowUpPoller } from "./follow-up-poller.js";
import { startHesitationNudgeWorker } from "./hesitation-nudge.js";
import { startPixExpiryMonitor } from "./pix-expiry-monitor.js";
import { startStaleOrderChecker } from "./stale-order-checker.js";
import { startDeferTimeoutSweeper } from "./defer-timeout-sweeper.js";
import { startAnonymizeMedusaRetry } from "./anonymize-medusa-retry.js";
import { startRetentionCleaner } from "./retention-cleaner.js";
import { startDriftEvaluate } from "./drift-evaluate.js";

/**
 * Start all background job workers and their repeatable schedules.
 */
export function registerWorkers(log: FastifyBaseLogger): void {
  startReservationReminder(log);
  startNoShowChecker(log);
  startReviewPromptPoller(log);
  startAbandonedCartChecker(log);
  startOutboxRetry(log);
  startPixExpiryChecker(log);
  startProactiveEngagement(log);
  startFollowUpPoller(log);
  startHesitationNudgeWorker();
  startPixExpiryMonitor();
  startStaleOrderChecker(log);
  // [audit-2026-05-27 P3-SCALE-RETENTION] Daily bounded sweep of the two
  // append-only tables (conversation_messages by sent_at, order_event_log by
  // created_at). OPT-IN via RETENTION_DAYS — no-op unless configured.
  startRetentionCleaner(log);
  // [task 03] Sweeps expired defer:pending:* keys every 60s and publishes
  // intent.defer.timeout for downstream notification fan-out.
  startDeferTimeoutSweeper(log);
  // [audit-2026-05-24 H3 Wave-B] Sweeps anonymize:medusa:pending:* every
  // 5 min and re-publishes pending events whose subscriber pass failed.
  // Emits .exhausted after MEDUSA_ANONYMIZE_MAX_ATTEMPTS (~1h budget).
  startAnonymizeMedusaRetry(log);
  // [F3] Recomputes behavioral drift every IBX_DRIFT_EVAL_INTERVAL_MS and
  // publishes ibx_behavioral_drift_* gauges/counter on the shared kernel
  // registry so GET /metrics exposes them. Fail-open; never blocks a turn.
  startDriftEvaluate(log);
}

/**
 * Gracefully shut down all background job workers.
 */
export async function shutdownWorkers(): Promise<void> {
  const { stopAbandonedCartChecker } = await import("./abandoned-cart-checker.js");
  const { stopNoShowChecker } = await import("./no-show-checker.js");
  const { stopOutboxRetry } = await import("./outbox-retry.js");
  const { stopReviewPromptPoller } = await import("./review-prompt-poller.js");
  const { stopReservationReminder } = await import("./reservation-reminder.js");
  const { stopPixExpiryChecker } = await import("./pix-expiry-checker.js");
  const { stopProactiveEngagement } = await import("./proactive-engagement.js");
  const { stopFollowUpPoller } = await import("./follow-up-poller.js");
  const { stopHesitationNudgeWorker } = await import("./hesitation-nudge.js");
  const { stopPixExpiryMonitor } = await import("./pix-expiry-monitor.js");
  const { stopStaleOrderChecker } = await import("./stale-order-checker.js");
  const { stopDeferTimeoutSweeper } = await import("./defer-timeout-sweeper.js");
  const { stopAnonymizeMedusaRetry } = await import("./anonymize-medusa-retry.js");
  const { stopRetentionCleaner } = await import("./retention-cleaner.js");
  const { stopDriftEvaluate } = await import("./drift-evaluate.js");

  await Promise.all([
    stopAbandonedCartChecker(),
    stopNoShowChecker(),
    stopOutboxRetry(),
    stopReviewPromptPoller(),
    stopReservationReminder(),
    stopPixExpiryChecker(),
    stopProactiveEngagement(),
    stopFollowUpPoller(),
    stopHesitationNudgeWorker(),
    stopPixExpiryMonitor(),
    stopStaleOrderChecker(),
    stopRetentionCleaner(),
    stopDeferTimeoutSweeper(),
    stopAnonymizeMedusaRetry(),
    stopDriftEvaluate(),
  ]);
}
