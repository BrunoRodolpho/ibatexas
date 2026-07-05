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
import { startLlmTokenUsageRetention } from "./llm-token-usage-retention.js";
import { startDriftEvaluate } from "./drift-evaluate.js";
import { startDlqDepthChecker } from "./dlq-depth-checker.js";
import { startEscalationParkExpirySweeper } from "./escalation-park-expiry-sweeper.js";
import { startObservabilityLivenessChecker } from "./observability-liveness-checker.js";

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
  // [item C / #94-16] Daily bounded sweep of the append-only llm_token_usage
  // cost-telemetry table. DEDICATED knob LLM_TOKEN_USAGE_RETENTION_DAYS,
  // DEFAULTS to 30 (not opt-in) so the table can't grow unbounded by default.
  startLlmTokenUsageRetention(log);
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
  // [NEW-025] Deterministic ops watchdog: SCANs the Redis DLQ lists every 5 min
  // and raises a governed ops-alert (ops.alert.open / ops_dlq_depth) when a
  // dead-letter queue crosses the alert threshold; AUTO-resolves when it drains.
  // Surfaces DLQ backlog to the admin ops inbox + the ops agent (was Sentry-only).
  startDlqDepthChecker(log);
  // [BKL-114] SCANs the full escalation:rec:* namespace every 5 min and flips
  // pendingIntents[] rows from "pending" → "expired" when their backing park
  // token has TTL-lapsed (queue hygiene — money is unaffected; a lapsed token
  // already 404s on resolve). CAS-guarded so a since-resolved row is never
  // clobbered; runs a startup recovery sweep for parks that lapsed while down.
  startEscalationParkExpirySweeper(log);
  // [BKL-109] Probes VictoriaLogs + VictoriaMetrics /health every 5 min and raises
  // a governed ops-alert (ops_observability_down) when the obs plane is DOWN while
  // the api is UP — the 2026-07-04 log-unrecoverable window that surfaced nowhere.
  // Debounced (N consecutive DOWN sweeps); AUTO-resolves on the first UP sweep.
  // Self-disables when VICTORIALOGS_URL is unset (obs stack not configured).
  startObservabilityLivenessChecker(log);
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
  const { stopLlmTokenUsageRetention } = await import(
    "./llm-token-usage-retention.js"
  );
  const { stopDriftEvaluate } = await import("./drift-evaluate.js");
  const { stopDlqDepthChecker } = await import("./dlq-depth-checker.js");
  const { stopEscalationParkExpirySweeper } = await import(
    "./escalation-park-expiry-sweeper.js"
  );
  const { stopObservabilityLivenessChecker } = await import(
    "./observability-liveness-checker.js"
  );

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
    stopLlmTokenUsageRetention(),
    stopDeferTimeoutSweeper(),
    stopAnonymizeMedusaRetry(),
    stopDriftEvaluate(),
    stopDlqDepthChecker(),
    stopEscalationParkExpirySweeper(),
    stopObservabilityLivenessChecker(),
  ]);
}
