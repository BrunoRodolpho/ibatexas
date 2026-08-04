// W7 — cart.ts: cachePixDetailsForCustomer envelope routing
//
// The coverage-baseline audit flagged `apps/api/src/routes/cart.ts:130` as a
// bare-arg `updatePixDetails` caller. This file asserts that after the
// migration the route helper builds a `customer.pix.details.save` envelope
// (UNTRUSTED customer-actor, sessionId = customerId) and dispatches via
// `updatePixDetailsFromEnvelope` — never the deprecated bare-arg surface.
//
// ── R5-S1: migrated onto the real CustomerService ─────────────────────────
//
// This file used to answer `createCustomerService()` with a two-key object
// literal — `{ updatePixDetails, updatePixDetailsFromEnvelope }` — plus
// `prisma: {}`, and fabricated the governance outcomes with
// `mockResolvedValue({ decision: { kind: "EXECUTE" } })` /
// `mockRejectedValue(new Error("CPF invalid"))`. Every assertion below about
// what the kernel DID was therefore an assertion about the fixture, not about
// pack-customer-onboarding: the test named a CPF refusal while no CPF guard ran.
//
// It now runs the REAL `createCustomerService` from @ibatexas/domain with an
// injected in-memory prisma-shaped client (`@ibatexas/domain/testing`), so:
//   • the envelope the route builds is adjudicated by the real policy bundle —
//     "EXECUTE" is now a result, not a fixture;
//   • the CPF refusal is the pack's own `validateCpfShape` guard;
//   • "persisted" / "not persisted" is observed as ROW STATE.
//
// ── R5-S2: the `vi.mock("@ibatexas/domain")` interception is GONE ─────────
//
// R5-S1 had to keep a factory interception, because cart.ts constructed its own
// service internally (`createCustomerService({ auditSink: getAuditSink() })`) and
// intercepting the module was the only way to reach the client seam from a route
// test. cart.ts now takes its service as a `CartRouteDeps` argument, so this file
// imports the REAL `@ibatexas/domain` — no module interception of any kind — and
// hands the route the service it should use.
//
// That deletes the throwing-`prisma`-proxy the mock installed. What replaces it
// is strictly stricter, in two layers:
//
//   1. COMPILE TIME. `cachePixDetailsForCustomer`'s `deps` parameter is REQUIRED
//      and has no default, so there is no singleton-backed path to fall back to.
//      Dropping the argument is a `tsc` error (TS2554), not a live connection —
//      the proxy could only catch that at runtime, and only if the swallowing
//      try/catch in the helper let it surface at all (it would not: it warns).
//   2. RUN TIME. `serviceFactory` below is a `vi.fn`, and "uses the injected
//      seam and constructs nothing of its own" asserts it was invoked exactly
//      once per persist. A re-introduced internal construction makes that red.
//
// On top of both, the injected client itself THROWS on any unrouted call, and
// "surfaces a failure from the INJECTED client" pins the route's observable
// outcome to an error only the injected client can produce.

import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import { createCustomerService, type CustomerService } from "@ibatexas/domain";
import type { CustomerServiceClient } from "@ibatexas/domain";
import {
  createInMemoryDomainClient,
  type InMemoryDomainClient,
} from "@ibatexas/domain/testing";
import { getAuditSink } from "@ibatexas/audit-sink";

// ── Hoisted mocks ────────────────────────────────────────────────────────

/**
 * R5 rollout — a TRIPWIRE, not a supplier.
 *
 * `cachePixDetailsForCustomer` now takes its Redis client from
 * `deps.redis`, so nothing in this file may reach the process singleton. This
 * `vi.fn` therefore REJECTS instead of answering a double: if the threading is
 * removed and the helper falls back to `getRedisClient()`, the sentinel below
 * lands in the helper's swallowed `console.warn` and the seam cases red.
 *
 * It is not deleted outright because `routes/cart.ts` still imports the symbol
 * (it is the DEFAULT behind `defaultCartRouteDeps`), and this file's
 * `vi.mock("@ibatexas/tools")` must supply every export the module imports.
 */
