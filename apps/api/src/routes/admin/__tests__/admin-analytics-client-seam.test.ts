// R5 rollout, webhook/chat family — `routes/admin/analytics.ts`'s Redis-client
// seam, BORN GUARDED.
//
// ── Why this file is the family's cheapest, and why that is a MEASUREMENT ────
//
// This route was carried into the slice UNREAD, with its sibling
// `routes/analytics.ts` already ruled owner-gated (it hands its CLIENT to
// `atomicIncr`, which is an `eval`). The instruction was to assume neither
// that they matched nor that they differed. They differ:
//
//   `admin/analytics.ts` hands `composeSalesAnalytics` NO CLIENT. It hands a
//   narrowed capability PORT — `redisGet: (key) => Promise<string | null>` —
//   which is the composer's only Redis-shaped member.
//
// So the downstream half of the Pick is bounded by the PORT'S TYPE rather than
// by a promise about what the callee happens to call today: the composer holds
// a one-key read function, not a client, and cannot issue `eval` even in
// principle. Pick = `{get}`.
//
// ── What the directional case pins ───────────────────────────────────────────
//
// The composer wraps every read in `Promise.allSettled` with a per-signal
// fallback to ZERO, and reports which signals fell back through `degraded`.
// That makes a happy-path assertion nearly worthless here: a route whose Redis
// reads ALL fail still answers 200 with a well-formed body full of zeros.
// `degraded` is the only field that can tell the two apart, so the case below
// requires REAL values read off the INJECTED keyspace AND `degraded` to be
// empty — and pairs it with the all-zeros/degraded shape in the same test, so
// "read the injected counters" is distinguished from "fell back and looked
// fine".
//
// ── Why the decoy/injected pair ──────────────────────────────────────────────
//
// `decoy` is what `getRedisClient()` returns and nothing in an injected case
// may touch it; `injected` is what `deps.redis` hands over. The DEFAULT arm is
// what makes the injected cases non-vacuous, is NOT itself seam evidence, and
// is EXCLUDED from the revert-to-red counts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";

// Assigned in beforeEach. The `vi.mock` factory closes over it LAZILY.
let decoy: InMemoryRedis;

const FROZEN = 1_700_000_000_000;

// Spread the REAL module and replace ONLY `getRedisClient`. `rk` stays REAL —
// Hard Rule #7 — so the keys under assertion are the ones the WRITERS write.
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return { ...real, getRedisClient: vi.fn(async () => decoy.client) };
});

const mockMedusaAdmin = vi.hoisted(() => vi.fn());
vi.mock("../_shared.js", () => ({ medusaAdmin: mockMedusaAdmin }));

const mockCustomerCount = vi.hoisted(() => vi.fn());
vi.mock("@ibatexas/domain", () => ({
  prisma: { customer: { count: mockCustomerCount } },
}));

interface SummaryBody {
  ordersToday: number;
  revenueToday: number;
  aov: number;
  activeCarts: number;
  newCustomers30d: number;
  outreachWeekly: number;
  waConversionRate: number;
  avgMessagesToCheckout: number;
  degraded: string[];
}

function freshInjected(): InMemoryRedis {
  return createInMemoryRedis({ now: () => FROZEN });
}

/**
 * `injected` omitted ⇒ the DEFAULT arm: no `deps.redis`, so the route must
 * fall back to `getRedisClient()` — i.e. the decoy.
 */
async function buildServer(injected?: InMemoryRedis): Promise<FastifyInstance> {
  const { analyticsRoutes } = await import("../analytics.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(analyticsRoutes, {
    deps: injected
      ? { redis: async () => injected.client as unknown as never }
      : undefined,
  });
  await app.ready();
  return app;
}

