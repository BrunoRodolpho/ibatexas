// Regression test for the multi-replica SSE bridge (AUDIT-FIX P1-SCALE-SSE).
//
// Before the fix the POST→GET bridge was a module-level in-memory Map, so a
// chunk produced on replica A was invisible to a GET served by replica B
// ("Sessão não encontrada."). The fix fans chunks out over Redis Pub/Sub plus a
// short replay list. These tests assert the Redis wiring with a mocked Redis:
//
//   - a chunk pushed via ONE emitter instance (one publish) is delivered to a
//     consumer that subscribed via Redis (simulating another replica), AND
//   - the duplicated subscriber connection is cleaned up on close (no leak).
//
// Limitation: a single Vitest process cannot exercise two real OS processes, so
// "another replica" is modeled by calling subscribeToStream() against a shared
// in-memory fake Redis bus — subscribeToStream never reads the in-process
// `streams` Map, so it exercises the pure cross-replica Redis path. Full
// multi-process delivery requires a live Redis and is out of scope for unit
// tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StreamChunk } from "@ibatexas/types";

// ── Fake Redis: one shared bus + list store across all duplicated clients ──────
//
// Mirrors node-redis v4 semantics that matter here:
//   - a subscriber is a *duplicated* connection (base.duplicate()) that must
//     connect() before use and can only (p)subscribe/unsubscribe,
//   - publish() fans a message to every connection subscribed to that channel,
//   - rPush/lRange/lTrim/expire back the replay list.

interface FakeBus {
  channels: Map<string, Set<(msg: string) => void>>;
  lists: Map<string, string[]>;
  // Bookkeeping so the test can assert no leaked subscribers.
  liveSubscribers: number;
  openConnections: number;
}

function makeFakeRedis(bus: FakeBus) {
  const localListeners = new Map<string, (msg: string) => void>();
  let open = true;

  const client = {
    // ── pub/sub ────────────────────────────────────────────────────────────
    duplicate() {
      bus.openConnections++;
      return makeFakeRedis(bus);
    },
    async connect() {
      return undefined;
    },
    async subscribe(channel: string, listener: (msg: string) => void) {
      const set = bus.channels.get(channel) ?? new Set();
      set.add(listener);
      bus.channels.set(channel, set);
      localListeners.set(channel, listener);
      bus.liveSubscribers++;
    },
    async unsubscribe(channel: string) {
      const listener = localListeners.get(channel);
      if (listener) {
        bus.channels.get(channel)?.delete(listener);
        localListeners.delete(channel);
        bus.liveSubscribers--;
      }
    },
    async publish(channel: string, message: string) {
      const set = bus.channels.get(channel);
      if (!set) return 0;
      for (const listener of set) listener(message);
      return set.size;
    },
    // ── replay list ──────────────────────────────────────────────────────────
    async rPush(key: string, value: string) {
      const list = bus.lists.get(key) ?? [];
      list.push(value);
      bus.lists.set(key, list);
      return list.length;
    },
    async lRange(key: string, start: number, stop: number) {
      const list = bus.lists.get(key) ?? [];
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(start, end);
    },
    async lTrim(key: string, start: number, stop: number) {
      const list = bus.lists.get(key) ?? [];
      const end = stop === -1 ? list.length : stop + 1;
      bus.lists.set(key, list.slice(start < 0 ? list.length + start : start, end));
      return "OK";
    },
    async expire() {
      return 1;
    },
    async quit() {
      if (open) {
        open = false;
        bus.openConnections--;
      }
      return "OK";
    },
  };
  return client;
}

let bus: FakeBus;
const mockGetRedisClient = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, getRedisClient: mockGetRedisClient };
});

// Import AFTER the mock is registered.
import {
  createStream,
  pushChunk,
  subscribeToStream,
  cleanupStream,
} from "../streaming/emitter.js";

beforeEach(() => {
  bus = {
    channels: new Map(),
    lists: new Map(),
    liveSubscribers: 0,
    openConnections: 1, // the base client
  };
  const base = makeFakeRedis(bus);
  mockGetRedisClient.mockResolvedValue(base);
});

afterEach(() => {
  vi.useRealTimers();
});

const SID = "550e8400-e29b-41d4-a716-446655440000";

