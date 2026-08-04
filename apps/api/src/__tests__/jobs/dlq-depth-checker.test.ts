// dlq-depth-checker — unit tests (NEW-025 detection half).
//
// Exhaustively covers the PURE detection logic (severity bands, event-name
// parse, the raise/resolve planner) and a thin injected-deps integration of
// `checkDlqDepth` (SCAN depths → govern raise/resolve through the OpsAlertService).

import { describe, it, expect, vi } from "vitest";
import { createInMemoryRedis } from "@ibatexas/tools/testing";
import { rk } from "@ibatexas/tools";
import {
  dlqDepthSeverity,
  parseDlqEventName,
  planDlqAlertActions,
  checkDlqDepth,
} from "../../jobs/dlq-depth-checker.js";

describe("dlqDepthSeverity — monotonic bands over threshold", () => {
  const t = 25;
  it("low at 1×, medium at 2×, high at 4×", () => {
    expect(dlqDepthSeverity(t, t)).toBe("low"); // exactly at threshold
    expect(dlqDepthSeverity(t * 2 - 1, t)).toBe("low");
    expect(dlqDepthSeverity(t * 2, t)).toBe("medium");
    expect(dlqDepthSeverity(t * 4 - 1, t)).toBe("medium");
    expect(dlqDepthSeverity(t * 4, t)).toBe("high");
    expect(dlqDepthSeverity(10_000, t)).toBe("high");
  });
});

describe("parseDlqEventName", () => {
  it("recovers the event after :dlq:", () => {
    expect(parseDlqEventName("production:dlq:order.placed")).toBe("order.placed");
    expect(parseDlqEventName("development:dlq:notification.send")).toBe("notification.send");
  });
  it("returns null for a non-DLQ key or an empty event", () => {
    expect(parseDlqEventName("production:outbox:order.placed")).toBeNull();
    expect(parseDlqEventName("production:dlq:")).toBeNull();
  });
});

describe("planDlqAlertActions — pure raise/resolve decision", () => {
  const threshold = 25;

  it("raises for a DLQ at/over threshold with the right severity; not below", () => {
    const plan = planDlqAlertActions({
      depths: new Map([
        ["order.placed", 30], // over → raise (low)
        ["notification.send", 120], // 4×+ → raise (high)
        ["support.handoff_requested", 5], // below → no raise
      ]),
      openByScope: new Map(),
      threshold,
    });
    const byEvent = Object.fromEntries(plan.raise.map((r) => [r.event, r]));
    expect(Object.keys(byEvent).sort()).toEqual(["notification.send", "order.placed"]);
    expect(byEvent["order.placed"]!.severity).toBe("low");
    expect(byEvent["notification.send"]!.severity).toBe("high");
    expect(plan.resolve).toHaveLength(0);
  });

  it("AUTO-resolves an open alert whose DLQ drained below threshold", () => {
    const plan = planDlqAlertActions({
      depths: new Map([["order.placed", 3]]), // below threshold now
      openByScope: new Map([["order.placed", "ops_1"]]), // but has an open alert
      threshold,
    });
    expect(plan.raise).toHaveLength(0);
    expect(plan.resolve).toEqual([{ id: "ops_1", event: "order.placed" }]);
  });

  it("AUTO-resolves an open alert whose DLQ vanished entirely (not in depths)", () => {
    const plan = planDlqAlertActions({
      depths: new Map(), // fully drained → key skipped by caller
      openByScope: new Map([["order.placed", "ops_1"]]),
      threshold,
    });
    expect(plan.resolve).toEqual([{ id: "ops_1", event: "order.placed" }]);
  });

  it("keeps (does NOT resolve) an open alert still over threshold — it re-raises to fold in", () => {
    const plan = planDlqAlertActions({
      depths: new Map([["order.placed", 50]]),
      openByScope: new Map([["order.placed", "ops_1"]]),
      threshold,
    });
    expect(plan.resolve).toHaveLength(0);
    expect(plan.raise.map((r) => r.event)).toEqual(["order.placed"]);
  });
});

