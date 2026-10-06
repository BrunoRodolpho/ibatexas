// Regression tests for the DLQ cap (P2-SCALE-DLQCAP).
//
// Verifies:
//   • pushToDlq lPushes the entry and sets the 7-day TTL.
//   • When the list grows past MAX_DLQ, it lTrims to (0, MAX_DLQ-1) keeping the
//     newest entries, and logs the number of dropped (oldest) entries.
//   • When the list is at/under the cap, it does NOT lTrim.
//   • Redis keys are built via rk() (Hard Rule).
//
// Pure unit test — Sentry is mocked, no network.
//
// ── R5 rollout: the double is the shared adapter, SPY-DELEGATED ──────────────
//
// The retired double PLANTED the answer the cap branches on: `lPush` returned a
// per-case constant (1003), so the list never actually grew, `lTrim` recorded a
// call against nothing, and no assertion in this file could tell a cap that
// keeps the NEWEST entries from one that keeps the OLDEST — the exact inversion
// that would leave ops paging on week-old failures. Its `rk` was faked as
// `test:`; apps/api's vitest resolves the real one to `development:`.
//
// The client is now `createInMemoryRedis()` with each command wrapped in a
// `vi.fn()` DELEGATING to the adapter, so the existing call assertions survive
// unedited while the list is real: the over-cap case seeds 1002 entries the way
// the producer writes them (LPUSH) and lets the 1003rd push trip the cap for
// real.
//
// `getRedisClient` is a rejecting TRIPWIRE — every case threads its client. The
// DEFAULT path is covered in
// `subscribers/__tests__/dedup-family-client-seam.test.ts`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";

const mockGetRedisClient = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("[tripwire] getRedisClient() must not be reached — thread the client");
  }),
);

vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return { ...real, getRedisClient: mockGetRedisClient };
});

vi.mock("@sentry/node", () => ({
  withScope: vi.fn((cb: (scope: unknown) => void) =>
    cb({ setTag: vi.fn(), setLevel: vi.fn() }),
  ),
  captureMessage: vi.fn(),
}));

const { rk } = await import("@ibatexas/tools");
import { pushToDlq } from "../../subscribers/dlq.js";

/** A frozen instant, so the TTL assertion is an exact equality. */
const FROZEN = 1_700_000_000_000;

type DlqSpies = {
  readonly redis: InMemoryRedis;
  readonly lPush: ReturnType<typeof vi.fn>;
  readonly lTrim: ReturnType<typeof vi.fn>;
  readonly expire: ReturnType<typeof vi.fn>;
  readonly client: Record<string, unknown>;
};

/** Spy-DELEGATE over the canonical adapter — a wrap, never a replacement. */
function createRedis(
  overrides: Partial<Record<"lPush" | "lTrim" | "expire", (...args: never[]) => unknown>> = {},
): DlqSpies {
  const redis = createInMemoryRedis({ now: () => FROZEN });
  const bind = (name: "lPush" | "lTrim" | "expire") => {
    const real = (redis.client as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
    return vi.fn(overrides[name] ?? ((...args: unknown[]) => real.call(redis.client, ...args)));
  };
  const lPush = bind("lPush");
  const lTrim = bind("lTrim");
  const expire = bind("expire");
  return { redis, lPush, lTrim, expire, client: { lPush, lTrim, expire } };
}

const asClient = (r: DlqSpies) => r.client as never;

/** Every surviving entry's `id`, newest first (LPUSH order). */
async function idsIn(r: DlqSpies, key: string): Promise<unknown[]> {
  const raw = await r.redis.client.lRange(key, 0, -1);
  return raw.map((x) => (JSON.parse(x) as { id?: unknown }).id);
}

describe("pushToDlq — DLQ cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MAX_DLQ;
  });

  it("pushes the entry under the namespaced key and sets the 7-day TTL", async () => {
    const r = createRedis();
    const key = rk("dlq:order.placed");

    await pushToDlq("order.placed", { id: "ord_1" }, new Error("boom"), undefined, {
      redis: asClient(r),
    });

    expect(r.lPush).toHaveBeenCalledOnce();
    expect(r.lPush.mock.calls[0]![0]).toBe(key);
    expect(r.expire).toHaveBeenCalledWith(key, 604_800);
    // The entry is a real LIST element, and the TTL is the exact 7 days — a
    // constant-`1` expire could not distinguish 7 days from 7 seconds.
    expect(await idsIn(r, key)).toEqual(["ord_1"]);
    expect(r.redis.ttlMs(key)).toBe(604_800_000);
  });

  it("does NOT lTrim when the list is at/under the default cap (1000)", async () => {
    const r = createRedis();
    const key = rk("dlq:order.placed");
    // 999 seeded + this push = exactly 1000, the cap.
    await r.redis.client.lPush(
      key,
      Array.from({ length: 999 }, (_, i) => JSON.stringify({ id: `seed_${i}` })),
    );

    await pushToDlq("order.placed", { id: "at_cap" }, "err", undefined, { redis: asClient(r) });

    expect(r.lTrim).not.toHaveBeenCalled();
    expect(await r.redis.client.lLen(key)).toBe(1000);
  });

  it("lTrims to (0, defaultCap-1) and logs dropped count when over the default cap", async () => {
    const r = createRedis();
    const key = rk("dlq:order.placed");
    // 1002 seeded + this push = 1003, three over the default cap.
    await r.redis.client.lPush(
      key,
      Array.from({ length: 1002 }, (_, i) => JSON.stringify({ id: `seed_${i}` })),
    );
    const log = { error: vi.fn() };

    await pushToDlq("order.placed", { id: "newest" }, "err", log, { redis: asClient(r) });

    expect(r.lTrim).toHaveBeenCalledWith(key, 0, 999);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ dropped: 3, cap: 1000 }),
      expect.stringContaining("dropped oldest"),
    );
    // THE PROPERTY, not the call: the list is really 1000 long, and the entry
    // that survives at the head is the one just pushed. An implementation that
    // trimmed the other end satisfies `toHaveBeenCalledWith` and fails here.
    expect(await r.redis.client.lLen(key)).toBe(1000);
    expect((await idsIn(r, key))[0]).toBe("newest");
  });

  it("honors the MAX_DLQ env override (read at module load)", async () => {
    // MAX_DLQ is captured at import time, so reset modules and re-import with the
    // env set to prove the override is actually wired (not just the default).
    vi.resetModules();
    process.env.MAX_DLQ = "5";
    const fresh = await import("../../subscribers/dlq.js");

    const r = createRedis();
    const key = rk("dlq:order.placed");
    await r.redis.client.lPush(
      key,
      Array.from({ length: 5 }, (_, i) => JSON.stringify({ id: `seed_${i}` })),
    );

    await fresh.pushToDlq("order.placed", { id: "newest" }, "err", undefined, {
      redis: asClient(r),
    });

    expect(r.lTrim).toHaveBeenCalledWith(key, 0, 4);
    expect(await r.redis.client.lLen(key)).toBe(5);
    expect((await idsIn(r, key))[0]).toBe("newest");
  });

  it("swallows Redis errors so the producer is not broken", async () => {
    const r = createRedis({
      lPush: (() => Promise.reject(new Error("redis down"))) as never,
    });
    const log = { error: vi.fn() };

    await expect(
      pushToDlq("order.placed", {}, "err", log, { redis: asClient(r) }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "order.placed" }),
      expect.stringContaining("Failed to push to DLQ"),
    );
  });
});
