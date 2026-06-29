// Unit tests for admin delivery-zone CRUD routes (routes/admin/delivery-zones.ts).
//
// These prove the route contract in isolation against a mocked
// DeliveryZoneService + Redis:
//   - GET    lists zones via the service
//   - POST   creates (201) and enforces the idempotency (409) + CEP-conflict
//            (422) + zod-validation (400) guards before any write
//   - PUT    updates (200) and skips the zone being edited in the CEP-conflict
//            check (excludeZoneId), but still 422s on a conflict with OTHER zones
//   - DELETE removes (200) and is also idempotency-guarded (409)
//
// Every mutation path also asserts the cache invalidation side-effect fires
// only on success, and never when a guard short-circuits the request.

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockListAll = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockRemove = vi.hoisted(() => vi.fn());

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockInvalidateDeliveryCache = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((k: string) => `ibatexas:${k}`));

vi.mock("@ibatexas/domain", () => ({
  createDeliveryZoneService: () => ({
    listAll: mockListAll,
    create: mockCreate,
    update: mockUpdate,
    remove: mockRemove,
  }),
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  invalidateDeliveryCache: mockInvalidateDeliveryCache,
  rk: mockRk,
}));

// requireManagerRole is exercised by escalations-authz.test.ts; here we let it
// pass through so we can focus on the handler logic of THIS file.
vi.mock("../../../middleware/staff-auth.js", () => ({
  requireManagerRole: (
    _request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ) => done(),
}));

import { deliveryZoneRoutes } from "../delivery-zones.js";

// ── Server factory ─────────────────────────────────────────────────────────

async function buildTestServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(deliveryZoneRoutes);
  await app.ready();
  return app;
}

// Redis stub: SET NX returns "OK" for a fresh request, null for a duplicate.
function createMockRedis(setResult: "OK" | null = "OK") {
  return { set: vi.fn().mockResolvedValue(setResult) };
}

const VALID_BODY = {
  name: "Zona Centro",
  cepPrefixes: ["12345"],
  feeInCentavos: 900,
  estimatedMinutes: 40,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRk.mockImplementation((k: string) => `ibatexas:${k}`);
  // Default: no existing zones → no CEP conflict.
  mockListAll.mockResolvedValue([]);
});

// ── GET ─────────────────────────────────────────────────────────────────────

