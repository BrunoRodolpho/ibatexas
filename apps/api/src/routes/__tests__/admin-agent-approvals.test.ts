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

async function build(gateway: unknown) {
  getAgentApprovalGateway.mockReturnValue(gateway);
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(adminAgentApprovalRoutes);
  await app.ready();
  return app;
}

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
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/agent-approvals/tok-1/resolve",
        payload: { accept: true },
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
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("approval not found");
      await app.close();
    });

    it("rejects a malformed body (accept missing) via the zod schema", async () => {
      const app = await build(stubGateway());
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/agent-approvals/tok-1/resolve",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });
});
