// NATS subscriber: cart + intelligence events
//
// Listens for:
//   ibatexas.cart.abandoned          → sends push/WhatsApp nudge (via NATS relay), updates Redis profile
//   ibatexas.order.placed            → bulk-insert CustomerOrderItem, update copurchase scores, global score
//   ibatexas.order.refunded          → update customer profile (refundCount, totalRefundAmount)
//   ibatexas.order.disputed          → alert staff, increment disputeCount in profile
//   ibatexas.order.canceled          → increment orderCancellationCount in profile
//   ibatexas.product.viewed          → update recentlyViewed in Redis customer profile
//   ibatexas.review.prompt.schedule  → schedule a review prompt 30min after delivery
//   ibatexas.review.submitted        → update review analytics (avg rating, review count per product)
//   ibatexas.cart.item_added         → cart analytics (popular products, cart composition tracking)
//   ibatexas.order.payment_failed    → logs payment failure for observability
//   ibatexas.notification.send       → stub: logs notification intent (delivery TBD)

import { subscribeNatsEvent } from "@ibatexas/nats-client";
import { getRedisClient, rk, PROFILE_TTL_SECONDS, getWhatsAppSender, reaisToCentavos, atomicIncr } from "@ibatexas/tools";
import * as Sentry from "@sentry/node";
import { createCustomerService, createLoyaltyService } from "@ibatexas/domain";
import { scheduleReviewPrompt } from "../jobs/review-prompt.js";
import { buildCartRecoveryMessage } from "../jobs/cart-recovery-messages.js";
import { loadSession } from "../session/store.js";
import type { FastifyBaseLogger } from "fastify";

const RECENTLY_VIEWED_MAX = 20;
const NATS_DEDUP_TTL = 604_800; // 7 days — matches Stripe webhook window

// ── Sorted set pruning limits (internal tuning knobs) ───────────────────────
const COPURCHASE_MAX_ENTRIES = 50;     // per-product copurchase sorted set
const GLOBAL_SCORE_MAX_ENTRIES = 200;  // product:global:score sorted set
const CART_POPULARITY_MAX_ENTRIES = 200; // product:cart:popularity sorted set

// ── Cart recovery tier timing ────────────────────────────────────────────────
const TIER_1_TO_2_MS = 4 * 60 * 60 * 1000;   // 4h cooldown before escalating to tier 2
const TIER_2_TO_3_MS = 18 * 60 * 60 * 1000;  // 18h cooldown before escalating to tier 3
const NUDGE_TTL_SECONDS = 48 * 60 * 60;       // 48h — nudge key lifetime

interface CartNudgeState {
  tier: 1 | 2 | 3;
  sentAt: number; // epoch ms
}

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

  // 30-day TTL on copurchase sorted sets to prevent unbounded growth
  const COPURCHASE_TTL = 30 * 86400; // 30 days
  const pipeline = redis.multi();
  for (let i = 0; i < productIds.length; i++) {
    for (let j = 0; j < productIds.length; j++) {
      if (i === j) continue;
      pipeline.zIncrBy(rk(`copurchase:${productIds[i]}`), 1, productIds[j]);
    }
    // Prune to keep only top N entries by score (remove lowest-ranked tail)
    pipeline.zRemRangeByRank(rk(`copurchase:${productIds[i]}`), 0, -(COPURCHASE_MAX_ENTRIES + 1));
    pipeline.expire(rk(`copurchase:${productIds[i]}`), COPURCHASE_TTL);
  }
  await pipeline.exec();
}

async function updateGlobalScores(
  items: Array<{ productId: string; quantity: number }>,
): Promise<void> {
  const redis = await getRedisClient();
  // 30-day TTL on global score to prevent unbounded growth
  const GLOBAL_SCORE_TTL = 30 * 86400; // 30 days
  const pipeline = redis.multi();
  for (const { productId, quantity } of items) {
    pipeline.zIncrBy(rk("product:global:score"), quantity, productId);
  }
  // Prune to keep only top N entries by score
  pipeline.zRemRangeByRank(rk("product:global:score"), 0, -(GLOBAL_SCORE_MAX_ENTRIES + 1));
  pipeline.expire(rk("product:global:score"), GLOBAL_SCORE_TTL);
  await pipeline.exec();
}

