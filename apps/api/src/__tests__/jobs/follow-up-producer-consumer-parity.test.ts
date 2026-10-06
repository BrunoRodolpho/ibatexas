// Driven producer→consumer parity for the follow-up queue (F-35)
//
// ── What this file exists to prove ───────────────────────────────────────────
//
// The `follow-up:scheduled` sorted set has exactly two ends, in two workspaces:
//
//   PRODUCER  packages/tools/src/intelligence/schedule-follow-up.ts
//             `zAdd(rk("follow-up:scheduled"), { score: fireAtMs, value: JSON })`
//   CONSUMER  apps/api/src/jobs/follow-up-poller.ts  (`processFollowUps`)
//             `zRangeByScore(rk("follow-up:scheduled"), 0, Date.now())` → publish → `zRem`
//
// Until F-35 was closed, NO test drove both. The producer resolved its client
// through a RELATIVE import inside the built package (`../redis/client.js`),
// which an apps/api `vi.mock("@ibatexas/tools")` — a mock of the package
// SPECIFIER — cannot reach. So the poller suites SEEDED the zset by hand, and
// producer/consumer agreement rode on two independent assertions of the same key
// literal (the producer's own suite pins `development:follow-up:scheduled`; the
// poller suites read the real `rk`). Two assertions of one literal is not a
// contract: rename the key on ONE side and both suites stay green while the
// queue silently splits in production. `dedup-family-client-seam.test.ts`
// recorded that as an open bound rather than dressing it up as a pin.
//
// The producer now takes an injectable client (`ScheduleFollowUpOptions`), so
// both ends run against ONE keyspace here.
//
// ── The discipline that makes it a real proof ────────────────────────────────
//
// This file NEVER writes the key literal, and never calls `rk`. It cannot: the
// only way an assertion below can pass is if the string the producer wrote to is
// the string the consumer read from. Agreement is the mechanism under test, so
// naming the key here would re-introduce exactly the third independent
// assertion this file was written to replace. Keyspace observations go through
// `redis.keys()` — a listing, not a lookup.
//
// Likewise the SCORE: no test asserts a number the producer computed. Each case
// moves the frozen clock across the fire time the producer chose and reads what
// the consumer does about it, so the producer's `Date.now() + hours*3_600_000`
// and the consumer's `zRangeByScore(…, 0, Date.now())` are checked against each
// other rather than against a literal.
//
// ── Non-vacuity ──────────────────────────────────────────────────────────────
//
// Every "does not fire" arm carries its control IN THE SAME TEST — a follow-up
// that DOES fire on the same poll, through the same client. An absence proved
// against a pipeline that was never live is satisfied by never-present, which is
// the failure mode this program keeps re-finding in close/release tests.
//
// `getRedisClient` is a rejecting TRIPWIRE for the CONSUMER's default arm (a
// package-specifier mock reaches the poller's `import { getRedisClient } from
// "@ibatexas/tools"`). It cannot cover the producer — that is the finding — so
// the producer's fallback is caught differently: `REDIS_URL` is unset under
// vitest, so a producer that ignored its injected client throws
// `REDIS_URL env var required` out of the real singleton. Both fallbacks are
// loud. The DEFAULT arms themselves are covered elsewhere (consumer:
// `subscribers/__tests__/dedup-family-client-seam.test.ts`; producer:
// `packages/tools/src/__tests__/intelligence/schedule-follow-up.test.ts`) and
// are not this file's subject.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";
import { Channel, type AgentContext } from "@ibatexas/types";
import { processFollowUps } from "../../jobs/follow-up-poller.js";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("[tripwire] getRedisClient() must not be reached — thread the client");
  }),
);

// Spread the REAL module and replace ONLY the client resolver. `rk` stays REAL
// (Hard Rule #7) and so does `scheduleFollowUp` — the function under test on the
// producer side is the shipped one, not a stand-in.
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return { ...real, getRedisClient: mockGetRedisClient };
});

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
  subscribeNatsEvent: vi.fn(async () => {}),
}));

// Resolved AFTER the mock factories above have been registered (vitest hoists
// `vi.mock` over the static imports, so `processFollowUps` up top is mocked-safe
// too). `scheduleFollowUp` comes off the spread-real module — the shipped
// producer, reached through the same specifier production uses.
const { scheduleFollowUp } = await import("@ibatexas/tools");

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A frozen instant the system clock starts pinned to. */
const NOW = 1_700_000_000_000;
const HOUR_MS = 3_600_000;

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    channel: Channel.WhatsApp,
    sessionId: "sess_parity",
    customerId: "cust_parity",
    userType: "customer",
    ...overrides,
  };
}

let redis: InMemoryRedis;

/** Schedule through the REAL producer, on the shared keyspace. */
async function produce(
  delayHours: number,
  reason: string,
  ctx: AgentContext = makeCtx(),
): Promise<{ success: boolean; message: string }> {
  return scheduleFollowUp({ delayHours, reason }, ctx, { client: redis.client });
}

