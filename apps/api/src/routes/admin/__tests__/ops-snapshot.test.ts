// admin/ops-snapshot.ts — manager-gated ops situational-snapshot (NEW-040).
// Locks:
//   (a) requireManagerRole fail-closed (403) for ATTENDANT (no service call);
//   (b) 200 composes all four summaries from the mocked service returns;
//   (c) ONE service rejecting → the endpoint still 200s with that sub-summary
//       as the zero/empty fallback and the other three intact (Promise.allSettled
//       resilience — one bad signal must never 500 the overview).
//
// Harness mirrors ops-alerts.test.ts / kitchen.test.ts: an instance-level
// preHandler injects the staff identity the parent admin guard would attach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockAlertsList = vi.hoisted(() => vi.fn());
const mockIncidentsList = vi.hoisted(() => vi.fn());
const mockGetTickets = vi.hoisted(() => vi.fn());
const mockGetDaySummary = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createOpsAlertService: () => ({ list: mockAlertsList }),
  createIncidentService: () => ({ list: mockIncidentsList }),
  createKitchenService: () => ({ getTickets: mockGetTickets }),
  createDayCloseService: () => ({ getDaySummary: mockGetDaySummary }),
}));

vi.mock("@ibatexas/audit-sink", () => ({ getAuditSink: () => undefined }));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

// ── Canned service returns ──────────────────────────────────────────────────

const ALERTS_RESULT = {
  // alerts.length (3) deliberately != openCount (5) to prove independence; one
  // RESOLVED row must NOT be tallied into bySeverity (terminal).
  alerts: [
    { id: "a1", status: "OPEN", severity: "high", cause: "ops_dlq_depth" },
    { id: "a2", status: "ACKNOWLEDGED", severity: "medium", cause: "ops_stale_defer" },
    { id: "a3", status: "RESOLVED", severity: "high", cause: "ops_stuck_order" },
  ],
  openCount: 5,
};

const INCIDENTS_RESULT = {
  rows: [{ id: "i1" }],
  openCount: 2,
  stats: { open: 1, acknowledged: 1, resolvedToday: 0, resolvedAuto: 0, resolvedStaff: 0, avgMinutes: 0 },
};

const KITCHEN_BOARD = {
  now: "2026-07-04T12:00:00.000Z",
  tickets: [
    { orderId: "o_old", displayId: 9, fulfillmentStatus: "preparing", items: [], itemCount: 2, ticketAgeMs: 3_600_000, statusSince: "x", timeInStatusMs: 1_800_000 },
    { orderId: "o_new", displayId: 12, fulfillmentStatus: "pending", items: [], itemCount: 1, ticketAgeMs: 300_000, statusSince: "y", timeInStatusMs: 300_000 },
  ],
  queueDepth: [
    { status: "pending", count: 1 },
    { status: "confirmed", count: 0 },
    { status: "preparing", count: 1 },
    { status: "ready", count: 0 },
  ],
  totalActive: 2,
};

const DAY_SUMMARY = {
  date: "2026-07-04",
  timezone: "America/Sao_Paulo",
  windowStart: "s",
  windowEnd: "e",
  orders: { count: 7, grossCentavos: 123_400 },
  settled: { count: 6, totalCentavos: 110_000, byMethod: { pix: 60_000, card: 40_000, cash: 10_000 } },
  refunds: { count: 1, totalCentavos: 5_000, byMethod: { pix: 5_000, card: 0, cash: 0 } },
  netCentavos: 105_000,
};

function primeAllHappy(): void {
  mockAlertsList.mockResolvedValue(ALERTS_RESULT);
  mockIncidentsList.mockResolvedValue(INCIDENTS_RESULT);
  mockGetTickets.mockResolvedValue(KITCHEN_BOARD);
  mockGetDaySummary.mockResolvedValue(DAY_SUMMARY);
}

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminOpsSnapshotRoutes } = await import("../ops-snapshot.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(adminOpsSnapshotRoutes);
  await app.ready();
  return app;
}

interface SnapshotBody {
  now: string;
  opsAlerts: { open: number; bySeverity: { low: number; medium: number; high: number } };
  incidents: { open: number };
  kitchen: { activeTickets: number; oldestTicketAgeMs: number; queueDepth: Array<{ status: string; count: number }> };
  caixa: { date: string; ordersCount: number; grossCentavos: number; settledCentavos: number; refundedCentavos: number; netCentavos: number };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

describe("GET /api/admin/ops/snapshot is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never reads any signal", async () => {
    primeAllHappy();
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/ops/snapshot" });
      expect(res.statusCode).toBe(403);
      expect(mockAlertsList).not.toHaveBeenCalled();
      expect(mockIncidentsList).not.toHaveBeenCalled();
      expect(mockGetTickets).not.toHaveBeenCalled();
      expect(mockGetDaySummary).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe("GET /api/admin/ops/snapshot composes all four summaries", () => {
  it("returns 200 folding each service return into its compact sub-summary", async () => {
    primeAllHappy();
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/ops/snapshot" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SnapshotBody;

      expect(typeof body.now).toBe("string");

      // Ops-alerts: independent NON_TERMINAL openCount + a severity tally that
      // EXCLUDES the terminal (RESOLVED) row.
      expect(body.opsAlerts.open).toBe(5);
      expect(body.opsAlerts.bySeverity).toEqual({ low: 0, medium: 1, high: 1 });

      // Incidents: the NON_TERMINAL openCount (attention badge).
      expect(body.incidents.open).toBe(2);

      // Kitchen: load summary only (no full ticket list), oldest ticket's age.
      expect(body.kitchen.activeTickets).toBe(2);
      expect(body.kitchen.oldestTicketAgeMs).toBe(3_600_000);
      expect(body.kitchen.queueDepth).toEqual(KITCHEN_BOARD.queueDepth);
      expect(body.kitchen).not.toHaveProperty("tickets");

      // Caixa: compact headline money figures (integer centavos).
      expect(body.caixa).toEqual({
        date: "2026-07-04",
        ordersCount: 7,
        grossCentavos: 123_400,
        settledCentavos: 110_000,
        refundedCentavos: 5_000,
        netCentavos: 105_000,
      });

      // Each signal was read exactly once.
      expect(mockAlertsList).toHaveBeenCalledTimes(1);
      expect(mockIncidentsList).toHaveBeenCalledTimes(1);
      expect(mockGetTickets).toHaveBeenCalledTimes(1);
      expect(mockGetDaySummary).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});

describe("GET /api/admin/ops/snapshot is resilient to one bad signal", () => {
  it("still 200s with a fallback sub-summary when ONE read rejects (allSettled)", async () => {
    // Kitchen read blows up (e.g. projection hiccup); the other three succeed.
    mockAlertsList.mockResolvedValue(ALERTS_RESULT);
    mockIncidentsList.mockResolvedValue(INCIDENTS_RESULT);
    mockGetTickets.mockRejectedValue(new Error("projection unavailable"));
    mockGetDaySummary.mockResolvedValue(DAY_SUMMARY);

    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/ops/snapshot" });
      // One bad signal must NOT 500 the overview.
      expect(res.statusCode).toBe(200);
      const body = res.json() as SnapshotBody;

      // The failed signal degrades to its zero/empty fallback…
      expect(body.kitchen).toEqual({ activeTickets: 0, oldestTicketAgeMs: 0, queueDepth: [] });

      // …while the other three remain fully intact.
      expect(body.opsAlerts.open).toBe(5);
      expect(body.incidents.open).toBe(2);
      expect(body.caixa.netCentavos).toBe(105_000);
    } finally {
      await server.close();
    }
  });
});
