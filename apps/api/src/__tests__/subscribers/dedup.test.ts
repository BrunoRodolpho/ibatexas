// Regression tests for the two-phase NATS idempotency guard (P1-CONC-DEDUP).
//
// Verifies:
//   • withDedup claims with a SHORT in-flight TTL, then promotes to the full TTL
//     ONLY after the handler succeeds (no mark-before-run / at-most-once hazard).
//   • A handler throw RELEASES the claim (del) so redelivery reprocesses, and the
//     error is rethrown (routed to the DLQ by the NATS loop).
//   • A Redis error during the claim FAILS CLOSED — the handler does NOT run and a
//     DedupUnavailableError is thrown (event left for redelivery, not processed
//     unguarded).
//   • A duplicate (claim returns null) skips the handler and returns false.
//   • isNewEvent keeps its single-phase SET NX semantics (backward compatible).
//
// Pure unit test — no network.
//
// ── R5 rollout: the double is the shared adapter, SPY-DELEGATED ──────────────
//
// The retired double was two constant `vi.fn()`s (`set → "OK"`, `del → 1`) over
// a faked `rk` that wrote `test:`. Both were fictions: `set` answered "OK" to a
// SECOND NX claim on the same key, so every "a duplicate is suppressed" case was
// satisfied by a constant rather than by a keyspace; and apps/api's vitest
// resolves the real `rk` to `development:`, a prefix this file never wrote.
//
// The client here is `createInMemoryRedis()` with each command wrapped in a
// `vi.fn()` that DELEGATES to the adapter — real NX, real TTLs, real DEL —
// so every `toHaveBeenCalledWith` below still means what it says while the
// keyspace assertions are now possible at all. (A wrap, not a replacement: the
// adapter is a Proxy and has no spyable own properties.)
//
// `getRedisClient` is a rejecting TRIPWIRE: every case threads its client
// explicitly, so a resolution here would be a threading defect, not a fallback.
// The DEFAULT path is covered in `subscribers/__tests__/dedup-family-client-seam.test.ts`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";

const mockGetRedisClient = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("[tripwire] getRedisClient() must not be reached — thread the client");
  }),
);

// `rk` runs REAL — Hard Rule #7 — so the keys asserted are the keys production
// writes.
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return { ...real, getRedisClient: mockGetRedisClient };
});

const { rk } = await import("@ibatexas/tools");
import { withDedup, isNewEvent, markProcessed, DedupUnavailableError } from "../../subscribers/dedup.js";

const FULL_TTL = 604_800;
const INFLIGHT_TTL = 300;

/** A frozen instant, so every TTL assertion is an exact equality. */
const FROZEN = 1_700_000_000_000;

type DedupSpies = {
  readonly redis: InMemoryRedis;
  readonly set: ReturnType<typeof vi.fn>;
  readonly del: ReturnType<typeof vi.fn>;
  readonly client: { set: unknown; del: unknown };
};

/**
 * Spy-DELEGATE over the canonical adapter: each command is a `vi.fn()` that
 * forwards to the real implementation, so call assertions and real semantics
 * coexist. `overrides` replaces a command outright — used only for the
 * Redis-down injections.
 */
function createRedis(
  overrides: Partial<Record<"set" | "del", (...args: never[]) => unknown>> = {},
): DedupSpies {
  const redis = createInMemoryRedis({ now: () => FROZEN });
  const realSet = redis.client.set.bind(redis.client);
  const realDel = redis.client.del.bind(redis.client);
  const set = vi.fn(
    overrides.set ?? ((...args: unknown[]) => (realSet as (...a: unknown[]) => unknown)(...args)),
  );
  const del = vi.fn(
    overrides.del ?? ((...args: unknown[]) => (realDel as (...a: unknown[]) => unknown)(...args)),
  );
  return { redis, set, del, client: { set, del } };
}

/** Narrow the spy bag to the seam's declared client type. */
function asClient(r: DedupSpies): Parameters<typeof withDedup>[2] extends { redis?: infer C }
  ? C
  : never {
  return r.client as never;
}

