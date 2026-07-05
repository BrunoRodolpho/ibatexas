// ops-snapshot-compose — the shared situational-snapshot composition (NEW-032).
//
// Verifies the fold of the four signals and the per-signal resilience (one bad
// read degrades to its zero/empty fallback; the other three stay intact).

import { describe, expect, it, vi } from "vitest";
import {
  composeOpsSnapshot,
  type OpsSnapshotComposeDeps,
} from "../ops-snapshot-compose.js";

const LOG = { error: vi.fn() };

function makeDeps(over: Partial<OpsSnapshotComposeDeps> = {}): OpsSnapshotComposeDeps {
  return {
    opsAlerts: () =>
      ({
        list: async () => ({
          alerts: [
            { status: "OPEN", severity: "high" },
            { status: "ACKNOWLEDGED", severity: "low" },
            { status: "RESOLVED", severity: "high" },
          ],
          openCount: 2,
        }),
      }) as never,
    incidents: () => ({ list: async () => ({ openCount: 1 }) }) as never,
    kitchen: () =>
      ({
        getTickets: async () => ({
          totalActive: 3,
          tickets: [{ ticketAgeMs: 90_000 }],
          queueDepth: [{ status: "preparing", count: 3 }],
        }),
      }) as never,
    dayClose: () =>
      ({
        getDaySummary: async (date: string) => ({
          date,
          orders: { count: 12, grossCentavos: 120_000 },
          settled: { totalCentavos: 100_000 },
          refunds: { totalCentavos: 5_000 },
          netCentavos: 95_000,
        }),
      }) as never,
    today: "2026-07-04",
    log: LOG,
    ...over,
  };
}

describe("composeOpsSnapshot", () => {
  it("folds the four signals into the compact snapshot", async () => {
    const snap = await composeOpsSnapshot(makeDeps());
    expect(snap.opsAlerts).toEqual({
      open: 2,
      bySeverity: { low: 1, medium: 0, high: 1 },
    });
    expect(snap.incidents).toEqual({ open: 1 });
    expect(snap.kitchen).toEqual({
      activeTickets: 3,
      oldestTicketAgeMs: 90_000,
      queueDepth: [{ status: "preparing", count: 3 }],
    });
    expect(snap.caixa).toEqual({
      date: "2026-07-04",
      ordersCount: 12,
      grossCentavos: 120_000,
      settledCentavos: 100_000,
      refundedCentavos: 5_000,
      netCentavos: 95_000,
    });
    expect(typeof snap.now).toBe("string");
    // BKL-100 — no signal failed, so nothing is flagged degraded.
    expect(snap.degraded).toEqual([]);
  });

  it("degrades ONE failing signal to its fallback; the others survive", async () => {
    const snap = await composeOpsSnapshot(
      makeDeps({
        kitchen: () =>
          ({
            getTickets: async () => {
              throw new Error("projection hiccup");
            },
          }) as never,
      }),
    );
    // Kitchen degraded to zero/empty…
    expect(snap.kitchen).toEqual({
      activeTickets: 0,
      oldestTicketAgeMs: 0,
      queueDepth: [],
    });
    // …the other three are intact.
    expect(snap.opsAlerts.open).toBe(2);
    expect(snap.incidents.open).toBe(1);
    expect(snap.caixa.ordersCount).toBe(12);
    // BKL-100 — the failed signal is flagged so a renderer never shows its zeros.
    expect(snap.degraded).toEqual(["kitchen"]);
  });
});