function buildNotificationMessage(
  type: string,
  _cartId?: string,
  tier?: 1 | 2 | 3,
  itemNames?: string[],
  customerName?: string,
): string {
  if (type === "cart_abandoned") {
    return buildCartRecoveryMessage(tier ?? 1, itemNames ?? [], customerName);
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
    const { cartId, sessionId, customerId, phone, itemNames: payloadItemNames, customerName: payloadCustomerName } = payload as {
      cartId: string;
      sessionId: string;
      customerId?: string;
      phone?: string;
      itemNames?: string[];
      customerName?: string;
    };
    log?.info({ cart_id: cartId, customer_id: customerId }, "[cart-intelligence] cart.abandoned received");

    try {
      const redis = await getRedisClient();
      const nudgeKey = rk(`cart:nudge:${cartId}`);
      const nudgeRaw = await redis.get(nudgeKey);

      let tier: 1 | 2 | 3 = 1;
      const now = Date.now();

      if (nudgeRaw) {
        const nudgeState = JSON.parse(nudgeRaw) as CartNudgeState;
        if (nudgeState.tier === 3) {
          // Final nudge already sent — skip
          log?.info({ cart_id: cartId }, "[cart-intelligence] cart.abandoned — tier 3 already sent, skipping");
          return;
        }
        if (nudgeState.tier === 1) {
          if (now - nudgeState.sentAt < TIER_1_TO_2_MS) {
            // Still within tier 1 cooldown — skip
            log?.info({ cart_id: cartId }, "[cart-intelligence] cart.abandoned — tier 1 cooldown, skipping");
            return;
          }
          tier = 2;
        } else if (nudgeState.tier === 2) {
          if (now - nudgeState.sentAt < TIER_2_TO_3_MS) {
            // Still within tier 2 cooldown — skip
            log?.info({ cart_id: cartId }, "[cart-intelligence] cart.abandoned — tier 2 cooldown, skipping");
            return;
          }
          tier = 3;
        }
      }

      // Resolve item names: prefer payload, fall back to session history
      let itemNames: string[] = payloadItemNames ?? [];
      if (itemNames.length === 0 && sessionId) {
        try {
          const history = await loadSession(sessionId);
          // Extract product names from agent tool_result messages in session history
          for (const msg of history) {
            if (msg.role === "assistant" && Array.isArray(msg.content)) {
              for (const block of msg.content as Array<{ type?: string; name?: string; content?: unknown }>) {
                if (block.type === "tool_result" && typeof block.content === "string") {
                  try {
                    const parsed = JSON.parse(block.content) as { items?: Array<{ name?: string; productName?: string }> };
                    if (Array.isArray(parsed.items)) {
                      const names = parsed.items
                        .map((i) => i.name ?? i.productName)
                        .filter((n): n is string => typeof n === "string" && n.length > 0);
                      if (names.length > 0) {
                        itemNames = names;
                      }
                    }
                  } catch {
                    // ignore unparseable tool result
                  }
                }
              }
            }
          }
        } catch (err) {
          log?.warn({ cart_id: cartId, error: String(err) }, "[cart-intelligence] cart.abandoned — failed to load session for item names");
        }
      }

      const customerName = payloadCustomerName;

      // Build personalized message
      const body = buildCartRecoveryMessage(tier, itemNames, customerName);

      // Persist nudge state
      const newNudgeState: CartNudgeState = { tier, sentAt: now };
      await redis.set(nudgeKey, JSON.stringify(newNudgeState), { EX: NUDGE_TTL_SECONDS });

      // Relay nudge to notification.send subscriber
      const { publishNatsEvent } = await import("@ibatexas/nats-client");
      await publishNatsEvent("notification.send", {
        type: "cart_abandoned",
        sessionId,
        customerId,
        cartId,
        phone,
        channel: "whatsapp",
        body,
      });

      // Staff alert: high-value abandoned cart — must NOT block main flow
      try {
        const staffPhone = process.env.STAFF_ALERT_PHONE;
        if (staffPhone) {
          const { medusaStore } = await import("@ibatexas/tools");
          const cartData = await medusaStore(`/store/carts/${cartId}`) as { cart?: { total?: number } };
          // Medusa v2 returns total in reais — convert to centavos
          const totalCentavos = reaisToCentavos(cartData?.cart?.total ?? 0);
          if (totalCentavos > 20000) { // R$200
            const alertKey = rk("alert:staff:hourly");
            const alertCount = await atomicIncr(redis, alertKey, 60 * 60);
            if (alertCount <= 10) {
              const { sendText } = await import("../whatsapp/client.js");
              const valorFormatado = (totalCentavos / 100).toFixed(2).replace(".", ",");
              const alertMsg = `🚨 Carrinho de alto valor abandonado!\nValor: R$${valorFormatado}\nCliente: ${customerName ?? "Anonimo"}\nAcao: Ligue para recuperar.`;
              await sendText(`whatsapp:${staffPhone}`, alertMsg);
              log?.info({ cart_id: cartId, total: totalCentavos, alert_count: alertCount }, "[cart-intelligence] staff alert sent for high-value cart");
            } else {
              log?.info({ cart_id: cartId, alert_count: alertCount }, "[cart-intelligence] Staff alert rate limit reached");
            }
          }
        }
      } catch (alertErr) {
        log?.warn({ cart_id: cartId, error: String(alertErr) }, "[cart-intelligence] staff alert failed — cart flow not affected");
      }
    } catch (err) {
      log?.error({ cart_id: cartId, error: String(err) }, "[cart-intelligence] cart.abandoned handler error");
      Sentry.withScope((scope) => {
        scope.setTag("subscriber", "cart.abandoned");
        scope.setContext("cart", { cartId, customerId });
        Sentry.captureException(err);
      });
    }
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

      // 6. Track daily WhatsApp orders metric and messages-to-checkout
      try {
        const phone = await redis.hGet(profileKey, "phone");
        if (phone) {
          const todayDateStr = new Date().toISOString().slice(0, 10);
          const waOrderKey = rk(`metrics:wa_orders:daily:${todayDateStr}`);
          await atomicIncr(redis, waOrderKey, 48 * 60 * 60);

          // Update exponential moving average of messages-to-checkout
          const { hashPhone } = await import("../whatsapp/session.js");
          const phoneHash = hashPhone(phone);
          const sessionId = await redis.hGet(rk(`wa:phone:${phoneHash}`), "sessionId");
          if (sessionId) {
            const msgCountRaw = await redis.get(rk(`metrics:messages:${sessionId}`));
            const msgCount = msgCountRaw ? parseInt(msgCountRaw, 10) : 0;
            if (msgCount > 0) {
              await redis.hSet(profileKey, "lastOrderMessageCount", String(msgCount));
              const avgKey = rk("metrics:avg_messages_to_checkout");
              const oldAvgRaw = await redis.get(avgKey);
              const oldAvg = oldAvgRaw ? parseFloat(oldAvgRaw) : msgCount;
              const newAvg = 0.9 * oldAvg + 0.1 * msgCount;
              await redis.set(avgKey, String(newAvg));
            }
          }
        }
      } catch (metricsErr) {
        log?.warn({ customer_id: customerId, error: String(metricsErr) }, "[cart-intelligence] order.placed metrics update failed");
      }

      // 7. Award loyalty stamp — failure must NOT block order processing
      try {
        const loyaltySvc = createLoyaltyService();
        const { stamps, rewarded } = await loyaltySvc.addStamp(customerId);
        log?.info({ customer_id: customerId, stamps, rewarded }, "[cart-intelligence] loyalty stamp awarded");

        if (rewarded) {
          const customer = await customerSvc.getById(customerId);
          const name = customer.name;
          const message = `Parabens${name ? `, ${name}` : ""}! 🎉 Voce completou 10 pedidos e ganhou R$20 de desconto! Use o codigo FIEL20 no proximo pedido.`;
          const { publishNatsEvent } = await import("@ibatexas/nats-client");
          await publishNatsEvent("notification.send", {
            type: "loyalty_reward",
            customerId,
            channel: "whatsapp",
            body: message,
          });
        }
      } catch (loyaltyErr) {
        log?.warn({ customer_id: customerId, error: String(loyaltyErr) }, "[cart-intelligence] loyalty stamp failed — order not affected");
      }

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
    const redis = await getRedisClient();
    const isDuplicate = await redis.set(rk(`nats:processed:view:${customerId}:${productId}`), "1", { EX: 60, NX: true });
    if (isDuplicate !== "OK") return;

    try {
      const redis = await getRedisClient();
      const recentKey = rk(`customer:profile:${customerId}`);

      // LPUSH + LTRIM in a pipeline to keep last N viewed products
      const pipeline = redis.multi();
      pipeline.lPush(rk(`customer:recentlyViewed:${customerId}`), productId);
      pipeline.lTrim(rk(`customer:recentlyViewed:${customerId}`), 0, RECENTLY_VIEWED_MAX - 1);
      // 7-day TTL on recentlyViewed to prevent unbounded growth
      pipeline.expire(rk(`customer:recentlyViewed:${customerId}`), 7 * 86400);
      pipeline.hSet(recentKey, "lastSeenAt", new Date().toISOString());
      await pipeline.exec();
      await resetProfileTtl(customerId);
    } catch (err) {
      log?.error({ product_id: productId, customer_id: customerId, error: String(err) }, "[cart-intelligence] product.viewed handler error");
    }
  });

  // ── search.results_viewed (batch) ──────────────────────────────────────────
  // Batch event from search_products (single event instead of O(n) product.viewed)
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
    const { type, sessionId, customerId, cartId, channel, message: msgBody, body } = payload as {
      type: string;
      sessionId?: string;
      customerId?: string;
      cartId?: string;
      channel?: string;
      message?: string;
      body?: string;
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

      // body (personalized) takes precedence over legacy message field, then falls back to template
      const text = (body && body.length > 0) ? body : (msgBody || buildNotificationMessage(type, cartId));

      const sender = getWhatsAppSender();
      if (sender) {
        await sender.sendText(`whatsapp:${customer.phone}`, text);
        log?.info({ customerId, type }, "[cart-intelligence] notification.send delivered via WhatsApp");
      } else {
        log?.info({ customerId, type, text }, "[cart-intelligence] notification.send — WhatsApp sender not configured (stub)");
      }
    } catch (err) {
      log?.error({ customerId, type, error: String(err) }, "[cart-intelligence] notification.send delivery error");
      Sentry.withScope((scope) => {
        scope.setTag("subscriber", "notification.send");
        scope.setContext("notification", { customerId, type });
        Sentry.captureException(err);
      });
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

      const APP_BASE_URL = process.env.APP_BASE_URL;
      if (!APP_BASE_URL) {
        log?.warn("[cart-intelligence] APP_BASE_URL not set — skipping review prompt link");
        return;
      }
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

  // ── order.refunded (EVT-002) ──────────────────────────────────────────────
  await subscribeNatsEvent("order.refunded", async (payload) => {
    const { orderId, chargeId, amountRefunded } = payload as {
      orderId: string;
      chargeId: string;
      amountRefunded: number;
    };

    log?.info(
      { order_id: orderId, charge_id: chargeId, amount: amountRefunded },
      "[cart-intelligence] order.refunded received",
    );

    if (!(await isNewEvent(`refund:${orderId}:${chargeId}`))) {
      log?.info({ order_id: orderId }, "[cart-intelligence] order.refunded duplicate — skipping");
      return;
    }

    try {
      // Look up customerId from the order via Medusa
      const { medusaAdmin } = await import("@ibatexas/tools");
      const data = await medusaAdmin(`/admin/orders/${orderId}`) as {
        order?: { customer_id?: string; metadata?: Record<string, string> };
      };
      const customerId = data.order?.customer_id ?? data.order?.metadata?.["customerId"];
      if (!customerId) {
        log?.info({ order_id: orderId }, "[cart-intelligence] order.refunded — no customerId found, skipping profile update");
        return;
      }

      const redis = await getRedisClient();
      const profileKey = rk(`customer:profile:${customerId}`);
      await redis.hIncrBy(profileKey, "refundCount", 1);
      await redis.hIncrBy(profileKey, "totalRefundAmount", amountRefunded);
      await resetProfileTtl(customerId);

      log?.info({ customer_id: customerId, order_id: orderId }, "[cart-intelligence] order.refunded — profile updated");
    } catch (err) {
      log?.error({ order_id: orderId, error: String(err) }, "[cart-intelligence] order.refunded handler error");
    }
  });

  // ── order.disputed (EVT-003) ──────────────────────────────────────────────
  await subscribeNatsEvent("order.disputed", async (payload) => {
    const { orderId, disputeId, amount, reason } = payload as {
      orderId: string | null;
      disputeId: string;
      amount: number;
      reason: string;
    };

    log?.warn(
      { order_id: orderId, dispute_id: disputeId, amount, reason },
      "[cart-intelligence] order.disputed received",
    );

    if (!(await isNewEvent(`dispute:${disputeId}`))) {
      log?.info({ dispute_id: disputeId }, "[cart-intelligence] order.disputed duplicate — skipping");
      return;
    }

    try {
      // Alert staff directly — notification.send requires customerId, but disputes are staff-only
      const staffPhone = process.env.STAFF_ALERT_PHONE;
      if (staffPhone) {
        const { sendText } = await import("../whatsapp/client.js");
        const valorFormatado = (amount / 100).toFixed(2).replace(".", ",");
        await sendText(
          `whatsapp:${staffPhone}`,
          `⚠️ *Disputa aberta* — Pedido: ${orderId ?? "N/A"}, Motivo: ${reason}, Valor: R$${valorFormatado}`,
        );
        log?.info({ dispute_id: disputeId }, "[cart-intelligence] dispute staff alert sent");
      } else {
        log?.warn("[cart-intelligence] STAFF_ALERT_PHONE not set — dispute alert skipped");
      }

      // Update customer profile if orderId is available
      if (orderId) {
        const { medusaAdmin } = await import("@ibatexas/tools");
        const data = await medusaAdmin(`/admin/orders/${orderId}`) as {
          order?: { customer_id?: string; metadata?: Record<string, string> };
        };
        const customerId = data.order?.customer_id ?? data.order?.metadata?.["customerId"];
        if (customerId) {
          const redis = await getRedisClient();
          const profileKey = rk(`customer:profile:${customerId}`);
          await redis.hIncrBy(profileKey, "disputeCount", 1);
          await resetProfileTtl(customerId);
          log?.info({ customer_id: customerId, dispute_id: disputeId }, "[cart-intelligence] order.disputed — profile updated");
        }
      }
    } catch (err) {
      log?.error({ dispute_id: disputeId, error: String(err) }, "[cart-intelligence] order.disputed handler error");
    }
  });

  // ── order.canceled (EVT-004) ──────────────────────────────────────────────
  await subscribeNatsEvent("order.canceled", async (payload) => {
    const { orderId, stripePaymentIntentId, cancellationReason } = payload as {
      orderId: string;
      stripePaymentIntentId: string;
      cancellationReason?: string;
    };

    log?.info(
      { order_id: orderId, stripe_pi: stripePaymentIntentId, reason: cancellationReason },
      "[cart-intelligence] order.canceled received",
    );

    if (!(await isNewEvent(`canceled:${orderId}`))) {
      log?.info({ order_id: orderId }, "[cart-intelligence] order.canceled duplicate — skipping");
      return;
    }

    try {
      const { medusaAdmin } = await import("@ibatexas/tools");
      const data = await medusaAdmin(`/admin/orders/${orderId}`) as {
        order?: { customer_id?: string; metadata?: Record<string, string> };
      };
      const customerId = data.order?.customer_id ?? data.order?.metadata?.["customerId"];
      if (!customerId) {
        log?.info({ order_id: orderId }, "[cart-intelligence] order.canceled — no customerId found, skipping profile update");
        return;
      }

      const redis = await getRedisClient();
      const profileKey = rk(`customer:profile:${customerId}`);
      await redis.hIncrBy(profileKey, "orderCancellationCount", 1);
      await resetProfileTtl(customerId);

      log?.info({ customer_id: customerId, order_id: orderId }, "[cart-intelligence] order.canceled — profile updated");
    } catch (err) {
      log?.error({ order_id: orderId, error: String(err) }, "[cart-intelligence] order.canceled handler error");
    }
  });

  // ── review.submitted (EVT-005) ────────────────────────────────────────────
  await subscribeNatsEvent("review.submitted", async (payload) => {
    const { productId, customerId, rating, reviewCount, newAvgRating } = payload as {
      productId: string;
      customerId: string;
      rating: number;
      reviewCount: number;
      newAvgRating: number;
      orderId?: string;
    };

    log?.info(
      { product_id: productId, customer_id: customerId, rating },
      "[cart-intelligence] review.submitted received",
    );

    try {
      const redis = await getRedisClient();

      // Update product review analytics
      const reviewKey = rk(`product:reviews:${productId}`);
      await redis.hSet(reviewKey, {
        avgRating: String(newAvgRating),
        reviewCount: String(reviewCount),
        lastReviewAt: new Date().toISOString(),
      });
      await redis.expire(reviewKey, 30 * 86400); // 30 days

      // Update customer profile
      if (customerId) {
        const profileKey = rk(`customer:profile:${customerId}`);
        await redis.hIncrBy(profileKey, "reviewCount", 1);
        await resetProfileTtl(customerId);
      }

      log?.info({ product_id: productId, avg_rating: newAvgRating }, "[cart-intelligence] review.submitted — analytics updated");
    } catch (err) {
      log?.error({ product_id: productId, error: String(err) }, "[cart-intelligence] review.submitted handler error");
    }
  });

  // ── product.intelligence.purge ──────────────────────────────────────────
  await subscribeNatsEvent("product.intelligence.purge", async (payload) => {
    const { productId } = payload as { productId: string };
    log?.info({ product_id: productId }, "[cart-intelligence] product.intelligence.purge — cleaning up");

    try {
      const redis = await getRedisClient();

      // 1. Delete this product's own copurchase set
      await redis.del(rk(`copurchase:${productId}`));

      // 2. Remove this product from ALL other copurchase sets (SCAN, never KEYS)
      let cursor = 0;
      const pattern = rk("copurchase:*");
      let cleanedCount = 0;
      do {
        const scanResult = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
        cursor = scanResult.cursor;
        if (scanResult.keys.length > 0) {
          const pipeline = redis.multi();
          for (const key of scanResult.keys) {
            pipeline.zRem(key, productId);
          }
          await pipeline.exec();
          cleanedCount += scanResult.keys.length;
        }
      } while (cursor !== 0);

      // 3. Remove from global scores
      await redis.zRem(rk("product:global:score"), productId);
      await redis.zRem(rk("product:cart:popularity"), productId);

      log?.info(
        { product_id: productId, copurchase_sets_cleaned: cleanedCount },
        "[cart-intelligence] product.intelligence.purge — cleanup complete",
      );
    } catch (err) {
      log?.error({ product_id: productId, error: String(err) }, "[cart-intelligence] product.intelligence.purge handler error");
      Sentry.captureException(err);
    }
  });

  // ── outreach.sent ────────────────────────────────────────────────────────
  await subscribeNatsEvent("outreach.sent", async (payload) => {
    const { customerId, messageType } = payload as {
      customerId: string;
      messageType: string;
      sentAt: string;
    };
    if (!customerId) return;

    try {
      const redis = await getRedisClient();
      const profileKey = rk(`customer:profile:${customerId}`);
      await redis.hSet(profileKey, "lastOutreachAt", new Date().toISOString());
      await resetProfileTtl(customerId);
      log?.info(
        { customer_id: customerId, message_type: messageType },
        "[cart-intelligence] outreach.sent — profile updated",
      );
    } catch (err) {
      log?.error(
        { customer_id: customerId, error: String(err) },
        "[cart-intelligence] outreach.sent handler error",
      );
    }
  });

  // ── cart.item_added (EVT-006) ─────────────────────────────────────────────
  await subscribeNatsEvent("cart.item_added", async (payload) => {
    const { cartId, customerId, productId, variantId, quantity } = payload as {
      cartId: string;
      customerId?: string;
      productId?: string;
      variantId: string;
      quantity?: number;
      sessionId?: string;
      reorderFromOrderId?: string;
    };

    log?.info(
      { cart_id: cartId, customer_id: customerId, variant_id: variantId },
      "[cart-intelligence] cart.item_added received",
    );

    try {
      const redis = await getRedisClient();

      // Track popular products by add-to-cart frequency
      if (productId) {
        const pipeline = redis.multi();
        pipeline.zIncrBy(rk("product:cart:popularity"), quantity ?? 1, productId);
        // Prune to keep only top N entries by score
        pipeline.zRemRangeByRank(rk("product:cart:popularity"), 0, -(CART_POPULARITY_MAX_ENTRIES + 1));
        pipeline.expire(rk("product:cart:popularity"), 30 * 86400); // 30 days
        await pipeline.exec();
      }

      // Update customer profile if authenticated
      if (customerId) {
        const profileKey = rk(`customer:profile:${customerId}`);
        await redis.hIncrBy(profileKey, "cartAddCount", 1);
        await redis.hSet(profileKey, "lastCartActivityAt", new Date().toISOString());
        await resetProfileTtl(customerId);
      }

      log?.info({ cart_id: cartId }, "[cart-intelligence] cart.item_added — analytics updated");
    } catch (err) {
      log?.error({ cart_id: cartId, error: String(err) }, "[cart-intelligence] cart.item_added handler error");
    }
  });

  // ── follow-up.due ─────────────────────────────────────────────────────────
  await subscribeNatsEvent("follow-up.due", async (payload) => {
    const { customerId, reason } = payload as { customerId: string; reason: string };
    log?.info({ customer_id: customerId, reason }, "[cart-intelligence] follow-up.due received");

    try {
      const customerSvc = createCustomerService();
      const customer = await customerSvc.getById(customerId);
      if (!customer?.phone) return;

      let message: string;
      switch (reason) {
        case "cart_save":
          message = `Oi${customer.name ? `, ${customer.name}` : ""}! Seu carrinho ainda tá salvo. Quer finalizar? Responda "meu carrinho" 🛒`;
          break;
        case "thinking":
          message = `Oi${customer.name ? `, ${customer.name}` : ""}! Pensou sobre o pedido? Posso ajudar com algo? 😊`;
          break;
        case "price_concern":
          message = `Oi${customer.name ? `, ${customer.name}` : ""}! Vi que você tava olhando nosso cardápio. Temos combos com preços especiais, quer dar uma olhada? 🥩`;
          break;
        default:
          message = `Oi${customer.name ? `, ${customer.name}` : ""}! O IbateXas tá aqui se precisar de algo 😊`;
      }

      const { publishNatsEvent: publish } = await import("@ibatexas/nats-client");
      await publish("notification.send", {
        type: "follow_up",
        customerId,
        channel: "whatsapp",
        body: message,
      });

      log?.info({ customer_id: customerId, reason }, "[cart-intelligence] follow-up.due — notification sent");
    } catch (err) {
      log?.error({ customer_id: customerId, reason, error: String(err) }, "[cart-intelligence] follow-up.due handler error");
      Sentry.withScope((scope) => {
        scope.setTag("subscriber", "follow-up.due");
        scope.setContext("follow_up", { customerId, reason });
        Sentry.captureException(err);
      });
    }
  });
}
