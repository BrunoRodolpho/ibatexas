// Unit tests for admin product routes — P0-X9 follow-up.
//
// Coverage:
//   - PATCH /api/admin/products/:id routes its write through
//     `medusaAdjudicated()` (NOT the bare `medusaAdmin()` transport).
//   - The envelope shape (scope, method, path, intentKind, sourceSubject)
//     is captured for audit.
//   - REFUSE / DEFER / NEEDS_REVIEW error classes are mapped to
//     pt-BR HTTP responses.
//
// This is the anti-theater assertion paired with the migration: the test
// passes ONLY when the route actually goes through `medusaAdjudicated`.
// If a future refactor accidentally reverts to `medusaAdmin(method:
// "POST")`, this suite fails AND the bypass-detection multi-line scan
// catches the offender independently.

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import { productRoutes } from "../products.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((k: string) => `ibatexas:${k}`));
const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockMedusaAdjudicated = vi.hoisted(() => vi.fn());
const MockRefusedError = vi.hoisted(() =>
  class extends Error {
    code: string;
    userFacing: string;
    constructor(opts: { code: string; userFacing: string }) {
      super(`Refused: ${opts.code}`);
      this.name = "MedusaAdjudicateRefusedError";
      this.code = opts.code;
      this.userFacing = opts.userFacing;
    }
  },
);
const MockDeferredError = vi.hoisted(() =>
  class extends Error {
    signal: string;
    constructor(opts: { signal: string }) {
      super(`Deferred: ${opts.signal}`);
      this.name = "MedusaAdjudicateDeferredError";
      this.signal = opts.signal;
    }
  },
);
const MockNeedsReviewError = vi.hoisted(() =>
  class extends Error {
    constructor() {
      super("NeedsReview");
      this.name = "MedusaAdjudicateNeedsReviewError";
    }
  },
);

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  medusaAdmin: mockMedusaAdmin,
  medusaAdjudicated: mockMedusaAdjudicated,
  MedusaAdjudicateRefusedError: MockRefusedError,
  MedusaAdjudicateDeferredError: MockDeferredError,
  MedusaAdjudicateNeedsReviewError: MockNeedsReviewError,
}));

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: vi.fn(async () => undefined) }),
}));

vi.mock("../../../middleware/staff-auth.js", () => ({
  requireManagerRole: (
    request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ) => {
    request.staffId = (request.headers["x-staff-id"] as string | undefined) ?? "staff_001";
    request.staffRole = "MANAGER";
    done();
  },
}));

vi.mock("../_shared.js", () => ({
  medusaAdmin: mockMedusaAdmin,
}));

// ── Server factory ─────────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(productRoutes);
  await app.ready();
  return app;
}

function createMockRedis() {
  return {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("PATCH /api/admin/products/:id — P0-X9 migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  });

  it("routes the write through medusaAdjudicated (NOT bare medusaAdmin POST)", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockResolvedValue({
      product: { id: "prod_01", title: "Costela updated" },
    });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/products/prod_01",
      payload: { status: "published" },
      headers: { "x-staff-id": "staff_42" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().product.id).toBe("prod_01");

    // medusaAdjudicated is called with the kernel-gated envelope shape.
    expect(mockMedusaAdjudicated).toHaveBeenCalledTimes(1);
    const args = mockMedusaAdjudicated.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      scope: "admin",
      method: "POST",
      path: "/admin/products/prod_01",
      intentKind: "medusa.admin.product.update",
      payload: { status: "published" },
    });
    expect(args.sourceSubject).toContain("route:PATCH /api/admin/products/:id");
    expect(args.sourceSubject).toContain("staff_42");
    expect(args.idempotencyKey).toBeDefined();

    // The bare medusaAdmin transport MUST NOT have been called for this mutation.
    expect(mockMedusaAdmin).not.toHaveBeenCalled();
  });

  it("forwards x-request-id as the idempotency key", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockResolvedValue({ product: { id: "prod_01" } });

    const app = await buildTestServer();
    await app.inject({
      method: "PATCH",
      url: "/api/admin/products/prod_01",
      payload: { status: "draft" },
      headers: { "x-request-id": "req-abc-123", "x-staff-id": "staff_42" },
    });

    const args = mockMedusaAdjudicated.mock.calls[0]?.[0];
    expect(args.idempotencyKey).toBe("req-abc-123");
  });

  it("returns 403 with pt-BR copy when the kernel REFUSES", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockRejectedValue(
      new MockRefusedError({
        code: "product.update.invalid",
        userFacing: "Não é permitido alterar este produto.",
      }),
    );

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/products/prod_01",
      payload: { status: "draft" },
      headers: { "x-staff-id": "staff_42" },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("Não é permitido alterar este produto.");
    expect(body.code).toBe("product.update.invalid");
  });

  it("returns 202 when the kernel DEFERS the egress", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockRejectedValue(
      new MockDeferredError({ signal: "manager.confirmation" }),
    );

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/products/prod_01",
      payload: { status: "draft" },
      headers: { "x-staff-id": "staff_42" },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("deferred");
    expect(body.signal).toBe("manager.confirmation");
  });

  it("returns 503 when the kernel needs human review", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMedusaAdjudicated.mockRejectedValue(new MockNeedsReviewError());

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/products/prod_01",
      payload: { status: "draft" },
      headers: { "x-staff-id": "staff_42" },
    });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toContain("atendimento humano");
  });

  it("returns 409 when x-request-id collides with a recently-processed request", async () => {
    // SET NX returns null → duplicate
    const mockRedis = createMockRedis();
    mockRedis.set = vi.fn().mockResolvedValue(null);
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/admin/products/prod_01",
      payload: { status: "draft" },
      headers: { "x-request-id": "req-collide", "x-staff-id": "staff_42" },
    });

    expect(res.statusCode).toBe(409);
    // Adjudicate path MUST NOT run for duplicates
    expect(mockMedusaAdjudicated).not.toHaveBeenCalled();
  });
});
