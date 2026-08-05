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
//
// ── R5 rollout, family 5 — the Redis double is RETIRED ──────────────────────
//
// This file used to build `{ set: vi.fn().mockResolvedValue("OK" | null) }` and
// hand it over through a mocked `getRedisClient`. Two fictions rode on that,
// and the dedup arms below are exactly where they mattered:
//
//   1. **The verdict was PLANTED.** `createMockRedis(null)` made SET NX answer
//      "already exists" without anything ever having existed. A gate whose SET
//      records nothing passes that arm identically — including a WRITE-ONLY
//      gate that would let every double-submit through in production. The
//      arms now seed the reservation through the SAME command the route
//      issues and let real NX semantics produce the null.
//   2. **`rk` was faked to `ibatexas:`** — a prefix production has never
//      written (under apps/api's vitest the real `rk` resolves to
//      `development:`). Hard Rule #7 keys are now the real ones.
//
// The client arrives through `deps.redis` (the R5 seam) and `getRedisClient` is
// a rejecting TRIPWIRE: if the route ever stops honouring the injected client,
// these cases fail loudly instead of silently passing against the singleton.
// The case list is unchanged — 14 before, 14 after.

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";
// Below the `vi.mock` blocks in intent, above them in text: vitest hoists
// `vi.mock` above every import regardless of position, and the sibling suite
// (`products-routes.test.ts`) already imports its SUT here.
import { deliveryZoneRoutes } from "../delivery-zones.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockListAll = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockRemove = vi.hoisted(() => vi.fn());

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockInvalidateDeliveryCache = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createDeliveryZoneService: () => ({
    listAll: mockListAll,
    create: mockCreate,
    update: mockUpdate,
    remove: mockRemove,
  }),
}));

// Spread the REAL module and replace only what must not run: the client
// resolver (a tripwire) and the fire-and-forget cache invalidation (whose real
// implementation resolves its OWN singleton — which is precisely why it is not
// downstream of this route's Pick). `rk` stays REAL.
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return {
    ...real,
    getRedisClient: mockGetRedisClient,
    invalidateDeliveryCache: mockInvalidateDeliveryCache,
  };
});

// requireManagerRole is exercised by escalations-authz.test.ts; here we let it
// pass through so we can focus on the handler logic of THIS file.
vi.mock("../../../middleware/staff-auth.js", () => ({
  requireManagerRole: (
    _request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ) => done(),
}));

// ── Server factory ─────────────────────────────────────────────────────────

/** A frozen instant, so the dedup TTL below is an exact equality. */
const FROZEN = 1_700_000_000_000;

/** The canonical in-memory adapter, injected through the R5 seam. */
let redis: InMemoryRedis;

async function buildTestServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(deliveryZoneRoutes, {
    deps: { redis: async () => redis.client as unknown as never },
  });
  await app.ready();
  return app;
}

const VALID_BODY = {
  name: "Zona Centro",
  cepPrefixes: ["12345"],
  feeInCentavos: 900,
  estimatedMinutes: 40,
};

beforeEach(() => {
  vi.clearAllMocks();
  redis = createInMemoryRedis({ now: () => FROZEN });
  // A rejecting TRIPWIRE, not a client. Nothing in this file may resolve the
  // singleton: every command must land on the injected adapter above.
  mockGetRedisClient.mockRejectedValue(
    new Error("getRedisClient() resolved — the deps.redis seam was bypassed"),
  );
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
    const { rk } = await import("@ibatexas/tools");
    // The reservation is made through the SAME command the route issues, so
    // the 409 comes from real NX semantics rather than from a planted answer.
    await redis.client.set(rk("dz:create:dedup:req-dup-1"), "1", { EX: 300, NX: true });

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
    const { rk } = await import("@ibatexas/tools");
    mockCreate.mockResolvedValue({ id: "z_new", ...VALID_BODY, active: true });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/delivery-zones",
      payload: VALID_BODY,
      headers: { "x-request-id": "req-fresh-1" },
    });

    expect(res.statusCode).toBe(201);
    // The reservation as a KEYSPACE property against the REAL `rk` key, not a
    // `toHaveBeenCalledWith` against a fake `ibatexas:` prefix.
    const key = rk("dz:create:dedup:req-fresh-1");
    expect(redis.peek(key)).toBe("1");
    // EXACT, on a frozen clock: `EX: 300`. `toBeGreaterThan(0)` cannot tell a
    // 5-minute replay window from a 5-second one.
    expect(redis.ttlMs(key)).toBe(300_000);
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
    const { rk } = await import("@ibatexas/tools");
    await redis.client.set(rk("dz:update:dedup:req-dup-put"), "1", { EX: 300, NX: true });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/delivery-zones/z1",
      payload: VALID_BODY,
      headers: { "x-request-id": "req-dup-put" },
    });

    expect(res.statusCode).toBe(409);
    // The UPDATE action's own key is what was consulted — the reservation was
    // seeded under `dz:update:…` and nothing else was written.
    expect(redis.keys()).toEqual([rk("dz:update:dedup:req-dup-put")]);
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
    const { rk } = await import("@ibatexas/tools");
    await redis.client.set(rk("dz:delete:dedup:req-dup-del"), "1", { EX: 300, NX: true });

    const app = await buildTestServer();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/delivery-zones/z9",
      headers: { "x-request-id": "req-dup-del" },
    });

    expect(res.statusCode).toBe(409);
    expect(redis.keys()).toEqual([rk("dz:delete:dedup:req-dup-del")]);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockInvalidateDeliveryCache).not.toHaveBeenCalled();
    await app.close();
  });
});
