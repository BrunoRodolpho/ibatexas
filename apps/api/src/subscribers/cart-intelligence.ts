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
//   ibatexas.order.status_changed    → sends WhatsApp notification on status transitions
//   ibatexas.notification.send       → delivers WhatsApp notification to customer

import { mintBroadcastReply } from "@adjudicate/core";
import { subscribeNatsEvent } from "@ibatexas/nats-client";
import { getRedisClient, rk, PROFILE_TTL_SECONDS, getWhatsAppSender, reaisToCentavos, atomicIncr } from "@ibatexas/tools";
import * as Sentry from "@sentry/node";
import {
  createCustomerService,
  createLoyaltyService,
  createOrderCommandService,
  createOrderEventLogService,
  createPaymentCommandService,
  ConcurrencyError,
  type LoyaltyStampAddPayload,
  type OrderProjectionCreatePayload,
  type OrderStatusReconcilePayload,
  type PaymentCreatePayload,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import { formatOrderId, type OrderPlacedEvent, type OrderStatusChangedEvent, type OrderFulfillmentStatus } from "@ibatexas/types";
import type { FastifyBaseLogger } from "fastify";
import { ITEMS_SCHEMA_VERSION } from "@ibatexas/domain";
import { withCorrelation } from "../lib/logger.js";
import { scheduleReviewPrompt } from "../jobs/review-prompt.js";
import { buildCartRecoveryMessage } from "../jobs/cart-recovery-messages.js";
import { loadSession } from "../session/store.js";
import { isNewEvent, withDedup } from "./dedup.js";
import { pushToDlq } from "./dlq.js";
import { buildSystemEnvelope } from "./__shared__/system-actor-envelope.js";

const RECENTLY_VIEWED_MAX = 20;

// ── Sorted set pruning limits (internal tuning knobs) ───────────────────────
const COPURCHASE_MAX_ENTRIES = 50;     // per-product copurchase sorted set
const GLOBAL_SCORE_MAX_ENTRIES = 200;  // product:global:score sorted set
const CART_POPULARITY_MAX_ENTRIES = 200; // product:cart:popularity sorted set

// ── Cart recovery tier timing ────────────────────────────────────────────────
const TIER_1_TO_2_MS = 4 * 60 * 60 * 1000;   // 4h cooldown before escalating to tier 2
const TIER_2_TO_3_MS = 18 * 60 * 60 * 1000;  // 18h cooldown before escalating to tier 3
const NUDGE_TTL_SECONDS = 48 * 60 * 60;       // 48h — nudge key lifetime

type CartNudgeTier = 1 | 2 | 3;

interface CartNudgeState {
  tier: CartNudgeTier;
  sentAt: number; // epoch ms
}

// ── Helpers ────────────────────────────────────────────────────────────────────


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
  tier?: CartNudgeTier,
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

type RedisClient = Awaited<ReturnType<typeof getRedisClient>>;

type OrderPlacedItem = {
  productId: string;
  variantId: string;
  quantity: number;
  priceInCentavos?: number;
};

// ── Shared profile-update helpers (CPD dedup) ───────────────────────────────────

// Resolve the customerId for an order via the Medusa admin API, falling back to
// metadata.customerId. Returns undefined when neither is present.
async function lookupOrderCustomerId(orderId: string): Promise<string | undefined> {
  const { medusaAdmin } = await import("@ibatexas/tools");
  const data = await medusaAdmin(`/admin/orders/${orderId}`) as {
    order?: { customer_id?: string; metadata?: Record<string, string> };
  };
  return data.order?.customer_id ?? data.order?.metadata?.["customerId"];
}

// Shared customer-profile mutation flow for the lightweight "profile updated"
// handlers (reservation.* and outreach.sent). Resolves Redis + the profile key,
// runs the caller's mutation, then emits the standard info log; failures are caught
// and emitted as the standard handler-error log (never rethrown).
async function applyProfileUpdate(
  customerId: string,
  mutate: (redis: RedisClient, profileKey: string) => Promise<void>,
  infoFields: Record<string, unknown>,
  infoMessage: string,
  errorMessage: string,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    const redis = await getRedisClient();
    const profileKey = rk(`customer:profile:${customerId}`);
    await mutate(redis, profileKey);
    log?.info(infoFields, infoMessage);
  } catch (err) {
    log?.error({ customer_id: customerId, error: String(err) }, errorMessage);
  }
}

// Registers a queue-grouped NATS subscription for a lightweight reservation.*
// profile-counter event: destructures + guards customerId, then runs the caller's
// mutation through applyProfileUpdate with the standard info-field shape and
// info/error log strings. Collapses the otherwise byte-identical reservation
// handler registrations into one call site (only the mutate ops + log strings differ).
async function registerProfileCounterSub(
  event: string,
  mutate: (redis: RedisClient, profileKey: string) => Promise<void>,
  infoLabel: string,
  errLabel: string,
  log?: FastifyBaseLogger,
): Promise<void> {
  await subscribeNatsEvent(event, async (payload) => {
    const { customerId } = payload as { customerId?: string };
    if (!customerId) return;

    await applyProfileUpdate(
      customerId,
      mutate,
      { customer_id: customerId },
      infoLabel,
      errLabel,
      log,
    );
  }, { queueGroup: "cart-intelligence" });
}

