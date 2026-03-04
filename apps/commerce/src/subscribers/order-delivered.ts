/**
 * Subscriber: order.delivered
 * Schedules a review prompt 24 hours after delivery confirmation.
 * Uses NATS to fire the review.prompt.scheduled event.
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { publishNatsEvent } from "@ibatexas/nats-client"

export default async function orderDeliveredHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    const orderId = data.id
    logger.info(`[Review Prompt] order.delivered: ${orderId} — scheduling review prompt`)

    // Fire event for API review-prompt-poller to pick up
    await publishNatsEvent("review.prompt.schedule", {
      orderId,
      deliveredAt: new Date().toISOString(),
      // customerId will be resolved by the API when processing this event
    })

    logger.info(`[Review Prompt] review.prompt.schedule published for order ${orderId}`)
  } catch (error) {
    // Non-blocking: review prompt scheduling must not affect order flow
    logger.error(
      `[Review Prompt] order.delivered handler failed for ${data.id}:`,
      error instanceof Error ? error : new Error(String(error)),
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.delivered",
}
