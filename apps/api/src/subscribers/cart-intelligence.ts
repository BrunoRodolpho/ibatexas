// NATS subscriber: cart + intelligence events
//
// Listens for:
//   ibatexas.cart.abandoned          → sends push/WhatsApp nudge (via NATS relay), updates Redis profile
//   ibatexas.order.placed            → bulk-insert CustomerOrderItem, update copurchase scores, global score
//   ibatexas.product.viewed          → update recentlyViewed in Redis customer profile
//   ibatexas.review.prompt.schedule  → schedule a review prompt 30min after delivery
//   ibatexas.order.payment_failed    → logs payment failure for observability
//   ibatexas.notification.send       → stub: logs notification intent (delivery TBD)

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import { getRedisClient, rk, PROFILE_TTL_SECONDS, getWhatsAppSender } from "@ibatexas/tools";
import { createCustomerService } from "@ibatexas/domain";
import { scheduleReviewPrompt } from "../jobs/review-prompt.js";
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

  // AUDIT-FIX: REDIS-C01 — add 30-day TTL to copurchase sorted sets (unbounded growth)
  const COPURCHASE_TTL = 30 * 86400; // 30 days
  const pipeline = redis.multi();
  for (let i = 0; i < productIds.length; i++) {
    for (let j = 0; j < productIds.length; j++) {
      if (i === j) continue;
      pipeline.zIncrBy(rk(`copurchase:${productIds[i]}`), 1, productIds[j]);
    }
    pipeline.expire(rk(`copurchase:${productIds[i]}`), COPURCHASE_TTL);
  }
  await pipeline.exec();
}

async function updateGlobalScores(
  items: Array<{ productId: string; quantity: number }>,
): Promise<void> {
  const redis = await getRedisClient();
  // AUDIT-FIX: REDIS-C01 — add 30-day TTL to product:global:score (unbounded growth)
  const GLOBAL_SCORE_TTL = 30 * 86400; // 30 days
  const pipeline = redis.multi();
  for (const { productId, quantity } of items) {
    pipeline.zIncrBy(rk("product:global:score"), quantity, productId);
  }
  pipeline.expire(rk("product:global:score"), GLOBAL_SCORE_TTL);
  await pipeline.exec();
}

