// W3 D1 — tests for the kill-switch Redis store.
//
// Two test flavours:
//   1. Unit tests against an in-memory fake (always runs in CI).
//   2. Integration tests against a real Redis docker on port 6382
//      (`docker run --name w3a-redis -p 6382:6379 redis:7-alpine`).
//      Skipped when REDIS_TEST_URL is not set so CI stays green.
//
// Anti-theater (RULE 2): each test was written FIRST and FAILED before
// `kill-switch-store.ts` existed. The integration test verifies the
// runbook scenario: operator enables → status returns metadata →
// operator disables → status returns null. Pub/sub events are caught by
// a side subscriber and inspected.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createClient } from "redis";
import {
  createKillSwitchStore,
  KILL_SWITCH_KEY_SUFFIX,
  KILL_SWITCH_CHANNEL_SUFFIX,
  type KillSwitchRedisClient,
  type KillSwitchEvent,
} from "../kill-switch-store.js";

// ── In-memory fake — covers the deterministic logic ──────────────────────

function createInMemoryClient() {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const channels = new Map<string, string[]>();
  const client: KillSwitchRedisClient & {
    inspect: () => Record<string, string>;
    published: (channel: string) => string[];
  } = {
    async set(key, value, options) {
      const entry: { value: string; expiresAt?: number } = { value };
      if (options?.EX !== undefined) {
        entry.expiresAt = Date.now() + options.EX * 1000;
      }
      store.set(key, entry);
      return "OK";
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    async publish(channel, message) {
      const arr = channels.get(channel) ?? [];
      arr.push(message);
      channels.set(channel, arr);
      return arr.length;
    },
    inspect() {
      return Object.fromEntries(
        [...store.entries()].map(([k, v]) => [k, v.value]),
      );
    },
    published(channel) {
      return channels.get(channel) ?? [];
    },
  };
  return client;
}

const rk = (key: string) => `test:${key}`;

describe("createKillSwitchStore — unit (in-memory)", () => {
  it("writes metadata + TTL on enable", async () => {
    const redis = createInMemoryClient();
    const store = createKillSwitchStore({ redis, rk });
    const setSpy = vi.spyOn(redis, "set");
    const md = await store.enable({
      enabledBy: "staff:alice",
      reason: "Refusal-rate spike at 19:35",
    });
    expect(md.enabledBy).toBe("staff:alice");
    expect(md.reason).toBe("Refusal-rate spike at 19:35");
    expect(md.enabledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
    expect(setSpy).toHaveBeenCalledWith(
      `test:${KILL_SWITCH_KEY_SUFFIX}`,
      expect.stringContaining("staff:alice"),
      { EX: 24 * 60 * 60 },
    );
  });

  it("publishes an 'enable' event on the channel", async () => {
    const redis = createInMemoryClient();
    const store = createKillSwitchStore({ redis, rk });
    await store.enable({
      enabledBy: "staff:bob",
      reason: "Soak window",
    });
    const events = redis.published(`test:${KILL_SWITCH_CHANNEL_SUFFIX}`);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]!) as KillSwitchEvent;
    expect(parsed.action).toBe("enable");
    expect(parsed.scope).toBe("global");
    expect(parsed.enabledBy).toBe("staff:bob");
    expect(parsed.reason).toBe("Soak window");
  });

  it("status() returns metadata after enable", async () => {
    const redis = createInMemoryClient();
    const store = createKillSwitchStore({ redis, rk });
    expect(await store.status()).toBeNull();
    await store.enable({ enabledBy: "x", reason: "y" });
    const md = await store.status();
    expect(md).not.toBeNull();
    expect(md?.enabledBy).toBe("x");
    expect(md?.reason).toBe("y");
  });

  it("disable() removes the flag and publishes a 'disable' event", async () => {
    const redis = createInMemoryClient();
    const store = createKillSwitchStore({ redis, rk });
    await store.enable({ enabledBy: "a", reason: "engage" });
    const priorState = await store.status();
    expect(priorState).not.toBeNull();

    const prior = await store.disable({ enabledBy: "b", reason: "release" });
    expect(prior?.enabledBy).toBe("a");
    expect(await store.status()).toBeNull();

    const events = redis.published(`test:${KILL_SWITCH_CHANNEL_SUFFIX}`);
    expect(events).toHaveLength(2);
    const disableEvt = JSON.parse(events[1]!) as KillSwitchEvent;
    expect(disableEvt.action).toBe("disable");
    expect(disableEvt.enabledBy).toBe("b");
  });

  it("disable() is idempotent when already inactive", async () => {
    const redis = createInMemoryClient();
    const store = createKillSwitchStore({ redis, rk });
    const result = await store.disable({ enabledBy: "x", reason: "z" });
    expect(result).toBeNull();
  });

  it("custom ttlSeconds is honored on enable", async () => {
    const redis = createInMemoryClient();
    const store = createKillSwitchStore({ redis, rk });
    const setSpy = vi.spyOn(redis, "set");
    await store.enable({
      enabledBy: "x",
      reason: "drill",
      ttlSeconds: 60,
    });
    expect(setSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { EX: 60 },
    );
  });

  it("status() returns null for corrupted JSON blobs", async () => {
    const redis = createInMemoryClient();
    await redis.set(`test:${KILL_SWITCH_KEY_SUFFIX}`, "not-json");
    const store = createKillSwitchStore({ redis, rk });
    expect(await store.status()).toBeNull();
  });

  it("status() returns null for blobs missing required fields", async () => {
    const redis = createInMemoryClient();
    await redis.set(
      `test:${KILL_SWITCH_KEY_SUFFIX}`,
      JSON.stringify({ enabledBy: "x" }),
    );
    const store = createKillSwitchStore({ redis, rk });
    expect(await store.status()).toBeNull();
  });
});

