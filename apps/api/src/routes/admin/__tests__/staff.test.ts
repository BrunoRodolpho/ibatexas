// admin/staff.ts — the OWNER-gated staff-administration surface (AUT-038 + AUT-007).
// Locks: requireOwnerRole fail-closes (403) on EVERY route incl. GET (this
// surface carries hourlyRateCentavos pay data + privilege grants); the four
// mutations thread the governed envelope (kind + payload + admin actor) to the
// StaffCommandService; typed errors map to 404/409/403/400; a `role` field on the
// PATCH body is rejected at the zod layer (400); a kernel REFUSE → 403.
//
// Harness mirrors ops-alerts.test.ts: an instance-level preHandler injects the
// staff identity the parent admin guard would attach. The mock exposes the REAL
// error-class shapes (via vi.hoisted) so the route's `instanceof` mapping works.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockList = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockDeactivate = vi.hoisted(() => vi.fn());
const mockAssignRole = vi.hoisted(() => vi.fn());

// Stand-in error classes with the SAME identity the route imports (both come
// from the mocked @ibatexas/domain), so `err instanceof X` narrows correctly.
const errs = vi.hoisted(() => {
  class StaffNotFoundError extends Error {}
  class DuplicatePhoneError extends Error {
    constructor(public phone: string) {
      super(phone);
    }
  }
  class LastOwnerError extends Error {}
  class SelfMutationError extends Error {}
  class RoleUpdateForbiddenError extends Error {}
  class InvalidStaffPhoneError extends Error {}
  class InvalidStaffRoleError extends Error {}
  class InvalidHourlyRateError extends Error {}
  return {
    StaffNotFoundError,
    DuplicatePhoneError,
    LastOwnerError,
    SelfMutationError,
    RoleUpdateForbiddenError,
    InvalidStaffPhoneError,
    InvalidStaffRoleError,
    InvalidHourlyRateError,
  };
});

vi.mock("@ibatexas/domain", () => ({
  createStaffCommandService: () => ({
    list: mockList,
    createFromEnvelope: mockCreate,
    updateFromEnvelope: mockUpdate,
    deactivateFromEnvelope: mockDeactivate,
    assignRoleFromEnvelope: mockAssignRole,
  }),
  ...errs,
}));

vi.mock("@ibatexas/audit-sink", () => ({ getAuditSink: () => undefined }));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const OWNER: StaffContext = { staffId: "staff_owner_01", staffRole: "OWNER" };
const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

const EXECUTE = { kind: "EXECUTE" as const };

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminStaffRoutes } = await import("../staff.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(adminStaffRoutes);
  await app.ready();
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

// ── GET /api/admin/staff ─────────────────────────────────────────────────────

describe("GET /api/admin/staff is OWNER-gated", () => {
  for (const ctx of [MANAGER, ATTENDANT]) {
    it(`rejects ${ctx.staffRole} with 403 and never lists`, async () => {
      const server = await buildServer(ctx);
      try {
        const res = await server.inject({ method: "GET", url: "/api/admin/staff" });
        expect(res.statusCode).toBe(403);
        expect(mockList).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    });
  }

  it("OWNER: returns { staff, total } and threads role/active/limit/offset", async () => {
    mockList.mockResolvedValue({
      staff: [{ id: "staff_1", name: "Ana", role: "OWNER", hourlyRateCentavos: 5000 }],
      total: 1,
    });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/staff?role=OWNER&active=true&limit=10&offset=5",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { staff: Array<{ id: string }>; total: number };
      expect(body.total).toBe(1);
      expect(body.staff.map((s) => s.id)).toEqual(["staff_1"]);
      expect(mockList.mock.calls[0]?.[0]).toMatchObject({
        role: "OWNER",
        active: true,
        limit: 10,
        offset: 5,
      });
    } finally {
      await server.close();
    }
  });

  it("OWNER: active=false is parsed as the boolean false (not coerced to true)", async () => {
    mockList.mockResolvedValue({ staff: [], total: 0 });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/staff?active=false" });
      expect(res.statusCode).toBe(200);
      expect(mockList.mock.calls[0]?.[0]).toMatchObject({ active: false });
    } finally {
      await server.close();
    }
  });
});

// ── POST /api/admin/staff ────────────────────────────────────────────────────

describe("POST /api/admin/staff — create", () => {
  it("rejects MANAGER with 403 and never creates", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/staff",
        payload: { phone: "+5511999990001", name: "Ana", role: "ATTENDANT" },
      });
      expect(res.statusCode).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("OWNER: creates (201) and threads the governed staff.create envelope", async () => {
    mockCreate.mockResolvedValue({ decision: EXECUTE, result: { id: "staff_new", name: "Ana" } });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/staff",
        payload: { phone: "+5511999990001", name: "Ana", role: "MANAGER", hourlyRateCentavos: 5000 },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { staff: { id: string } }).staff).toMatchObject({ id: "staff_new" });
      const env = mockCreate.mock.calls[0]?.[0] as {
        kind: string;
        payload: Record<string, unknown>;
        actor: { sessionId: string; role?: string };
      };
      expect(env.kind).toBe("staff.create");
      expect(env.payload).toMatchObject({
        phone: "+5511999990001",
        name: "Ana",
        role: "MANAGER",
        hourlyRateCentavos: 5000,
      });
      expect(env.actor.sessionId).toBe("admin:staff_owner_01");
      expect(env.actor.role).toBe("OWNER");
    } finally {
      await server.close();
    }
  });

  it("OWNER: a duplicate ACTIVE phone maps to 409", async () => {
    mockCreate.mockRejectedValue(new errs.DuplicatePhoneError("+5511999990001"));
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/staff",
        payload: { phone: "+5511999990001", name: "Ana" },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await server.close();
    }
  });

  it("OWNER: a kernel REFUSE maps to 403 with the kernel's userFacing copy", async () => {
    mockCreate.mockResolvedValue({
      decision: { kind: "REFUSE", refusal: { userFacing: "Bloqueado pelo kernel." } },
    });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/staff",
        payload: { phone: "+5511999990001", name: "Ana" },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: string }).error).toBe("Bloqueado pelo kernel.");
    } finally {
      await server.close();
    }
  });

  it("OWNER: an invalid phone (service-side) maps to 400", async () => {
    mockCreate.mockRejectedValue(new errs.InvalidStaffPhoneError("bad"));
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/staff",
        payload: { phone: "+5511999990001", name: "Ana" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });
});

