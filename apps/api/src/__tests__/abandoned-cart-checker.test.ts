// Tests for abandoned-cart-checker job.
// NATS is mocked; Redis is the canonical in-memory adapter, INJECTED through
// the job's own seam. Tests call the exported checkAbandonedCarts() processor
// directly (BullMQ is mocked).
//
// ── R5 rollout, family 2 — what the migration killed here ───────────────────
//
// The retired double was seven bare `vi.fn()`s plus a FAKED `rk` returning
// `test:${k}`, and `session/store.js` was mocked whole. Four fictions rode on
// that, and the last is the one this family's Pick rule is about:
//
//   1. The wrong prefix. The real `rk()` under apps/api's vitest resolves to
//      `development:`, so every `expect(hDel).toHaveBeenCalledWith("test:active:carts", …)`
//      asserted a key production has never written.
//   2. `hDel`/`hSet` recorded a CALL and changed nothing. "removes cart from the
//      active hash" meant "hDel was invoked", not "the cart is gone" — so a
//      module that deleted the wrong field, or re-added it a line later, passed.
//      The re-arm (`hSet`) likewise could not be observed by any later scan.
//   3. The paging case planted `cursor: 42` — a handle no HSCAN on this client
//      ever issued. It proved the loop follows a cursor the TEST invented, not
//      that it terminates on a real one. It now walks a 150-entry hash whose
//      pages the adapter mints.
//   4. `loadSession` was mocked, which hid the whole DOWNSTREAM half of the
//      fail-closed Pick: the job hands its client to `loadSession`, whose client
//      type is `Pick<…, "lRange">`. With the store mocked, a client that cannot
//      serve `lRange` — the naive "declare what this module issues" Pick — looks
//      perfectly healthy here. `session/store.js` is now REAL, so the history
//      these tests read is a list written through the adapter.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";
import { rk } from "@ibatexas/tools";
import {
  checkAbandonedCarts,
  startAbandonedCartChecker,
  stopAbandonedCartChecker,
} from "../jobs/abandoned-cart-checker.js";

// ── Hoisted mock functions ──────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());

// ── Mocks (before imports) ──────────────────────────────────────────────────

