// Fail-CLOSED tests for the exported hot-path bot-pause gate (D2).
//
// SDD Invariant 7: "Safety-gate reads fail CLOSED — read-error ≠ read-absence."
// SDD §E HUMAN_HANDOFF_ACTIVE: "read-error → safe posture, never concrete `false`."
//
// `isSessionPausedForHuman()` reads the pause flag through getEscalationStore()
// → getRedisClient(). We mock @ibatexas/tools at the module boundary so we can
// drive that seam (throw vs. reachable) while keeping the real `rk()` key shape,
// so the keys the gate reads match the keys we seed.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRedisClient = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", async () => {
  const actual = await vi.importActual<typeof import("@ibatexas/tools")>(
    "@ibatexas/tools",
  );
  return { ...actual, getRedisClient: mockGetRedisClient };
});

import {
  createEscalationStore,
  isSessionPausedForHuman,
  type EscalationRedis,
} from "../escalation-store.js";

function fakeRedis(): EscalationRedis & {
  _kv: Map<string, string>;
  _sets: Map<string, Set<string>>;
} {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    _kv: kv,
    _sets: sets,
    async get(k) {
      return kv.get(k) ?? null;
    },
    async set(k, v) {
      kv.set(k, v);
    },
    async del(k) {
      kv.delete(k);
    },
    async sAdd(k, m) {
      const s = sets.get(k) ?? new Set<string>();
      s.add(m);
      sets.set(k, s);
    },
    async sRem(k, m) {
      sets.get(k)?.delete(m);
    },
    async sMembers(k) {
      return [...(sets.get(k) ?? [])];
    },
  };
}

describe("isSessionPausedForHuman — fail-CLOSED safety gate (D2, SDD Inv 7 / §E)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) getEscalationStore/Redis error → returns true (PAUSED, fail-CLOSED)", async () => {
    // The client itself is unreachable — getEscalationStore() throws.
    mockGetRedisClient.mockRejectedValue(new Error("redis unreachable"));
    expect(await isSessionPausedForHuman("sess-any")).toBe(true);
  });

  it("(a) a store read-error inside isPaused → returns true (PAUSED, fail-CLOSED)", async () => {
    // Client is reachable, but the GET throws (transient store error).
    const redis = fakeRedis();
    redis.get = vi.fn(async () => {
      throw new Error("GET failed");
    });
    mockGetRedisClient.mockResolvedValue(redis);
    expect(await isSessionPausedForHuman("sess-any")).toBe(true);
  });

  it("(b) store reachable + session genuinely PAUSED → true (normal path preserved)", async () => {
    const redis = fakeRedis();
    // Seed an OPEN escalation through the real store (real rk() keys).
    await createEscalationStore(redis).recordHandoff({
      sessionId: "sess-paused",
      at: "2026-06-26T00:00:00.000Z",
    });
    mockGetRedisClient.mockResolvedValue(redis);
    expect(await isSessionPausedForHuman("sess-paused")).toBe(true);
  });

  it("(b) store reachable + session genuinely NOT paused → false (read-absence is a real false)", async () => {
    const redis = fakeRedis();
    mockGetRedisClient.mockResolvedValue(redis);
    // No record for this session: read-ABSENCE, not read-ERROR ⇒ concrete false.
    expect(await isSessionPausedForHuman("sess-unknown")).toBe(false);
  });

  it("(b) store reachable + escalation RESOLVED → false (un-paused, normal path)", async () => {
    const redis = fakeRedis();
    const store = createEscalationStore(redis);
    await store.recordHandoff({ sessionId: "sess-r", at: "2026-06-26T00:00:00.000Z" });
    await store.resolve("sess-r", "staff:alice", "2026-06-26T00:05:00.000Z");
    mockGetRedisClient.mockResolvedValue(redis);
    expect(await isSessionPausedForHuman("sess-r")).toBe(false);
  });
});
