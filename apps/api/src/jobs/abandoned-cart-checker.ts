// Abandoned cart checker
// Runs every 15 minutes. Uses SSCAN (never KEYS *) to iterate rk('active:carts').
// Publishes ibatexas.cart.abandoned for sessions idle > 2h with a non-empty cart.

import { getRedisClient, rk } from "@ibatexas/tools";
import { loadSession } from "../session/store.js";
import { publishNatsEvent } from "@ibatexas/nats-client";
import type { FastifyBaseLogger } from "fastify";

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const SCAN_COUNT = 100; // SSCAN cursor batch size

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let logger: FastifyBaseLogger | null = null;

async function checkAbandonedCarts(): Promise<void> {
  const redis = await getRedisClient();
  const activeCartsKey = rk("active:carts");
  let cursor = 0;
  let abandonedCount = 0;

  do {
    const scanResult = await redis.sScan(activeCartsKey, cursor, { COUNT: SCAN_COUNT });
    cursor = scanResult.cursor;
    const members = scanResult.members;

    for (const cartId of members) {
      try {
        // Derive sessionId from cartId (cartId is stored as the member)
        // Find session that contains this cartId
        const sessionKey = `session:${cartId}`;
        const sessionExists = await redis.exists(sessionKey);

        if (!sessionExists) {
          // Session expired — remove from active:carts
          await redis.sRem(activeCartsKey, cartId);
          continue;
        }

        // Check session TTL as a proxy for last activity
        const ttl = await redis.ttl(sessionKey);
        const GUEST_TTL = 48 * 60 * 60;
        const remainingMs = ttl * 1000;
        const lastActivityAgoMs = GUEST_TTL * 1000 - remainingMs;

        if (lastActivityAgoMs < IDLE_THRESHOLD_MS) {
          // Not idle enough yet
          continue;
        }

        // Load session to check if there's actual agent chat (proxy for non-empty cart)
        const history = await loadSession(cartId);
        if (history.length === 0) {
          // Empty session — remove from tracking, no event
          await redis.sRem(activeCartsKey, cartId);
          continue;
        }

        // Publish abandoned event
        await publishNatsEvent("ibatexas.cart.abandoned", {
          eventType: "cart.abandoned",
          cartId,
          sessionId: cartId,
          idleMs: lastActivityAgoMs,
        });

        abandonedCount++;

        // Remove member to avoid duplicate events
        await redis.sRem(activeCartsKey, cartId);
      } catch (err) {
        logger?.error({ cartId, error: String(err) }, "[abandoned-cart] Error processing cart");
      }
    }
  } while (cursor !== 0);

  logger?.info({ abandoned_count: abandonedCount, run_at: new Date().toISOString() }, "Abandoned cart check complete");
}

export function startAbandonedCartChecker(log?: FastifyBaseLogger): void {
  if (intervalHandle) return;
  logger = log ?? null;
  intervalHandle = setInterval(() => {
    void checkAbandonedCarts().catch((err) => {
      logger?.error(err, "[abandoned-cart-checker] Unexpected error");
    });
  }, CHECK_INTERVAL_MS);
}

export function stopAbandonedCartChecker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
