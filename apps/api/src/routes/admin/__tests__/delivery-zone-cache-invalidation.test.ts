// F-42 — the delivery cache invalidation is DRIVEN through the real route.
//
// ── What this file exists to prove, and why the sibling suite cannot ────────
//
// `delivery-zones.test.ts` mocks `invalidateDeliveryCache` and asserts it was
// CALLED. That is the right shape for the guard arms it owns (a 409 must not
// invalidate), but a call-count can never see the failure F-42 is about: the
// real function's body is a bare try/catch with an empty handler, so a client
// that cannot serve it produces a `TypeError` that is absorbed, an invalidation
// that never happens, and a spy that still says "called once". Green suite,
// stale cache, and a zone edit that silently stops showing up in chat.
//
// So this file mocks NOTHING on that path. The REAL `invalidateDeliveryCache`
// runs, on the REAL route, against the canonical in-memory adapter, and every
// assertion is on the adapter's own state and command log — the keys that
// actually disappeared and the `scan`/`del` actually issued.
//
// ── The tripwire's exact reach (do not over-read it) ───────────────────────
//
// `getRedisClient` is mocked to a rejecting tripwire, which proves the ROUTE
// honours `deps.redis` for its dedup gate. It does NOT reach inside
// `invalidateDeliveryCache`: that function resolves its singleton through a
// RELATIVE import within `@ibatexas/tools`, which a mock of the package
// SPECIFIER cannot intercept. What guards the invalidation path is not the
// tripwire but the assertions themselves — if the route stopped threading its
// client, the real function would resolve the real singleton and the seeded
// keys on THIS adapter would survive, which is exactly what the arms below
// would report.
//
// ── ABSENCE arms carry their own DURING arm ────────────────────────────────
//
// "the delivery keys are gone" is worthless if they were never there, so every
// arm asserts the key is PRESENT on the adapter immediately before the request
// and absent after. Same for the 409 control, in the opposite direction.

import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";
import {
  invalidateDeliveryCache,
  rk,
  type DeliveryCacheClient,
  type DeliveryCacheInvalidationClient,
} from "@ibatexas/tools";
import { deliveryZoneRoutes } from "../delivery-zones.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockListAll = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockRemove = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createDeliveryZoneService: () => ({
    listAll: mockListAll,
    create: mockCreate,
    update: mockUpdate,
    remove: mockRemove,
  }),
}));

// Spread the REAL module and replace ONLY the client resolver. `rk` stays real
// and — the point of this file — so does `invalidateDeliveryCache`.
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return { ...real, getRedisClient: mockGetRedisClient };
});

