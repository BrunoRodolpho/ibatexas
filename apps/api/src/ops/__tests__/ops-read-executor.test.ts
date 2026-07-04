// ops-read-executor — the ops_snapshot read executor closure (NEW-032 slice B).
// Mocks the @ibatexas/domain read services + audit sink so the closure body
// (lazy service construction → composeOpsSnapshot) runs without a DB.

import { describe, expect, it, vi } from "vitest";

vi.mock("@ibatexas/domain", () => ({
  createOpsAlertService: () => ({ list: async () => ({ alerts: [], openCount: 0 }) }),
  createIncidentService: () => ({ list: async () => ({ openCount: 0 }) }),
  createKitchenService: () => ({
    getTickets: async () => ({ totalActive: 0, tickets: [], queueDepth: [] }),
  }),
  createDayCloseService: () => ({
    getDaySummary: async (date: string) => ({
      date,
      orders: { count: 0, grossCentavos: 0 },
      settled: { totalCentavos: 0 },
      refunds: { totalCentavos: 0 },
      netCentavos: 0,
    }),
  }),
}));
vi.mock("@ibatexas/audit-sink", () => ({ getAuditSink: () => ({}) }));

import { createOpsSnapshotReadExecutor } from "../ops-read-executor.js";

describe("createOpsSnapshotReadExecutor", () => {
  it("returns an executor that composes the situational snapshot from the domain reads", async () => {
    const executor = createOpsSnapshotReadExecutor();
    const snap = await executor({}, {} as never);
    expect(snap).toMatchObject({
      opsAlerts: { open: 0 },
      incidents: { open: 0 },
      kitchen: { activeTickets: 0 },
      caixa: { ordersCount: 0 },
    });
    expect(typeof snap.now).toBe("string");
  });
});