const SINGLETON_TRIPWIRE = "cart-pix-details: reached the getRedisClient singleton";
const mockGetRedisClient = vi.hoisted(() =>
  vi.fn(() =>
    Promise.reject(new Error("cart-pix-details: reached the getRedisClient singleton")),
  ),
);
const mockRk = vi.hoisted(() => vi.fn((k: string) => `ibatexas:${k}`));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  estimateDelivery: vi.fn(),
  createCheckout: vi.fn(),
  reaisToCentavos: vi.fn(),
  MedusaRequestError: class {},
  cancelStalePaymentIntent: vi.fn(),
  loadSchedule: vi.fn(),
  getMealPeriodFromSchedule: vi.fn(),
  medusaAdjudicated: vi.fn(),
  MedusaAdjudicateRefusedError: class {},
  MedusaAdjudicateDeferredError: class {},
  MedusaAdjudicateNeedsReviewError: class {},
}));

import { cachePixDetailsForCustomer, type CartRouteDeps } from "../cart.js";

/** A CPF whose Modulo-11 checksum is valid, so the pack's guard accepts it. */
const VALID_CPF = "39053344705";

/**
 * The PIX-cache write double.
 *
 * NOT `createInMemoryRedis`: `cachePixDetailsForCustomer`'s only Redis touch is
 * a MULTI pipeline, and the canonical adapter refuses `multi` (W4 — pipeline
 * semantics are the owner-gated class). So this file keeps a hand double; what
 * changed in the R5 rollout is WHERE it enters — through `deps.redis`, the
 * production seam, rather than through a module interception of
 * `getRedisClient`.
 */
function createMockRedis() {
  const pipeline = {
    hSet: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  return {
    multi: vi.fn(() => pipeline),
    hGetAll: vi.fn().mockResolvedValue({}),
    expire: vi.fn().mockResolvedValue(true),
    _pipeline: pipeline,
  };
}

/**
 * Wrap an in-memory client so `customer.update` — the delegate call
 * `performUpdatePixDetails` makes — rejects with `message`.
 *
 * A top-level Proxy rather than a spread: `InMemoryDomainClient.client` is
 * itself a Proxy whose target carries only `$transaction`/`$queryRaw`, so
 * spreading it would silently drop every model delegate. The `customer`
 * delegate underneath IS a plain object, so that one is spread.
 */
function withFailingCustomerUpdate(
  base: CustomerServiceClient,
  message: string,
): CustomerServiceClient {
  const source = base as unknown as Record<string, unknown>;
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === "customer") {
        return {
          ...(source["customer"] as Record<string, unknown>),
          update: () => Promise.reject(new Error(message)),
        };
      }
      return source[prop as string];
    },
  }) as unknown as CustomerServiceClient;
}

let db: InMemoryDomainClient;
let service: CustomerService;
let serviceFactory: ReturnType<typeof vi.fn>;
let deps: CartRouteDeps;
/** The client `deps.redis` hands out — reassigned per test. */
let redis: ReturnType<typeof createMockRedis>;
/** Counts how many times the subject resolved a client through the seam. */
let redisFactory: ReturnType<typeof vi.fn>;
let envelopeSpy: MockInstance;
let bareArgSpy: MockInstance;

/**
 * A `CartRouteDeps` member this test's subject must never reach for.
 *
 * R5-S5 widened `CartRouteDeps` from one member to five (the rest of cart.ts's
 * service factories joined the seam). `cachePixDetailsForCustomer` still uses
 * ONLY `customerService`, so the four newcomers are filled with throwers rather
 * than real constructions: that keeps the widening from silently handing this
 * test's subject four new reachable services, and turns any future reach into a
 * loud failure instead of a live connection. `() => never` is assignable to
 * every member's factory type, so no cast is needed.
 */
function unreachableDep(name: keyof CartRouteDeps): () => never {
  return () => {
    throw new Error(`cachePixDetailsForCustomer reached for deps.${name}()`);
  };
}