vi.mock("../../../middleware/staff-auth.js", () => ({
  requireManagerRole: (
    _request: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void,
  ) => done(),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

let redis: InMemoryRedis;

/** A cached delivery answer for a CEP — what a zone edit must invalidate. */
const CACHED_CEP = "14815000";
/** A second one, so a single-key DEL cannot pass for a full invalidation. */
const CACHED_CEP_2 = "01001000";
/** Not a delivery key: proof the MATCH pattern is load-bearing. */
const UNRELATED_KEY = "cart:active:session:s1";

function cachedKeys(): string[] {
  return [rk(`delivery:cep:${CACHED_CEP}`), rk(`delivery:cep:${CACHED_CEP_2}`)];
}

function seedDeliveryCache(): void {
  for (const key of cachedKeys()) {
    redis.client.set(key, '{"success":true,"message":"stale"}');
  }
  redis.client.set(rk(UNRELATED_KEY), "cart_1");
}

async function buildTestServer(
  resolveRedis: () => Promise<typeof redis.client> = async () => redis.client,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(deliveryZoneRoutes, { deps: { redis: resolveRedis } });
  await app.ready();
  return app;
}

const VALID_BODY = {
  name: "Zona Centro",
  cepPrefixes: ["12345"],
  feeInCentavos: 900,
  estimatedMinutes: 40,
};

/** Commands the adapter served, in order. */
function commands(): string[] {
  return redis.calls.map((c) => c.command);
}

beforeEach(() => {
  vi.clearAllMocks();
  redis = createInMemoryRedis();
  mockGetRedisClient.mockRejectedValue(
    new Error("getRedisClient() resolved — the deps.redis seam was bypassed"),
  );
  mockListAll.mockResolvedValue([]);
});

// ── The born guard: every mutating route really invalidates ────────────────

describe("F-42 — a zone mutation invalidates the delivery cache ON THE THREADED CLIENT", () => {
  it("POST (create) deletes every cached CEP answer and leaves unrelated keys", async () => {
    mockCreate.mockResolvedValue({ id: "z_new", ...VALID_BODY, active: true });
    seedDeliveryCache();
    // DURING arm — the keys are on this adapter before the request.
    expect(redis.keys()).toEqual(expect.arrayContaining(cachedKeys()));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/delivery-zones",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);

    // Fire-and-forget: the invalidation is not awaited by the handler.
    await vi.waitFor(() => {
      expect(redis.keys()).toEqual([rk(UNRELATED_KEY)]);
    });
    // It went through SCAN + DEL on THIS adapter, not some other path.
    expect(commands()).toContain("scan");
    expect(commands()).toContain("del");
    await app.close();
  });

  it("PUT (update) deletes every cached CEP answer", async () => {
    mockUpdate.mockResolvedValue({ id: "z1", ...VALID_BODY, active: true });
    seedDeliveryCache();
    expect(redis.keys()).toEqual(expect.arrayContaining(cachedKeys()));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/delivery-zones/z1",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(redis.keys()).toEqual([rk(UNRELATED_KEY)]);
    });
    expect(commands()).toContain("scan");
    expect(commands()).toContain("del");
    await app.close();
  });

  it("DELETE (remove) deletes every cached CEP answer", async () => {
    mockRemove.mockResolvedValue(undefined);
    seedDeliveryCache();
    expect(redis.keys()).toEqual(expect.arrayContaining(cachedKeys()));

    const app = await buildTestServer();
    const res = await app.inject({ method: "DELETE", url: "/api/admin/delivery-zones/z9" });
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(redis.keys()).toEqual([rk(UNRELATED_KEY)]);
    });
    expect(commands()).toContain("scan");
    expect(commands()).toContain("del");
    await app.close();
  });

  it("the DEL really is keyed on rk() — a neighbouring environment's key survives", async () => {
    mockUpdate.mockResolvedValue({ id: "z1", ...VALID_BODY, active: true });
    seedDeliveryCache();
    const foreign = "production:delivery:cep:14815000";
    await redis.client.set(foreign, '{"success":true}');
    expect(redis.peek(foreign)).toBe('{"success":true}');

    const app = await buildTestServer();
    await app.inject({ method: "PUT", url: "/api/admin/delivery-zones/z1", payload: VALID_BODY });

    await vi.waitFor(() => {
      expect(redis.peek(rk(`delivery:cep:${CACHED_CEP}`))).toBeUndefined();
    });
    // Hard Rule #7's prefix is what bounded the blast radius.
    expect(redis.peek(foreign)).toBe('{"success":true}');
    await app.close();
  });
});

// ── The CONTROL: a short-circuited request invalidates NOTHING ─────────────

describe("F-42 control — a guard short-circuit issues no SCAN and no DEL", () => {
  it("a duplicate x-request-id (409) leaves the cached answers intact", async () => {
    seedDeliveryCache();
    await redis.client.set(rk("dz:update:dedup:req-dup"), "1", { EX: 300, NX: true });
    expect(redis.keys()).toEqual(expect.arrayContaining(cachedKeys()));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/delivery-zones/z1",
      payload: VALID_BODY,
      headers: { "x-request-id": "req-dup" },
    });
    expect(res.statusCode).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();

    // Give any stray fire-and-forget chain the same number of ticks the
    // positive arms needed, so this is an absence and not a race we won.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(redis.keys()).toEqual(expect.arrayContaining(cachedKeys()));
    expect(commands()).not.toContain("scan");
    expect(commands()).not.toContain("del");
    await app.close();
  });
});

// ── The degradation the threading must NOT change ─────────────────────────

