// Proactive engagement job — scans for dormant customers and sends personalized WhatsApp messages.
// Runs every 4 hours via BullMQ repeatable job.
// Respects per-customer cooldown via Redis key to prevent spamming.

import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import * as Sentry from "@sentry/node";
import { createQueue, createWorker, type Job } from "./queue.js";
import { createCustomerService } from "@ibatexas/domain";
import { sendText } from "../whatsapp/client.js";
import { buildOutreachMessage } from "./outreach-messages.js";
import { fetchWeatherCondition } from "./weather-helper.js";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

const REPEAT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const DORMANT_THRESHOLD_DAYS = 7;
const COOLDOWN_DAYS = 3;
const MAX_MESSAGES_PER_RUN = 50;
const WEEKLY_COUNTER_TTL = 7 * 86400; // 7 days

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

/** Core job logic — exported for direct testing. */
export async function checkDormantCustomers(log?: FastifyBaseLogger | null): Promise<void> {
  const effectiveLogger = log ?? logger;

  // Time-of-day guard — only send during lunch (10-13) or dinner (17-20) windows in Brazil
  const currentHour = Number.parseInt(
    new Intl.DateTimeFormat("pt-BR", {
      hour: "numeric",
      hour12: false,
      timeZone: "America/Sao_Paulo",
    }).format(new Date()),
    10,
  );
  const inLunchWindow = currentHour >= 10 && currentHour < 13;
  const inDinnerWindow = currentHour >= 17 && currentHour < 20;
  if (!inLunchWindow && !inDinnerWindow) {
    effectiveLogger?.info(
      { current_hour: currentHour },
      "[proactive-engagement] Skipping outreach — outside meal window",
    );
    return;
  }

  // Fetch weather condition once for all customers in this run
  const weatherCondition = await fetchWeatherCondition();

  const redis = await getRedisClient();
  const customerSvc = createCustomerService();

  const dormantCustomers = await customerSvc.findDormantCustomers(DORMANT_THRESHOLD_DAYS);

  effectiveLogger?.info(
    { dormant_count: dormantCustomers.length },
    "[proactive-engagement] Found dormant customers",
  );

  let sentCount = 0;
  const now = new Date();
  const dayOfWeek = now.getDay();

  for (const customer of dormantCustomers) {
    if (sentCount >= MAX_MESSAGES_PER_RUN) break;

    try {
      // Check cooldown — skip if outreach was sent recently
      const cooldownKey = rk(`outreach:last:${customer.id}`);
      const onCooldown = await redis.exists(cooldownKey);
      if (onCooldown) {
        effectiveLogger?.info(
          { customer_id: customer.id },
          "[proactive-engagement] Skipping — cooldown active",
        );
        continue;
      }

      // Read profile for risk signals
      const profileKey = rk(`customer:profile:${customer.id}`);
      const profile = await redis.hGetAll(profileKey);
      const noShowCount = Number.parseInt(profile["noShowCount"] ?? "0", 10);
      const disputeCount = Number.parseInt(profile["disputeCount"] ?? "0", 10);

      if (noShowCount > 2 || disputeCount > 0) {
        effectiveLogger?.info(
          { customer_id: customer.id, no_show_count: noShowCount, dispute_count: disputeCount },
          "[proactive-engagement] Skipping — risk signals",
        );
        continue;
      }

      // Find top product from score:* fields
      let topProductId: string | null = null;
      let topScore = -1;
      for (const [field, value] of Object.entries(profile)) {
        if (field.startsWith("score:")) {
          const score = Number.parseFloat(value);
          if (score > topScore) {
            topScore = score;
            topProductId = field.slice(6);
          }
        }
      }

      // Resolve product name (best-effort — fall back to empty string for message default)
      let topProductName = "";
      if (topProductId) {
        try {
          const { medusaAdmin } = await import("@ibatexas/tools");
          const data = await medusaAdmin(`/admin/products/${topProductId}`) as {
            product?: { title?: string };
          };
          topProductName = data.product?.title ?? "";
        } catch {
          // Non-fatal — message builder has a fallback
        }
      }

      // Compute days since last order
      const lastOrderAtStr = profile["lastOrderAt"];
      const lastOrderMs = lastOrderAtStr ? new Date(lastOrderAtStr).getTime() : 0;
      const daysSinceLastOrder = lastOrderMs
        ? Math.floor((now.getTime() - lastOrderMs) / 86400000)
        : DORMANT_THRESHOLD_DAYS;

      const { message, type: messageType } = buildOutreachMessage(
        customer.name ?? "",
        topProductName,
        daysSinceLastOrder,
        dayOfWeek,
        weatherCondition,
      );

      // Send WhatsApp message
      await sendText(`whatsapp:${customer.phone}`, message);

      // Set cooldown key
      await redis.set(cooldownKey, "1", { EX: COOLDOWN_DAYS * 86400 });

      // Increment weekly counter (INCR + set TTL only if key is new)
      const weeklyKey = rk("outreach:weekly:count");
      const newCount = await redis.incr(weeklyKey);
      if (newCount === 1) {
        await redis.expire(weeklyKey, WEEKLY_COUNTER_TTL);
      }

      // Publish NATS event
      await publishNatsEvent("outreach.sent", {
        customerId: customer.id,
        messageType,
        sentAt: now.toISOString(),
      });

      sentCount++;
      effectiveLogger?.info(
        { customer_id: customer.id, message_type: messageType },
        "[proactive-engagement] Outreach sent",
      );
    } catch (err) {
      effectiveLogger?.error(
        { customer_id: customer.id, error: String(err) },
        "[proactive-engagement] Error sending outreach",
      );
      Sentry.withScope((scope) => {
        scope.setTag("job", "proactive-engagement");
        scope.setTag("source", "background-job");
        scope.setContext("customer", { customerId: customer.id });
        Sentry.captureException(err);
      });
    }
  }

  effectiveLogger?.info(
    { sent_count: sentCount, run_at: now.toISOString() },
    "[proactive-engagement] Run complete",
  );
}

/** BullMQ processor — wraps core logic. */
async function processor(_job: Job): Promise<void> {
  await checkDormantCustomers();
}

export function startProactiveEngagement(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("proactive-engagement");
  worker = createWorker("proactive-engagement", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[proactive-engagement] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "proactive-engagement");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  void queue.upsertJobScheduler("proactive-engagement-repeat", {
    every: REPEAT_INTERVAL_MS,
  });
}

export async function stopProactiveEngagement(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