// Shared flow for order.* profile updates that must first resolve the customer via
// the Medusa admin API (order.refunded / order.canceled). Emits the standard
// skip / updated / error logs byte-for-byte; never rethrows.
async function updateProfileForOrderEvent(
  orderId: string,
  eventLabel: string,
  mutate: (redis: RedisClient, profileKey: string) => Promise<void>,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    const customerId = await lookupOrderCustomerId(orderId);
    if (!customerId) {
      log?.info({ order_id: orderId }, `[cart-intelligence] ${eventLabel} — no customerId found, skipping profile update`);
      return;
    }

    const redis = await getRedisClient();
    const profileKey = rk(`customer:profile:${customerId}`);
    await mutate(redis, profileKey);
    await resetProfileTtl(customerId);

    log?.info({ customer_id: customerId, order_id: orderId }, `[cart-intelligence] ${eventLabel} — profile updated`);
  } catch (err) {
    log?.error({ order_id: orderId, error: String(err) }, `[cart-intelligence] ${eventLabel} handler error`);
  }
}

// Minimal view of a kernel Decision needed for SYSTEM-envelope write handling.
type KernelDecisionView =
  | { kind: "REFUSE"; refusal: { code: string } }
  | { kind: "EXECUTE" | "REWRITE" | "ESCALATE" | "REQUEST_CONFIRMATION" | "DEFER" };

// Shared post-decision handling for SYSTEM-envelope command outcomes
// (order.projection.create / payment.create). Returns true when the kernel
// authorized the write (EXECUTE/REWRITE) — the caller then emits its own success
// log. On any other decision it emits the standard "kernel did not authorize"
// warning and, on REFUSE, routes the source event to the DLQ. Behaviour is
// byte-identical to the previous inline branches; kernel/audit semantics untouched.
async function handleKernelWriteDecision(
  decision: KernelDecisionView,
  opts: {
    orderId: string;
    warnMessage: string;
    dlqSubject: string;
    dlqReasonLabel: string;
    payload: Record<string, unknown>;
    log?: FastifyBaseLogger;
  },
): Promise<boolean> {
  if (decision.kind === "EXECUTE" || decision.kind === "REWRITE") {
    return true;
  }
  const refusalCode = decision.kind === "REFUSE" ? decision.refusal.code : undefined;
  opts.log?.warn(
    { order_id: opts.orderId, decision: decision.kind, refusalCode },
    opts.warnMessage,
  );
  if (decision.kind === "REFUSE") {
    await pushToDlq(
      opts.dlqSubject,
      opts.payload,
      `kernel REFUSE (${opts.dlqReasonLabel}): ${decision.refusal.code}`,
      opts.log,
    );
  }
  return false;
}

// ── cart.abandoned helpers ──────────────────────────────────────────────────────

// Returns the nudge tier to send, or null when the abandoned-cart nudge should be
// skipped (final tier already sent, or still within a tier cooldown window).
function resolveNudgeTier(
  nudgeRaw: string | null,
  now: number,
  cartId: string,
  log?: FastifyBaseLogger,
): CartNudgeTier | null {
  if (!nudgeRaw) return 1;
  const nudgeState = JSON.parse(nudgeRaw) as CartNudgeState;
  if (nudgeState.tier === 3) {
    // Final nudge already sent — skip
    log?.info({ cart_id: cartId }, "[cart-intelligence] cart.abandoned — tier 3 already sent, skipping");
    return null;
  }
  if (nudgeState.tier === 1) {
    if (now - nudgeState.sentAt < TIER_1_TO_2_MS) {
      // Still within tier 1 cooldown — skip
      log?.info({ cart_id: cartId }, "[cart-intelligence] cart.abandoned — tier 1 cooldown, skipping");
      return null;
    }
    return 2;
  }
  if (nudgeState.tier === 2) {
    if (now - nudgeState.sentAt < TIER_2_TO_3_MS) {
      // Still within tier 2 cooldown — skip
      log?.info({ cart_id: cartId }, "[cart-intelligence] cart.abandoned — tier 2 cooldown, skipping");
      return null;
    }
    return 3;
  }
  return 1;
}

// Extracts product names from a single agent message block (tool_result JSON).
function extractNamesFromToolResult(
  block: { type?: string; name?: string; content?: unknown },
): string[] {
  if (block.type !== "tool_result" || typeof block.content !== "string") return [];
  try {
    const parsed = JSON.parse(block.content) as { items?: Array<{ name?: string; productName?: string }> };
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items
      .map((i) => i.name ?? i.productName)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    // ignore unparseable tool result
    return [];
  }
}

// Resolve item names: prefer payload, fall back to session history.
async function resolveAbandonedItemNames(
  payloadItemNames: string[] | undefined,
  sessionId: string,
  cartId: string,
  log?: FastifyBaseLogger,
): Promise<string[]> {
  let itemNames: string[] = payloadItemNames ?? [];
  if (itemNames.length > 0 || !sessionId) return itemNames;
  try {
    const history = await loadSession(sessionId);
    // Extract product names from agent tool_result messages in session history
    for (const msg of history) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{ type?: string; name?: string; content?: unknown }>) {
          const names = extractNamesFromToolResult(block);
          if (names.length > 0) {
            itemNames = names;
          }
        }
      }
    }
  } catch (err) {
    log?.warn({ cart_id: cartId, error: String(err) }, "[cart-intelligence] cart.abandoned — failed to load session for item names");
  }
  return itemNames;
}