describe("F-42 — a Redis outage on the invalidation path stays fail-soft", () => {
  it("the mutation still succeeds, the cache is left warm, and nothing escapes", async () => {
    // Before the threading, `getRedisClient()` rejected INSIDE the callee's own
    // catch. Now the resolution happens in the route, so the rejection handler
    // in `invalidateZoneCache` is the only thing standing between an outage and
    // an unhandled rejection — a failure mode this slice must not introduce.
    const escaped: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      escaped.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      seedDeliveryCache();
      mockUpdate.mockResolvedValue({ id: "z1", ...VALID_BODY, active: true });
      // No `x-request-id`, so the dedup gate never resolves a client: this
      // factory is reached ONLY by the invalidation path.
      const app = await buildTestServer(() =>
        Promise.reject(new Error("redis down")),
      );

      const res = await app.inject({
        method: "PUT",
        url: "/api/admin/delivery-zones/z1",
        payload: VALID_BODY,
      });

      // The admin's edit was not held hostage by the cache.
      expect(res.statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(escaped).toEqual([]);
      // And the degradation is the documented one: the cache stays warm until
      // its TTL rather than the request failing.
      expect(redis.keys()).toEqual(expect.arrayContaining(cachedKeys()));
      await app.close();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ── The TRAP this finding exists to prevent ────────────────────────────────

describe("F-42 trap — a caller-derived, scan-less client", () => {
  /**
   * The Pick a caller would derive from what the ROUTE ITSELF issues: `set`
   * alone, with node-redis' real signature. This is the pre-fix shape — the
   * route's own `DeliveryZoneRouteRedisClient` was exactly this before F-42 —
   * written out so both proofs below are about a concrete type rather than a
   * described one.
   */
  type CallerDerivedRedis = Pick<DeliveryCacheClient, "set">;

  it("COMPILE-TIME: cannot reach the seam — `scan` is missing and tsc says so", () => {
    const scanless = {} as CallerDerivedRedis;

    // The pin. `@ts-expect-error` is itself an error when the error it names
    // stops happening, so widening `DeliveryCacheInvalidationOptions` back to
    // something a scan-less client satisfies FAILS `tsc --noEmit` right here.
    // The suppressed diagnostic, measured by lifting this directive:
    //   TS2739: Type 'Pick<DeliveryCacheClient, "set">' is missing the following
    //   properties from type 'DeliveryCacheInvalidationClient': scan, del
    // @ts-expect-error — scan-less client must not be assignable to the seam
    const rejected = () => invalidateDeliveryCache({ client: scanless });

    // The arrow above is never invoked: this arm is a TYPE assertion, and
    // running it would only re-prove the runtime arm below.
    expect(typeof rejected).toBe("function");
  });

  it("RUNTIME: with the type defeated, the failure is SILENT — nothing is invalidated", async () => {
    seedDeliveryCache();
    expect(redis.keys()).toEqual(expect.arrayContaining(cachedKeys()));

    // A spy-delegate over the canonical adapter: the commands it DOES carry
    // land on the real double, so this is the true pre-fix client and not a
    // stub that answers itself. `scan` is genuinely absent.
    const scanless = {
      set: vi.fn((...args: Parameters<typeof redis.client.set>) => redis.client.set(...args)),
      del: vi.fn((...args: Parameters<typeof redis.client.del>) => redis.client.del(...args)),
    };
    expect("scan" in scanless).toBe(false);

    // The cast is the defeat. Before F-42 the seam accepted this shape without
    // one, which is precisely the hazard.
    await expect(
      invalidateDeliveryCache({ client: scanless as unknown as DeliveryCacheInvalidationClient }),
    ).resolves.toBeUndefined(); // ← it does NOT throw. The catch ate the TypeError.

    // And nothing happened. This is the bug, reproduced: no error, no signal,
    // stale cache. A call-count spy would have reported a healthy invalidation.
    expect(redis.keys()).toEqual(expect.arrayContaining(cachedKeys()));
    expect(scanless.del).not.toHaveBeenCalled();
    expect(commands()).not.toContain("scan");
    expect(commands()).not.toContain("del");
  });
});
