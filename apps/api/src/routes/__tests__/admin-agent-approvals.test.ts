// WS-D1: the staff HTTP surface for Stage-1 agent approvals
// (routes/admin/agent-approvals.ts). These cases prove the route's contract in
// isolation: it 404s when the managed-agent plane is off (gateway null),
// proxies list/get against the engine, and maps engine errors to 400. The
// resolve→EXECUTE lineage itself is the engine's concern (covered by the
// engine-level agent-approvals.test.ts); here we prove the wire.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";

// Control the route's view of the plane via the bootstrap accessor. `vi.mock`
// is hoisted above module init, so the mock fn must be created via `vi.hoisted`.
const { getAgentApprovalGateway } = vi.hoisted(() => ({ getAgentApprovalGateway: vi.fn() }));
vi.mock("../../claustrum-bootstrap.js", () => ({ getAgentApprovalGateway }));

import { adminAgentApprovalRoutes } from "../admin/agent-approvals.js";

// The resolve route's `requireManagerRole` preHandler reads request.staffId /
// staffRole (JWT path) and request.adminApiKeyRole (registry-key path) — in
// production those are populated by optionalAuth + the admin index guard
// (routes/admin/index.ts) BEFORE the route preHandler runs. This isolated route
// test registers only `adminAgentApprovalRoutes`, so we stand in for that outer
// chain with an instance-level preHandler that maps test headers onto those
// exact decorations. It sets nothing when the headers are absent (bare/unmapped
// caller), so `requireManagerRole` sees the same request shape it would in prod.
const AUTH_HEADERS = {
  staffId: "x-test-staff-id",
  staffRole: "x-test-staff-role",
  apiKeyRole: "x-test-api-key-role",
} as const;

async function build(gateway: unknown) {
  getAgentApprovalGateway.mockReturnValue(gateway);
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Instance-level preHandler runs before the route-level requireManagerRole.
  app.addHook("preHandler", async (request) => {
    const h = request.headers;
    const staffId = h[AUTH_HEADERS.staffId];
    const staffRole = h[AUTH_HEADERS.staffRole];
    const apiKeyRole = h[AUTH_HEADERS.apiKeyRole];
    const r = request as unknown as {
      staffId?: string;
      staffRole?: string;
      adminApiKeyRole?: string;
    };
    if (typeof staffId === "string") r.staffId = staffId;
    if (typeof staffRole === "string") r.staffRole = staffRole;
    if (typeof apiKeyRole === "string") r.adminApiKeyRole = apiKeyRole;
  });
  await app.register(adminAgentApprovalRoutes);
  await app.ready();
  return app;
}

/** Header sets for the resolve-route role gate (see build() above). */
const AS_MANAGER = {
  [AUTH_HEADERS.staffId]: "staff_mgr",
  [AUTH_HEADERS.staffRole]: "MANAGER",
} as const;
const AS_OWNER = {
  [AUTH_HEADERS.staffId]: "staff_owner",
  [AUTH_HEADERS.staffRole]: "OWNER",
} as const;
const AS_ATTENDANT = {
  [AUTH_HEADERS.staffId]: "staff_att",
  [AUTH_HEADERS.staffRole]: "ATTENDANT",
} as const;
const AS_API_KEY_OWNER = { [AUTH_HEADERS.apiKeyRole]: "OWNER" } as const;
const AS_API_KEY_MANAGER = { [AUTH_HEADERS.apiKeyRole]: "MANAGER" } as const;

function stubGateway() {
  return {
    list: vi.fn((filter?: { status?: string }) => [
      { token: "tok-1", status: filter?.status ?? "pending", intentKind: "payment.pix.regenerate" },
    ]),
    get: vi.fn((token: string) =>
      token === "tok-1" ? { token: "tok-1", status: "pending" } : null,
    ),
    resolve: vi.fn(async ({ token, accepted }: { token: string; accepted: boolean }) => ({
      request: { token, status: accepted ? "approved" : "rejected" },
      decision: { kind: "EXECUTE" },
    })),
  };
}