// Staff alert: high-value abandoned cart — must NOT block main flow.
async function sendHighValueCartAlert(
  redis: RedisClient,
  cartId: string,
  customerName: string | undefined,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    const staffPhone = process.env.STAFF_ALERT_PHONE;
    if (!staffPhone) return;
    const { medusaStore } = await import("@ibatexas/tools");
    const cartData = await medusaStore(`/store/carts/${cartId}`) as { cart?: { total?: number } };
    // Medusa v2 returns total in reais — convert to centavos
    const totalCentavos = reaisToCentavos(cartData?.cart?.total ?? 0);
    // Idempotency: one high-value alert per cart, even under at-least-once
    // redelivery across replicas. Guard BEFORE the hourly rate-limit incr so
    // a duplicate delivery neither re-sends nor wastes the rate budget.
    if (totalCentavos > 20000 && (await isNewEvent(`alert:highvalue-cart:${cartId}`))) { // R$200
      const alertKey = rk("alert:staff:hourly");
      const alertCount = await atomicIncr(redis, alertKey, 60 * 60);
      if (alertCount <= 10) {
        const { sendText } = await import("../whatsapp/client.js");
        const valorFormatado = (totalCentavos / 100).toFixed(2).replace(".", ",");
        const alertMsg = `🚨 Carrinho de alto valor abandonado!\nValor: R$${valorFormatado}\nCliente: ${customerName ?? "Anonimo"}\nAcao: Ligue para recuperar.`;
        await sendText(`whatsapp:${staffPhone}`, mintBroadcastReply(alertMsg));
        log?.info({ cart_id: cartId, total: totalCentavos, alert_count: alertCount }, "[cart-intelligence] staff alert sent for high-value cart");
      } else {
        log?.info({ cart_id: cartId, alert_count: alertCount }, "[cart-intelligence] Staff alert rate limit reached");
      }
    }
  } catch (alertErr) {
    log?.warn({ cart_id: cartId, error: String(alertErr) }, "[cart-intelligence] staff alert failed — cart flow not affected");
  }
}

// ── order.placed helpers ────────────────────────────────────────────────────────

// Track daily WhatsApp orders metric and the messages-to-checkout moving average.
async function updateCheckoutMetrics(
  redis: RedisClient,
  profileKey: string,
  customerId: string,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    const phone = await redis.hGet(profileKey, "phone");
    if (!phone) return;
    const todayDateStr = new Date().toISOString().slice(0, 10);
    const waOrderKey = rk(`metrics:wa_orders:daily:${todayDateStr}`);
    await atomicIncr(redis, waOrderKey, 48 * 60 * 60);

    // Update exponential moving average of messages-to-checkout
    const { hashPhone } = await import("../whatsapp/session.js");
    const phoneHash = hashPhone(phone);
    const sessionId = await redis.hGet(rk(`wa:phone:${phoneHash}`), "sessionId");
    if (!sessionId) return;
    const msgCountRaw = await redis.get(rk(`metrics:messages:${sessionId}`));
    const msgCount = msgCountRaw ? Number.parseInt(msgCountRaw, 10) : 0;
    if (msgCount > 0) {
      await redis.hSet(profileKey, "lastOrderMessageCount", String(msgCount));
      const avgKey = rk("metrics:avg_messages_to_checkout");
      const oldAvgRaw = await redis.get(avgKey);
      const oldAvg = oldAvgRaw ? Number.parseFloat(oldAvgRaw) : msgCount;
      const newAvg = 0.9 * oldAvg + 0.1 * msgCount;
      await redis.set(avgKey, String(newAvg));
    }
  } catch (metricsErr) {
    log?.warn({ customer_id: customerId, error: String(metricsErr) }, "[cart-intelligence] order.placed metrics update failed");
  }
}

// Award loyalty stamp — failure must NOT block order processing.
//
// Audit 2026-05-23 NEW-W9-V4: kernel-gated via loyalty.stamp.add envelope
// (SYSTEM-only). The kernel REFUSE path bails before the Prisma write —
// falling through to the legacy notification flow only when EXECUTE/REWRITE.
async function awardLoyaltyStamp(
  customerId: string,
  orderId: string,
  customerSvc: ReturnType<typeof createCustomerService>,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    const loyaltySvc = createLoyaltyService({ auditSink: getAuditSink() });
    const loyaltyPayload: LoyaltyStampAddPayload = { customerId };
    const loyaltyEnvelope = buildSystemEnvelope({
      kind: "loyalty.stamp.add" as const,
      payload: loyaltyPayload,
      sourceSubject: "order.placed",
      eventId: `loyalty:${orderId}`,
    });
    const loyaltyOutcome = await loyaltySvc.addStampFromEnvelope(
      loyaltyEnvelope,
      { ctx: { customerId } },
    );
    if (
      loyaltyOutcome.decision.kind !== "EXECUTE" &&
      loyaltyOutcome.decision.kind !== "REWRITE"
    ) {
      const refusalCode =
        loyaltyOutcome.decision.kind === "REFUSE"
          ? loyaltyOutcome.decision.refusal.code
          : undefined;
      log?.warn(
        { customer_id: customerId, decision: loyaltyOutcome.decision.kind, refusalCode },
        "[cart-intelligence] loyalty stamp — kernel did not authorize",
      );
      throw new Error(`kernel ${loyaltyOutcome.decision.kind}: ${refusalCode ?? "n/a"}`);
    }
    const { stamps, rewarded } = loyaltyOutcome.result!;
    log?.info({ customer_id: customerId, stamps, rewarded }, "[cart-intelligence] loyalty stamp awarded");

    if (rewarded) {
      const customer = await customerSvc.getById(customerId);
      const name = customer.name;
      const namePart = name ? `, ${name}` : "";
      const message = `Parabens${namePart}! 🎉 Voce completou 10 pedidos e ganhou R$20 de desconto! Use o codigo FIEL20 no proximo pedido.`;
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
}

// Staff WhatsApp alert for new order — must NOT block main flow.
async function sendNewOrderStaffAlert(
  orderId: string,
  payload: unknown,
  itemCount: number,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    const staffPhone = process.env.STAFF_ALERT_PHONE;
    if (staffPhone && (await isNewEvent(`alert:new-order:${orderId}`))) {
      const { sendText } = await import("../whatsapp/client.js");
      const totalRaw = (payload as { total?: number }).total;
      const totalCentavos = typeof totalRaw === "number" ? totalRaw : 0;
      const valorFormatado = (totalCentavos / 100).toFixed(2).replace(".", ",");
      await sendText(
        `whatsapp:${staffPhone}`,
        mintBroadcastReply(
          `🔔 *Novo pedido!*\nCliente: ${(payload as { customerName?: string }).customerName ?? "N/A"}\nItens: ${itemCount}\nTotal: R$${valorFormatado}`,
        ),
      );
      log?.info({ order_id: orderId }, "[cart-intelligence] staff new-order alert sent");
    }
  } catch (alertErr) {
    log?.warn({ order_id: orderId, error: String(alertErr) }, "[cart-intelligence] staff new-order alert failed");
  }
}

