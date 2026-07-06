// admin/schedule-shifts.ts — the manager-gated escala surface (NEW-016).
// Locks: requireManagerRole fail-closes (403) on every route; GET returns
// { range, shifts } with the range threaded to the service (default 7-day window
// when omitted); POST 201 with the assigned shift + body validation; DELETE 200
// with the row, 404-only-when-missing.
//
// Harness mirrors ops-alerts.test.ts: an instance-level preHandler injects the
// staff identity the parent admin guard would attach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockList = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockClockIn = vi.hoisted(() => vi.fn());
const mockClockOut = vi.hoisted(() => vi.fn());
const mockLaborCost = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createStaffScheduleService: () => ({
    listShifts: mockList,
    createShift: mockCreate,
    deleteShift: mockDelete,
    clockIn: mockClockIn,
    clockOut: mockClockOut,
  }),
  createLaborCostService: () => ({
    getLaborCost: mockLaborCost,
  }),
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { scheduleShiftRoutes } = await import("../schedule-shifts.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(scheduleShiftRoutes);
  await app.ready();
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

describe("GET /api/admin/schedule/shifts is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never lists", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/schedule/shifts" });
      expect(res.statusCode).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns { range, shifts } and threads from/to/staffId to the service", async () => {
    mockList.mockResolvedValue([{ id: "shift_1", staffId: "staff_9" }]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/schedule/shifts?from=2026-07-04&to=2026-07-06&staffId=staff_9",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        range: { from: string; to: string };
        shifts: Array<{ id: string }>;
      };
      expect(body.range).toEqual({ from: "2026-07-04", to: "2026-07-06" });
      expect(body.shifts.map((s) => s.id)).toEqual(["shift_1"]);
      expect(mockList.mock.calls[0]?.[0]).toMatchObject({
        from: "2026-07-04",
        to: "2026-07-06",
        staffId: "staff_9",
      });
    } finally {
      await server.close();
    }
  });

  it("defaults the range when from/to are omitted (7-day window, exclusive to)", async () => {
    mockList.mockResolvedValue([]);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/schedule/shifts" });
      expect(res.statusCode).toBe(200);
      const arg = mockList.mock.calls[0]?.[0] as { from: string; to: string; staffId?: string };
      // Both YYYY-MM-DD, from strictly before to, and no staffId filter.
      expect(arg.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(arg.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(arg.from < arg.to).toBe(true);
      expect(arg.staffId).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("rejects a malformed date with 400", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/schedule/shifts?from=2026-7-4&to=2026-07-06",
      });
      expect(res.statusCode).toBe(400);
      expect(mockList).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/admin/schedule/shifts — assign a shift", () => {
  it("rejects ATTENDANT with 403 and never creates", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/schedule/shifts",
        payload: {
          staffId: "staff_9",
          startsAt: "2026-07-04T14:00:00.000Z",
          endsAt: "2026-07-04T22:00:00.000Z",
        },
      });
      expect(res.statusCode).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("assigns a shift (201) and threads the coerced Date fields + role/note", async () => {
    mockCreate.mockResolvedValue({ id: "shift_1", staffId: "staff_9" });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/schedule/shifts",
        payload: {
          staffId: "staff_9",
          startsAt: "2026-07-04T14:00:00.000Z",
          endsAt: "2026-07-04T22:00:00.000Z",
          role: "COZINHA",
          note: "turno de sábado",
        },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { shift: { id: string } }).shift).toMatchObject({ id: "shift_1" });
      const arg = mockCreate.mock.calls[0]?.[0] as {
        staffId: string;
        startsAt: Date;
        endsAt: Date;
        role?: string;
        note?: string;
      };
      expect(arg.staffId).toBe("staff_9");
      expect(arg.startsAt).toBeInstanceOf(Date);
      expect(arg.startsAt.toISOString()).toBe("2026-07-04T14:00:00.000Z");
      expect(arg.role).toBe("COZINHA");
      expect(arg.note).toBe("turno de sábado");
    } finally {
      await server.close();
    }
  });

  it("rejects a shift whose endsAt is not after startsAt (400)", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/schedule/shifts",
        payload: {
          staffId: "staff_9",
          startsAt: "2026-07-04T22:00:00.000Z",
          endsAt: "2026-07-04T14:00:00.000Z",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe("DELETE /api/admin/schedule/shifts/:id — remove a shift", () => {
  it("rejects ATTENDANT with 403 and never deletes", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "DELETE",
        url: "/api/admin/schedule/shifts/shift_1",
      });
      expect(res.statusCode).toBe(403);
      expect(mockDelete).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("deletes and returns the row (200)", async () => {
    mockDelete.mockResolvedValue({ id: "shift_1", staffId: "staff_9" });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "DELETE",
        url: "/api/admin/schedule/shifts/shift_1",
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { shift: { id: string } }).shift).toMatchObject({ id: "shift_1" });
      expect(mockDelete).toHaveBeenCalledWith("shift_1");
    } finally {
      await server.close();
    }
  });

  it("404s ONLY when the id does not exist (deleteShift returns null)", async () => {
    mockDelete.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "DELETE",
        url: "/api/admin/schedule/shifts/missing",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "staff_shift_not_found" });
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/admin/schedule/shifts/:id/clock-in (NEW-034)", () => {
  it("rejects ATTENDANT with 403 and never clocks in", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/schedule/shifts/shift_1/clock-in",
      });
      expect(res.statusCode).toBe(403);
      expect(mockClockIn).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("clocks in (200) with no body → service defaults `at` to now (undefined)", async () => {
    mockClockIn.mockResolvedValue({ id: "shift_1", actualStart: "2026-07-04T14:00:00.000Z" });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/schedule/shifts/shift_1/clock-in",
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { shift: { id: string } }).shift).toMatchObject({ id: "shift_1" });
      expect(mockClockIn).toHaveBeenCalledWith("shift_1", undefined);
    } finally {
      await server.close();
    }
  });

  it("threads a backdated `at` (coerced to a Date) from the body", async () => {
    mockClockIn.mockResolvedValue({ id: "shift_1" });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/schedule/shifts/shift_1/clock-in",
        payload: { at: "2026-07-04T14:05:00.000Z" },
      });
      expect(res.statusCode).toBe(200);
      const at = mockClockIn.mock.calls[0]?.[1] as Date;
      expect(at).toBeInstanceOf(Date);
      expect(at.toISOString()).toBe("2026-07-04T14:05:00.000Z");
    } finally {
      await server.close();
    }
  });

  it("404s ONLY when the id does not exist (clockIn returns null)", async () => {
    mockClockIn.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/schedule/shifts/missing/clock-in",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "staff_shift_not_found" });
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/admin/schedule/shifts/:id/clock-out (NEW-034)", () => {
  it("rejects ATTENDANT with 403 and never clocks out", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/schedule/shifts/shift_1/clock-out",
      });
      expect(res.statusCode).toBe(403);
      expect(mockClockOut).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("clocks out (200) and returns the row", async () => {
    mockClockOut.mockResolvedValue({ id: "shift_1", actualEnd: "2026-07-04T22:00:00.000Z" });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/schedule/shifts/shift_1/clock-out",
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { shift: { id: string } }).shift).toMatchObject({ id: "shift_1" });
      expect(mockClockOut).toHaveBeenCalledWith("shift_1", undefined);
    } finally {
      await server.close();
    }
  });

  it("404s ONLY when the id does not exist (clockOut returns null)", async () => {
    mockClockOut.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/schedule/shifts/missing/clock-out",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "staff_shift_not_found" });
    } finally {
      await server.close();
    }
  });
});

