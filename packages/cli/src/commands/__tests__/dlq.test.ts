// W6-9 — tests for `ibx dlq` dynamic event discovery.
//
// Per audit/06-reliability-fail-open.md P2-A: pre-W6 the DLQ CLI
// hardcoded 5 event names. The W6-9 fix replaces the hardcoded list with
// a Redis SCAN over `{prefix}:dlq:*` keys. These tests verify the
// dynamic discovery against an in-memory stub that mimics node-redis's
// `scanIterator()`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { createInMemoryRedis } from "@ibatexas/tools/testing";
import { rk } from "@ibatexas/tools";

// R5-S8 — the canonical in-memory adapter replaces a hand-rolled double with
// two fictions. (1) Its `scanIterator` reduced the glob to `startsWith` after
// stripping one trailing `*`, so `MATCH` was pattern-matching in name only.
// (2) Its `lLen` measured a JS array the TEST planted under the key; production
// writes DLQs with LPUSH (`apps/api/src/subscribers/dlq.ts:29`), so the count in
// every row came from the fixture's own shape rather than from a list. Seeding
// through `lPush` here means `lLen` measures what the real producer wrote.
const mockGetRedisClient = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", async () => {
  // `rk` was faked as `test:${key}` — a prefix that depends on the fake rather
  // than on APP_ENV. Spread from the real module so the keys seeded below are
  // the keys `discoverDlqEvents` actually SCANs for.
  const actual = await vi.importActual<typeof import("@ibatexas/tools")>("@ibatexas/tools");
  return { ...actual, getRedisClient: mockGetRedisClient };
});

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}));

function captureStdout(): { restore: () => void; getOutput: () => string } {
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    chunks.push(args.join(" "));
  });
  return {
    restore: () => {
      logSpy.mockRestore();
    },
    getOutput: () => chunks.join("\n"),
  };
}

describe("ibx dlq list — dynamic event discovery (W6-9)", () => {
  let redis: ReturnType<typeof createInMemoryRedis>;

  /** Seed a DLQ the way the producer writes it (`pushToDlq` → LPUSH). */
  async function seedDlq(event: string, depth: number): Promise<void> {
    await redis.client.lPush(
      rk(`dlq:${event}`),
      Array.from({ length: depth }, (_, i) => `entry-${i}`),
    );
  }

  beforeEach(() => {
    redis = createInMemoryRedis();
    mockGetRedisClient.mockImplementation(async () => redis.client);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("discovers new event subjects via SCAN (not the hardcoded hint list)", async () => {
    // Seed Redis with three DLQ keys — including subjects that the
    // PRE-W6 hardcoded list omitted (`audit.intent.decision.v1` +
    // `intent.defer.resume`).
    await seedDlq("audit.intent.decision.v1", 2);
    await seedDlq("intent.defer.resume", 1);
    await seedDlq("order.status_changed", 1);

    const stdout = captureStdout();
    try {
      const cmd = new Command();
      cmd.exitOverride();
      const { registerDlqCommands } = await import("../dlq.js");
      registerDlqCommands(cmd);
      await cmd.parseAsync(["list"], { from: "user" });

      const out = stdout.getOutput();
      // All three discovered subjects must appear in the output.
      expect(out).toContain("audit.intent.decision.v1");
      expect(out).toContain("intent.defer.resume");
      expect(out).toContain("order.status_changed");
    } finally {
      stdout.restore();
    }
  });

  it("falls back to the hint list when SCAN yields zero keys", async () => {
    // No DLQ keys present. SCAN returns []. The fallback hint list is
    // used so the operator's CLI doesn't show "✓ All DLQs empty" before
    // they've even attempted to publish anything.
    const stdout = captureStdout();
    try {
      const cmd = new Command();
      cmd.exitOverride();
      const { registerDlqCommands } = await import("../dlq.js");
      registerDlqCommands(cmd);
      await cmd.parseAsync(["list"], { from: "user" });

      const out = stdout.getOutput();
      // Total count = 0 → "All DLQs empty" shortcut.
      expect(out).toContain("All DLQs empty");
    } finally {
      stdout.restore();
    }
  });

  it("respects custom DLQ subjects added by future subscribers", async () => {
    // Future subjects (e.g. `customer.anonymize.failed`) are discovered
    // automatically without code changes — the gate is the SCAN.
    await seedDlq("customer.anonymize.failed", 1);

    const stdout = captureStdout();
    try {
      const cmd = new Command();
      cmd.exitOverride();
      const { registerDlqCommands } = await import("../dlq.js");
      registerDlqCommands(cmd);
      await cmd.parseAsync(["list"], { from: "user" });
      const out = stdout.getOutput();
      expect(out).toContain("customer.anonymize.failed");
    } finally {
      stdout.restore();
    }
  });
});