// Customer order-received WhatsApp notification.
async function sendOrderReceivedNotification(
  orderId: string,
  customerId: string,
  payload: unknown,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    const displayId = (payload as { displayId?: number }).displayId ?? 0;
    if (displayId > 0 && customerId) {
      const { buildOrderReceivedMessage } = await import("../notifications/order-messages.js");
      const { publishNatsEvent: publish } = await import("@ibatexas/nats-client");
      await publish("notification.send", {
        type: "order_received",
        customerId,
        channel: "whatsapp",
        body: buildOrderReceivedMessage(displayId),
      });
      log?.info({ order_id: orderId, display_id: displayId }, "[cart-intelligence] order.placed — customer notification dispatched");
    }
  } catch (notifErr) {
    log?.warn({ order_id: orderId, error: String(notifErr) }, "[cart-intelligence] order.placed — customer notification failed");
  }
}

// Create order projection — failure must NOT block order processing.
//
// Task 16: kernel-gated via order.projection.create envelope (SYSTEM-only).
async function createOrderProjection(
  orderId: string,
  customerId: string,
  items: OrderPlacedItem[],
  payload: unknown,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    const orderPayload = payload as Partial<OrderPlacedEvent>;
    const commandSvc = createOrderCommandService(log ?? undefined, {
      auditSink: getAuditSink(),
    });
    const totalInCentavos = orderPayload.totalInCentavos ?? items.reduce((s, i) => s + (i.priceInCentavos ?? 0) * (i.quantity ?? 1), 0);
    const projectionCreatePayload: OrderProjectionCreatePayload = {
      orderId,
      displayId: orderPayload.displayId ?? 0,
      customerId,
      fulfillmentStatus: "pending",
      paymentStatus: orderPayload.paymentStatus ?? "pending",
      totalInCentavos,
    };
    const envelope = buildSystemEnvelope({
      kind: "order.projection.create" as const,
      payload: projectionCreatePayload,
      sourceSubject: "order.placed",
      eventId: `projection:${orderId}`,
    });
    const outcome = await commandSvc.createFromEnvelope(envelope, {
      id: orderId,
      displayId: orderPayload.displayId ?? 0,
      customerId,
      customerEmail: orderPayload.customerEmail ?? null,
      customerName: orderPayload.customerName ?? null,
      customerPhone: orderPayload.customerPhone ?? null,
      fulfillmentStatus: "pending",
      paymentStatus: orderPayload.paymentStatus ?? "pending",
      totalInCentavos,
      subtotalInCentavos: orderPayload.subtotalInCentavos ?? 0,
      shippingInCentavos: orderPayload.shippingInCentavos ?? 0,
      itemCount: items.length,
      itemsJson: items.map((i) => ({
        productId: i.productId,
        variantId: i.variantId,
        title: (i as { title?: string }).title ?? "",
        quantity: i.quantity ?? 1,
        priceInCentavos: i.priceInCentavos ?? 0,
      })),
      itemsSchemaVersion: ITEMS_SCHEMA_VERSION,
      shippingAddressJson: orderPayload.shippingAddress ?? null,
      deliveryType: orderPayload.deliveryType ?? null,
      paymentMethod: orderPayload.paymentMethod ?? null,
      tipInCentavos: orderPayload.tipInCentavos ?? 0,
      medusaCreatedAt: new Date(),
    });
    const authorized = await handleKernelWriteDecision(outcome.decision, {
      orderId,
      warnMessage: "[cart-intelligence] order projection create — kernel did not authorize",
      dlqSubject: "order.placed",
      dlqReasonLabel: "projection",
      payload: payload as Record<string, unknown>,
      log,
    });
    if (authorized) {
      log?.info({ order_id: orderId }, "[cart-intelligence] order projection created");
    }
  } catch (projErr) {
    // Duplicate key = projection already exists (e.g. reprocessed event) — safe to ignore
    // P2002 is Prisma's code for unique constraint violation
    const isPrismaUniqueViolation = typeof projErr === "object" && projErr !== null && "code" in projErr && (projErr as { code: string }).code === "P2002";
    if (isPrismaUniqueViolation) {
      log?.info({ order_id: orderId }, "[cart-intelligence] order projection already exists — skipping");
    } else {
      log?.warn({ order_id: orderId, error: String(projErr) }, "[cart-intelligence] order projection creation failed — order not affected");
    }
  }
}