/** Build the dep set the route registration would resolve, over `client`. */
function depsOver(client: CustomerServiceClient): CartRouteDeps {
  // Same construction options cart.ts's own default uses — only `client` is
  // added, so the audit sink and policy bundle are the production ones.
  const svc = createCustomerService({ auditSink: getAuditSink(), client });
  service = svc;
  envelopeSpy = vi.spyOn(svc, "updatePixDetailsFromEnvelope");
  bareArgSpy = vi.spyOn(svc, "updatePixDetails");
  serviceFactory = vi.fn(() => svc);
  redis = createMockRedis();
  redisFactory = vi.fn(async () => redis);
  return {
    customerService: serviceFactory as unknown as () => CustomerService,
    customerLookupService: unreachableDep("customerLookupService"),
    orderCommandService: unreachableDep("orderCommandService"),
    orderQueryService: unreachableDep("orderQueryService"),
    paymentQueryService: unreachableDep("paymentQueryService"),
    // R5 rollout — the PIX cache write runs on THIS client, not the singleton.
    // `unreachableDep` is wrong for this member: unlike the four services above,
    // `cachePixDetailsForCustomer` genuinely reaches it.
    redis: redisFactory as unknown as CartRouteDeps["redis"],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("cart.ts — cachePixDetailsForCustomer envelope routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = createInMemoryDomainClient({
      seed: {
        customer: [
          { id: "cust_01", phone: "+5511999990001" },
          { id: "cust_42", phone: "+5511999990042" },
          { id: "cust_03", phone: "+5511999990003" },
        ],
      },
    });
    deps = depsOver(db.client);
  });

  it("routes DB persist through updatePixDetailsFromEnvelope (not bare-arg)", async () => {
    await cachePixDetailsForCustomer(
      "cust_01",
      { name: "Alice", email: "alice@example.com", cpf: VALID_CPF },
      deps,
    );

    expect(envelopeSpy).toHaveBeenCalledTimes(1);
    expect(bareArgSpy).not.toHaveBeenCalled();

    // The real kernel decided this, and the real executor ran: the row carries
    // the details. Under the old fixture both facts were asserted by the mock's
    // own return value.
    const out = await envelopeSpy.mock.results[0]!.value;
    expect(out.decision.kind).toBe("EXECUTE");
    expect(db.rows("customer").find((r) => r.id === "cust_01")).toMatchObject({
      name: "Alice",
      email: "alice@example.com",
      cpf: VALID_CPF,
    });
  });

  it("uses the injected seam and constructs nothing of its own", async () => {
    // R5-S2 guard. This is what replaces R5-S1's throwing `prisma` proxy at
    // runtime: the route must obtain its CustomerService from `deps`, exactly
    // once, and it must be the instance we handed it. If cart.ts ever grows an
    // internal `createCustomerService(...)` fallback again, the factory count
    // drops to 0 and the identity check fails — both before any row is touched.
    await cachePixDetailsForCustomer(
      "cust_01",
      { name: "Alice", email: "alice@example.com", cpf: VALID_CPF },
      deps,
    );

    expect(serviceFactory).toHaveBeenCalledTimes(1);
    expect(serviceFactory.mock.results[0]!.value).toBe(service);
    expect(envelopeSpy).toHaveBeenCalledTimes(1);
    // …and the write landed in the injected store, not anywhere else.
    expect(db.rows("customer").find((r) => r.id === "cust_01")).toMatchObject({
      cpf: VALID_CPF,
    });
  });

  it("builds envelope with customer.pix.details.save kind + UNTRUSTED + user actor", async () => {
    await cachePixDetailsForCustomer(
      "cust_42",
      { name: "Bob", email: "bob@example.com", cpf: VALID_CPF },
      deps,
    );

    const [envelope, state, extras] = envelopeSpy.mock.calls[0]!;
    expect(envelope.kind).toBe("customer.pix.details.save");
    expect(envelope.taint).toBe("UNTRUSTED");
    expect(envelope.actor.principal).toBe("user");
    expect(envelope.actor.sessionId).toBe("cust_42");
    expect(envelope.payload).toEqual({
      name: "Bob",
      email: "bob@example.com",
      cpf: VALID_CPF,
    });
    expect(state.ctx.customerId).toBe("cust_42");
    expect(state.ctx.isAuthenticated).toBe(true);
    expect(state.ctx.customerExists).toBe(true);
    expect(extras).toEqual({ customerId: "cust_42" });
  });

  it("propagates Redis-cache writes even when the envelope dispatch refuses", async () => {
    const before = db.rows("customer").find((r) => r.id === "cust_03");

    await expect(
      cachePixDetailsForCustomer(
        "cust_03",
        { name: "Carol", email: "carol@example.com", cpf: "bad" },
        deps,
      ),
    ).resolves.toBeUndefined();

    // The refusal is the pack's own CPF-shape guard, not a hand-rejected promise.
    const out = await envelopeSpy.mock.results[0]!.value;
    expect(out.decision.kind).toBe("REFUSE");
    expect(out.decision.refusal.code).toBe("customer.cpf.invalid_format");

    // Redis pipeline was still flushed…
    expect(redis._pipeline.exec).toHaveBeenCalledTimes(1);
    // …and the refusal means the executor never ran, so the row is untouched —
    // name and email are NOT persisted alongside the bad CPF.
    expect(db.rows("customer").find((r) => r.id === "cust_03")).toEqual(before);
    // Bare-arg path was NOT used.
    expect(bareArgSpy).not.toHaveBeenCalled();
  });

  it("swallows a DB failure on the persist and still flushes the Redis cache", async () => {
    // The helper's try/catch is best-effort by design (a checkout that already
    // booked against Medusa must not fail on a cache/persist hiccup). An unknown
    // customerId is the production shape of that failure: the kernel EXECUTEs
    // and the executor's UPDATE finds no row (Prisma P2025).
    await expect(
      cachePixDetailsForCustomer(
        "cust_does_not_exist",
        { name: "Dave", email: "dave@example.com", cpf: VALID_CPF },
        deps,
      ),
    ).resolves.toBeUndefined();

    expect(envelopeSpy).toHaveBeenCalledTimes(1);
    await expect(envelopeSpy.mock.results[0]!.value).rejects.toThrow(
      /no customer row matches/,
    );
    expect(redis._pipeline.exec).toHaveBeenCalledTimes(1);
    expect(bareArgSpy).not.toHaveBeenCalled();
  });

  it("surfaces a failure from the INJECTED client, not from the singleton", async () => {
    // R5-S2 — the standing form of the revert-to-red proof. The only difference
    // from the passing case is the client behind the injected service, so the
    // route's observable outcome (the swallowed warning) can only carry this
    // sentinel if the injected client is genuinely the one on the write path.
    const sentinel = "injected-client: customer.update refused to run";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failing = depsOver(withFailingCustomerUpdate(db.client, sentinel));

      await expect(
        cachePixDetailsForCustomer(
          "cust_01",
          { name: "Alice", email: "alice@example.com", cpf: VALID_CPF },
          failing,
        ),
      ).resolves.toBeUndefined();

      expect(envelopeSpy).toHaveBeenCalledTimes(1);
      await expect(envelopeSpy.mock.results[0]!.value).rejects.toThrow(sentinel);
      expect(warn).toHaveBeenCalledWith(
        "[cart/checkout] Failed to cache PIX details:",
        sentinel,
      );
      // The kernel EXECUTEd, the executor threw, so nothing was persisted.
      expect(db.rows("customer").find((r) => r.id === "cust_01")).not.toMatchObject(
        { cpf: VALID_CPF },
      );
    } finally {
      warn.mockRestore();
    }
  });

  // ── R5 rollout — the Redis client seam, born guarded ────────────────────
  //
  // F-5: a new seam ships with a probe of its CONSUMING SURFACE. Injecting a
  // client and asserting on it proves nothing on its own — the subject could
  // ignore the argument and resolve the singleton, and every assertion above
  // would still pass, because none of them looks at where the write landed.
  //
  // The FAIL-CLOSED PICK hazard this specifically covers: this consumer's whole
  // body is inside a swallowing `try/catch`. A Redis client that cannot serve
  // it does not raise — it warns and returns. So "the cache write happened" has
  // to be observed on the injected object, and "the singleton was not reached"
  // has to be observed separately, or a silent degradation reads as green.

  it("[seam] the PIX cache write lands on the INJECTED client, resolved once", async () => {
    await cachePixDetailsForCustomer(
      "cust_01",
      { name: "Alice", email: "alice@example.com", cpf: VALID_CPF },
      deps,
    );

    // Resolved through the seam exactly once — one Redis touch, one resolution.
    expect(redisFactory).toHaveBeenCalledTimes(1);
    // …and the pipeline it opened is the one we handed over.
    expect(redis.multi).toHaveBeenCalledTimes(1);
    expect(redis._pipeline.exec).toHaveBeenCalledTimes(1);
    // Fields queued on the injected pipeline, under the rk()-namespaced key.
    expect(redis._pipeline.hSet).toHaveBeenCalledWith(
      "ibatexas:customer:pix:cust_01",
      "cpf",
      VALID_CPF,
    );
  });

  it("[seam] never resolves the getRedisClient singleton", async () => {
    // The tripwire rejects. `cachePixDetailsForCustomer` swallows into a warn,
    // so a fallback would be INVISIBLE without this assertion — which is the
    // whole point of pinning the call count rather than the outcome.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await cachePixDetailsForCustomer(
        "cust_01",
        { name: "Alice", email: "alice@example.com", cpf: VALID_CPF },
        deps,
      );

      expect(mockGetRedisClient).not.toHaveBeenCalled();
      // Positive control: the tripwire's sentinel never reached the warn path,
      // and no warn happened at all — so the run above really was clean.
      expect(warn).not.toHaveBeenCalledWith(
        "[cart/checkout] Failed to cache PIX details:",
        SINGLETON_TRIPWIRE,
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