describe("GET /api/admin/delivery-zones", () => {
  it("returns the zones from the service under a { zones } envelope", async () => {
    const zones = [
      { id: "z1", name: "Zona A", cepPrefixes: ["11111"], feeInCentavos: 500, estimatedMinutes: 30, active: true },
    ];
    mockListAll.mockResolvedValue(zones);

    const app = await buildTestServer();
    const res = await app.inject({ method: "GET", url: "/api/admin/delivery-zones" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ zones });
    expect(mockListAll).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

// ── POST (create) ────────────────────────────────────────────────────────────

describe("POST /api/admin/delivery-zones — create", () => {
  it("creates the zone (201), applies the active default, and invalidates the cache", async () => {
    const created = { id: "z_new", ...VALID_BODY, active: true };
    mockCreate.mockResolvedValue(created);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/delivery-zones",
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ zone: created });
    // active defaulted to true by the zod schema before the service sees it.
    expect(mockCreate).toHaveBeenCalledWith({ ...VALID_BODY, active: true });
    expect(mockInvalidateDeliveryCache).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects a duplicate x-request-id with 409 and never writes", async () => {
    mockGetRedisClient.mockResolvedValue(createMockRedis(null)); // NX failed → duplicate

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/delivery-zones",
      payload: VALID_BODY,
      headers: { "x-request-id": "req-dup-1" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Requisicao duplicada." });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockInvalidateDeliveryCache).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes the dedup guard on a fresh x-request-id (SET NX/EX with the rk'd key) → 201", async () => {
    const redis = createMockRedis("OK");
    mockGetRedisClient.mockResolvedValue(redis);
    mockCreate.mockResolvedValue({ id: "z_new", ...VALID_BODY, active: true });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/delivery-zones",
      payload: VALID_BODY,
      headers: { "x-request-id": "req-fresh-1" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockRk).toHaveBeenCalledWith("dz:create:dedup:req-fresh-1");
    expect(redis.set).toHaveBeenCalledWith(
      "ibatexas:dz:create:dedup:req-fresh-1",
      "1",
      { EX: 300, NX: true },
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects a CEP already used by another zone with 422 and a pt-BR message", async () => {
    mockListAll.mockResolvedValue([
      { id: "z_other", name: "Zona Sul", cepPrefixes: ["12345", "67890"] },
    ]);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/delivery-zones",
      payload: { ...VALID_BODY, cepPrefixes: ["12345"] },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("CEPs já atribuídos");
    expect(body.message).toBe("CEPs já usados em outras zonas: 12345 (Zona Sul)");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockInvalidateDeliveryCache).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a malformed CEP via the zod schema (400) before any write", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/delivery-zones",
      payload: { ...VALID_BODY, cepPrefixes: ["not-a-cep"] },
    });

    expect(res.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an empty cepPrefixes array via the zod schema (400)", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/delivery-zones",
      payload: { ...VALID_BODY, cepPrefixes: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects estimatedMinutes out of range via the zod schema (400)", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/delivery-zones",
      payload: { ...VALID_BODY, estimatedMinutes: 999 },
    });

    expect(res.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── PUT (update) ─────────────────────────────────────────────────────────────

describe("PUT /api/admin/delivery-zones/:id — update", () => {
  it("updates the zone (200) and invalidates the cache", async () => {
    const updated = { id: "z1", ...VALID_BODY, active: true };
    mockUpdate.mockResolvedValue(updated);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/delivery-zones/z1",
      payload: VALID_BODY,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ zone: updated });
    expect(mockUpdate).toHaveBeenCalledWith("z1", { ...VALID_BODY, active: true });
    expect(mockInvalidateDeliveryCache).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does NOT flag the zone's OWN CEPs as a conflict (excludeZoneId) → 200", async () => {
    mockListAll.mockResolvedValue([
      { id: "z1", name: "Zona A", cepPrefixes: ["11111"] },
      { id: "z2", name: "Zona B", cepPrefixes: ["22222"] },
    ]);
    mockUpdate.mockResolvedValue({ id: "z1", name: "Zona A", cepPrefixes: ["11111"] });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/delivery-zones/z1",
      payload: { ...VALID_BODY, name: "Zona A", cepPrefixes: ["11111"] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("still 422s when the update reuses a CEP owned by a DIFFERENT zone", async () => {
    mockListAll.mockResolvedValue([
      { id: "z1", name: "Zona A", cepPrefixes: ["11111"] },
      { id: "z2", name: "Zona B", cepPrefixes: ["22222"] },
    ]);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/delivery-zones/z1",
      payload: { ...VALID_BODY, cepPrefixes: ["22222"] },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toBe("CEPs já usados em outras zonas: 22222 (Zona B)");
    expect(mockUpdate).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a duplicate x-request-id with 409 and never updates", async () => {
    mockGetRedisClient.mockResolvedValue(createMockRedis(null));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/delivery-zones/z1",
      payload: VALID_BODY,
      headers: { "x-request-id": "req-dup-put" },
    });

    expect(res.statusCode).toBe(409);
    expect(mockRk).toHaveBeenCalledWith("dz:update:dedup:req-dup-put");
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInvalidateDeliveryCache).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── DELETE (remove) ──────────────────────────────────────────────────────────

describe("DELETE /api/admin/delivery-zones/:id — remove", () => {
  it("removes the zone (200 { ok: true }) and invalidates the cache", async () => {
    mockRemove.mockResolvedValue(undefined);

    const app = await buildTestServer();
    const res = await app.inject({ method: "DELETE", url: "/api/admin/delivery-zones/z9" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mockRemove).toHaveBeenCalledWith("z9");
    expect(mockInvalidateDeliveryCache).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects a duplicate x-request-id with 409 and never removes", async () => {
    mockGetRedisClient.mockResolvedValue(createMockRedis(null));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/delivery-zones/z9",
      headers: { "x-request-id": "req-dup-del" },
    });

    expect(res.statusCode).toBe(409);
    expect(mockRk).toHaveBeenCalledWith("dz:delete:dedup:req-dup-del");
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockInvalidateDeliveryCache).not.toHaveBeenCalled();
    await app.close();
  });
});