describe("GET /api/admin/schedule/labor-cost (NEW-034)", () => {
  it("rejects ATTENDANT with 403 and never aggregates", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/schedule/labor-cost",
      });
      expect(res.statusCode).toBe(403);
      expect(mockLaborCost).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns the labor-cost report and threads the [from, to) range", async () => {
    const report = {
      range: { from: "2026-07-04", to: "2026-07-06" },
      timezone: "America/Sao_Paulo",
      byStaff: [
        { staffId: "staff_a", name: "Ana", scheduledHours: 8, actualHours: 7.5, costCentavos: 15000, rateMissing: false },
      ],
      totalCostCentavos: 15000,
      totalScheduledHours: 8,
      totalActualHours: 7.5,
    };
    mockLaborCost.mockResolvedValue(report);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/schedule/labor-cost?from=2026-07-04&to=2026-07-06",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ totalCostCentavos: 15000, byStaff: [{ staffId: "staff_a" }] });
      expect(mockLaborCost.mock.calls[0]?.[0]).toMatchObject({ from: "2026-07-04", to: "2026-07-06" });
    } finally {
      await server.close();
    }
  });

  it("defaults the range when from/to are omitted (7-day window, exclusive to)", async () => {
    mockLaborCost.mockResolvedValue({
      range: { from: "x", to: "y" },
      timezone: "America/Sao_Paulo",
      byStaff: [],
      totalCostCentavos: 0,
      totalScheduledHours: 0,
      totalActualHours: 0,
    });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/schedule/labor-cost" });
      expect(res.statusCode).toBe(200);
      const arg = mockLaborCost.mock.calls[0]?.[0] as { from: string; to: string };
      expect(arg.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(arg.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(arg.from < arg.to).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects a malformed date with 400", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/schedule/labor-cost?from=2026-7-4&to=2026-07-06",
      });
      expect(res.statusCode).toBe(400);
      expect(mockLaborCost).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