// Create Payment row — failure must NOT block order processing.
//
// Task 16: kernel-gated via payment.create envelope (SYSTEM-only).
async function createPaymentRow(
  orderId: string,
  items: OrderPlacedItem[],
  payload: unknown,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    const orderPayload = payload as Partial<OrderPlacedEvent>;
    const method = (orderPayload.paymentMethod ?? "pix") as "pix" | "card" | "cash";
    const totalInCentavos = orderPayload.totalInCentavos ?? items.reduce((s, i) => s + (i.priceInCentavos ?? 0) * (i.quantity ?? 1), 0);

    const paymentCmdSvc = createPaymentCommandService(log ?? undefined, {
      auditSink: getAuditSink(),
    });
    const paymentCreatePayload: PaymentCreatePayload = {
      orderId,
      method,
      amountInCentavos: totalInCentavos,
      ...(orderPayload.stripePaymentIntentId === undefined
        ? {}
        : { stripePaymentIntentId: orderPayload.stripePaymentIntentId }),
    };
    const envelope = buildSystemEnvelope({
      kind: "payment.create" as const,
      payload: paymentCreatePayload,
      sourceSubject: "order.placed",
      eventId: `payment:${orderId}`,
    });
    const outcome = await paymentCmdSvc.createFromEnvelope(envelope);
    const authorized = await handleKernelWriteDecision(outcome.decision, {
      orderId,
      warnMessage: "[cart-intelligence] payment.create — kernel did not authorize",
      dlqSubject: "order.placed",
      dlqReasonLabel: "payment",
      payload: payload as Record<string, unknown>,
      log,
    });
    if (authorized) {
      log?.info({ order_id: orderId, method }, "[cart-intelligence] payment row created");
    }
  } catch (payErr) {
    // ActivePaymentExistsError or unique constraint = already created — safe to ignore
    const isExpected =
      (payErr as Error).name === "ActivePaymentExistsError" ||
      (typeof payErr === "object" && payErr !== null && "code" in payErr && (payErr as { code: string }).code === "P2002");
    if (isExpected) {
      log?.info({ order_id: orderId }, "[cart-intelligence] payment row already exists — skipping");
    } else {
      log?.warn({ order_id: orderId, error: String(payErr) }, "[cart-intelligence] payment row creation failed — order not affected");
    }
  }
}

// ── order.status_changed helpers ────────────────────────────────────────────────

// Reconcile projection (safety net — PATCH handler updates projection first).
//
// Task 16: kernel-gated via order.status.reconcile envelope (SYSTEM-only).
async function reconcileOrderProjection(
  orderId: string,
  newStatus: string,
  eventVersion: number,
  payload: Record<string, unknown>,
  hLog?: FastifyBaseLogger,
): Promise<void> {
  try {
    const commandSvc = createOrderCommandService(hLog ?? undefined, {
      auditSink: getAuditSink(),
    });
    const reconcilePayload: OrderStatusReconcilePayload = {
      orderId,
      newStatus,
      eventVersion,
      actor: "system",
    };
    const envelope = buildSystemEnvelope({
      kind: "order.status.reconcile" as const,
      payload: reconcilePayload,
      sourceSubject: "order.status_changed",
      eventId: `reconcile:${orderId}:${eventVersion}`,
    });
    const outcome = await commandSvc.reconcileStatusFromEnvelope(envelope);
    if (
      outcome.decision.kind !== "EXECUTE" &&
      outcome.decision.kind !== "REWRITE"
    ) {
      const refusalCode =
        outcome.decision.kind === "REFUSE"
          ? outcome.decision.refusal.code
          : undefined;
      hLog?.warn(
        { order_id: orderId, decision: outcome.decision.kind, refusalCode },
        "[cart-intelligence] projection reconcile — kernel did not authorize",
      );
      if (outcome.decision.kind === "REFUSE") {
        await pushToDlq(
          "order.status_changed",
          payload,
          `kernel REFUSE: ${outcome.decision.refusal.code}`,
          hLog,
        );
      }
    } else if (outcome.result) {
      hLog?.info({ order_id: orderId, version: outcome.result.version }, "[cart-intelligence] projection reconciled from event");
    } else {
      hLog?.info({ order_id: orderId }, "[cart-intelligence] projection already up-to-date — reconcile skipped");
    }
  } catch (reconcileErr) {
    if (reconcileErr instanceof ConcurrencyError) {
      // Expected: PATCH handler already updated — safe to ignore
      hLog?.info({ order_id: orderId }, "[cart-intelligence] projection reconcile skipped (concurrency — already updated)");
    } else {
      hLog?.warn({ order_id: orderId, error: String(reconcileErr) }, "[cart-intelligence] projection reconcile failed");
      await pushToDlq("order.status_changed", payload, reconcileErr, hLog);
    }
  }
}