// Only the CLIENT resolver is replaced. `rk` runs REAL (Hard Rule #7), and
// `session/store.js` is NOT mocked — see fiction 4 above.
vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return { ...actual, getRedisClient: mockGetRedisClient };
});

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("../jobs/queue.js", () => ({
  createQueue: vi.fn(() => ({
    upsertJobScheduler: vi.fn(),
    close: vi.fn(),
  })),
  createWorker: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("@sentry/node", () => ({
  withScope: vi.fn((cb: (scope: unknown) => void) => cb({ setTag: vi.fn(), setContext: vi.fn() })),
  captureException: vi.fn(),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h
const ACTIVE_CARTS = (): string => rk("active:carts");

function createMockLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: "info",
  };
}

describe("abandoned-cart-checker", () => {
  let redis: InMemoryRedis;

  /** Write an active:carts entry, the way `trackCartId` writes it. */
  async function track(
    cartId: string,
    sessionType: "guest" | "customer",
    idleMs: number,
  ): Promise<void> {
    await redis.client.hSet(
      ACTIVE_CARTS(),
      cartId,
      JSON.stringify({ cartId, sessionType, lastActivity: Date.now() - idleMs }),
    );
  }

  /** Seed a session history the REAL `loadSession` will read via LRANGE. */
  async function seedHistory(cartId: string, content = "Quero costela"): Promise<void> {
    await redis.client.rPush(rk(`session:${cartId}`), JSON.stringify({ role: "user", content }));
  }

  /** The fields still present in active:carts, read straight out of the keyspace. */
  async function activeCartIds(): Promise<string[]> {
    return Object.keys(await redis.client.hGetAll(ACTIVE_CARTS())).sort();
  }

  const run = (log?: unknown) =>
    checkAbandonedCarts(log as never, { redis: redis.client });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // The adapter reads the FAKE clock, so TTLs move when a test advances time.
    redis = createInMemoryRedis({ now: () => Date.now() });
    mockPublishNatsEvent.mockResolvedValue(undefined);
    // Tripwire by default — every case here injects. The two cases that
    // deliberately exercise the DEFAULT path override this.
    mockGetRedisClient.mockRejectedValue(
      new Error("getRedisClient() resolved — the abandoned-cart seam is unwired"),
    );
  });

  afterEach(async () => {
    await stopAbandonedCartChecker();
    vi.useRealTimers();
  });

  // ── start / stop lifecycle ──────────────────────────────────────────────

  it("starts and stops without errors", async () => {
    expect(() => startAbandonedCartChecker()).not.toThrow();
    await expect(stopAbandonedCartChecker()).resolves.toBeUndefined();
  });

  it("does not start a second worker if already running", () => {
    startAbandonedCartChecker();
    // Second call should be a no-op
    expect(() => startAbandonedCartChecker()).not.toThrow();
  });

  it("stopAbandonedCartChecker is safe to call when not started", async () => {
    await expect(stopAbandonedCartChecker()).resolves.toBeUndefined();
  });

  // ── Empty cart hash ────────────────────────────────────────────────────────

  it("handles an empty active:carts hash and scans the REAL rk() key", async () => {
    await run();

    const scans = redis.calls.filter((c) => c.command === "hScan");
    expect(scans).toHaveLength(1);
    expect(scans[0]!.args).toEqual([ACTIVE_CARTS(), 0, { COUNT: 100 }]);
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Cart not idle enough ─────────────────────────────────────────────

  it("skips carts that have not been idle long enough", async () => {
    await track("cart_02", "guest", 30 * 60 * 1000); // 30 minutes
    await seedHistory("cart_02");

    await run();

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    // The cart is still tracked — asserted against the keyspace, not a spy.
    expect(await activeCartIds()).toEqual(["cart_02"]);
  });

  // ── Session idle but empty history — remove silently ──────────────────────

  it("removes cart from the active hash when the session has empty history", async () => {
    await track("cart_03", "guest", 3 * 60 * 60 * 1000);
    // No `seedHistory` — the REAL loadSession LRANGEs an absent list and gets [].

    await run();

    expect(await activeCartIds()).toEqual([]);
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });

  // ── Abandoned cart — publish event and re-arm ─────────────────────────────

  it("publishes cart.abandoned for an idle cart with non-empty history, and RE-ARMS it", async () => {
    await track("cart_04", "guest", 3 * 60 * 60 * 1000);
    await seedHistory("cart_04");

    await run();

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.abandoned",
      expect.objectContaining({
        eventType: "cart.abandoned",
        cartId: "cart_04",
        sessionId: "cart_04",
        sessionType: "guest",
      }),
    );

    // No nudge key exists (first detection) → the cart is RE-ARMED, not evicted:
    // still present, with `lastActivity` moved to now. The retired double could
    // only see that `hSet` was called.
    const stored = await redis.client.hGetAll(ACTIVE_CARTS());
    expect(Object.keys(stored)).toEqual(["cart_04"]);
    expect(JSON.parse(stored["cart_04"]!)).toMatchObject({
      cartId: "cart_04",
      sessionType: "guest",
      lastActivity: Date.now(),
    });
  });

  it("EVICTS a cart already at the final nudge tier instead of re-arming it", async () => {
    await track("cart_final", "guest", 3 * 60 * 60 * 1000);
    await seedHistory("cart_final");
    await redis.client.set(rk("cart:nudge:cart_final"), JSON.stringify({ tier: 3 }));

    await run();

    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);
    expect(await activeCartIds()).toEqual([]);
  });

  it("attaches the owner's phone from the customer profile when one is resolvable", async () => {
    await track("cart_phone", "guest", 3 * 60 * 60 * 1000);
    await seedHistory("cart_phone");
    await redis.client.set(rk("session:owner:cart_phone"), "cust_9");
    await redis.client.hSet(rk("customer:profile:cust_9"), "phone", "+5511999990001");

    await run();

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.abandoned",
      expect.objectContaining({ cartId: "cart_phone", phone: "+5511999990001" }),
    );
  });

  // ── Multiple carts in a single scan batch ─────────────────────────────────

  it("processes multiple carts in one scan batch", async () => {
    const idleMs = 4 * 60 * 60 * 1000; // 4 hours
    await track("cart_a", "guest", idleMs);
    await track("cart_b", "customer", idleMs);
    await track("cart_c", "guest", idleMs);
    for (const id of ["cart_a", "cart_b", "cart_c"]) await seedHistory(id, "Ola!");

    await run();

    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(3);
    // No nudge keys exist (first detection) → all three re-armed, none evicted.
    expect(await activeCartIds()).toEqual(["cart_a", "cart_b", "cart_c"]);
  });

  // ── Pagination (multi-page HSCAN) ─────────────────────────────────────────

  it("paginates through HSCAN with cursors the CLIENT minted, and terminates", async () => {
    // SCAN_COUNT is 100, so 150 entries force a genuine second page. The
    // retired double planted `cursor: 42`, a handle no client ever issued.
    const idleMs = 2.5 * 60 * 60 * 1000;
    for (let i = 0; i < 150; i++) {
      await track(`cart_p${i}`, "guest", idleMs);
      await seedHistory(`cart_p${i}`, "Oi");
    }

    await run();

    const scans = redis.calls.filter((c) => c.command === "hScan");
    expect(scans).toHaveLength(2);
    expect(scans[0]!.args[1]).toBe(0);
    // The second call's cursor is whatever the FIRST call returned — not 42.
    expect(scans[1]!.args[1]).not.toBe(0);
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(150);
  });

  // ── Error handling per cart ───────────────────────────────────────────────

  it("continues processing remaining carts when one throws", async () => {
    const idleMs = 3 * 60 * 60 * 1000;
    await track("cart_fail", "guest", idleMs);
    await track("cart_ok", "guest", idleMs);
    await seedHistory("cart_ok", "Pedido");
    // A spy-DELEGATE fault injector: it decides whether THIS lRange throws and
    // otherwise forwards to the adapter, so `cart_ok` still runs against real
    // list semantics.
    const realLRange = redis.client.lRange.bind(redis.client);
    const faulty = new Proxy(redis.client, {
      get(target, prop) {
        if (prop !== "lRange") return Reflect.get(target, prop) as unknown;
        return (key: string, start: number, stop: number) =>
          key === rk("session:cart_fail")
            ? Promise.reject(new Error("Redis timeout"))
            : realLRange(key, start, stop);
      },
    });

    const mockLogger = createMockLogger();
    await checkAbandonedCarts(mockLogger as never, { redis: faulty as never });

    // Error logged for the first cart
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ cartId: "cart_fail" }),
      "[abandoned-cart] Error processing cart",
    );

    // Second cart still published successfully
    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.abandoned",
      expect.objectContaining({ cartId: "cart_ok" }),
    );
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);
  });

  // ── Exactly at idle threshold — is abandoned ─────────────────────────

  it("flags cart at exactly the idle threshold as abandoned", async () => {
    await track("cart_exact", "guest", IDLE_THRESHOLD_MS);
    await seedHistory("cart_exact", "Oi");

    await run();

    // At exactly 2h: condition is `<` so exactly 2h passes through -> is abandoned
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);
  });

  // ── Logger receives completion summary ────────────────────────────────────

  it("logs completion summary with abandoned count", async () => {
    await track("cart_log", "guest", 5 * 60 * 60 * 1000);
    await seedHistory("cart_log", "Menu");

    const mockLogger = createMockLogger();
    await run(mockLogger);

    // NOISE-5: summary logs only when carts were abandoned, tagged component/event.
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "job.abandoned-cart",
        event: "sweep",
        abandoned_count: 1,
      }),
      "abandoned-cart sweep flagged carts",
    );
  });

  // ── Unexpected top-level error is caught ──────────────────────────────────

  it("throws unexpected errors from checkAbandonedCarts for BullMQ to handle", async () => {
    // The DEFAULT path — no client threaded — so the singleton IS resolved and
    // its failure propagates. This also doubles as the seam's fallback control:
    // if the `?? (await getRedisClient())` were dropped, nothing here would
    // reach the resolver at all.
    mockGetRedisClient.mockRejectedValue(new Error("Redis connection refused"));

    await expect(checkAbandonedCarts()).rejects.toThrow("Redis connection refused");
  });

  it("uses the singleton when NO client is threaded (the default is preserved)", async () => {
    const singleton = createInMemoryRedis({ now: () => Date.now() });
    mockGetRedisClient.mockResolvedValue(singleton.client);
    await singleton.client.hSet(
      ACTIVE_CARTS(),
      "cart_singleton",
      JSON.stringify({
        cartId: "cart_singleton",
        sessionType: "guest",
        lastActivity: Date.now() - 3 * 60 * 60 * 1000,
      }),
    );
    await singleton.client.rPush(
      rk("session:cart_singleton"),
      JSON.stringify({ role: "user", content: "Oi" }),
    );

    await checkAbandonedCarts();

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.abandoned",
      expect.objectContaining({ cartId: "cart_singleton" }),
    );
    // ...and the INJECTED keyspace of this describe was untouched.
    expect(redis.calls).toHaveLength(0);
  });

  // ── Legacy entry fallback ─────────────────────────────────────────────────

  it("handles legacy entries (bare cartId) by falling back to session TTL", async () => {
    const GUEST_TTL = 48 * 60 * 60;
    const idleMs = 3 * 60 * 60 * 1000; // 3 hours
    const ttlSeconds = GUEST_TTL - idleMs / 1000;

    // A bare cartId, not JSON — the pre-REDIS-M04 shape.
    await redis.client.hSet(ACTIVE_CARTS(), "cart_legacy", "cart_legacy");
    // The TTL proxy the fallback reads is `rk("session:<id>")` — the SAME key
    // `loadSession` LRANGEs, which production writes as a LIST with a TTL set by
    // `appendMessages`' pipeline. The retired double had `exists`, `ttl` and
    // `loadSession` as three unrelated constants, so nothing forced them to be
    // about one key of one type; the first draft of this migration seeded a
    // STRING here and the adapter refused it (WRONGTYPE) — which is the fiction
    // being killed, stated as an observation rather than a claim.
    await seedHistory("cart_legacy", "Oi");
    expect(await redis.client.expire(rk("session:cart_legacy"), ttlSeconds)).toBe(true);

    await run();

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "cart.abandoned",
      expect.objectContaining({ cartId: "cart_legacy" }),
    );
  });

  it("removes legacy entry when session no longer exists", async () => {
    await redis.client.hSet(ACTIVE_CARTS(), "cart_old", "cart_old");
    // No session key at all — `exists` answers 0 out of the real keyspace.

    await run();

    expect(await activeCartIds()).toEqual([]);
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
  });
});
