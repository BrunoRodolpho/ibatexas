// AUT-007 adversarial-review FIX 1 — live-enforced role demotion.
//
// PINS: request.staffRole is sourced from the FRESH staff row on every request
// (middleware/auth.ts extractStaffAuth), NOT from the JWT `role` claim baked at
// login. Pre-fix, a `staff.role.assign` demotion was a NO-OP for up to the 8h
// staff-token TTL: the demoted OWNER's JWT kept minting OWNER power, letting
// them re-promote themselves or deactivate the demoter. Deactivation was
// already live (the row is re-fetched every request for `active`); this suite
// proves role changes are enforced SYMMETRICALLY through BOTH layers:
//
//   1. the route preHandler (`requireOwnerRole` 403s the demoted OWNER), and
//   2. the kernel actor.role seam (`resolveActorRole` yields the FRESH role, so
//      the REAL `staffRoleGuard` REFUSEs the demoted staffer's OWNER-only
//      staff.* envelope at the AUTH phase).
//
// Harness mirrors staff-middleware.test.ts (staff_token cookie + JSON-decoding
// jwt.staff.verify) with a per-test-controllable getById mock — the mock row IS
// the role authority, exactly like production Postgres.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import { buildEnvelope } from "@adjudicate/core";

const mockGetById = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

vi.mock("@ibatexas/domain", () => ({
  createStaffService: () => ({ getById: mockGetById }),
}));

type StaffTokenPayload = {
  sub: string;
  userType: "staff";
  role: "OWNER" | "MANAGER" | "ATTENDANT";
  jti?: string;
  aud?: string;
};

/** A staff JWT whose `role` claim was baked at LOGIN TIME (possibly stale). */
function staffCookie(payload: StaffTokenPayload): string {
  return JSON.stringify(payload);
}

async function buildTestServer() {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  app.decorateRequest("jwtVerify", async function () {
    throw new Error("no customer token");
  });
  app.decorateRequest("user", null as never);
  app.decorateRequest("customerId", undefined);
  app.decorateRequest("userType", undefined);
  app.decorateRequest("staffId", undefined);
  app.decorateRequest("staffRole", undefined);

  app.decorate("jwt", {
    verify(): never {
      throw new Error("customer instance must not verify staff tokens");
    },
    staff: {
      verify(token: string): StaffTokenPayload {
        return JSON.parse(token) as StaffTokenPayload;
      },
    },
  } as never);

  const { optionalAuth } = await import("../middleware/auth.js");
  const { requireOwnerRole, requireStaff } = await import("../middleware/staff-auth.js");
  const { resolveActorRole } = await import("../routes/admin/_shared-actions.js");

  // The OWNER-gated surface (mirrors every /api/admin/staff route).
  app.get(
    "/owner-only",
    { preHandler: [optionalAuth, requireOwnerRole] },
    async (request, reply) =>
      reply.send({ staffId: request.staffId, staffRole: request.staffRole }),
  );

  // Echoes the actor.role the admin routes would stamp into the kernel
  // envelope (via resolveActorRole → actorFor) — the value staffRoleGuard sees.
  app.get(
    "/actor-role-echo",
    { preHandler: [optionalAuth, requireStaff] },
    async (request, reply) =>
      reply.send({ actorRole: resolveActorRole(request) ?? null }),
  );

  await app.ready();
  return app;
}

/** The demoted staffer's request: JWT still claims OWNER, row says MANAGER. */
const DEMOTED_COOKIE = staffCookie({
  sub: "staff_demoted",
  userType: "staff",
  role: "OWNER", // stale login-time claim — must NOT be trusted
  jti: "jti_demoted",
  aud: "staff_token",
});

describe("FIX 1 — staff.role.assign demotion is live on the next request", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildTestServer();
  });
  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((k: string) => `test:${k}`);
    mockGetRedisClient.mockResolvedValue({ get: vi.fn(async () => null) });
  });

  it("a demoted OWNER (JWT says OWNER, row says MANAGER) is 403'd by requireOwnerRole", async () => {
    // The staff.role.assign demotion already landed: the ROW is MANAGER.
    mockGetById.mockResolvedValue({ id: "staff_demoted", active: true, role: "MANAGER" });

    const res = await server.inject({
      method: "GET",
      url: "/owner-only",
      cookies: { staff_token: DEMOTED_COOKIE },
    });

    expect(mockGetById).toHaveBeenCalledWith("staff_demoted");
    expect(res.statusCode).toBe(403); // NEW (lower) role enforced immediately
  });

  it("the demoted staffer's kernel actor.role is the FRESH row role, and staffRoleGuard REFUSEs their OWNER-only staff.* envelope", async () => {
    mockGetById.mockResolvedValue({ id: "staff_demoted", active: true, role: "MANAGER" });

    const res = await server.inject({
      method: "GET",
      url: "/actor-role-echo",
      cookies: { staff_token: DEMOTED_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    const { actorRole } = res.json() as { actorRole: string | null };
    // resolveActorRole (the value actorFor stamps on every admin envelope)
    // carries the fresh DB role, not the stale JWT claim.
    expect(actorRole).toBe("MANAGER");

    // Drive the REAL production guard with the envelope the routes would
    // build: the demoted staffer proposing an OWNER-only staff-CRUD verb.
    const { staffRoleGuard, STAFF_ROLE_REFUSAL_CODE } = await import(
      "../claustrum/staff-role-guard.js"
    );
    const envelope = buildEnvelope({
      kind: "staff.create",
      payload: { phone: "+5511999990001", name: "Novo", role: "ATTENDANT" },
      actor: {
        principal: "user" as const,
        sessionId: "admin:staff_demoted",
        role: actorRole as "MANAGER",
      },
      taint: "TRUSTED" as const,
      nonce: "n-demoted-create",
    });
    const decision = staffRoleGuard(envelope, {});
    expect(decision?.kind).toBe("REFUSE");
    if (decision?.kind === "REFUSE") {
      expect(decision.refusal.code).toBe(STAFF_ROLE_REFUSAL_CODE);
    }
  });

  it("control (non-vacuous): an aligned OWNER row passes requireOwnerRole", async () => {
    mockGetById.mockResolvedValue({ id: "staff_demoted", active: true, role: "OWNER" });

    const res = await server.inject({
      method: "GET",
      url: "/owner-only",
      cookies: { staff_token: DEMOTED_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { staffRole: string }).staffRole).toBe("OWNER");
  });

  it("symmetry: a PROMOTED staffer (JWT says ATTENDANT, row says OWNER) gains the new role immediately", async () => {
    mockGetById.mockResolvedValue({ id: "staff_promoted", active: true, role: "OWNER" });

    const res = await server.inject({
      method: "GET",
      url: "/owner-only",
      cookies: {
        staff_token: staffCookie({
          sub: "staff_promoted",
          userType: "staff",
          role: "ATTENDANT", // stale claim from before the promotion
          jti: "jti_promoted",
          aud: "staff_token",
        }),
      },
    });
    // DB is authoritative in BOTH directions — the row role governs.
    expect(res.statusCode).toBe(200);
    expect((res.json() as { staffRole: string }).staffRole).toBe("OWNER");
  });
});
