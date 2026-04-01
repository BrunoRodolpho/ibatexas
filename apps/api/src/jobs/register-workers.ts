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
  ]);
}
