// W4 P1-H — API-key fail-closed tests for staff-auth role gates.
//
// Pre-W4 `requireManagerRole` was a no-op when no JWT was present —
// any holder of ADMIN_API_KEY had unbounded mutation power. W4 adds an
// API-key role registry; an API key with no role mapping fails-closed
// on `requireManagerRole` / `requireOwnerRole`.

import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { requireManagerRole, requireOwnerRole } from "../middleware/staff-auth.js";

// ── Server factory ────────────────────────────────────────────────────────

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorateRequest("staffId", undefined);
  app.decorateRequest("staffRole", undefined);
  app.decorateRequest("adminApiKeyRole", undefined);

  // Mount routes guarded by the role gates under test.
  app.post(
    "/admin/manager-only",
    { preHandler: requireManagerRole },
    async () => ({ ok: true, gate: "manager" }),
  );
  app.post(
    "/admin/owner-only",
    { preHandler: requireOwnerRole },
    async () => ({ ok: true, gate: "owner" }),
  );

  // Inject identity simulators — the real admin guard sets these
  // fields; in this test we set them directly via headers to keep the
  // test surface narrow.
  app.addHook("preHandler", async (request) => {
    const staffRole = request.headers["x-test-staff-role"];
    if (typeof staffRole === "string" && staffRole.length > 0) {
      request.staffId = "staff_test";
      request.staffRole = staffRole as "OWNER" | "MANAGER" | "ATTENDANT";
    }
    const apiRole = request.headers["x-test-api-key-role"];
    if (apiRole === "OWNER" || apiRole === "MANAGER") {
      request.adminApiKeyRole = apiRole;
    }
  });

  await app.ready();
  return app;
}

describe("P1-H — requireManagerRole fail-closed", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    if (app) await app.close();
    app = await buildServer();
  });

  it("[P1-H] passes with staff JWT MANAGER role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/manager-only",
      headers: { "x-test-staff-role": "MANAGER" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("[P1-H] passes with staff JWT OWNER role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/manager-only",
      headers: { "x-test-staff-role": "OWNER" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("[P1-H] refuses staff JWT with ATTENDANT role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/manager-only",
      headers: { "x-test-staff-role": "ATTENDANT" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("gerentes");
  });

  it("[P1-H] passes with API-key registry-mapped MANAGER role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/manager-only",
      headers: { "x-test-api-key-role": "MANAGER" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("[P1-H] passes with API-key registry-mapped OWNER role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/manager-only",
      headers: { "x-test-api-key-role": "OWNER" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("[P1-H] FAIL-CLOSED — API key without registry role gets 403 (regression: pre-W4 passed)", async () => {
    // Empty headers — no JWT, no registry role. Pre-W4 this passed
    // (the gate was a no-op for non-JWT callers).
    const res = await app.inject({
      method: "POST",
      url: "/admin/manager-only",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("chave de API sem permissão");
  });
});

describe("P1-H — requireOwnerRole fail-closed", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    if (app) await app.close();
    app = await buildServer();
  });

  it("[P1-H] passes with staff JWT OWNER role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/owner-only",
      headers: { "x-test-staff-role": "OWNER" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("[P1-H] refuses staff JWT MANAGER (OWNER-only route)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/owner-only",
      headers: { "x-test-staff-role": "MANAGER" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("proprietário");
  });

  it("[P1-H] passes with API-key OWNER role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/owner-only",
      headers: { "x-test-api-key-role": "OWNER" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("[P1-H] refuses API-key MANAGER role (OWNER-only route)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/owner-only",
      headers: { "x-test-api-key-role": "MANAGER" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("proprietário");
  });

  it("[P1-H] FAIL-CLOSED — API key without registry role gets 403 on OWNER route", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/owner-only",
    });
    expect(res.statusCode).toBe(403);
  });
});
