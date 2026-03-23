// Register all BullMQ workers and repeatable job schedules.
// Called once from server startup after all routes are registered.

import type { FastifyBaseLogger } from "fastify";
import { startAbandonedCartChecker } from "./abandoned-cart-checker.js";
import { startNoShowChecker } from "./no-show-checker.js";
import { startOutboxRetry } from "./outbox-retry.js";
import { startReviewPromptPoller } from "./review-prompt-poller.js";
import { startReservationReminder } from "./reservation-reminder.js";
import { startPixExpiryChecker } from "./pix-expiry-checker.js";

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

  await Promise.all([
    stopAbandonedCartChecker(),
    stopNoShowChecker(),
    stopOutboxRetry(),
    stopReviewPromptPoller(),
    stopReservationReminder(),
    stopPixExpiryChecker(),
  ]);
}
