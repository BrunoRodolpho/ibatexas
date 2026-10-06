// Proactive engagement job — scans for dormant customers and sends personalized WhatsApp messages.
// Runs every 4 hours via BullMQ repeatable job.
// Respects per-customer cooldown via Redis key to prevent spamming.

import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import * as Sentry from "@sentry/node";
import { createCustomerService } from "@ibatexas/domain";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { mintCronReply } from "@adjudicate/core";
import { sendText } from "../whatsapp/client.js";
import { createQueue, createWorker, type Job } from "./queue.js";
import { buildOutreachMessage } from "./outreach-messages.js";
import { fetchWeatherCondition } from "./weather-helper.js";

const REPEAT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const DORMANT_THRESHOLD_DAYS = 7;
const COOLDOWN_DAYS = 3;
const MAX_MESSAGES_PER_RUN = 50;
const WEEKLY_COUNTER_TTL = 7 * 86400; // 7 days

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

type DormantCustomer = Awaited<
  ReturnType<ReturnType<typeof createCustomerService>["findDormantCustomers"]>
>[number];

// ── The Redis client seam (R5 rollout, jobs/subscribers family) ──────────────
//
// Named-type deps bag, per the `SweeperRedis` precedent in this same directory.
//
// FAIL-CLOSED PICK ANALYSIS (R5-S12's rule):
//   • commands ISSUED here: `exists` (cooldown probe), `hGetAll` (risk profile),
//     `set` (cooldown write), `incr` + `expire` (the weekly cap counter).
//   • commands consumed DOWNSTREAM: none. The client goes into
//     `OutreachRunContext` and no further — `processCustomerOutreach` is
//     module-local. `fetchWeatherCondition()` DOES take a client now, and is
//     deliberately NOT handed this one; see below.
//   • feature detection: none in this module's graph (measured).
// So the Pick is {exists, hGetAll, set, incr, expire}.
//
// WHY `fetchWeatherCondition` KEEPS ITS OWN RESOLUTION. Collapsing the two into
// one client would change the default path's singleton-resolution COUNT from two
// to one — a behaviour change smuggled in under a refactor. The R5 rollout's
// standing rule (family 1, `trackCartId`) is that a callee's own resolution is
// not folded into its caller's client; the count is pinned as a test rather than
// asserted in prose.
//
// SWALLOWING: every command here is awaited without a local catch. The
// per-customer `try/catch` in `checkDormantCustomers` DOES swallow (it logs +
// Sentry-reports and moves to the next customer), so a client missing one of
// these five degrades to "zero outreach sent, N errors logged" rather than a
// job failure — which is why the seam test asserts the WRITES landed, not just
// that the run completed.

/** The node-redis v4 surface this job's cooldown + weekly-cap guards use. */
export type OutreachRedis = Pick<
  Awaited<ReturnType<typeof getRedisClient>>,
  "exists" | "hGetAll" | "set" | "incr" | "expire"
>;

export interface CheckDormantCustomersDeps {
  /** Injected for tests. Defaults to the shared Redis client. */
  readonly redis?: OutreachRedis;
}

interface OutreachRunContext {
  redis: OutreachRedis;
  log: FastifyBaseLogger | null;
  now: Date;
  dayOfWeek: number;
  weatherCondition: Awaited<ReturnType<typeof fetchWeatherCondition>>;
}

/** Current hour (0-23) in the restaurant timezone. */
function getRestaurantHour(): number {
  return Number.parseInt(
    new Intl.DateTimeFormat("pt-BR", {
      hour: "numeric",
      hour12: false,
      timeZone: process.env.RESTAURANT_TIMEZONE || "America/Sao_Paulo",
    }).format(new Date()),
    10,
  );
}

/** True only during the lunch (10-13) or dinner (17-20) outreach windows. */
function isWithinMealWindow(hour: number): boolean {
  const inLunchWindow = hour >= 10 && hour < 13;
  const inDinnerWindow = hour >= 17 && hour < 20;
  return inLunchWindow || inDinnerWindow;
}

