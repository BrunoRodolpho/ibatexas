// NATS subscriber: cart + intelligence events
//
// Listens for:
//   ibatexas.cart.abandoned   → sends push/WhatsApp nudge (via NATS relay), updates Redis profile
//   ibatexas.order.placed     → bulk-insert CustomerOrderItem, update copurchase scores, global score
//   ibatexas.product.viewed   → update recentlyViewed in Redis customer profile

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import { getRedisClient, rk, PROFILE_TTL_SECONDS } from "@ibatexas/tools";
import { prisma } from "@ibatexas/domain";
import type { FastifyBaseLogger } from "fastify";

const RECENTLY_VIEWED_MAX = 20;
const NATS_DEDUP_TTL = 604_800; // 7 days — matches Stripe webhook window

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * NATS idempotency guard — prevents duplicate processing on redelivery.
 * Returns true if this event has NOT been processed yet (safe to proceed).
 * Returns false if already processed (skip handler).
 */
async function isNewEvent(eventKey: string): Promise<boolean> {
  const redis = await getRedisClient();
  // SET NX with TTL — only succeeds if key doesn't exist
  const result = await redis.set(rk(`nats:processed:${eventKey}`), "1", { EX: NATS_DEDUP_TTL, NX: true });
  return result === "OK";
}

async function updateCopurchaseScores(productIds: string[]): Promise<void> {
  if (productIds.length < 2) return;
  const redis = await getRedisClient();

  const pipeline = redis.multi();
  for (let i = 0; i < productIds.length; i++) {
    for (let j = 0; j < productIds.length; j++) {
      if (i === j) continue;
      pipeline.zIncrBy(rk(`copurchase:${productIds[i]}`), 1, productIds[j]);
    }
  }
  await pipeline.exec();
}

async function updateGlobalScores(
  items: Array<{ productId: string; quantity: number }>,
): Promise<void> {
  const redis = await getRedisClient();
  const pipeline = redis.multi();
  for (const { productId, quantity } of items) {
    pipeline.zIncrBy(rk("product:global:score"), quantity, productId);
  }
  await pipeline.exec();
}

async function resetProfileTtl(customerId: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.expire(rk(`customer:profile:${customerId}`), PROFILE_TTL_SECONDS);
}

// ── Subscriber setup ────────────────────────────────────────────────────────────

export async function startCartIntelligenceSubscribers(
  log?: FastifyBaseLogger,
): Promise<void> {
  // ── cart.abandoned ─────────────────────────────────────────────────────────
  await subscribeNatsEvent("cart.abandoned", async (payload) => {
    const { cartId, sessionId } = payload as { cartId: string; sessionId: string };
    log?.info({ cart_id: cartId }, "[cart-intelligence] cart.abandoned received");

    // Relay nudge to WhatsApp/push microservice via NATS (fire-and-forget)
    // The actual delivery is handled by a separate service subscribed to ibatexas.notification.send
    const { publishNatsEvent } = await import("@ibatexas/nats-client");
    await publishNatsEvent("notification.send", {
      type: "cart_abandoned",
      sessionId,
      cartId,
      channel: "whatsapp",
    });
  });

  // ── order.placed ──────────────────────────────────────────────────────────
  await subscribeNatsEvent("order.placed", async (payload) => {
    const {
      customerId,
      orderId,
      items,
    } = payload as {
      customerId?: string;
      orderId: string;
      items: Array<{ productId: string; variantId: string; quantity: number; priceInCentavos?: number }>;
    };

    if (!customerId) return;

    // Idempotency: skip if this order.placed event was already processed
    if (!(await isNewEvent(`order:${orderId}`))) {
      log?.info({ order_id: orderId }, "[cart-intelligence] order.placed duplicate — skipping");
      return;
    }

    log?.info(
      { customer_id: customerId, order_id: orderId, item_count: items.length },
      "[cart-intelligence] order.placed — updating intelligence",
    );

    try {
      const now = new Date();

      // 1. Bulk-insert CustomerOrderItem rows
      await prisma.customerOrderItem.createMany({
        data: items.map(({ productId, variantId, quantity, priceInCentavos }) => ({
          customerId,
          productId,
          variantId,
          quantity,
          priceInCentavos: priceInCentavos ?? 0,
          orderedAt: now,
          medusaOrderId: orderId,
        })),
        skipDuplicates: false,
      });

      // 2. Update copurchase sorted sets
      await updateCopurchaseScores(items.map((i) => i.productId));

      // 3. Update global product score
      await updateGlobalScores(items.map(({ productId, quantity }) => ({ productId, quantity })));

      // 4. Update Redis profile counters
      const redis = await getRedisClient();
      const profileKey = rk(`customer:profile:${customerId}`);
      await redis.hIncrBy(profileKey, "orderCount", 1);
      await redis.hSet(profileKey, "lastOrderAt", now.toISOString());
      await redis.hDel(profileKey, "cartItems"); // clear cart snapshot
      await resetProfileTtl(customerId);

      log?.info({ customer_id: customerId }, "[cart-intelligence] order.placed handled");
    } catch (err) {
      log?.error({ customer_id: customerId, order_id: orderId, error: String(err) }, "[cart-intelligence] order.placed handler error");
    }
  });

  // ── product.viewed ─────────────────────────────────────────────────────────
  await subscribeNatsEvent("product.viewed", async (payload) => {
    const { productId, customerId } = payload as {
      productId: string;
      customerId?: string;
    };
    if (!customerId) return;

    // Debounce: same customer viewing same product within 60s is one event
    const viewKey = `view:${customerId}:${productId}`;
    const redis = await getRedisClient();
    const isDuplicate = await redis.set(rk(`nats:processed:${viewKey}`), "1", { EX: 60, NX: true });
    if (isDuplicate !== "OK") return;

    try {
      const redis = await getRedisClient();
      const recentKey = rk(`customer:profile:${customerId}`);

      // LPUSH + LTRIM in a pipeline to keep last N viewed products
      const pipeline = redis.multi();
      pipeline.lPush(rk(`customer:recentlyViewed:${customerId}`), productId);
      pipeline.lTrim(rk(`customer:recentlyViewed:${customerId}`), 0, RECENTLY_VIEWED_MAX - 1);
      pipeline.hSet(recentKey, "lastSeenAt", new Date().toISOString());
      await pipeline.exec();
      await resetProfileTtl(customerId);
    } catch (err) {
      log?.error({ product_id: productId, customer_id: customerId, error: String(err) }, "[cart-intelligence] product.viewed handler error");
    }
  });
}
