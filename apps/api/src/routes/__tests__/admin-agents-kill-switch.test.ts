// BKL-098: the operator surface for the per-agent kill switch
// (routes/admin/agents-kill-switch.ts). These cases prove the route contract in
// isolation over a MOCKED AgentKillSwitchManager (no Redis): the MANAGER+ gate
// fail-closes (403) before the manager is ever consulted; kill/unkill reuse
// manager.trip()/clear() and return the killed flag idempotently; an unknown
// agentId 404s WITHOUT tripping a phantom; the plane-off manager (null) 503s;
// and kill-status reads isKilled() keyed by sessionIdPrefix (not the id).

import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import { AGENT_REGISTRY } from "@ibatexas/agents";

// Control the route's view of the plane via the bootstrap accessor. `vi.mock`
// is hoisted above module init, so the mock fn must be created via `vi.hoisted`.
const { getAgentKillSwitchManager } = vi.hoisted(() => ({
  getAgentKillSwitchManager: vi.fn(),
}));
vi.mock("../../claustrum-bootstrap.js", () => ({ getAgentKillSwitchManager }));

import { adminAgentKillSwitchRoutes } from "../admin/agents-kill-switch.js";

// The known agent from the real registry (findAgent runs against real data).
const KNOWN = AGENT_REGISTRY[0]!;
const UNKNOWN = "does-not-exist";

// Stand-in for the outer admin auth chain (optionalAuth + admin index guard):
// map test headers onto the exact request decorations requireManagerRole reads.
const AUTH_HEADERS = {
  staffId: "x-test-staff-id",
  staffRole: "x-test-staff-role",
  apiKeyRole: "x-test-api-key-role",
} as const;