describe("checkDlqDepth — injected-deps integration", () => {
  // R5-S7 — the canonical in-memory adapter replaces a hand-rolled double whose
  // `scanIterator` IGNORED MATCH (it yielded whatever it was constructed with)
  // and whose `lLen` re-derived the event from the key instead of measuring a
  // list. Both halves of the job's Redis contract — "scan only MY prefix" and
  // "depth is the list's length" — were therefore asserted by nothing. Here the
  // keyspace is real: `rk()` runs unstubbed, DLQs are seeded with the same LPUSH
  // production writes them with (`subscribers/dlq.ts`), and depth is counted.
  async function seedDlqs(lists: Record<string, number>) {
    const redis = createInMemoryRedis();
    for (const [event, depth] of Object.entries(lists)) {
      if (depth > 0) {
        await redis.client.lPush(
          rk(`dlq:${event}`),
          Array.from({ length: depth }, (_, i) => `msg-${i}`),
        );
      }
    }
    // A non-DLQ key sharing the env prefix. The old double could not have held
    // one, so nothing proved the job SCOPES its scan; now MATCH is load-bearing
    // and this key must never reach parseDlqEventName.
    await redis.client.set(rk("outbox:order.placed"), "not-a-dlq");
    return redis;
  }

  it("raises an ops.alert.open for an over-threshold DLQ", async () => {
    const openAlert = vi.fn().mockResolvedValue({ decision: { kind: "EXECUTE" }, result: { opened: true } });
    const resolveAlert = vi.fn().mockResolvedValue({ decision: { kind: "EXECUTE" }, result: {} });
    const svc = {
      openAlertFromEnvelope: openAlert,
      resolveAlertFromEnvelope: resolveAlert,
      list: vi.fn().mockResolvedValue({ alerts: [], openCount: 0 }),
    } as unknown as Parameters<typeof checkDlqDepth>[1] extends { svc?: infer S } ? S : never;

    await checkDlqDepth(null, { redis: (await seedDlqs({ "order.placed": 100 })).client, svc });

    expect(openAlert).toHaveBeenCalledTimes(1);
    const env = openAlert.mock.calls[0]![0] as { kind: string; payload: Record<string, unknown> };
    expect(env.kind).toBe("ops.alert.open");
    expect(env.payload).toMatchObject({
      cause: "ops_dlq_depth",
      severity: "high",
      scope: "order.placed",
      dedupeKey: "ops_dlq_depth:order.placed",
    });
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("AUTO-resolves an open alert when its DLQ has drained", async () => {
    const openAlert = vi.fn();
    const resolveAlert = vi.fn().mockResolvedValue({ decision: { kind: "EXECUTE" }, result: {} });
    const svc = {
      openAlertFromEnvelope: openAlert,
      resolveAlertFromEnvelope: resolveAlert,
      list: vi.fn().mockResolvedValue({
        alerts: [{ id: "ops_1", scope: "order.placed", status: "OPEN" }],
        openCount: 1,
      }),
    } as unknown as Parameters<typeof checkDlqDepth>[1] extends { svc?: infer S } ? S : never;

    // No DLQ lists present → order.placed drained.
    await checkDlqDepth(null, { redis: (await seedDlqs({})).client, svc });

    expect(openAlert).not.toHaveBeenCalled();
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    const env = resolveAlert.mock.calls[0]![0] as { kind: string; payload: Record<string, unknown> };
    expect(env.kind).toBe("ops.alert.resolve");
    expect(env.payload).toMatchObject({ id: "ops_1", resolutionType: "AUTO" });
  });

  it("does nothing (no raise, no resolve) when all DLQs are below threshold and none are open", async () => {
    const openAlert = vi.fn();
    const resolveAlert = vi.fn();
    const svc = {
      openAlertFromEnvelope: openAlert,
      resolveAlertFromEnvelope: resolveAlert,
      list: vi.fn().mockResolvedValue({ alerts: [], openCount: 0 }),
    } as unknown as Parameters<typeof checkDlqDepth>[1] extends { svc?: infer S } ? S : never;

    await checkDlqDepth(null, { redis: (await seedDlqs({ "order.placed": 3 })).client, svc });

    expect(openAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });
});