/** Drain through the REAL consumer, on the shared keyspace. */
async function consume(): Promise<void> {
  await processFollowUps(null, { redis: redis.client });
}

/** Customer ids the consumer published, in order. */
function published(): string[] {
  return mockPublishNatsEvent.mock.calls.map(
    (c) => (c[1] as { customerId: string }).customerId,
  );
}

describe("follow-up queue — the producer's entry is the entry the consumer drains", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    // `now: () => Date.now()` rather than the captured default, so the adapter's
    // TTL clock follows `setSystemTime` no matter when it was constructed.
    redis = createInMemoryRedis({ now: () => Date.now() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a scheduled follow-up is INVISIBLE before its fire time and is drained after it — key and score agreement, driven end to end", async () => {
    const result = await produce(4, "thinking");
    expect(result.success).toBe(true);

    // The producer wrote SOMETHING — one key appeared in the shared keyspace.
    // Read as a listing: naming the key here would be the literal assertion this
    // file replaces. If the producer's key and the consumer's key ever diverge,
    // this line still passes and the two below are what red.
    expect(redis.keys()).toHaveLength(1);

    // ── Not yet due: the consumer finds the producer's entry and leaves it ────
    await consume();
    expect(published()).toEqual([]);
    expect(redis.keys()).toHaveLength(1);

    // ── Past the fire time the producer chose ────────────────────────────────
    vi.setSystemTime(new Date(NOW + 4 * HOUR_MS + 1000));
    await consume();

    // Fired. This is the whole contract: the consumer's `zRangeByScore` window
    // located a member only the producer ever wrote, at a key only the producer
    // ever named, with a score only the producer ever computed.
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishNatsEvent).toHaveBeenCalledWith("follow-up.due", {
      customerId: "cust_parity",
      reason: "thinking",
    });
    // ...and drained: the zset emptied, so its key is gone from the keyspace. A
    // key still standing here means the consumer published from one place and
    // removed from another.
    expect(redis.keys()).toEqual([]);
  });

  it("a follow-up beyond the due horizon does NOT fire while a due sibling on the same poll does", async () => {
    // Both go through the real producer, onto the same key, on the same clock.
    await produce(1, "thinking", makeCtx({ customerId: "cust_near" }));
    await produce(48, "cart_save", makeCtx({ customerId: "cust_far" }));

    vi.setSystemTime(new Date(NOW + 1 * HOUR_MS + 1000));
    await consume();

    // The CONTROL fired on this very poll, so "cust_far did not fire" is a score
    // comparison and not an inert pipeline. A stubbed `zRangeByScore` answering
    // `[]` — the retired double's "not due" case — cannot tell those apart.
    expect(published()).toEqual(["cust_near"]);
    // The far entry is STILL SCHEDULED: not published, not removed.
    expect(redis.keys()).toHaveLength(1);

    // ...and it is not stranded — cross the horizon it was actually given and it
    // drains. Without this the test could not distinguish "correctly deferred"
    // from "written with a score no window will ever reach".
    vi.setSystemTime(new Date(NOW + 48 * HOUR_MS + 1000));
    await consume();
    expect(published()).toEqual(["cust_near", "cust_far"]);
    expect(redis.keys()).toEqual([]);
  });

  it("the producer's 72h clamp is a real score the consumer honours, not a message string", async () => {
    // The producer clamps `delayHours` to [1, 72]. Its own suite reads the clamp
    // off a recorded `zAdd` argument and off the pt-BR message; neither shows
    // that the clamped value is what a poller will actually act on.
    const result = await produce(100, "price_concern");
    expect(result.success).toBe(true);
    expect(result.message).toContain("72h");

    // Unclamped, 100h would still be ~28h short of due here.
    vi.setSystemTime(new Date(NOW + 72 * HOUR_MS + 1000));
    await consume();

    expect(published()).toEqual(["cust_parity"]);
    expect(redis.keys()).toEqual([]);
  });

  it("an unauthenticated schedule writes NOTHING to the queue while an authenticated one on the same client fires", async () => {
    const guest = await produce(1, "thinking", makeCtx({ customerId: undefined }));
    expect(guest.success).toBe(false);
    expect(guest.message).toMatch(/autenticaç/i);

    // Nothing reached the shared keyspace — the guard returns BEFORE any client
    // is resolved, injected or not.
    expect(redis.keys()).toEqual([]);

    // CONTROL, same client, same poll: the pipeline is live in this test, so the
    // absence above is a refusal rather than a never-present.
    await produce(1, "cart_save", makeCtx({ customerId: "cust_authed" }));
    expect(redis.keys()).toHaveLength(1);

    vi.setSystemTime(new Date(NOW + 1 * HOUR_MS + 1000));
    await consume();

    expect(published()).toEqual(["cust_authed"]);
    expect(redis.keys()).toEqual([]);
  });
});
