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

import { createInMemoryRedis } from "@ibatexas/tools/testing";
import {
  createEscalationStore,
  isSessionPausedForHuman,
  type EscalationRedis,
} from "../escalation-store.js";

// R5-S7 — the canonical in-memory adapter replaces a hand-rolled EscalationRedis.
// `rk()` was already running real here (the barrel mock spreads `actual`), so the
// keys are unchanged; what changes is that sAdd/sRem/del now report real counts
// instead of `undefined`.
const fakeRedis = () => createInMemoryRedis().client;

/**
 * The adapter deliberately models a WORKING Redis — it has no failure-injection
 * surface, and giving it one would let any test fake an outage. This test's
 * SUBJECT is a failing read, so the failure is wrapped around the real client
 * here, at the one seam that needs it, rather than built into the shared double.
 */
function withFailingGet(client: EscalationRedis): EscalationRedis {
  return new Proxy(client, {
    get: (target, prop) =>
      prop === "get"
        ? async () => {
            throw new Error("GET failed");
          }
        : Reflect.get(target, prop),
  }) as EscalationRedis;
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
    mockGetRedisClient.mockResolvedValue(withFailingGet(fakeRedis()));
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