// Staff alert on all transitions. Guarded by a stable per-transition identity
// (orderId + event version) to avoid duplicate staff messages under
// at-least-once redelivery / multi-replica.
async function sendStatusTransitionAlert(
  orderId: string,
  displayId: number,
  previousStatus: string,
  newStatus: string,
  eventVersion: number | undefined,
  hLog?: FastifyBaseLogger,
): Promise<void> {
  try {
    const staffPhone = process.env.STAFF_ALERT_PHONE;
    if (staffPhone && (await isNewEvent(`alert:status:${orderId}:${eventVersion}`))) {
      const { ORDER_STATUS_LABELS_PT } = await import("@ibatexas/types");
      const fromLabel = ORDER_STATUS_LABELS_PT[previousStatus as OrderFulfillmentStatus] ?? previousStatus;
      const toLabel = ORDER_STATUS_LABELS_PT[newStatus as OrderFulfillmentStatus] ?? newStatus;
      const { sendText } = await import("../whatsapp/client.js");
      await sendText(
        `whatsapp:${staffPhone}`,
        mintBroadcastReply(`📋 Pedido ${formatOrderId(displayId)}: ${fromLabel} → ${toLabel}`),
      );
      hLog?.info({ order_id: orderId, newStatus }, "[cart-intelligence] staff transition alert sent");
    }
  } catch (staffErr) {
    hLog?.warn({ order_id: orderId, error: String(staffErr) }, "[cart-intelligence] staff transition alert failed");
  }
}

// ── Subscriber setup ────────────────────────────────────────────────────────────