/** Pick the highest-scoring product id from the profile's score:* fields. */
function findTopProductId(profile: Record<string, string>): string | null {
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
  return topProductId;
}

/** Resolve product name (best-effort — empty string lets the message builder fall back). */
async function resolveTopProductName(topProductId: string | null): Promise<string> {
  if (!topProductId) return "";
  try {
    const { medusaAdmin } = await import("@ibatexas/tools");
    const data = (await medusaAdmin(`/admin/products/${topProductId}`)) as {
      product?: { title?: string };
    };
    return data.product?.title ?? "";
  } catch {
    // Non-fatal — message builder has a fallback
    return "";
  }
}

/**
 * Process outreach for a single customer.
 * Returns true if a message was actually sent (so the caller can count it).
 */
async function processCustomerOutreach(
  customer: DormantCustomer,
  ctx: OutreachRunContext,
): Promise<boolean> {
  const { redis, log, now, dayOfWeek, weatherCondition } = ctx;

  // Check cooldown — skip if outreach was sent recently
  const cooldownKey = rk(`outreach:last:${customer.id}`);
  const onCooldown = await redis.exists(cooldownKey);
  if (onCooldown) {
    log?.info(
      { customer_id: customer.id },
      "[proactive-engagement] Skipping — cooldown active",
    );
    return false;
  }

  // Read profile for risk signals
  const profileKey = rk(`customer:profile:${customer.id}`);
  const profile = await redis.hGetAll(profileKey);
  const noShowCount = Number.parseInt(profile["noShowCount"] ?? "0", 10);
  const disputeCount = Number.parseInt(profile["disputeCount"] ?? "0", 10);

  if (noShowCount > 2 || disputeCount > 0) {
    log?.info(
      { customer_id: customer.id, no_show_count: noShowCount, dispute_count: disputeCount },
      "[proactive-engagement] Skipping — risk signals",
    );
    return false;
  }

  const topProductId = findTopProductId(profile);
  const topProductName = await resolveTopProductName(topProductId);

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
  await sendText(`whatsapp:${customer.phone}`, mintCronReply(message));

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

  log?.info(
    { customer_id: customer.id, message_type: messageType },
    "[proactive-engagement] Outreach sent",
  );
  return true;
}

/** Log + report an error raised while processing a single customer's outreach. */
function reportOutreachError(
  log: FastifyBaseLogger | null,
  customer: DormantCustomer,
  err: unknown,
): void {
  log?.error(
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

/** Core job logic — exported for direct testing. */
export async function checkDormantCustomers(
  log?: FastifyBaseLogger | null,
  deps: CheckDormantCustomersDeps = {},
): Promise<void> {
  const effectiveLogger = log ?? logger;

  // Time-of-day guard — only send during lunch (10-13) or dinner (17-20) windows in Brazil
  const currentHour = getRestaurantHour();
  if (!isWithinMealWindow(currentHour)) {
    effectiveLogger?.info(
      { current_hour: currentHour },
      "[proactive-engagement] Skipping outreach — outside meal window",
    );
    return;
  }

  // Fetch weather condition once for all customers in this run
  const weatherCondition = await fetchWeatherCondition();

  const redis: OutreachRedis = deps.redis ?? (await getRedisClient());
  const customerSvc = createCustomerService();

  const dormantCustomers = await customerSvc.findDormantCustomers(DORMANT_THRESHOLD_DAYS);

  effectiveLogger?.info(
    { dormant_count: dormantCustomers.length },
    "[proactive-engagement] Found dormant customers",
  );

  let sentCount = 0;
  const now = new Date();
  const ctx: OutreachRunContext = {
    redis,
    log: effectiveLogger,
    now,
    dayOfWeek: now.getDay(),
    weatherCondition,
  };

  for (const customer of dormantCustomers) {
    if (sentCount >= MAX_MESSAGES_PER_RUN) break;

    try {
      const sent = await processCustomerOutreach(customer, ctx);
      if (sent) sentCount++;
    } catch (err) {
      reportOutreachError(effectiveLogger, customer, err);
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
