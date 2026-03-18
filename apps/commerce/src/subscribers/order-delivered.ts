/**
 * Subscriber: order.delivered
 * Schedules a review prompt 24 hours after delivery confirmation.
 * Uses NATS to fire the review.prompt.scheduled event.
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { publishNatsEvent } from "@ibatexas/nats-client"

export default async function orderDeliveredHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  try {
    const orderId = data.id
    logger.info(`[Review Prompt] order.delivered: ${orderId} — scheduling review prompt`)

    // Resolve order to get customerId (required by review.prompt.schedule subscriber)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ["id", "customer_id"],
      filters: { id: orderId },
    })
    const order = orders[0]
    if (!order?.customer_id) {
      logger.warn(`[Review Prompt] order.delivered: ${orderId} — no customer_id, skipping review prompt`)
      return
    }

    // Fire event for API review-prompt-poller to pick up
    await publishNatsEvent("review.prompt.schedule", {
      orderId,
      customerId: order.customer_id,
      deliveredAt: new Date().toISOString(),
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
