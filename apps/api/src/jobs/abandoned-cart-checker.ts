// Abandoned cart checker
// Runs every 15 minutes via BullMQ repeatable job. Uses HSCAN (never KEYS *)
// to iterate rk('active:carts') hash.
// Publishes cart.abandoned for sessions idle > 2h with a non-empty cart.
//
// active:carts is a Hash: each field stores {cartId, sessionType, lastActivity}
// so the idle threshold uses the correct session TTL per session type.

import { getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { loadSession } from "../session/store.js";
import { createQueue, createWorker, type Job } from "./queue.js";

const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const SCAN_COUNT = 100; // HSCAN cursor batch size
const REPEAT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

interface ActiveCartEntry {
  cartId: string;
  sessionType: "guest" | "customer";
  lastActivity: number; // epoch ms
}

// ── The Redis client seam (R5 rollout, jobs/subscribers family) ──────────────
//
// Named-type deps bag, per the `SweeperRedis` precedent in this same directory.
//
// FAIL-CLOSED PICK ANALYSIS (R5-S12's rule) — this module is the family's
// instance of the DOWNSTREAM-CONSUMER case, and the interesting one:
//
//   • commands ISSUED here: `hScan` (the active:carts walk), `exists` + `ttl`
//     (the legacy session-TTL proxy), `hDel` (evict), `get` (session owner +
//     nudge tier), `hGet` (profile phone), `hSet` (re-arm).
//   • commands consumed DOWNSTREAM: `lRange`. `processCartEntry` calls
//     `loadSession(entry.cartId, { client: redis })`, and `loadSession`'s own
//     client type is `Pick<…, "lRange">` — a command this file never names.
//   • feature detection: none in this module's graph (measured).
//
// So the honest Pick is {issued} ∪ {lRange}, and the union is what
// `AbandonedCartRedis` declares. The "declare only what this module issues"
// reading compiles, typechecks, and SILENTLY KILLS THE JOB: `loadSession`'s
// `lRange` throws, `processCartEntry` propagates, and `checkAbandonedCarts`'s
// per-cart `try/catch` swallows it into a log line — so every cart looks like an
// error, `cart.abandoned` is never published for ANY cart, and the sweep still
// reports success. That degrade is measured in the seam test, not asserted here.

/**
 * The node-redis v4 surface the sweep needs — its OWN commands union the one
 * `session/store.ts`'s `loadSession` issues on the client it is handed.
 */
export type AbandonedCartRedis = Pick<
  Awaited<ReturnType<typeof getRedisClient>>,
  "hScan" | "exists" | "ttl" | "hDel" | "get" | "hGet" | "hSet" | "lRange"
>;

export interface CheckAbandonedCartsDeps {
  /** Injected for tests. Defaults to the shared Redis client. */
  readonly redis?: AbandonedCartRedis;
}

type RedisClient = AbandonedCartRedis;

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

/** Parse a hash entry or fall back to session TTL proxy for legacy entries. */
async function parseCartEntry(
  cartId: string,
  raw: string,
  redis: RedisClient,
  activeCartsKey: string,
): Promise<ActiveCartEntry | null> {
  try {
    return JSON.parse(raw) as ActiveCartEntry;
  } catch {
    // Legacy entry (bare cartId from before REDIS-M04) — fall back to session TTL proxy
    const sessionKey = rk(`session:${cartId}`);
    if (!(await redis.exists(sessionKey))) {
      await redis.hDel(activeCartsKey, cartId);
      return null;
    }
    const ttl = await redis.ttl(sessionKey);
    const GUEST_TTL = 48 * 60 * 60;
    const lastActivityAgoMs = GUEST_TTL * 1000 - ttl * 1000;
    return { cartId, sessionType: "guest", lastActivity: Date.now() - lastActivityAgoMs };
  }
}

/** Process a single cart entry: check idle time, emit event if abandoned. Returns true if abandoned. */
async function processCartEntry(
  cartId: string,
  raw: string,
  redis: RedisClient,
  activeCartsKey: string,
): Promise<boolean> {
  const entry = await parseCartEntry(cartId, raw, redis, activeCartsKey);
  if (!entry) return false;

  const idleMs = Date.now() - entry.lastActivity;
  if (idleMs < IDLE_THRESHOLD_MS) return false;

  // The client threads THROUGH — this is why `AbandonedCartRedis` carries an
  // `lRange` this module never issues itself.
  const history = await loadSession(entry.cartId, { client: redis });
  if (history.length === 0) {
    await redis.hDel(activeCartsKey, cartId);
    return false;
  }

  // Resolve phone from session owner if available (best-effort)
  let phone: string | undefined;
  try {
    const ownerKey = rk(`session:owner:${cartId}`);
    const ownerId = await redis.get(ownerKey);
    if (ownerId) {
      const profileKey = rk(`customer:profile:${ownerId}`);
      const profilePhone = await redis.hGet(profileKey, "phone");
      if (profilePhone) phone = profilePhone;
    }
  } catch {
    // phone resolution is best-effort — proceed without it
  }

  // Check current nudge tier to decide whether to remove from active:carts
  const nudgeKey = rk(`cart:nudge:${cartId}`);
  const nudgeRaw = await redis.get(nudgeKey);
  const isFinalTier = nudgeRaw
    ? (JSON.parse(nudgeRaw) as { tier: number }).tier === 3
    : false;

  await publishNatsEvent("cart.abandoned", {
    eventType: "cart.abandoned",
    cartId: entry.cartId,
    sessionId: entry.cartId,
    sessionType: entry.sessionType,
    idleMs,
    ...(phone ? { phone } : {}),
  });

  if (isFinalTier) {
    // Final nudge was already sent before this scan — remove from active tracking
    await redis.hDel(activeCartsKey, cartId);
  } else {
    // Re-arm for next tier: update lastActivity so the cart is re-scanned after cooldown
    const updatedEntry = { ...entry, lastActivity: Date.now() };
    await redis.hSet(activeCartsKey, cartId, JSON.stringify(updatedEntry));
  }

  return true;
}

/** Core job logic — exported for direct testing. */
export async function checkAbandonedCarts(
  log?: FastifyBaseLogger | null,
  deps: CheckAbandonedCartsDeps = {},
): Promise<void> {
  const effectiveLogger = log ?? logger;
  const redis: AbandonedCartRedis = deps.redis ?? (await getRedisClient());
  const activeCartsKey = rk("active:carts");
  let abandonedCount = 0;

  let cursor = 0;
  do {
    const scanResult = await redis.hScan(activeCartsKey, cursor, { COUNT: SCAN_COUNT });
    cursor = scanResult.cursor;

    for (const { field: cartId, value: raw } of scanResult.tuples) {
      try {
        if (await processCartEntry(cartId, raw, redis, activeCartsKey)) {
          abandonedCount++;
        }
      } catch (err) {
        effectiveLogger?.error({ cartId, error: String(err) }, "[abandoned-cart] Error processing cart");
        Sentry.withScope((scope) => {
          scope.setTag("job", "abandoned-cart-checker");
          scope.setTag("source", "background-job");
          scope.setContext("cart", { cartId });
          Sentry.captureException(err);
        });
      }
    }
  } while (cursor !== 0);

  // NOISE-5: log only when carts were actually abandoned (most runs are 0).
  if (abandonedCount > 0) {
    effectiveLogger?.info(
      { component: "job.abandoned-cart", event: "sweep", abandoned_count: abandonedCount },
      "abandoned-cart sweep flagged carts",
    );
  }
}

/** BullMQ processor — wraps the core logic with Sentry reporting. */
async function processor(_job: Job): Promise<void> {
  await checkAbandonedCarts();
}

export function startAbandonedCartChecker(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  queue = createQueue("abandoned-cart-checker");
  worker = createWorker("abandoned-cart-checker", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[abandoned-cart-checker] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "abandoned-cart-checker");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  // Add repeatable job (idempotent — BullMQ deduplicates by repeat key)
  void queue.upsertJobScheduler("abandoned-cart-repeat", {
    every: REPEAT_INTERVAL_MS,
  });
}

export async function stopAbandonedCartChecker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
