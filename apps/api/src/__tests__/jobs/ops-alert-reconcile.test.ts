// ops-alert-reconcile — unit tests (BKL-080 shared watchdog emit helper).

import { describe, it, expect, vi } from "vitest";
import type { OpsAlertOpenPayload } from "@ibatexas/domain";
import {
  sweepCountSeverity,
  reconcileSweepOpsAlert,
} from "../../jobs/ops-alert-reconcile.js";

function openPayload(over: Partial<OpsAlertOpenPayload> = {}): OpsAlertOpenPayload {
  return {
    cause: "ops_stuck_order",
    severity: "medium",
    source: "stale-order-checker",
    scope: null,
    title: "pedidos travados: 12 numa varredura",
    detail: "12 pedidos cancelados",
    context: { canceledCount: 12, threshold: 10 },
    dedupeKey: "ops_stuck_order",
    ...over,
  };
}

function makeSvc(alerts: Array<Record<string, unknown>> = []) {
  const open = vi.fn().mockResolvedValue({ decision: { kind: "EXECUTE" }, result: { opened: true } });
  const resolve = vi.fn().mockResolvedValue({ decision: { kind: "EXECUTE" }, result: {} });
  const list = vi.fn().mockResolvedValue({ alerts, openCount: alerts.length });
  return {
    svc: { openAlertFromEnvelope: open, resolveAlertFromEnvelope: resolve, list } as unknown as Parameters<
      typeof reconcileSweepOpsAlert
    >[0]["svc"],
    open,
    resolve,
    list,
  };
}

describe("sweepCountSeverity — medium below 3×, high at/above", () => {
  it("bands", () => {
    expect(sweepCountSeverity(10, 10)).toBe("medium");
    expect(sweepCountSeverity(29, 10)).toBe("medium");
    expect(sweepCountSeverity(30, 10)).toBe("high");
    expect(sweepCountSeverity(1000, 10)).toBe("high");
  });
});

describe("reconcileSweepOpsAlert", () => {
  it("over threshold → raises (folds) an ops.alert.open with the payload", async () => {
    const { svc, open, resolve, list } = makeSvc();
    await reconcileSweepOpsAlert({
      svc,
      over: true,
      open: openPayload(),
      sourceSubject: "stale-order-checker",
      now: 1234,
    });
    expect(open).toHaveBeenCalledTimes(1);
    const env = open.mock.calls[0]![0] as { kind: string; payload: Record<string, unknown> };
    expect(env.kind).toBe("ops.alert.open");
    expect(env.payload).toMatchObject({ cause: "ops_stuck_order", dedupeKey: "ops_stuck_order" });
    expect(resolve).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled(); // no list read on the raise path
  });

  it("not over + an open alert for the condition exists → AUTO-resolves it", async () => {
    const { svc, open, resolve } = makeSvc([
      { id: "ops_1", status: "OPEN", dedupeKey: "ops_stuck_order" },
    ]);
    await reconcileSweepOpsAlert({
      svc,
      over: false,
      open: openPayload(),
      sourceSubject: "stale-order-checker",
      now: 1234,
    });
    expect(open).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    const env = resolve.mock.calls[0]![0] as { kind: string; payload: Record<string, unknown> };
    expect(env.kind).toBe("ops.alert.resolve");
    expect(env.payload).toMatchObject({ id: "ops_1", resolutionType: "AUTO" });
  });

  it("not over + no open alert → no-op (no resolve)", async () => {
    const { svc, open, resolve } = makeSvc([]);
    await reconcileSweepOpsAlert({
      svc,
      over: false,
      open: openPayload(),
      sourceSubject: "stale-order-checker",
      now: 1234,
    });
    expect(open).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("not over + an open alert of a DIFFERENT condition → does NOT resolve it", async () => {
    const { svc, resolve } = makeSvc([
      { id: "ops_other", status: "OPEN", dedupeKey: "ops_dlq_depth" },
    ]);
    await reconcileSweepOpsAlert({
      svc,
      over: false,
      open: openPayload({ cause: "ops_stuck_order", dedupeKey: "ops_stuck_order" }),
      sourceSubject: "stale-order-checker",
      now: 1234,
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});