function buildNotificationMessage(type: string, _cartId?: string): string {
  if (type === "cart_abandoned") {
    return [
      `🛒 *IbateXas — Esqueceu algo no carrinho?*`,
      ``,
      `Seus itens ainda estão esperando por você!`,
      `Finalize seu pedido antes que acabe.`,
      ``,
      `Responda "meu carrinho" para continuar.`,
    ].join("\n");
  }
  return `IbateXas: você tem uma nova notificação. Responda para saber mais.`;
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
    const { cartId, sessionId, customerId } = payload as { cartId: string; sessionId: string; customerId?: string };
    log?.info({ cart_id: cartId, customer_id: customerId }, "[cart-intelligence] cart.abandoned received");

    // Relay nudge to WhatsApp/push microservice via NATS (fire-and-forget)
    // The actual delivery is handled by the notification.send subscriber below
    const { publishNatsEvent } = await import("@ibatexas/nats-client");
    await publishNatsEvent("notification.send", {
      type: "cart_abandoned",
      sessionId,
      customerId,
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
    const itemsWithPrice = items.map((i) => ({ ...i, priceInCentavos: i.priceInCentavos ?? 0 }));

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
      // 1. Bulk-insert CustomerOrderItem rows via CustomerService
      const customerSvc = createCustomerService();
      await customerSvc.recordOrderItems(customerId, orderId, itemsWithPrice);

      // 2. Update copurchase sorted sets
      await updateCopurchaseScores(items.map((i) => i.productId));

      // 3. Update global product score
      await updateGlobalScores(items.map(({ productId, quantity }) => ({ productId, quantity })));

      // 4. Update Redis profile counters
      const redis = await getRedisClient();
      const profileKey = rk(`customer:profile:${customerId}`);
      await redis.hIncrBy(profileKey, "orderCount", 1);
      await redis.hSet(profileKey, "lastOrderAt", new Date().toISOString());
      await redis.hDel(profileKey, "cartItems"); // clear cart snapshot

      // 5. Update lastOrderedProductIds and refresh stale score:* fields
      const orderedProductIds = items.map((i) => i.productId);
      await redis.hSet(profileKey, "lastOrderedProductIds", JSON.stringify(orderedProductIds));

      // Delete existing score:* fields — they'll be recomputed on next profile read (cache-miss path)
      const allFields = await redis.hKeys(profileKey);
      const staleScoreFields = allFields.filter((f) => f.startsWith("score:"));
      if (staleScoreFields.length > 0) {
        await redis.hDel(profileKey, staleScoreFields);
      }

      await resetProfileTtl(customerId);

      log?.info({ customer_id: customerId }, "[cart-intelligence] order.placed handled");
    } catch (err) {
      log?.error({ customer_id: customerId, order_id: orderId, error: String(err) }, "[cart-intelligence] order.placed handler error");
    }
  });

  // ── order.payment_failed ─────────────────────────────────────────────────
  await subscribeNatsEvent("order.payment_failed", async (payload) => {
    const { orderId, stripePaymentIntentId, lastPaymentError } = payload as {
      orderId: string;
      stripePaymentIntentId?: string;
      lastPaymentError?: string;
    };

    log?.warn(
      { order_id: orderId, stripe_pi: stripePaymentIntentId, error: lastPaymentError },
      "[cart-intelligence] order.payment_failed — payment failure recorded",
    );
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
      // AUDIT-FIX: REDIS-C02 — add 7-day TTL to customer:recentlyViewed (was missing, unbounded growth)
      pipeline.expire(rk(`customer:recentlyViewed:${customerId}`), 7 * 86400);
      pipeline.hSet(recentKey, "lastSeenAt", new Date().toISOString());
      await pipeline.exec();
      await resetProfileTtl(customerId);
    } catch (err) {
      log?.error({ product_id: productId, customer_id: customerId, error: String(err) }, "[cart-intelligence] product.viewed handler error");
    }
  });

  // ── search.results_viewed (batch) ──────────────────────────────────────────
  // AUDIT-FIX: EVT-F10 — Handles batch event from search_products (replaces O(n) product.viewed)
  await subscribeNatsEvent("search.results_viewed", async (payload) => {
    const { productIds, customerId } = payload as {
      productIds: string[];
      customerId?: string | null;
    };
    if (!customerId || !Array.isArray(productIds) || productIds.length === 0) return;

    try {
      const redis = await getRedisClient();

      // Batch: LPUSH all product IDs and LTRIM in a single pipeline
      const pipeline = redis.multi();
      for (const productId of productIds) {
        pipeline.lPush(rk(`customer:recentlyViewed:${customerId}`), productId);
      }
      pipeline.lTrim(rk(`customer:recentlyViewed:${customerId}`), 0, RECENTLY_VIEWED_MAX - 1);
      pipeline.expire(rk(`customer:recentlyViewed:${customerId}`), 7 * 86400);
      const profileKey = rk(`customer:profile:${customerId}`);
      pipeline.hSet(profileKey, "lastSeenAt", new Date().toISOString());
      await pipeline.exec();
      await resetProfileTtl(customerId);
    } catch (err) {
      log?.error({ customer_id: customerId, count: productIds.length, error: String(err) }, "[cart-intelligence] search.results_viewed handler error");
    }
  });

  // ── review.prompt.schedule ────────────────────────────────────────────────
  await subscribeNatsEvent("review.prompt.schedule", async (payload) => {
    const { customerId, orderId } = payload as { customerId: string; orderId: string };
    if (!customerId || !orderId) return;

    log?.info(
      { customer_id: customerId, order_id: orderId },
      "[cart-intelligence] review.prompt.schedule — scheduling review prompt",
    );

    try {
      await scheduleReviewPrompt(customerId, orderId);
    } catch (err) {
      log?.error(
        { customer_id: customerId, order_id: orderId, error: String(err) },
        "[cart-intelligence] review.prompt.schedule handler error",
      );
    }
  });

  // ── notification.send ────────────────────────────────────────────────────
  await subscribeNatsEvent("notification.send", async (payload) => {
    const { type, sessionId, customerId, cartId, channel, message: msgBody } = payload as {
      type: string;
      sessionId?: string;
      customerId?: string;
      cartId?: string;
      channel?: string;
      message?: string;
    };
    log?.info(
      { notification_type: type, session_id: sessionId, cart_id: cartId, channel },
      "[cart-intelligence] notification.send — processing notification",
    );

    // Only deliver WhatsApp notifications for now
    if (channel !== "whatsapp" || !customerId) {
      log?.info({ channel, customerId }, "[cart-intelligence] notification.send — skipping (non-whatsapp or no customerId)");
      return;
    }

    try {
      const customerSvc = createCustomerService();
      const customer = await customerSvc.getById(customerId).catch(() => null);
      if (!customer?.phone) {
        log?.info({ customerId }, "[cart-intelligence] notification.send — customer has no phone");
        return;
      }

      const text = msgBody || buildNotificationMessage(type, cartId);

      const sender = getWhatsAppSender();
      if (sender) {
        await sender.sendText(`whatsapp:${customer.phone}`, text);
        log?.info({ customerId, type }, "[cart-intelligence] notification.send delivered via WhatsApp");
      } else {
        log?.info({ customerId, type, text }, "[cart-intelligence] notification.send — WhatsApp sender not configured (stub)");
      }
    } catch (err) {
      log?.error({ customerId, type, error: String(err) }, "[cart-intelligence] notification.send delivery error");
    }
  });

  // ── reservation.created ─────────────────────────────────────────────────
  await subscribeNatsEvent("reservation.created", async (payload) => {
    const { customerId } = payload as { customerId?: string };
    if (!customerId) return;

    try {
      const redis = await getRedisClient();
      const profileKey = rk(`customer:profile:${customerId}`);
      await redis.hIncrBy(profileKey, "reservationCount", 1);
      await redis.hSet(profileKey, "lastReservationAt", new Date().toISOString());
      await resetProfileTtl(customerId);
      log?.info({ customer_id: customerId }, "[cart-intelligence] reservation.created — profile updated");
    } catch (err) {
      log?.error({ customer_id: customerId, error: String(err) }, "[cart-intelligence] reservation.created handler error");
    }
  });

  // ── reservation.modified ─────────────────────────────────────────────
  await subscribeNatsEvent("reservation.modified", async (payload) => {
    const { customerId } = payload as { customerId?: string };
    if (!customerId) return;

    try {
      const redis = await getRedisClient();
      const profileKey = rk(`customer:profile:${customerId}`);
      await redis.hSet(profileKey, "lastReservationModifiedAt", new Date().toISOString());
      log?.info({ customer_id: customerId }, "[cart-intelligence] reservation.modified — profile updated");
    } catch (err) {
      log?.error({ customer_id: customerId, error: String(err) }, "[cart-intelligence] reservation.modified handler error");
    }
  });

  // ── reservation.cancelled ───────────────────────────────────────────────
  await subscribeNatsEvent("reservation.cancelled", async (payload) => {
    const { customerId } = payload as { customerId?: string };
    if (!customerId) return;

    try {
      const redis = await getRedisClient();
      const profileKey = rk(`customer:profile:${customerId}`);
      await redis.hIncrBy(profileKey, "cancellationCount", 1);
      log?.info({ customer_id: customerId }, "[cart-intelligence] reservation.cancelled — profile updated");
    } catch (err) {
      log?.error({ customer_id: customerId, error: String(err) }, "[cart-intelligence] reservation.cancelled handler error");
    }
  });

  // ── reservation.no_show ─────────────────────────────────────────────────
  await subscribeNatsEvent("reservation.no_show", async (payload) => {
    const { customerId } = payload as { customerId?: string };
    if (!customerId) return;

    try {
      const redis = await getRedisClient();
      const profileKey = rk(`customer:profile:${customerId}`);
      await redis.hIncrBy(profileKey, "noShowCount", 1);
      log?.info({ customer_id: customerId }, "[cart-intelligence] reservation.no_show — profile updated");
    } catch (err) {
      log?.error({ customer_id: customerId, error: String(err) }, "[cart-intelligence] reservation.no_show handler error");
    }
  });

  // ── review.prompt (delivery — sends WhatsApp review request) ────────────
  await subscribeNatsEvent("review.prompt", async (payload) => {
    const { customerId, orderId } = payload as { customerId: string; orderId: string };
    if (!customerId || !orderId) return;

    log?.info(
      { customer_id: customerId, order_id: orderId },
      "[cart-intelligence] review.prompt — sending review request",
    );

    try {
      const customerSvc = createCustomerService();
      const customer = await customerSvc.getById(customerId).catch(() => null);
      if (!customer?.phone) return;

      const APP_BASE_URL = process.env.APP_BASE_URL || "https://ibatexas.com.br";
      const message = [
        `⭐ *IbateXas — Como foi sua experiência?*`,
        ``,
        `Seu pedido foi entregue! Gostaríamos muito de saber o que achou.`,
        ``,
        `Responda com uma nota de 1 a 5, ou acesse:`,
        `${APP_BASE_URL}/conta/pedidos`,
        ``,
        `Sua avaliação nos ajuda a melhorar! 🙏`,
      ].join("\n");

      const sender = getWhatsAppSender();
      if (sender) {
        await sender.sendText(`whatsapp:${customer.phone}`, message);
        log?.info({ customer_id: customerId }, "[cart-intelligence] review.prompt delivered via WhatsApp");
      } else {
        log?.info({ customer_id: customerId, message }, "[cart-intelligence] review.prompt — WhatsApp sender not configured (stub)");
      }
    } catch (err) {
      log?.error({ customer_id: customerId, order_id: orderId, error: String(err) }, "[cart-intelligence] review.prompt delivery error");
    }
  });
}
