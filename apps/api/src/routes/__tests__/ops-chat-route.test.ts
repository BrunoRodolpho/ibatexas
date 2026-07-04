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

// BKL-084 — the ops-history store is mocked so the route touches no Redis and the
// appends/reads are spy-able.
const { appendOpsMessages, buildOpsHistoryBlock, loadOpsHistory } = vi.hoisted(() => ({
  appendOpsMessages: vi.fn(async () => {}),
  buildOpsHistoryBlock: vi.fn(async () => undefined as string | undefined),
  loadOpsHistory: vi.fn(async () => [] as Array<{ role: string; content: string }>),
}));
vi.mock("../../ops/ops-history.js", () => ({
  appendOpsMessages,
  buildOpsHistoryBlock,
  loadOpsHistory,
}));

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

// ── BKL-084 — conversation history: persist around the turn + thread the block ──

describe("POST /api/admin/ops/chat — history persistence (BKL-084)", () => {
  beforeEach(() => vi.clearAllMocks());

  /** A spy-able factory returning a no-op conductor (capsule stub). */
  function stubFactory() {
    const factoryFn = vi.fn(() => ({
      openCapsule: vi.fn(async () => ({ id: "capsule" })),
      closeCapsule: vi.fn(async () => {}),
    }));
    getOpsConductorFactory.mockReturnValue(factoryFn);
    return factoryFn;
  }

  const OK_TURN = {
    response: { text: "Feito." },
    decision: { kind: "EXECUTE" },
    acted: { kind: "executed" },
    plan: { envelopes: [] as Array<{ kind: string }> },
  };

  it("appends the user message BEFORE the turn and the assistant reply AFTER", async () => {
    stubFactory();
    handleTurn.mockResolvedValue(OK_TURN);
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ops/chat",
      payload: { message: "acabou a picanha" },
      headers: AS_OWNER,
    });
    expect(res.statusCode).toBe(200);
    // The context block is built BEFORE the user message is appended (so the live
    // message is the inbound, not a duplicated history line).
    expect(buildOpsHistoryBlock).toHaveBeenCalledWith("staff_1");
    expect(appendOpsMessages).toHaveBeenCalledTimes(2);
    expect(appendOpsMessages).toHaveBeenNthCalledWith(1, "staff_1", [
      { role: "user", content: "acabou a picanha" },
    ]);
    expect(appendOpsMessages).toHaveBeenNthCalledWith(2, "staff_1", [
      { role: "assistant", content: "Feito." },
    ]);
    await app.close();
  });

  it("threads a rendered history block into the conductor factory", async () => {
    const factoryFn = stubFactory();
    buildOpsHistoryBlock.mockResolvedValueOnce("### HISTÓRICO ... ###");
    handleTurn.mockResolvedValue(OK_TURN);
    const app = await build();
    await app.inject({
      method: "POST",
      url: "/api/admin/ops/chat",
      payload: { message: "e o brisket?" },
      headers: AS_OWNER,
    });
    expect(factoryFn).toHaveBeenCalledWith(
      { staffId: "staff_1", role: "OWNER" },
      { historyBlock: "### HISTÓRICO ... ###" },
    );
    await app.close();
  });

  it("omits historyBlock when there is no prior context", async () => {
    const factoryFn = stubFactory();
    buildOpsHistoryBlock.mockResolvedValueOnce(undefined);
    handleTurn.mockResolvedValue(OK_TURN);
    const app = await build();
    await app.inject({
      method: "POST",
      url: "/api/admin/ops/chat",
      payload: { message: "oi" },
      headers: AS_OWNER,
    });
    expect(factoryFn).toHaveBeenCalledWith({ staffId: "staff_1", role: "OWNER" }, {});
    await app.close();
  });

  it("a user-message append failure is non-fatal — the turn still returns 200", async () => {
    stubFactory();
    appendOpsMessages.mockRejectedValueOnce(new Error("redis down")); // 1st call (user)
    handleTurn.mockResolvedValue(OK_TURN);
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ops/chat",
      payload: { message: "acabou a picanha" },
      headers: AS_OWNER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toBe("Feito.");
    await app.close();
  });

  it("an assistant-reply append failure is non-fatal — the turn still returns 200", async () => {
    stubFactory();
    // 1st append (user) resolves, 2nd append (assistant) rejects.
    appendOpsMessages
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("redis down"));
    handleTurn.mockResolvedValue(OK_TURN);
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ops/chat",
      payload: { message: "acabou a picanha" },
      headers: AS_OWNER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toBe("Feito.");
    expect(appendOpsMessages).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("does NOT persist an assistant reply when the turn throws (502)", async () => {
    stubFactory();
    handleTurn.mockRejectedValue(new Error("kernel exploded"));
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/ops/chat",
      payload: { message: "acabou a picanha" },
      headers: AS_OWNER,
    });
    expect(res.statusCode).toBe(502);
    // Only the pre-turn user append ran; no assistant append on a failed turn.
    expect(appendOpsMessages).toHaveBeenCalledTimes(1);
    expect(appendOpsMessages).toHaveBeenCalledWith("staff_1", [
      { role: "user", content: "acabou a picanha" },
    ]);
    await app.close();
  });
});

describe("GET /api/admin/ops/chat/history (BKL-084)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("403 without a staff JWT (customer/anon)", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/api/admin/ops/chat/history" });
    expect(res.statusCode).toBe(403);
    expect(loadOpsHistory).not.toHaveBeenCalled();
    await app.close();
  });

  it("200 returns the caller's persisted thread { messages, count }", async () => {
    loadOpsHistory.mockResolvedValueOnce([
      { role: "user", content: "quantas costelas?" },
      { role: "assistant", content: "temos 12" },
    ]);
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/ops/chat/history",
      headers: AS_OWNER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      messages: [
        { role: "user", content: "quantas costelas?" },
        { role: "assistant", content: "temos 12" },
      ],
      count: 2,
    });
    // Scoped to the authenticated staffId — never a query param.
    expect(loadOpsHistory).toHaveBeenCalledWith("staff_1");
    await app.close();
  });

  it("returns an empty thread when the store read fails (best-effort hydrate)", async () => {
    loadOpsHistory.mockRejectedValueOnce(new Error("redis down"));
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/ops/chat/history",
      headers: AS_OWNER,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messages: [], count: 0 });
    await app.close();
  });
});