function mockManager() {
  return {
    trip: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    isKilled: vi.fn((_ns: string) => false),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

async function build(manager: unknown) {
  getAgentKillSwitchManager.mockReturnValue(manager);
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (request) => {
    const h = request.headers;
    const r = request as unknown as {
      staffId?: string;
      staffRole?: string;
      adminApiKeyRole?: string;
    };
    const staffId = h[AUTH_HEADERS.staffId];
    const staffRole = h[AUTH_HEADERS.staffRole];
    const apiKeyRole = h[AUTH_HEADERS.apiKeyRole];
    if (typeof staffId === "string") r.staffId = staffId;
    if (typeof staffRole === "string") r.staffRole = staffRole;
    if (typeof apiKeyRole === "string") r.adminApiKeyRole = apiKeyRole;
  });
  await app.register(adminAgentKillSwitchRoutes);
  await app.ready();
  return app;
}

const AS_MANAGER = {
  [AUTH_HEADERS.staffId]: "staff_mgr",
  [AUTH_HEADERS.staffRole]: "MANAGER",
} as const;
const AS_ATTENDANT = {
  [AUTH_HEADERS.staffId]: "staff_att",
  [AUTH_HEADERS.staffRole]: "ATTENDANT",
} as const;

describe("admin agent kill-switch routes (BKL-098)", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("MANAGER+ gate (requireManagerRole) fail-closes before the manager", () => {
    it("ATTENDANT ⇒ 403 on kill / unkill / status; manager never consulted", async () => {
      const mgr = mockManager();
      const app = await build(mgr);
      const kill = await app.inject({
        method: "POST",
        url: `/api/admin/agents/${KNOWN.id}/kill`,
        headers: AS_ATTENDANT,
      });
      const unkill = await app.inject({
        method: "POST",
        url: `/api/admin/agents/${KNOWN.id}/unkill`,
        headers: AS_ATTENDANT,
      });
      const status = await app.inject({
        method: "GET",
        url: "/api/admin/agents/kill-status",
        headers: AS_ATTENDANT,
      });
      expect(kill.statusCode).toBe(403);
      expect(unkill.statusCode).toBe(403);
      expect(status.statusCode).toBe(403);
      expect(mgr.trip).not.toHaveBeenCalled();
      expect(mgr.clear).not.toHaveBeenCalled();
      expect(mgr.isKilled).not.toHaveBeenCalled();
      await app.close();
    });

    it("bare caller (no role) ⇒ 403", async () => {
      const app = await build(mockManager());
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/agents/${KNOWN.id}/kill`,
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  describe("POST kill → manager.trip", () => {
    it("trips the switch with the agent id + returns { killed: true }", async () => {
      const mgr = mockManager();
      const app = await build(mgr);
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/agents/${KNOWN.id}/kill`,
        headers: AS_MANAGER,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ agentId: KNOWN.id, killed: true });
      expect(mgr.trip).toHaveBeenCalledTimes(1);
      expect(mgr.trip).toHaveBeenCalledWith(KNOWN.id, expect.any(String));
      await app.close();
    });

    it("forwards an operator-supplied reason", async () => {
      const mgr = mockManager();
      const app = await build(mgr);
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/agents/${KNOWN.id}/kill`,
        headers: AS_MANAGER,
        payload: { reason: "runaway refunds" },
      });
      expect(res.statusCode).toBe(200);
      expect(mgr.trip).toHaveBeenCalledWith(KNOWN.id, "runaway refunds");
      await app.close();
    });

    it("unknown agentId ⇒ 404 and trip is NEVER called (no phantom trip)", async () => {
      const mgr = mockManager();
      const app = await build(mgr);
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/agents/${UNKNOWN}/kill`,
        headers: AS_MANAGER,
      });
      expect(res.statusCode).toBe(404);
      expect(mgr.trip).not.toHaveBeenCalled();
      await app.close();
    });

    it("is idempotent — a double kill returns 200 both times", async () => {
      const mgr = mockManager();
      const app = await build(mgr);
      const first = await app.inject({
        method: "POST",
        url: `/api/admin/agents/${KNOWN.id}/kill`,
        headers: AS_MANAGER,
      });
      const second = await app.inject({
        method: "POST",
        url: `/api/admin/agents/${KNOWN.id}/kill`,
        headers: AS_MANAGER,
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(mgr.trip).toHaveBeenCalledTimes(2);
      await app.close();
    });

    it("plane off (manager null) ⇒ 503, not 500", async () => {
      const app = await build(null);
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/agents/${KNOWN.id}/kill`,
        headers: AS_MANAGER,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ message: expect.stringContaining("indisponível") });
      await app.close();
    });
  });

  describe("POST unkill → manager.clear", () => {
    it("clears the switch + returns { killed: false }", async () => {
      const mgr = mockManager();
      const app = await build(mgr);
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/agents/${KNOWN.id}/unkill`,
        headers: AS_MANAGER,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ agentId: KNOWN.id, killed: false });
      expect(mgr.clear).toHaveBeenCalledWith(KNOWN.id);
      await app.close();
    });

    it("unknown agentId ⇒ 404, clear never called", async () => {
      const mgr = mockManager();
      const app = await build(mgr);
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/agents/${UNKNOWN}/unkill`,
        headers: AS_MANAGER,
      });
      expect(res.statusCode).toBe(404);
      expect(mgr.clear).not.toHaveBeenCalled();
      await app.close();
    });

    it("plane off ⇒ 503", async () => {
      const app = await build(null);
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/agents/${KNOWN.id}/unkill`,
        headers: AS_MANAGER,
      });
      expect(res.statusCode).toBe(503);
      await app.close();
    });
  });

  describe("GET kill-status", () => {
    it("lists the roster's killed state, reading isKilled by sessionIdPrefix", async () => {
      const mgr = mockManager();
      // Kill exactly the known agent's namespace to prove the id→prefix mapping.
      mgr.isKilled.mockImplementation((ns: string) => ns === KNOWN.sessionIdPrefix);
      const app = await build(mgr);
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/agents/kill-status",
        headers: AS_MANAGER,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { agents: Array<{ agentId: string; killed: boolean }> };
      expect(body.agents).toContainEqual({ agentId: KNOWN.id, killed: true });
      // isKilled was consulted with the NAMESPACE, never the bare id.
      expect(mgr.isKilled).toHaveBeenCalledWith(KNOWN.sessionIdPrefix);
      expect(mgr.isKilled).not.toHaveBeenCalledWith(KNOWN.id);
      await app.close();
    });

    it("?agentId= filters to one agent; unknown ⇒ 404", async () => {
      const mgr = mockManager();
      const app = await build(mgr);
      const one = await app.inject({
        method: "GET",
        url: `/api/admin/agents/kill-status?agentId=${KNOWN.id}`,
        headers: AS_MANAGER,
      });
      expect(one.statusCode).toBe(200);
      expect((one.json() as { agents: unknown[] }).agents).toHaveLength(1);
      const bad = await app.inject({
        method: "GET",
        url: `/api/admin/agents/kill-status?agentId=${UNKNOWN}`,
        headers: AS_MANAGER,
      });
      expect(bad.statusCode).toBe(404);
      await app.close();
    });

    it("plane off ⇒ 503", async () => {
      const app = await build(null);
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/agents/kill-status",
        headers: AS_MANAGER,
      });
      expect(res.statusCode).toBe(503);
      await app.close();
    });
  });
});