// ── PATCH /api/admin/staff/:id ───────────────────────────────────────────────

describe("PATCH /api/admin/staff/:id — update", () => {
  it("rejects MANAGER with 403 and never updates", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/staff/staff_1",
        payload: { name: "Nova" },
      });
      expect(res.statusCode).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("OWNER: updates (200) and threads { staffId, name }", async () => {
    mockUpdate.mockResolvedValue({ decision: EXECUTE, result: { id: "staff_1", name: "Nova" } });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/staff/staff_1",
        payload: { name: "Nova" },
      });
      expect(res.statusCode).toBe(200);
      const env = mockUpdate.mock.calls[0]?.[0] as { kind: string; payload: Record<string, unknown> };
      expect(env.kind).toBe("staff.update");
      expect(env.payload).toMatchObject({ staffId: "staff_1", name: "Nova" });
    } finally {
      await server.close();
    }
  });

  it("OWNER: a `role` field in the body is REJECTED at the zod layer (400, never updates)", async () => {
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/staff/staff_1",
        payload: { name: "Nova", role: "OWNER" },
      });
      expect(res.statusCode).toBe(400);
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("OWNER: an empty body is REJECTED (400, at-least-one-field refine)", async () => {
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/staff/staff_1",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("OWNER: an unknown target maps to 404", async () => {
    mockUpdate.mockRejectedValue(new errs.StaffNotFoundError());
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/admin/staff/ghost",
        payload: { name: "Nova" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});

// ── POST /api/admin/staff/:id/deactivate ─────────────────────────────────────

describe("POST /api/admin/staff/:id/deactivate", () => {
  for (const ctx of [MANAGER, ATTENDANT]) {
    it(`rejects ${ctx.staffRole} with 403 and never deactivates`, async () => {
      const server = await buildServer(ctx);
      try {
        const res = await server.inject({
          method: "POST",
          url: "/api/admin/staff/staff_1/deactivate",
        });
        expect(res.statusCode).toBe(403);
        expect(mockDeactivate).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    });
  }

  it("OWNER: deactivates (200) and threads the staff.deactivate envelope", async () => {
    mockDeactivate.mockResolvedValue({ decision: EXECUTE, result: { id: "staff_1", active: false } });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/staff/staff_1/deactivate",
      });
      expect(res.statusCode).toBe(200);
      const env = mockDeactivate.mock.calls[0]?.[0] as { kind: string; payload: Record<string, unknown> };
      expect(env.kind).toBe("staff.deactivate");
      expect(env.payload).toMatchObject({ staffId: "staff_1" });
    } finally {
      await server.close();
    }
  });

  it("OWNER: the last-owner guard maps to 409", async () => {
    mockDeactivate.mockRejectedValue(new errs.LastOwnerError());
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/staff/owner_1/deactivate",
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await server.close();
    }
  });

  it("OWNER: self-deactivation maps to 403", async () => {
    mockDeactivate.mockRejectedValue(new errs.SelfMutationError());
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/staff/staff_owner_01/deactivate",
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });
});

// ── POST /api/admin/staff/:id/role ───────────────────────────────────────────

describe("POST /api/admin/staff/:id/role — assign role", () => {
  it("rejects MANAGER with 403 and never assigns", async () => {
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/staff/staff_1/role",
        payload: { role: "MANAGER" },
      });
      expect(res.statusCode).toBe(403);
      expect(mockAssignRole).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("OWNER: assigns (200) and threads the staff.role.assign envelope", async () => {
    mockAssignRole.mockResolvedValue({ decision: EXECUTE, result: { id: "staff_1", role: "MANAGER" } });
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/staff/staff_1/role",
        payload: { role: "MANAGER" },
      });
      expect(res.statusCode).toBe(200);
      const env = mockAssignRole.mock.calls[0]?.[0] as { kind: string; payload: Record<string, unknown> };
      expect(env.kind).toBe("staff.role.assign");
      expect(env.payload).toMatchObject({ staffId: "staff_1", role: "MANAGER" });
    } finally {
      await server.close();
    }
  });

  it("OWNER: an invalid role in the body is REJECTED at the zod layer (400)", async () => {
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/staff/staff_1/role",
        payload: { role: "ROOT" },
      });
      expect(res.statusCode).toBe(400);
      expect(mockAssignRole).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("OWNER: demoting the last owner maps to 409", async () => {
    mockAssignRole.mockRejectedValue(new errs.LastOwnerError());
    const server = await buildServer(OWNER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/staff/owner_1/role",
        payload: { role: "MANAGER" },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      await server.close();
    }
  });
});