describe("withDedup — two-phase idempotency guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims with a SHORT in-flight TTL, then promotes to full TTL after success", async () => {
    const r = createRedis();
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await withDedup("evt:1", handler, { redis: asClient(r) });

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledOnce();

    // First set = claim with NX + short in-flight TTL
    expect(r.set).toHaveBeenNthCalledWith(
      1,
      rk("nats:processed:evt:1"),
      "1",
      { EX: INFLIGHT_TTL, NX: true },
    );
    // Second set = confirm/promote to full TTL (no NX)
    expect(r.set).toHaveBeenNthCalledWith(
      2,
      rk("nats:processed:evt:1"),
      "1",
      { EX: FULL_TTL },
    );
    // Claim was NOT released on success
    expect(r.del).not.toHaveBeenCalled();
    // ...and the keyspace agrees, which the constant double could not show.
    expect(r.redis.ttlMs(rk("nats:processed:evt:1"))).toBe(FULL_TTL * 1000);
  });

  it("does NOT promote to full TTL until the handler runs (no mark-before-run)", async () => {
    const r = createRedis();

    let setCallsAtHandlerStart = -1;
    let ttlAtHandlerStart: number | null | undefined;
    const handler = vi.fn().mockImplementation(async () => {
      setCallsAtHandlerStart = r.set.mock.calls.length;
      ttlAtHandlerStart = r.redis.ttlMs(rk("nats:processed:evt:order"));
    });

    await withDedup("evt:order", handler, { redis: asClient(r) });

    // At the moment the handler started, exactly ONE set (the claim) had run —
    // the full-TTL promote happens only AFTER the handler returns.
    expect(setCallsAtHandlerStart).toBe(1);
    // And the marker in the keyspace carried the SHORT lifetime at that moment.
    expect(ttlAtHandlerStart).toBe(INFLIGHT_TTL * 1000);
    expect(r.set).toHaveBeenCalledTimes(2);
  });

  it("RELEASES the claim and rethrows when the handler throws (redelivery reprocesses)", async () => {
    const r = createRedis();
    const boom = new Error("handler blew up");
    const handler = vi.fn().mockRejectedValue(boom);

    await expect(withDedup("evt:fail", handler, { redis: asClient(r) })).rejects.toThrow(
      "handler blew up",
    );

    // Claim was made (short TTL) ...
    expect(r.set).toHaveBeenCalledTimes(1);
    expect(r.set).toHaveBeenCalledWith(
      rk("nats:processed:evt:fail"),
      "1",
      { EX: INFLIGHT_TTL, NX: true },
    );
    // ... and then RELEASED so the event is not left marked-as-done.
    expect(r.del).toHaveBeenCalledWith(rk("nats:processed:evt:fail"));
    // The release is REAL: the key is gone, so a redelivery re-claims.
    expect(r.redis.peek(rk("nats:processed:evt:fail"))).toBeUndefined();
  });

  it("FAILS CLOSED when the claim itself errors (Redis down) — handler not run", async () => {
    const r = createRedis({
      set: (() => Promise.reject(new Error("ECONNREFUSED"))) as never,
    });
    const handler = vi.fn();

    await expect(
      withDedup("evt:redisdown", handler, { redis: asClient(r) }),
    ).rejects.toBeInstanceOf(DedupUnavailableError);

    // Handler must NOT have run — we fail closed rather than proceed unguarded.
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips the handler and returns false on a duplicate (claim already held)", async () => {
    const r = createRedis();
    const handler = vi.fn();

    // A REAL prior claim, written the way phase 1 writes it — not a stub that
    // answers `null` to the first NX it ever sees.
    await r.redis.client.set(rk("nats:processed:evt:dup"), "1", {
      EX: INFLIGHT_TTL,
      NX: true,
    });

    const result = await withDedup("evt:dup", handler, { redis: asClient(r) });

    expect(result).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    // No promote, no release for a duplicate.
    expect(r.del).not.toHaveBeenCalled();
    expect(r.set).toHaveBeenCalledTimes(1);
  });

  it("treats a failed promote as non-fatal (handler already succeeded)", async () => {
    const r = createRedis();
    const realSet = r.redis.client.set.bind(r.redis.client);
    let calls = 0;
    // Spy-delegate with the SECOND call (the promote) turned into a failure —
    // the claim is genuine, so the keyspace really carries the marker.
    r.set.mockImplementation((...args: unknown[]) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("promote failed"));
      return (realSet as (...a: unknown[]) => unknown)(...args);
    });
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await withDedup("evt:promotefail", handler, { redis: asClient(r) });

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    // The in-flight claim survives at its SHORT TTL, which is the documented
    // consequence: a re-process becomes possible after 5 minutes, not 7 days.
    expect(r.redis.ttlMs(rk("nats:processed:evt:promotefail"))).toBe(INFLIGHT_TTL * 1000);
  });
});

describe("isNewEvent — single-phase claim (backward compatible)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true and marks with full TTL when SET NX succeeds", async () => {
    const r = createRedis();

    const result = await isNewEvent("alert:new-order:order_1", { redis: asClient(r) });

    expect(result).toBe(true);
    expect(r.set).toHaveBeenCalledWith(
      rk("nats:processed:alert:new-order:order_1"),
      "1",
      { EX: FULL_TTL, NX: true },
    );
    expect(r.redis.ttlMs(rk("nats:processed:alert:new-order:order_1"))).toBe(FULL_TTL * 1000);
  });

  it("returns false when the key is already claimed (already processed)", async () => {
    const r = createRedis();

    expect(await isNewEvent("alert:dup", { redis: asClient(r) })).toBe(true);
    // The SECOND call is what the retired constant `"OK"` could never answer.
    expect(await isNewEvent("alert:dup", { redis: asClient(r) })).toBe(false);
  });

  it("propagates a Redis error so the caller decides fail-open vs fail-closed", async () => {
    const r = createRedis({ set: (() => Promise.reject(new Error("down"))) as never });

    await expect(isNewEvent("alert:err", { redis: asClient(r) })).rejects.toThrow("down");
  });
});

describe("markProcessed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets the processed key with the full TTL (no NX, so it overwrites a claim)", async () => {
    const r = createRedis();

    // Seed the short claim so "overwrites" is observable rather than asserted.
    await r.redis.client.set(rk("nats:processed:evt:confirm"), "1", {
      EX: INFLIGHT_TTL,
      NX: true,
    });

    await markProcessed("evt:confirm", { redis: asClient(r) });

    expect(r.set).toHaveBeenCalledWith(
      rk("nats:processed:evt:confirm"),
      "1",
      { EX: FULL_TTL },
    );
    expect(r.redis.ttlMs(rk("nats:processed:evt:confirm"))).toBe(FULL_TTL * 1000);
  });
});
