// F-21 — the cart-creation lock cannot be released by a non-owner. REAL REDIS.
//
// ── Why a container and not a double ─────────────────────────────────────────
//
// The property under test is compare-and-delete ATOMICITY: "delete this key
// only if its value is still my token" has to be one indivisible step on the
// Redis server, because the whole point is that another caller may be
// interleaving with us. A JS Map-stub of `eval()` would decide that comparison
// in our own process and hand back green on a code path with no real coverage —
// W4 RULE 3, which is why `createInMemoryRedis` REFUSES `eval` outright. The
// unit layer (`packages/tools/src/cart/__tests__/get-or-create-cart-lock.test.ts`)
// therefore proves the SHAPE — a UUID token, an eval release, nothing released
// on a lost race — and this file proves the SEMANTICS.
//
// ── The defect being regressed ───────────────────────────────────────────────
//
// `getOrCreateCart` took its lock with a constant value (`set(lockKey, "1",
// {NX, EX:10})`) and released it with an unconditional `del(lockKey)`. When the
// 10s TTL lapsed during a slow Medusa POST, caller A's `del` destroyed caller
// B's FRESH lock — both proceeded, both POSTed, and two carts landed on
// `rk("cart:active:session:<conversationId>")`, the key that decides what a
// checkout BUYS. Hard Rule #10; reference implementation
// `apps/api/src/whatsapp/session.ts`.
//
// The code driven below is PRODUCTION code: `acquireCartCreationLock` is the
// exact function `getOrCreateCart` calls, at the exact key it locks. Restoring
// the constant value + unconditional `del` inside it turns the first and last
// cases in this file red.
//
// Gated by RUN_REAL_REDIS, mirroring every other real-Redis suite: CI runs the
// container; local dev may opt out with `IBX_SKIP_REAL_REDIS=1`.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { acquireCartCreationLock, closeRedisClient, rk } from "@ibatexas/tools";
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js";

const SESSION = "sess_f21_ownership";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!RUN_REAL_REDIS)(
  "F-21 cart-creation lock ownership (real Redis)",
  () => {
    let harness: RedisTestHarness;
    let lockKey: string;

    beforeAll(async () => {
      harness = await setupRedisTestContainer();
      // `getRedisClient()` inside @ibatexas/tools reads REDIS_URL lazily on
      // first call, so pointing it at the container here is enough for the
      // production lock code to run against it.
      process.env.REDIS_URL = harness.url;
      process.env.APP_ENV = "test";
      // rk() reads APP_ENV at call time — build the key after setting it.
      lockKey = rk(`cart:create:lock:${SESSION}`);
    }, 120_000);

    afterAll(async () => {
      // Close the @ibatexas/tools singleton FIRST: stopping the container out
      // from under a live connection sets node-redis reconnecting against a
      // dead host and spams the run log.
      await closeRedisClient().catch(() => undefined);
      await harness?.teardown();
      delete process.env.REDIS_URL;
    });

    beforeEach(async () => {
      await harness.client.flushAll();
    });

    // ── (i) The F-21 scenario, now impossible ────────────────────────────────

    it("A's release does NOT remove B's lock after A's TTL lapsed", async () => {
      const a = await acquireCartCreationLock(SESSION);
      expect(a).not.toBeNull();

      // A is mid-Medusa-POST and its lock expires. PEXPIRE 1 + a beat models
      // the lapse exactly: post-expiry, the key is simply gone.
      await harness.client.pExpire(lockKey, 1);
      await sleep(50);
      expect(await harness.client.get(lockKey)).toBeNull();

      // B arrives and legitimately takes the lock.
      const b = await acquireCartCreationLock(SESSION);
      expect(b).not.toBeNull();
      expect(b?.value).not.toBe(a?.value);

      // A finally returns and releases. Pre-F-21 this deleted B's lock.
      await a?.release();

      expect(await harness.client.get(lockKey)).toBe(b?.value);

      // …and B is still the owner, i.e. its own release still works.
      await b?.release();
      expect(await harness.client.get(lockKey)).toBeNull();
    });

    // ── (ii) The normal path still releases ──────────────────────────────────

    it("A acquires and releases its OWN lock normally", async () => {
      const a = await acquireCartCreationLock(SESSION);
      expect(a).not.toBeNull();
      expect(await harness.client.get(lockKey)).toBe(a?.value);

      await a?.release();

      expect(await harness.client.get(lockKey)).toBeNull();
      // The lock is genuinely free again, not merely value-cleared.
      const next = await acquireCartCreationLock(SESSION);
      expect(next).not.toBeNull();
    });

    it("locks the documented key with a bounded TTL", async () => {
      await acquireCartCreationLock(SESSION);

      expect(await harness.client.exists(lockKey)).toBe(1);
      const ttl = await harness.client.ttl(lockKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10);
    });

    // ── (iii) Competing clients: exactly one winner ──────────────────────────

    it("a concurrent acquire storm produces exactly ONE winner while held", async () => {
      const results = await Promise.all(
        Array.from({ length: 25 }, () => acquireCartCreationLock(SESSION)),
      );

      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      const winner = winners[0];
      expect(await harness.client.get(lockKey)).toBe(winner?.value);

      // Every loser now runs `getOrCreateCart`'s finally: `lock?.release()` on
      // a null handle. Pre-F-21 this same branch ran an unconditional
      // `redis.del(lockKey)` — 24 deletions of the winner's lock.
      const losers = results.filter((r) => r !== winner);
      expect(losers).toHaveLength(24);
      await Promise.all(losers.map((l) => l?.release()));

      expect(await harness.client.get(lockKey)).toBe(winner?.value);
    });

    it("a second storm after release again produces exactly ONE winner", async () => {
      const first = await Promise.all(
        Array.from({ length: 10 }, () => acquireCartCreationLock(SESSION)),
      );
      const firstWinner = first.find((r) => r !== null);
      await firstWinner?.release();

      const second = await Promise.all(
        Array.from({ length: 10 }, () => acquireCartCreationLock(SESSION)),
      );

      expect(second.filter((r) => r !== null)).toHaveLength(1);
    });

    // ── (iv) Control: the pre-F-21 release DOES destroy B's lock ─────────────
    //
    // Without this the ownership cases could be passing for the wrong reason
    // (e.g. if the sequence never actually let B take the lock). This runs the
    // IDENTICAL sequence and swaps only the release mechanism for the one the
    // fix removed; it MUST show the damage.

    it("control — an unconditional DEL in the same sequence DOES destroy B's lock", async () => {
      await acquireCartCreationLock(SESSION);
      await harness.client.pExpire(lockKey, 1);
      await sleep(50);
      const b = await acquireCartCreationLock(SESSION);
      // Possession only — deliberately NOT a token-identity assertion, so this
      // control measures the release mechanism and nothing else.
      expect(b).not.toBeNull();
      expect(await harness.client.get(lockKey)).toBe(b?.value);

      // The pre-F-21 release, verbatim: `await redis.del(lockKey)`.
      await harness.client.del(lockKey);

      expect(await harness.client.get(lockKey)).toBeNull();
      // B is no longer protected: a third caller walks straight in, which is
      // the double-cart mechanism.
      const c = await acquireCartCreationLock(SESSION);
      expect(c).not.toBeNull();
    });
  },
);