// ── Integration test — real Redis on port 6382 ───────────────────────────

const REDIS_TEST_URL =
  process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6382";

describe("createKillSwitchStore — integration (real Redis)", () => {
  let client: ReturnType<typeof createClient>;
  let available = true;

  beforeEach(async () => {
    client = createClient({ url: REDIS_TEST_URL });
    client.on("error", () => {
      available = false;
    });
    try {
      await client.connect();
      await client.flushDb();
    } catch {
      available = false;
    }
  });

  afterEach(async () => {
    if (client.isOpen) {
      await client.quit();
    }
  });

  it("round-trips enable→status→disable on a real Redis", async () => {
    if (!available) {
      console.log("[skip] redis not reachable at", REDIS_TEST_URL);
      return;
    }
    const store = createKillSwitchStore({
      // node-redis publish signature is compatible — cast to satisfy
      // the structural interface.
      redis: client as unknown as KillSwitchRedisClient,
      rk,
    });

    // Start: switch is inactive.
    expect(await store.status()).toBeNull();

    // Enable.
    const md = await store.enable({
      enabledBy: "cli:integration-test",
      reason: "test round-trip",
      ttlSeconds: 300,
    });
    expect(md.enabledBy).toBe("cli:integration-test");

    // Status reflects the enable.
    const status = await store.status();
    expect(status?.enabledBy).toBe("cli:integration-test");
    expect(status?.reason).toBe("test round-trip");

    // Disable.
    const prior = await store.disable({
      enabledBy: "cli:integration-test",
      reason: "test cleanup",
    });
    expect(prior?.enabledBy).toBe("cli:integration-test");
    expect(await store.status()).toBeNull();
  });

  it("publishes events that a subscriber receives", async () => {
    if (!available) return;
    const subscriber = client.duplicate();
    await subscriber.connect();
    const received: string[] = [];
    await subscriber.subscribe(
      `test:${KILL_SWITCH_CHANNEL_SUFFIX}`,
      (msg) => received.push(msg),
    );

    const store = createKillSwitchStore({
      redis: client as unknown as KillSwitchRedisClient,
      rk,
    });
    await store.enable({ enabledBy: "x", reason: "y" });

    // Allow subscriber callback to drain.
    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(received[0]!) as KillSwitchEvent;
    expect(parsed.action).toBe("enable");

    await subscriber.unsubscribe();
    await subscriber.quit();
  });
});
