// ops-chat route (NEW-032 slice B) — the ingress contract in isolation:
//   - 403 without a staff JWT (customer/anon: requireStaff fail-closed);
//   - 200 happy path with the {reply, decision, executed, proposedKinds} shape;
//   - a conductor throw → 502 with an honest pt-BR body (never fabricated success).
//
// The conductor factory is mocked via the bootstrap accessor; the admin auth
// chain (optionalAuth + index guard populating request.staffId/staffRole) is
// stood in for with an instance-level preHandler mapping test headers.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";

const { getOpsConductorFactory } = vi.hoisted(() => ({
  getOpsConductorFactory: vi.fn(),
}));
vi.mock("../../claustrum-bootstrap.js", () => ({ getOpsConductorFactory }));

import { adminOpsChatRoutes } from "../admin/ops-chat.js";

const AUTH_HEADERS = {
  staffId: "x-test-staff-id",
  staffRole: "x-test-staff-role",
} as const;

const AS_OWNER = {
  [AUTH_HEADERS.staffId]: "staff_1",
  [AUTH_HEADERS.staffRole]: "OWNER",
} as const;

// Mock @claustrum/core's handleTurn so the route's turn result is scriptable.
const { handleTurn } = vi.hoisted(() => ({ handleTurn: vi.fn() }));
vi.mock("@claustrum/core", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, handleTurn };
});

async function build() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (request) => {
    const h = request.headers;
    const r = request as unknown as { staffId?: string; staffRole?: string };
    if (typeof h[AUTH_HEADERS.staffId] === "string") r.staffId = h[AUTH_HEADERS.staffId] as string;
    if (typeof h[AUTH_HEADERS.staffRole] === "string") r.staffRole = h[AUTH_HEADERS.staffRole] as string;
  });
  await app.register(adminOpsChatRoutes);
  await app.ready();
  return app;
}

describe("POST /api/admin/ops/chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("403 without a staff JWT (customer/anon)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ops/chat",
      payload: { message: "acabou a picanha" },
      // no staff headers → requireStaff 403
    });
    expect(res.statusCode).toBe(403);
    expect(getOpsConductorFactory).not.toHaveBeenCalled();
    await app.close();
  });

  it("400 on an empty message (zod, pt-BR)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ops/chat",
      payload: { message: "   " },
      headers: AS_OWNER,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("200 happy path returns {reply, decision, executed, proposedKinds}", async () => {
    const close = vi.fn(async () => {});
    getOpsConductorFactory.mockReturnValue((actor: { staffId: string; role: string }) => {
      expect(actor).toEqual({ staffId: "staff_1", role: "OWNER" });
      return {
        openCapsule: vi.fn(async () => ({ id: "capsule" })),
        closeCapsule: close,
      };
    });
    handleTurn.mockResolvedValue({
      response: { text: "Marquei a picanha como indisponível." },
      decision: { kind: "EXECUTE" },
      acted: { kind: "executed" },
      plan: { envelopes: [{ kind: "product.availability.set" }] },
    });

    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ops/chat",
      payload: { message: "acabou a picanha" },
      headers: AS_OWNER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      reply: "Marquei a picanha como indisponível.",
      decision: "EXECUTE",
      executed: true,
      proposedKinds: ["product.availability.set"],
    });
    expect(close).toHaveBeenCalledTimes(1); // closeCapsule ran in finally
    await app.close();
  });

  it("REFUSE surfaces decision + executed:false", async () => {
    getOpsConductorFactory.mockReturnValue(() => ({
      openCapsule: vi.fn(async () => ({ id: "capsule" })),
      closeCapsule: vi.fn(async () => {}),
    }));
    handleTurn.mockResolvedValue({
      response: { text: "Ação não disponível." },
      decision: { kind: "REFUSE" },
      acted: { kind: "refused" },
      plan: { envelopes: [{ kind: "product.availability.set" }] },
    });
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ops/chat",
      payload: { message: "tira o X" },
      headers: AS_OWNER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toBe("REFUSE");
    expect(res.json().executed).toBe(false);
    await app.close();
  });

  it("503 when the ops conductor factory is unavailable (bootstrap not run)", async () => {
    getOpsConductorFactory.mockImplementation(() => {
      throw new Error("Ops conductor factory not initialized.");
    });
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ops/chat",
      payload: { message: "acabou a picanha" },
      headers: AS_OWNER,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/indisponível/i);
    await app.close();
  });

  it("a conductor throw → 502 with an honest pt-BR body (never fabricated success)", async () => {
    const close = vi.fn(async () => {});
    getOpsConductorFactory.mockReturnValue(() => ({
      openCapsule: vi.fn(async () => ({ id: "capsule" })),
      closeCapsule: close,
    }));
    handleTurn.mockRejectedValue(new Error("kernel exploded"));

    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ops/chat",
      payload: { message: "acabou a picanha" },
      headers: AS_OWNER,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/não consegui|tente novamente/i);
    expect(close).toHaveBeenCalledTimes(1); // closeCapsule still ran in finally
    await app.close();
  });
});