export async function startCartIntelligenceSubscribers(
  log?: FastifyBaseLogger,
): Promise<void> {
  const eventLog = createOrderEventLogService(log);

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

      const now = Date.now();
      const tier = resolveNudgeTier(nudgeRaw, now, cartId, log);
      if (tier === null) return;

      // Resolve item names: prefer payload, fall back to session history
      const itemNames = await resolveAbandonedItemNames(payloadItemNames, sessionId, cartId, log);

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
      await sendHighValueCartAlert(redis, cartId, customerName, log);
    } catch (err) {
      log?.error({ cart_id: cartId, error: String(err) }, "[cart-intelligence] cart.abandoned handler error");
      Sentry.withScope((scope) => {
        scope.setTag("subscriber", "cart.abandoned");
        scope.setContext("cart", { cartId, customerId });
        Sentry.captureException(err);
      });
    }
  }, { queueGroup: "cart-intelligence" });

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

    // Idempotency: fail-closed two-phase guard — claims a short in-flight key,
    // runs the body, and promotes to the full dedup TTL ONLY on success. If the
    // body throws, the claim is released and the failure is routed to the DLQ
    // for recovery (see the outer catch). Replaces the former isNewEvent
    // (mark-before-run), which on a mid-handler crash dropped the side effect
    // AND pinned the event as processed. (No AUTO-redelivery on Core NATS —
    // recovery is via the DLQ / outbox-retry; see dedup.ts header.)
    const processed = await withDedup(`order:${orderId}`, async () => {
    log?.info(
      { customer_id: customerId, order_id: orderId, item_count: items.length },
      "[cart-intelligence] order.placed — updating intelligence",
    );

    void eventLog.append({
      orderId,
      eventType: "order.placed",
      discriminator: orderId,
      payload: payload as Record<string, unknown>,
      timestamp: (payload as { timestamp?: string }).timestamp ?? new Date().toISOString(),
    });

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
      await updateCheckoutMetrics(redis, profileKey, customerId, log);

      // 7. Award loyalty stamp — failure must NOT block order processing
      await awardLoyaltyStamp(customerId, orderId, customerSvc, log);

      // 8. Staff WhatsApp alert for new order — must NOT block main flow.
      // Per-alert idempotency guard so redelivery / multi-replica never double-sends,
      // independent of the handler-level order:* guard above.
      await sendNewOrderStaffAlert(orderId, payload, items.length, log);

      // 9. Customer order-received WhatsApp notification
      await sendOrderReceivedNotification(orderId, customerId, payload, log);

      // 10. Create order projection — failure must NOT block order processing
      await createOrderProjection(orderId, customerId, items, payload, log);

      // 11. Create Payment row — failure must NOT block order processing
      await createPaymentRow(orderId, items, payload, log);

      log?.info({ customer_id: customerId }, "[cart-intelligence] order.placed handled");
    } catch (err) {
      // C2: don't silently swallow. The two-phase guard would otherwise pin this
      // event as processed (full TTL) with the side effect lost and no recovery
      // path. Route it to the DLQ (matching notification.send) so a failed
      // order.placed is recoverable rather than dropped-and-suppressed.
      log?.error({ customer_id: customerId, order_id: orderId, error: String(err) }, "[cart-intelligence] order.placed handler error");
      await pushToDlq("order.placed", payload as Record<string, unknown>, err, log);
    }
    }); // end withDedup
    if (!processed) {
      log?.info({ order_id: orderId }, "[cart-intelligence] order.placed duplicate — skipping");
    }
  }, { queueGroup: "cart-intelligence" });

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

    void eventLog.append({
      orderId,
      eventType: "order.payment_failed",
      discriminator: stripePaymentIntentId ?? orderId,
      payload: payload as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
  }, { queueGroup: "cart-intelligence" });

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
  }, { queueGroup: "cart-intelligence" });

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
  }, { queueGroup: "cart-intelligence" });

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
  }, { queueGroup: "cart-intelligence" });

  // ── order.status_changed ─────────────────────────────────────────────────
  await subscribeNatsEvent("order.status_changed", async (payload) => {
    const { orderId, displayId, previousStatus, newStatus, customerId, version: eventVersion, correlationId } =
      payload as unknown as OrderStatusChangedEvent & { correlationId?: string };

    const hLog = correlationId ? withCorrelation(log ?? null, correlationId) : log;

    hLog?.info(
      { order_id: orderId, display_id: displayId, from: previousStatus, to: newStatus, version: eventVersion },
      "[cart-intelligence] order.status_changed received",
    );

    void eventLog.append({
      orderId,
      eventType: "order.status_changed",
      discriminator: String(eventVersion),
      payload: payload as unknown as Record<string, unknown>,
      timestamp: (payload as unknown as OrderStatusChangedEvent).timestamp ?? new Date().toISOString(),
    });

    // 1. Reconcile projection (safety net — PATCH handler updates projection first)
    //
    // Task 16: kernel-gated via order.status.reconcile envelope (SYSTEM-only).
    await reconcileOrderProjection(
      orderId,
      newStatus as string,
      eventVersion ?? 0,
      payload as Record<string, unknown>,
      hLog,
    );

    // 2. Send WhatsApp notification for customer-facing transitions
    const notifiableStatuses = ["confirmed", "preparing", "ready", "in_delivery", "delivered", "canceled"];
    if (!notifiableStatuses.includes(newStatus) || !customerId) {
      hLog?.info({ newStatus, customerId }, "[cart-intelligence] order.status_changed — skipping notification (non-notifiable or no customerId)");
      return;
    }

    try {
      const { buildOrderStatusMessage } = await import("../notifications/order-messages.js");
      const message = buildOrderStatusMessage(displayId, newStatus);
      if (!message) return;

      const { publishNatsEvent: publish } = await import("@ibatexas/nats-client");
      await publish("notification.send", {
        type: `order_${newStatus}`,
        customerId,
        channel: "whatsapp",
        body: message,
      });

      hLog?.info({ order_id: orderId, newStatus }, "[cart-intelligence] order.status_changed — notification queued");
    } catch (err) {
      hLog?.error({ order_id: orderId, error: String(err) }, "[cart-intelligence] order.status_changed handler error");
      Sentry.withScope((scope) => {
        scope.setTag("subscriber", "order.status_changed");
        scope.setContext("order", { orderId, displayId, newStatus });
        Sentry.captureException(err);
      });
    }

    // 3. Staff alert on all transitions.
    await sendStatusTransitionAlert(orderId, displayId, previousStatus as string, newStatus, eventVersion, hLog);
  }, { queueGroup: "cart-intelligence" });

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

    // Idempotency guard — fail-closed two-phase guard. Replaces the former
    // isNewEvent (mark-before-run) to avoid permanently dropping a WhatsApp
    // delivery if the process crashes mid-send.
    const eventKey = `notification:${customerId || sessionId}:${type}`;
    const notifProcessed = await withDedup(eventKey, async () => {
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
        await sender.sendText(`whatsapp:${customer.phone}`, mintBroadcastReply(text));
        log?.info({ customerId, type }, "[cart-intelligence] notification.send delivered via WhatsApp");
      } else {
        log?.info({ customerId, type, text }, "[cart-intelligence] notification.send — WhatsApp sender not configured (stub)");
      }
    } catch (err) {
      log?.error({ customerId, type, error: String(err) }, "[cart-intelligence] notification.send delivery error");
      await pushToDlq("notification.send", payload as Record<string, unknown>, err, log);
    }
    }); // end withDedup
    if (!notifProcessed) {
      log?.info({ event_key: eventKey }, "[cart-intelligence] notification.send duplicate — skipping");
    }
  }, { queueGroup: "cart-intelligence" });

  // ── reservation.created ─────────────────────────────────────────────────
  await subscribeNatsEvent("reservation.created", async (payload) => {
    const { customerId } = payload as { customerId?: string };
    if (!customerId) return;

    await applyProfileUpdate(
      customerId,
      async (redis, profileKey) => {
        await redis.hIncrBy(profileKey, "reservationCount", 1);
        await redis.hSet(profileKey, "lastReservationAt", new Date().toISOString());
        await resetProfileTtl(customerId);
      },
      { customer_id: customerId },
      "[cart-intelligence] reservation.created — profile updated",
      "[cart-intelligence] reservation.created handler error",
      log,
    );
  }, { queueGroup: "cart-intelligence" });

  // ── reservation.modified ─────────────────────────────────────────────
  await registerProfileCounterSub(
    "reservation.modified",
    async (redis, profileKey) => {
      await redis.hSet(profileKey, "lastReservationModifiedAt", new Date().toISOString());
    },
    "[cart-intelligence] reservation.modified — profile updated",
    "[cart-intelligence] reservation.modified handler error",
    log,
  );

  // ── reservation.cancelled ───────────────────────────────────────────────
  await registerProfileCounterSub(
    "reservation.cancelled",
    async (redis, profileKey) => {
      await redis.hIncrBy(profileKey, "cancellationCount", 1);
    },
    "[cart-intelligence] reservation.cancelled — profile updated",
    "[cart-intelligence] reservation.cancelled handler error",
    log,
  );

  // ── reservation.no_show ─────────────────────────────────────────────────
  await registerProfileCounterSub(
    "reservation.no_show",
    async (redis, profileKey) => {
      await redis.hIncrBy(profileKey, "noShowCount", 1);
    },
    "[cart-intelligence] reservation.no_show — profile updated",
    "[cart-intelligence] reservation.no_show handler error",
    log,
  );

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
        await sender.sendText(`whatsapp:${customer.phone}`, mintBroadcastReply(message));
        log?.info({ customer_id: customerId }, "[cart-intelligence] review.prompt delivered via WhatsApp");
      } else {
        log?.info({ customer_id: customerId, message }, "[cart-intelligence] review.prompt — WhatsApp sender not configured (stub)");
      }
    } catch (err) {
      log?.error({ customer_id: customerId, order_id: orderId, error: String(err) }, "[cart-intelligence] review.prompt delivery error");
    }
  }, { queueGroup: "cart-intelligence" });

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

    const refundProcessed = await withDedup(`refund:${orderId}:${chargeId}`, async () => {
    void eventLog.append({
      orderId,
      eventType: "order.refunded",
      discriminator: chargeId,
      payload: payload as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });

    await updateProfileForOrderEvent(
      orderId,
      "order.refunded",
      async (redis, profileKey) => {
        await redis.hIncrBy(profileKey, "refundCount", 1);
        await redis.hIncrBy(profileKey, "totalRefundAmount", amountRefunded);
      },
      log,
    );
    }); // end withDedup
    if (!refundProcessed) {
      log?.info({ order_id: orderId }, "[cart-intelligence] order.refunded duplicate — skipping");
    }
  }, { queueGroup: "cart-intelligence" });

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

    const disputeProcessed = await withDedup(`dispute:${disputeId}`, async () => {
    void eventLog.append({
      orderId: orderId ?? "unknown",
      eventType: "order.disputed",
      discriminator: disputeId,
      payload: payload as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });

    try {
      // Alert staff directly — notification.send requires customerId, but disputes are staff-only
      const staffPhone = process.env.STAFF_ALERT_PHONE;
      if (staffPhone) {
        const { sendText } = await import("../whatsapp/client.js");
        const valorFormatado = (amount / 100).toFixed(2).replace(".", ",");
        await sendText(
          `whatsapp:${staffPhone}`,
          mintBroadcastReply(
            `⚠️ *Disputa aberta* — Pedido: ${orderId ?? "N/A"}, Motivo: ${reason}, Valor: R$${valorFormatado}`,
          ),
        );
        log?.info({ dispute_id: disputeId }, "[cart-intelligence] dispute staff alert sent");
      } else {
        log?.warn("[cart-intelligence] STAFF_ALERT_PHONE not set — dispute alert skipped");
      }

      // Update customer profile if orderId is available
      if (orderId) {
        const customerId = await lookupOrderCustomerId(orderId);
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
    }); // end withDedup
    if (!disputeProcessed) {
      log?.info({ dispute_id: disputeId }, "[cart-intelligence] order.disputed duplicate — skipping");
    }
  }, { queueGroup: "cart-intelligence" });

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

    const canceledProcessed = await withDedup(`canceled:${orderId}`, async () => {
    void eventLog.append({
      orderId,
      eventType: "order.canceled",
      discriminator: orderId,
      payload: payload as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });

    await updateProfileForOrderEvent(
      orderId,
      "order.canceled",
      async (redis, profileKey) => {
        await redis.hIncrBy(profileKey, "orderCancellationCount", 1);
      },
      log,
    );
    }); // end withDedup
    if (!canceledProcessed) {
      log?.info({ order_id: orderId }, "[cart-intelligence] order.canceled duplicate — skipping");
    }
  }, { queueGroup: "cart-intelligence" });

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
  }, { queueGroup: "cart-intelligence" });

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
  }, { queueGroup: "cart-intelligence" });

  // ── outreach.sent ────────────────────────────────────────────────────────
  await subscribeNatsEvent("outreach.sent", async (payload) => {
    const { customerId, messageType } = payload as {
      customerId: string;
      messageType: string;
      sentAt: string;
    };
    if (!customerId) return;

    await applyProfileUpdate(
      customerId,
      async (redis, profileKey) => {
        await redis.hSet(profileKey, "lastOutreachAt", new Date().toISOString());
        await resetProfileTtl(customerId);
      },
      { customer_id: customerId, message_type: messageType },
      "[cart-intelligence] outreach.sent — profile updated",
      "[cart-intelligence] outreach.sent handler error",
      log,
    );
  }, { queueGroup: "cart-intelligence" });

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
  }, { queueGroup: "cart-intelligence" });

  // ── follow-up.due ─────────────────────────────────────────────────────────
  await subscribeNatsEvent("follow-up.due", async (payload) => {
    const { customerId, reason } = payload as { customerId: string; reason: string };
    log?.info({ customer_id: customerId, reason }, "[cart-intelligence] follow-up.due received");

    try {
      const customerSvc = createCustomerService();
      const customer = await customerSvc.getById(customerId);
      if (!customer?.phone) return;

      const namePart = customer.name ? `, ${customer.name}` : "";
      let message: string;
      switch (reason) {
        case "cart_save":
          message = `Oi${namePart}! Seu carrinho ainda tá salvo. Quer finalizar? Responda "meu carrinho" 🛒`;
          break;
        case "thinking":
          message = `Oi${namePart}! Pensou sobre o pedido? Posso ajudar com algo? 😊`;
          break;
        case "price_concern":
          message = `Oi${namePart}! Vi que você tava olhando nosso cardápio. Temos combos com preços especiais, quer dar uma olhada? 🥩`;
          break;
        default:
          message = `Oi${namePart}! O IbateXas tá aqui se precisar de algo 😊`;
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
  }, { queueGroup: "cart-intelligence" });
}
