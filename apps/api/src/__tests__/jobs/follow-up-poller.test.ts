// Tests for follow-up poller job
// No Redis or NATS required.
//
// Scenarios:
// - Due entries (score <= now) are published and removed
// - Future entries (score > now) are NOT published
// - Multiple due entries processed in one run
// - Sentry called on publish error
//
// ── R5 rollout: the double is the shared adapter, SPY-DELEGATED ──────────────
//
// The retired double answered `zRangeByScore` from a per-case
// `mockResolvedValue`, so the sorted set never existed: the "not due" case
// handed back `[]` and proved nothing about SCORES, and `zRem` reported a
// constant `1` whether or not the member was there. Its `rk` was faked (it
// happened to agree with the real one, which made the coincidence look like a
// fact).
//
// The client is now `createInMemoryRedis()` with each command wrapped in a
// `vi.fn()` DELEGATING to the adapter, so the call assertions below survive
// unedited while the due window becomes a real score comparison against a
// frozen system clock. Entries are SEEDED with `zAdd` — the command
// `packages/tools/src/intelligence/schedule-follow-up.ts` uses to schedule
// them.
//
// `getRedisClient` is a rejecting TRIPWIRE — every case threads its client. The
// DEFAULT path and the F-32 BullMQ registration pair live in
// `subscribers/__tests__/dedup-family-client-seam.test.ts`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("[tripwire] getRedisClient() must not be reached — thread the client");
  }),
);
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockSentryCaptureException = vi.hoisted(() => vi.fn());
const mockSentryWithScope = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return { ...real, getRedisClient: mockGetRedisClient };
});

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@sentry/node", () => ({
  withScope: mockSentryWithScope.mockImplementation((cb: (scope: unknown) => void) => {
    cb({ setTag: vi.fn(), setContext: vi.fn() });
  }),
  captureException: mockSentryCaptureException,
}));

// Only the BullMQ FACTORIES are replaced — `assertDepsBag` is spread through
// REAL, because `processFollowUps` calls it on every invocation (F-32).
vi.mock("../../jobs/queue.js", async (orig) => {
  const real = await orig<typeof import("../../jobs/queue.js")>();
  return {
    ...real,
    createQueue: vi.fn(() => ({ upsertJobScheduler: vi.fn(), close: vi.fn() })),
    createWorker: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
  };
});

const { rk } = await import("@ibatexas/tools");
import { processFollowUps } from "../../jobs/follow-up-poller.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A frozen instant the system clock is pinned to. */
const NOW = 1_700_000_000_000;

const SCHEDULED_KEY = rk("follow-up:scheduled");

function makeEntry(customerId: string, reason: string): string {
  return JSON.stringify({ customerId, reason, scheduledAt: new Date(NOW).toISOString() });
}

type PollerSpies = {
  readonly redis: InMemoryRedis;
  readonly zRangeByScore: ReturnType<typeof vi.fn>;
  readonly zRem: ReturnType<typeof vi.fn>;
  readonly client: Record<string, unknown>;
};

/** Spy-DELEGATE over the canonical adapter — a wrap, never a replacement. */
function createRedis(): PollerSpies {
  const redis = createInMemoryRedis({ now: () => NOW });
  const bind = (name: "zRangeByScore" | "zRem") => {
    const real = (redis.client as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
    return vi.fn((...args: unknown[]) => real.call(redis.client, ...args));
  };
  const zRangeByScore = bind("zRangeByScore");
  const zRem = bind("zRem");
  return { redis, zRangeByScore, zRem, client: { zRangeByScore, zRem } };
}

const asClient = (r: PollerSpies) => r.client as never;

/** Schedule a member at an offset from `NOW` (negative = already due). */
async function seed(r: PollerSpies, member: string, offsetMs: number): Promise<string> {
  await r.redis.client.zAdd(SCHEDULED_KEY, { score: NOW + offsetMs, value: member });
  return member;
}

/** What is still scheduled, over a window wide enough to include the future. */
function remaining(r: PollerSpies): Promise<string[]> {
  return r.redis.client.zRangeByScore(SCHEDULED_KEY, 0, NOW + 86_400_000);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("processFollowUps", () => {
  let mockRedis: PollerSpies;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    mockRedis = createRedis();
    mockPublishNatsEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes follow-up.due and removes due entries", async () => {
    const entry = await seed(mockRedis, makeEntry("cust_01", "thinking"), -1000);

    await processFollowUps(null, { redis: asClient(mockRedis) });

    expect(mockPublishNatsEvent).toHaveBeenCalledOnce();
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("follow-up.due", {
      customerId: "cust_01",
      reason: "thinking",
    });
    expect(mockRedis.zRem).toHaveBeenCalledWith(SCHEDULED_KEY, entry);
    // The removal is REAL — a constant-`1` zRem could not show this.
    expect(await remaining(mockRedis)).toEqual([]);
  });

  it("does not publish entries that are not due (score > now)", async () => {
    // A genuinely FUTURE entry, in the same sorted set. The retired double
    // expressed this case as `zRangeByScore → []`, which is indistinguishable
    // from a poller that reads nothing at all.
    const future = await seed(mockRedis, makeEntry("cust_later", "thinking"), 3_600_000);

    await processFollowUps(null, { redis: asClient(mockRedis) });

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    expect(mockRedis.zRem).not.toHaveBeenCalled();
    // ...and it is still scheduled.
    expect(await remaining(mockRedis)).toEqual([future]);
  });

  it("processes multiple due entries in one run", async () => {
    await seed(mockRedis, makeEntry("cust_01", "thinking"), -3000);
    await seed(mockRedis, makeEntry("cust_02", "cart_save"), -2000);
    await seed(mockRedis, makeEntry("cust_03", "price_concern"), -1000);

    await processFollowUps(null, { redis: asClient(mockRedis) });

    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(3);
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("follow-up.due", { customerId: "cust_01", reason: "thinking" });
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("follow-up.due", { customerId: "cust_02", reason: "cart_save" });
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("follow-up.due", { customerId: "cust_03", reason: "price_concern" });
    expect(mockRedis.zRem).toHaveBeenCalledTimes(3);
    expect(await remaining(mockRedis)).toEqual([]);
  });

  it("calls Sentry on publish error and leaves entry in sorted set", async () => {
    const entry = await seed(mockRedis, makeEntry("cust_01", "thinking"), -1000);
    mockPublishNatsEvent.mockRejectedValue(new Error("NATS unavailable"));

    await processFollowUps(null, { redis: asClient(mockRedis) });

    expect(mockSentryWithScope).toHaveBeenCalled();
    // Entry should NOT be removed when publish fails — read off the keyspace,
    // not off a call count.
    expect(mockRedis.zRem).not.toHaveBeenCalled();
    expect(await remaining(mockRedis)).toEqual([entry]);
  });

  it("removes malformed entries silently without publishing", async () => {
    await seed(mockRedis, "not-valid-json", -1000);

    await processFollowUps(null, { redis: asClient(mockRedis) });

    expect(mockPublishNatsEvent).not.toHaveBeenCalled();
    expect(mockRedis.zRem).toHaveBeenCalledWith(SCHEDULED_KEY, "not-valid-json");
    expect(await remaining(mockRedis)).toEqual([]);
  });
});