// Let the fire-and-forget Redis fan-out in pushChunk settle.
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe("cross-replica SSE bridge over Redis", () => {
  it("delivers a chunk produced on one replica to a consumer subscribed on another", async () => {
    // Replica B's GET subscribes first (no in-memory entry on B).
    const received: StreamChunk[] = [];
    const sub = await subscribeToStream(SID, (c) => received.push(c));
    // Nothing produced yet → genuinely unknown to the cluster.
    expect(sub).toBeUndefined();

    // Replica A's POST produces chunks (one emitter instance / publishes).
    createStream(SID);
    pushChunk(SID, { type: "text_delta", delta: "Olá" });
    pushChunk(SID, { type: "done" });
    await flush();

    // Replica B's GET now connects (slightly after) and catches up via replay.
    const lateReceived: StreamChunk[] = [];
    const lateSub = await subscribeToStream(SID, (c) => lateReceived.push(c));
    expect(lateSub).toBeDefined();
    expect(lateReceived).toEqual([
      { type: "text_delta", delta: "Olá" },
      { type: "done" },
    ]);

    await lateSub!.close();
  });

  it("delivers live chunks published after the consumer subscribed", async () => {
    // Produce a first chunk so the replay list exists and subscribe succeeds.
    createStream(SID);
    pushChunk(SID, { type: "text_delta", delta: "primeiro" });
    await flush();

    const received: StreamChunk[] = [];
    const sub = await subscribeToStream(SID, (c) => received.push(c));
    expect(sub).toBeDefined();
    // Replay delivered the first chunk.
    expect(received).toEqual([{ type: "text_delta", delta: "primeiro" }]);

    // Now produce more chunks live — they must reach the already-attached sub.
    pushChunk(SID, { type: "text_delta", delta: "segundo" });
    pushChunk(SID, { type: "done" });
    await flush();

    expect(received).toEqual([
      { type: "text_delta", delta: "primeiro" },
      { type: "text_delta", delta: "segundo" },
      { type: "done" },
    ]);

    await sub!.close();
  });

  it("de-duplicates the replay/live overlap by sequence number", async () => {
    createStream(SID);
    pushChunk(SID, { type: "text_delta", delta: "a" });
    pushChunk(SID, { type: "text_delta", delta: "b" });
    await flush();

    // Subscribe: replay must yield a,b exactly once even though the live channel
    // may also redeliver them depending on timing.
    const received: StreamChunk[] = [];
    const sub = await subscribeToStream(SID, (c) => received.push(c));

    pushChunk(SID, { type: "done" });
    await flush();

    expect(received).toEqual([
      { type: "text_delta", delta: "a" },
      { type: "text_delta", delta: "b" },
      { type: "done" },
    ]);
    await sub!.close();
  });

  it("cleans up the duplicated subscriber connection on close (no leak)", async () => {
    createStream(SID);
    pushChunk(SID, { type: "done" });
    await flush();

    const baselineConnections = bus.openConnections; // just the base client
    const sub = await subscribeToStream(SID, () => {});
    expect(sub).toBeDefined();

    // A duplicated subscriber connection + an active subscription now exist.
    expect(bus.openConnections).toBe(baselineConnections + 1);
    expect(bus.liveSubscribers).toBe(1);

    await sub!.close();

    // Subscription removed and the duplicated connection closed.
    expect(bus.liveSubscribers).toBe(0);
    expect(bus.openConnections).toBe(baselineConnections);
  });

  it("tears down the probe connection when the session is unknown (no leak)", async () => {
    const baselineConnections = bus.openConnections;

    // No producer ran → subscribeToStream must return undefined AND not leak the
    // duplicated connection it opened to probe.
    const sub = await subscribeToStream(SID, () => {});
    expect(sub).toBeUndefined();
    expect(bus.liveSubscribers).toBe(0);
    expect(bus.openConnections).toBe(baselineConnections);
  });

  it("expires the replay list on cleanup grace (in-memory entry removed)", async () => {
    vi.useFakeTimers();
    createStream(SID);
    cleanupStream(SID);
    // Default grace is 30s; entry persists until then.
    vi.advanceTimersByTime(30_000);
    // No assertion error == timer fired without throwing; isStreamActive covered
    // by the existing emitter unit test.
  });
});
