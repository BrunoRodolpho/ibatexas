// admin/ops-alerts.ts — the manager-gated ops-alert inbox (NEW-025 / BKL-081).
// Locks: requireManagerRole fail-closed (403) on both routes; GET returns
// { alerts, openCount } with the INDEPENDENT openCount; the cause filter enum
// (400 on unknown); the governed STAFF resolve (envelope shape, 404-only-on-missing).
//
// Harness mirrors incidents.test.ts: an instance-level preHandler injects the
// staff identity the parent admin guard would attach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockList = vi.hoisted(() => vi.fn());
const mockResolve = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createOpsAlertService: () => ({
    list: mockList,
    resolveAlertFromEnvelope: mockResolve,
  }),
}));

vi.mock("@ibatexas/audit-sink", () => ({ getAuditSink: () => undefined }));

vi.mock("../../../subscribers/__shared__/system-actor-envelope.js", () => ({
  buildSystemEnvelope: (args: unknown) => args,
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminOpsAlertRoutes } = await import("../ops-alerts.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(adminOpsAlertRoutes);
  await app.ready();
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

describe("GET /api/admin/ops-alerts is manager-gated", () => {
  it("rejects ATTENDANT with 403 and never lists", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/ops-alerts" });
      expect(res.statusCode).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns { alerts, openCount } with the INDEPENDENT count", async () => {
    // alerts.length (1) deliberately != openCount (4) to prove independence.
    mockList.mockResolvedValue({
      alerts: [{ id: "ops_1", status: "OPEN", cause: "ops_dlq_depth" }],
      openCount: 4,
    });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/ops-alerts" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { alerts: Array<{ id: string }>; openCount: number };
      expect(body.openCount).toBe(4);
      expect(body.alerts.map((a) => a.id)).toEqual(["ops_1"]);
    } finally {
      await server.close();
    }
  });

  it("accepts a valid ops cause filter and rejects an unknown one (400)", async () => {
    mockList.mockResolvedValue({ alerts: [], openCount: 0 });
    const server = await buildServer(MANAGER);
    try {
      const ok = await server.inject({
        method: "GET",
        url: "/api/admin/ops-alerts?cause=ops_dlq_depth",
      });
      expect(ok.statusCode).toBe(200);
      const bad = await server.inject({
        method: "GET",
        url: "/api/admin/ops-alerts?cause=not_a_cause",
      });
      expect(bad.statusCode).toBe(400);
      // The cause filter is threaded into the service call.
      expect(mockList.mock.calls[0]?.[0]).toMatchObject({ cause: "ops_dlq_depth" });
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/admin/ops-alerts/:id/resolve — governed STAFF resolve", () => {
  it("rejects ATTENDANT with 403 and never resolves", async () => {
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ops-alerts/ops_1/resolve",
      });
      expect(res.statusCode).toBe(403);
      expect(mockResolve).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("resolves as STAFF (envelope shape) and returns the alert", async () => {
    mockResolve.mockResolvedValue({
      decision: { kind: "EXECUTE" },
      result: { id: "ops_1", status: "RESOLVED", resolvedBy: "staff:staff_mgr_01" },
    });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ops-alerts/ops_1/resolve",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { alert: { id: string; status: string } };
      expect(body.alert).toMatchObject({ id: "ops_1", status: "RESOLVED" });
      // The governed envelope carries the STAFF identity + resolution type.
      const env = mockResolve.mock.calls[0]?.[0] as { kind: string; payload: Record<string, unknown> };
      expect(env.kind).toBe("ops.alert.resolve");
      expect(env.payload).toMatchObject({
        id: "ops_1",
        resolvedBy: "staff:staff_mgr_01",
        resolutionType: "STAFF",
      });
    } finally {
      await server.close();
    }
  });

  it("404s ONLY when the id does not exist (resolve returns null)", async () => {
    mockResolve.mockResolvedValue({ decision: { kind: "EXECUTE" }, result: null });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/admin/ops-alerts/missing/resolve",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "ops_alert_not_found" });
    } finally {
      await server.close();
    }
  });
});
