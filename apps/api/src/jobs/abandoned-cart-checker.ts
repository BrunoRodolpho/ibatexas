// Abandoned cart checker
// Runs every 15 minutes. Uses HSCAN (never KEYS *) to iterate rk('active:carts') hash.
// Publishes cart.abandoned for sessions idle > 2h with a non-empty cart.
//
// AUDIT-FIX: REDIS-M04 — active:carts is now a Hash (not Set). Each field stores
// {cartId, sessionType, lastActivity} so idle threshold uses correct session TTL
// instead of guessing from session TTL (which differed for guest vs authenticated).

import { getRedisClient, rk } from "@ibatexas/tools";
import { loadSession } from "../session/store.js";
import { publishNatsEvent } from "@ibatexas/nats-client";
import type { FastifyBaseLogger } from "fastify";

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const SCAN_COUNT = 100; // HSCAN cursor batch size

interface ActiveCartEntry {
  cartId: string;
  sessionType: "guest" | "customer";
  lastActivity: number; // epoch ms
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let logger: FastifyBaseLogger | null = null;
// AUDIT-FIX: EVT-F02 — Overlap guard prevents concurrent job runs
let isRunning = false;

async function checkAbandonedCarts(): Promise<void> {
  // AUDIT-FIX: EVT-F02 — Skip if previous run still in progress
  if (isRunning) return;
  isRunning = true;
  try {
    const redis = await getRedisClient();
    const activeCartsKey = rk("active:carts");
    let abandonedCount = 0;

    // AUDIT-FIX: REDIS-M04 — iterate hash fields via HSCAN instead of SSCAN
    let cursor = 0;
    do {
      const scanResult = await redis.hScan(activeCartsKey, cursor, { COUNT: SCAN_COUNT });
      cursor = scanResult.cursor;

      for (const { field: cartId, value: raw } of scanResult.tuples) {
        try {
          let entry: ActiveCartEntry;
          try {
            entry = JSON.parse(raw) as ActiveCartEntry;
          } catch {
            // Legacy entry (bare cartId from before the fix) — fall back to session TTL proxy
            const sessionKey = rk(`session:${cartId}`);
            const sessionExists = await redis.exists(sessionKey);
            if (!sessionExists) {
              await redis.hDel(activeCartsKey, cartId);
              continue;
            }
            const ttl = await redis.ttl(sessionKey);
            const GUEST_TTL = 48 * 60 * 60;
            const remainingMs = ttl * 1000;
            const lastActivityAgoMs = GUEST_TTL * 1000 - remainingMs;
            entry = { cartId, sessionType: "guest", lastActivity: Date.now() - lastActivityAgoMs };
          }

          const idleMs = Date.now() - entry.lastActivity;

          if (idleMs < IDLE_THRESHOLD_MS) {
            // Not idle enough yet
            continue;
          }

          // Load session to check if there's actual agent chat (proxy for non-empty cart)
          const history = await loadSession(entry.cartId);
          if (history.length === 0) {
            // Empty session — remove from tracking, no event
            await redis.hDel(activeCartsKey, cartId);
            continue;
          }

          // Publish abandoned event
          await publishNatsEvent("cart.abandoned", {
            eventType: "cart.abandoned",
            cartId: entry.cartId,
            sessionId: entry.cartId,
            sessionType: entry.sessionType,
            idleMs,
          });

          abandonedCount++;

          // Remove member to avoid duplicate events
          await redis.hDel(activeCartsKey, cartId);
        } catch (err) {
          logger?.error({ cartId, error: String(err) }, "[abandoned-cart] Error processing cart");
        }
      }
    } while (cursor !== 0);

    logger?.info({ abandoned_count: abandonedCount, run_at: new Date().toISOString() }, "Abandoned cart check complete");
  } finally {
    isRunning = false;
  }
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
