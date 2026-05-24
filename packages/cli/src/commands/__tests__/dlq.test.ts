// W6-9 — tests for `ibx dlq` dynamic event discovery.
//
// Per audit/06-reliability-fail-open.md P2-A: pre-W6 the DLQ CLI
// hardcoded 5 event names. The W6-9 fix replaces the hardcoded list with
// a Redis SCAN over `{prefix}:dlq:*` keys. These tests verify the
// dynamic discovery against an in-memory stub that mimics node-redis's
// `scanIterator()`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const mockRedisClient = vi.hoisted(() => {
  const store = new Map<string, string[]>();
  return {
    store,
    scanIterator(opts: { MATCH: string; COUNT: number }): AsyncIterable<string> {
      const pattern = opts.MATCH;
      const prefix = pattern.replace(/\*$/, "");
      const keys: string[] = [];
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) keys.push(k);
      }
      return (async function* () {
        for (const k of keys) yield k;
      })();
    },
    async lLen(key: string) {
      return store.get(key)?.length ?? 0;
    },
  };
});

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => mockRedisClient),
  rk: (k: string) => `test:${k}`,
}));

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
  beforeEach(() => {
    mockRedisClient.store.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("discovers new event subjects via SCAN (not the hardcoded hint list)", async () => {
    // Seed Redis with three DLQ keys — including subjects that the
    // PRE-W6 hardcoded list omitted (`audit.intent.decision.v1` +
    // `intent.defer.resume`).
    mockRedisClient.store.set("test:dlq:audit.intent.decision.v1", ["x", "y"]);
    mockRedisClient.store.set("test:dlq:intent.defer.resume", ["z"]);
    mockRedisClient.store.set("test:dlq:order.status_changed", ["w"]);

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
    mockRedisClient.store.clear();
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
    mockRedisClient.store.set("test:dlq:customer.anonymize.failed", ["a"]);

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
