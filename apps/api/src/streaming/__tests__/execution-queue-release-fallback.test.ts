// F-21 (class rollout, site 3) — `releaseWebAgentLock`'s no-tracked-state
// fallback must NOT delete the key. REAL REDIS.
//
// ── The defect being regressed ───────────────────────────────────────────────
//
// `streaming/execution-queue.ts` is otherwise the GOOD pattern already: a UUID
// lock value, a Lua compare-and-delete release, an ownership-checked heartbeat.
// One branch escaped it:
//
//     if (state) {
//       await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [state.lockValue] })
//     } else {
//       // Fallback: if no state tracked (shouldn't happen), unconditional DEL
//       await redis.del(key)
//     }
//
// `state` is the per-PROCESS `activeLocks` Map. The Redis key is not
// per-process. So "no tracked state" is reached exactly when this process
// cannot know who holds the key — after a restart, or on a second release for a
// session whose first release already cleared the entry. In both, the key may
// belong to a DIFFERENT, live cycle, and deleting it lets a concurrent agent
// run for that session: the mutual exclusion this module exists to provide.
//
// Per the F-22 ruling's failure direction, with no ownership proof the safe
// action is leave-to-TTL plus a loud log. The cost is bounded — at most
// LOCK_TTL_SECONDS of a stuck session, and the heartbeat that could extend it
// past that is gone with the state. A blind DEL's cost is a concurrency bug
// with no bound.
//
// ── Why a container ─────────────────────────────────────────────────────────
//
// The owned-release half is a Lua compare-and-delete, which needs a real server
// (W4 RULE 3). Both halves are driven through the PRODUCTION
// `acquireWebAgentLock` / `releaseWebAgentLock`, whose module resolves
// `getRedisClient()` from `@ibatexas/tools` — pointed at the container by
// setting REDIS_URL before the first call.
//
// Enrolled in the M0 loud-skip roll call (`scripts/check-real-redis-suites.mjs`).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rk } from "@ibatexas/tools";
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "../../__tests__/helpers/redis-testcontainer.js";

const SESSION = "sess_f21_execqueue";

describe.skipIf(!RUN_REAL_REDIS)(
  "F-21 web-agent lock release fallback (real Redis)",
  () => {
    let harness: RedisTestHarness;
    let key: string;
    let acquireWebAgentLock: (s: string) => Promise<boolean>;
    let releaseWebAgentLock: (s: string) => Promise<void>;

    beforeAll(async () => {
      harness = await setupRedisTestContainer();
      // `getRedisClient()` reads REDIS_URL lazily on first call, so pointing it
      // at the container here is enough for the production module to run
      // against it. Import AFTER, so the module graph binds to this env.
      process.env.REDIS_URL = harness.url;
      process.env.APP_ENV = "test";
      const mod = await import("../execution-queue.js");
      acquireWebAgentLock = mod.acquireWebAgentLock;
      releaseWebAgentLock = mod.releaseWebAgentLock;
      key = rk(`web:agent:${SESSION}`);
    }, 90_000);

    afterAll(async () => {
      await harness?.teardown();
    });

    beforeEach(async () => {
      await harness.client.flushAll();
      vi.restoreAllMocks();
    });

    // ── (i) The headline: no tracked state ⇒ the key SURVIVES ───────────────

    it("no tracked state → the key is NOT deleted (left to its TTL)", async () => {
      // A key held by SOMEONE ELSE — a different process's live cycle. This
      // process has never acquired for this session, so `activeLocks` has no
      // entry and the fallback branch is the one that runs.
      const foreign = "foreign-process-lock-value";
      await harness.client.set(key, foreign, { EX: 30 });

      await releaseWebAgentLock(SESSION);

      // THE DEFECT WOULD FIRE HERE. The foreign holder keeps its lock.
      expect(await harness.client.get(key)).toBe(foreign);

      // …and its TTL is untouched, so it still expires on its own schedule
      // rather than living forever. BOUNDED, not exact-equality (#517).
      const ttl = await harness.client.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
    });

    it("no tracked state → a loud warn names the condition", async () => {
      const { logger } = await import("../../lib/logger.js");
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

      await harness.client.set(key, "foreign-process-lock-value", { EX: 30 });
      await releaseWebAgentLock(SESSION);

      // Loud, and identifiable: silently leaving a key would be indistinguishable
      // from the release having worked, which is why the ruling asks for a log
      // rather than just the absence of a DEL.
      expect(warn).toHaveBeenCalledTimes(1);
      const [ctx, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
      expect(ctx["component"]).toBe("execution-queue");
      expect(ctx["sessionId"]).toBe(SESSION);
      expect(ctx["key"]).toBe(key);
      expect(msg).toContain("no tracked lock state");
    });

    // ── (ii) The owned path is UNCHANGED ────────────────────────────────────

    it("an owned release still deletes the key (ownership-checked, unchanged)", async () => {
      expect(await acquireWebAgentLock(SESSION)).toBe(true);
      const held = await harness.client.get(key);
      expect(held).not.toBeNull();

      await releaseWebAgentLock(SESSION);

      expect(await harness.client.get(key)).toBeNull();
      // …so the session can run again immediately.
      expect(await acquireWebAgentLock(SESSION)).toBe(true);
      await releaseWebAgentLock(SESSION);
    });

    it("an owned release does not delete a key that changed hands mid-cycle", async () => {
      expect(await acquireWebAgentLock(SESSION)).toBe(true);

      // This process's TTL lapsed and another cycle claimed the session.
      const foreign = "another-cycles-lock-value";
      await harness.client.set(key, foreign);

      await releaseWebAgentLock(SESSION);

      // The compare-and-delete matched nothing — this is the branch that was
      // ALREADY correct before F-21, pinned here so the fallback change is
      // measured against a working control rather than against nothing.
      expect(await harness.client.get(key)).toBe(foreign);
    });

    // ── (iii) A SECOND release finds no state — the live regression shape ───

    it("a second release for the same session leaves a re-acquired lock intact", async () => {
      expect(await acquireWebAgentLock(SESSION)).toBe(true);
      await releaseWebAgentLock(SESSION); // clears the Map entry
      expect(await harness.client.get(key)).toBeNull();

      // A NEW cycle (or another process) claims the session.
      const nextCycle = "next-cycles-lock-value";
      await harness.client.set(key, nextCycle, { EX: 30 });

      // A stray second release — the "shouldn't happen" the old comment waved
      // at. It now finds no state and must leave the new cycle alone.
      await releaseWebAgentLock(SESSION);

      expect(await harness.client.get(key)).toBe(nextCycle);
    });

    // ── (iv) CONTROL: the pre-F-21 fallback DOES destroy it ─────────────────
    //
    // Without this, the cases above could pass for the wrong reason — e.g. if
    // `releaseWebAgentLock` never reached the fallback at all. This reproduces
    // the IDENTICAL end state and runs the mechanism the fix removed. It MUST
    // show the damage.

    it("control — the pre-F-21 unconditional DEL in the same end state DOES destroy it", async () => {
      const foreign = "foreign-process-lock-value";
      await harness.client.set(key, foreign, { EX: 30 });

      // The pre-F-21 fallback, verbatim: `await redis.del(key)`.
      await harness.client.del(key);

      expect(await harness.client.get(key)).toBeNull();
      // The foreign holder is no longer protected: a concurrent agent walks
      // straight in for a session that already has one running.
      expect(await acquireWebAgentLock(SESSION)).toBe(true);
      await releaseWebAgentLock(SESSION);
    });
  },
);
