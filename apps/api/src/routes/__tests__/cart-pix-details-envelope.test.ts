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
// The `vi.mock("@ibatexas/domain")` call itself has to stay, and it is doing
// one job only: cart.ts constructs its own service internally
// (`createCustomerService({ auditSink: getAuditSink() })`), so intercepting the
// factory is the only way to reach the client seam from a route test. Every
// method body is real. Injecting services at the route composition root is what
// would remove this last interception.

import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import type { CustomerServiceOptions } from "@ibatexas/domain";
import {
  createInMemoryDomainClient,
  type InMemoryDomainClient,
} from "@ibatexas/domain/testing";

// ── Hoisted mocks ────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((k: string) => `ibatexas:${k}`));

/**
 * The client the intercepted factory injects, plus call-through spies on the
 * two CustomerService methods this file makes routing claims about. `vi.spyOn`
 * keeps the real implementation, so a recorded call is also an EXECUTED one.
 */
const seam = vi.hoisted(() => ({
  client: null as InMemoryDomainClient["client"] | null,
  envelopeSpy: null as MockInstance | null,
  bareArgSpy: null as MockInstance | null,
}));

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

vi.mock("@ibatexas/domain", async () => {
  const actual =
    await vi.importActual<typeof import("@ibatexas/domain")>("@ibatexas/domain");
  return {
    ...actual,
    createCustomerService: (options?: CustomerServiceOptions) => {
      if (!seam.client) {
        throw new Error(
          "[test] createCustomerService() reached before the in-memory client was installed",
        );
      }
      const svc = actual.createCustomerService({
        ...(options ?? {}),
        client: seam.client,
      });
      seam.envelopeSpy = vi.spyOn(svc, "updatePixDetailsFromEnvelope");
      seam.bareArgSpy = vi.spyOn(svc, "updatePixDetails");
      return svc;
    },
    // The singleton must never be reached from this file. A throwing proxy makes
    // that a loud failure instead of an accidental connection attempt.
    prisma: new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(
            `[test] the prisma singleton was accessed (prisma.${String(prop)}) — ` +
              "this suite runs entirely on the injected in-memory client",
          );
        },
      },
    ),
  };
});

import { cachePixDetailsForCustomer } from "../cart.js";

/** A CPF whose Modulo-11 checksum is valid, so the pack's guard accepts it. */
const VALID_CPF = "39053344705";

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

let db: InMemoryDomainClient;

function envelopeSpy(): MockInstance {
  if (!seam.envelopeSpy) throw new Error("[test] service was never constructed");
  return seam.envelopeSpy;
}

function bareArgSpy(): MockInstance {
  if (!seam.bareArgSpy) throw new Error("[test] service was never constructed");
  return seam.bareArgSpy;
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
    seam.client = db.client;
    seam.envelopeSpy = null;
    seam.bareArgSpy = null;
    mockGetRedisClient.mockResolvedValue(createMockRedis());
  });

  it("routes DB persist through updatePixDetailsFromEnvelope (not bare-arg)", async () => {
    await cachePixDetailsForCustomer("cust_01", {
      name: "Alice",
      email: "alice@example.com",
      cpf: VALID_CPF,
    });

    expect(envelopeSpy()).toHaveBeenCalledTimes(1);
    expect(bareArgSpy()).not.toHaveBeenCalled();

    // The real kernel decided this, and the real executor ran: the row carries
    // the details. Under the old fixture both facts were asserted by the mock's
    // own return value.
    const out = await envelopeSpy().mock.results[0]!.value;
    expect(out.decision.kind).toBe("EXECUTE");
    expect(db.rows("customer").find((r) => r.id === "cust_01")).toMatchObject({
      name: "Alice",
      email: "alice@example.com",
      cpf: VALID_CPF,
    });
  });

  it("builds envelope with customer.pix.details.save kind + UNTRUSTED + user actor", async () => {
    await cachePixDetailsForCustomer("cust_42", {
      name: "Bob",
      email: "bob@example.com",
      cpf: VALID_CPF,
    });

    const [envelope, state, extras] = envelopeSpy().mock.calls[0]!;
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
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);
    const before = db.rows("customer").find((r) => r.id === "cust_03");

    await expect(
      cachePixDetailsForCustomer("cust_03", {
        name: "Carol",
        email: "carol@example.com",
        cpf: "bad",
      }),
    ).resolves.toBeUndefined();

    // The refusal is the pack's own CPF-shape guard, not a hand-rejected promise.
    const out = await envelopeSpy().mock.results[0]!.value;
    expect(out.decision.kind).toBe("REFUSE");
    expect(out.decision.refusal.code).toBe("customer.cpf.invalid_format");

    // Redis pipeline was still flushed…
    expect(redis._pipeline.exec).toHaveBeenCalledTimes(1);
    // …and the refusal means the executor never ran, so the row is untouched —
    // name and email are NOT persisted alongside the bad CPF.
    expect(db.rows("customer").find((r) => r.id === "cust_03")).toEqual(before);
    // Bare-arg path was NOT used.
    expect(bareArgSpy()).not.toHaveBeenCalled();
  });

  it("swallows a DB failure on the persist and still flushes the Redis cache", async () => {
    // The helper's try/catch is best-effort by design (a checkout that already
    // booked against Medusa must not fail on a cache/persist hiccup). An unknown
    // customerId is the production shape of that failure: the kernel EXECUTEs
    // and the executor's UPDATE finds no row (Prisma P2025).
    const redis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(redis);

    await expect(
      cachePixDetailsForCustomer("cust_does_not_exist", {
        name: "Dave",
        email: "dave@example.com",
        cpf: VALID_CPF,
      }),
    ).resolves.toBeUndefined();

    expect(envelopeSpy()).toHaveBeenCalledTimes(1);
    await expect(envelopeSpy().mock.results[0]!.value).rejects.toThrow(
      /no customer row matches/,
    );
    expect(redis._pipeline.exec).toHaveBeenCalledTimes(1);
    expect(bareArgSpy()).not.toHaveBeenCalled();
  });
});