describe("admin agent-approvals route (WS-D1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("plane off (gateway null) → 404 on every route", () => {
    it("GET list / GET :token / POST resolve all 404", async () => {
      const app = await build(null);
      expect((await app.inject({ method: "GET", url: "/api/admin/agent-approvals" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/admin/agent-approvals/tok-1" })).statusCode).toBe(404);
      // An AUTHORIZED (manager) caller still gets 404 when the plane is off —
      // requireManagerRole passes, then the handler's null-gateway check 404s.
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/agent-approvals/tok-1/resolve",
        payload: { accept: true },
        headers: AS_MANAGER,
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });
  });

  describe("plane on → proxies the engine", () => {
    it("lists approvals (and forwards the status filter)", async () => {
      const gw = stubGateway();
      const app = await build(gw);
      const res = await app.inject({ method: "GET", url: "/api/admin/agent-approvals?status=pending" });
      expect(res.statusCode).toBe(200);
      expect(res.json().approvals).toHaveLength(1);
      expect(gw.list).toHaveBeenCalledWith({ status: "pending" });
      await app.close();
    });

    it("returns one approval, 404 for an unknown token", async () => {
      const app = await build(stubGateway());
      expect((await app.inject({ method: "GET", url: "/api/admin/agent-approvals/tok-1" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/admin/agent-approvals/nope" })).statusCode).toBe(404);
      await app.close();
    });

    it("resolves (accept) → returns the decision kind", async () => {
      const gw = stubGateway();
      const app = await build(gw);
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/agent-approvals/tok-1/resolve",
        payload: { accept: true },
        headers: AS_MANAGER,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().decision).toEqual({ kind: "EXECUTE" });
      expect(gw.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ token: "tok-1", accepted: true }),
      );
      await app.close();
    });

    it("maps an engine error (unknown/expired token) to 400", async () => {
      const gw = stubGateway();
      gw.resolve.mockRejectedValueOnce(new Error("approval not found"));
      const app = await build(gw);
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/agent-approvals/stale/resolve",
        payload: { accept: false },
        headers: AS_MANAGER,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("approval not found");
      await app.close();
    });

    it("rejects a malformed body (accept missing) via the zod schema", async () => {
      const app = await build(stubGateway());
      // Schema validation (preValidation) runs BEFORE the requireManagerRole
      // preHandler, so a malformed body 400s regardless of role — authorize the
      // caller so the assertion isolates the schema rejection, not the gate.
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/agent-approvals/tok-1/resolve",
        payload: {},
        headers: AS_MANAGER,
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  // ── BKL-069 Part D — resolve is a MANAGER+ act (SCN-120) ─────────────────────
  describe("resolve role gate (requireManagerRole preHandler)", () => {
    async function injectResolve(app: Awaited<ReturnType<typeof build>>, headers: Record<string, string>) {
      return app.inject({
        method: "POST",
        url: "/api/admin/agent-approvals/tok-1/resolve",
        payload: { accept: true },
        headers,
      });
    }

    it("ATTENDANT JWT ⇒ 403, gateway never consulted", async () => {
      const gw = stubGateway();
      const app = await build(gw);
      const res = await injectResolve(app, AS_ATTENDANT);
      expect(res.statusCode).toBe(403);
      expect(gw.resolve).not.toHaveBeenCalled();
      await app.close();
    });

    it("MANAGER JWT ⇒ resolve proceeds (200)", async () => {
      const gw = stubGateway();
      const app = await build(gw);
      const res = await injectResolve(app, AS_MANAGER);
      expect(res.statusCode).toBe(200);
      expect(gw.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ token: "tok-1", accepted: true }),
      );
      await app.close();
    });

    it("OWNER JWT ⇒ resolve proceeds (200)", async () => {
      const gw = stubGateway();
      const app = await build(gw);
      const res = await injectResolve(app, AS_OWNER);
      expect(res.statusCode).toBe(200);
      expect(gw.resolve).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("registry OWNER API key ⇒ resolve proceeds (200)", async () => {
      const gw = stubGateway();
      const app = await build(gw);
      const res = await injectResolve(app, AS_API_KEY_OWNER);
      expect(res.statusCode).toBe(200);
      expect(gw.resolve).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("registry MANAGER API key ⇒ resolve proceeds (200)", async () => {
      const gw = stubGateway();
      const app = await build(gw);
      const res = await injectResolve(app, AS_API_KEY_MANAGER);
      expect(res.statusCode).toBe(200);
      expect(gw.resolve).toHaveBeenCalledTimes(1);
      await app.close();
    });

    it("unmapped / bare key (no staff role, no api-key role) ⇒ 403", async () => {
      const gw = stubGateway();
      const app = await build(gw);
      const res = await injectResolve(app, {});
      expect(res.statusCode).toBe(403);
      expect(gw.resolve).not.toHaveBeenCalled();
      await app.close();
    });
  });
});