async function getSummary(app: FastifyInstance): Promise<SummaryBody> {
  const res = await app.inject({
    method: "GET",
    url: "/api/admin/analytics/summary",
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as SummaryBody;
}

/** Seed the four counter keys the composer reads, on `target`. */
async function seedCounters(
  target: InMemoryRedis,
  rk: (k: string) => string,
  values: { outreach: string; conversations: string; waOrders: string; avgMessages: string },
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await target.client.set(rk("outreach:weekly:count"), values.outreach);
  await target.client.set(rk(`metrics:conversations:daily:${today}`), values.conversations);
  await target.client.set(rk(`metrics:wa_orders:daily:${today}`), values.waOrders);
  await target.client.set(rk("metrics:avg_messages_to_checkout"), values.avgMessages);
}

beforeEach(() => {
  vi.clearAllMocks();
  decoy = createInMemoryRedis({ now: () => FROZEN });
  // The non-Redis signals succeed, so every `degraded` entry below is
  // attributable to Redis alone.
  mockMedusaAdmin.mockResolvedValue({ orders: [], count: 0 });
  mockCustomerCount.mockResolvedValue(7);
});

afterEach(() => {
  vi.useRealTimers();
  // Deliberately NO `vi.resetModules()` — see #548's counterfeit-signal note.
});

describe("seam — admin/analytics summary drives the INJECTED client", () => {
  it("[directional — the WhatsApp signals are READ from the injected keyspace, not defaulted] real counters produce real numbers with an EMPTY degraded list, while an unseeded keyspace in the SAME test yields the all-zeros shape", async () => {
    const { rk } = await import("@ibatexas/tools");

    // The unseeded CONTROL first. This is the shape a route whose Redis reads
    // ALL fail also produces — which is exactly why the seeded arm below
    // cannot rely on a 200 or a well-formed body to prove anything.
    const unseeded = freshInjected();
    const bareApp = await buildServer(unseeded);
    try {
      const bare = await getSummary(bareApp);
      expect(bare.outreachWeekly).toBe(0);
      expect(bare.waConversionRate).toBe(0);
      expect(bare.avgMessagesToCheckout).toBe(0);
    } finally {
      await bareApp.close();
    }

    const injected = freshInjected();
    await seedCounters(injected, rk, {
      outreach: "42",
      conversations: "200",
      waOrders: "50",
      avgMessages: "6",
    });

    const app = await buildServer(injected);
    try {
      const body = await getSummary(app);
      // Values that can ONLY have come off the injected keyspace.
      expect(body.outreachWeekly).toBe(42);
      // 50 orders / 200 conversations = 25%.
      expect(body.waConversionRate).toBe(25);
      expect(body.avgMessagesToCheckout).toBe(6);
      // The field that separates "read it" from "fell back and looked fine".
      expect(body.degraded).not.toContain("whatsapp");
      // The seam: nothing reached the singleton.
      expect(decoy.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("prefers the INJECTED counters over DIFFERENT values sitting on the singleton", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    await seedCounters(injected, rk, {
      outreach: "11",
      conversations: "100",
      waOrders: "20",
      avgMessages: "4",
    });
    // The SAME keys carry DIFFERENT values on the singleton, so a fallback
    // produces a visibly wrong number instead of a coincidence that the
    // "decoy untouched" assertion alone could not distinguish from a
    // coincidence. MEASURED scope: the `get` in this Pick serves exactly the
    // `whatsapp` signal — `activeCarts`, `orders` and `newCustomers30d` come
    // from Medusa and Prisma, not from Redis.
    await seedCounters(decoy, rk, {
      outreach: "999",
      conversations: "999",
      waOrders: "999",
      avgMessages: "999",
    });

    const app = await buildServer(injected);
    try {
      const body = await getSummary(app);
      expect(body.outreachWeekly).toBe(11);
      expect(body.outreachWeekly).not.toBe(999);
      expect(body.avgMessagesToCheckout).toBe(4);
      expect(body.waConversionRate).toBe(20);
      // Filtered to `get` rather than a bare length: this test SEEDS the decoy
      // (that is the point of it), so its `set`s are in the log. `get` is the
      // only command the route issues, so a `get` on the singleton is exactly
      // what a fallback would look like.
      expect(decoy.calls.filter((c) => c.command === "get")).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("[default arm — EXCLUDED from the RTR counts] with no deps.redis the composer's port reads the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    await seedCounters(decoy, rk, {
      outreach: "8",
      conversations: "100",
      waOrders: "10",
      avgMessages: "3",
    });

    const app = await buildServer();
    try {
      const body = await getSummary(app);
      expect(body.outreachWeekly).toBe(8);
      expect(body.waConversionRate).toBe(10);
    } finally {
      await app.close();
    }
  });
});
