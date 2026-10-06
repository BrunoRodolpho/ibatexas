import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { prisma } from "@ibatexas/domain";
import { getRedisClient } from "@ibatexas/tools";
import { composeSalesAnalytics } from "../../ops/sales-analytics-compose.js";
import { medusaAdmin } from "./_shared.js";

const AnalyticsSummaryResponse = z.object({
  ordersToday: z.number(),
  revenueToday: z.number(),
  aov: z.number(),
  activeCarts: z.number(),
  newCustomers30d: z.number(),
  outreachWeekly: z.number(),
  waConversionRate: z.number(),
  avgMessagesToCheckout: z.number(),
  // BKL-128 — the composer signals that FAILED and fell back to zeros
  // ("orders" | "activeCarts" | "newCustomers30d" | "whatsapp"). The dashboard
  // renders a degraded signal's tiles as "indisponível", never as confident
  // zeros (the BKL-100 posture; the flat DTO previously DROPPED this field).
  degraded: z.array(z.string()),
});

// ── R5 rollout, webhook/chat family — this route's Redis client seam ────────
//
// The ONE `getRedisClient()` call this module made directly now resolves
// through `AdminAnalyticsRouteDeps.redis`. This file had no composition root
// before; the one below is `redis`-only by design — `medusaAdmin` and `prisma`
// are separate seam questions and are untouched here.
//
// ── THE HAND-IT-TO READ (#548's rule) — done, and the answer is a PORT ──────
//
// This route was carried into the slice UNREAD, with an explicit instruction
// neither to assume it matched its sibling nor to assume it differed. It
// differs, and the difference is structural.
//
// `routes/analytics.ts` — the sibling — is owner-gated because it hands its
// CLIENT to `atomicIncr`, which is an `eval`. This file hands
// `composeSalesAnalytics` no client at all. It hands a NARROWED CAPABILITY
// PORT: `redisGet: (key: string) => Promise<string | null>`, the composer's
// only Redis-shaped member. The composer therefore cannot issue `eval` — or
// any other command — even in principle: it holds a one-key read function, not
// a client, so the downstream half of the Pick is bounded by the PORT'S TYPE
// rather than by a promise about what the callee happens to call today. Its
// four `redisGet(...)` uses are all reads of counter keys.
//
// That makes this the cheapest file in the family and the only one where the
// fail-closed Pick rule is enforced by a signature someone else already wrote.
//
// ── THE FAIL-CLOSED PICK ──────────────────────────────────────────────────
//
// {issued} = {get}, and {optionally consumed downstream} = {} — the port
// consumes the RESULT of `get`, never the client. Pick = `{get}`.
//
// ── Feature detection: MEASURED, none ─────────────────────────────────────
//
// `typeof client.X === "function"` was swept over `apps/api/src/routes`,
// `apps/api/src/ops` and `packages/tools/src`: no live Redis probe on any path
// this file reaches.

type RedisClient = Awaited<ReturnType<typeof getRedisClient>>;

/**
 * The EXHAUSTIVE union of Redis commands this route issues — the type
 * `AdminAnalyticsRouteDeps.redis` resolves to.
 *
 * Hand-written rather than derived from the `redisGet` lambda below: a derived
 * type can never disagree with its consumer, so it could not catch a consumer
 * that grew a command nobody declared (F-14).
 */
export type AdminAnalyticsRouteRedisClient = Pick<RedisClient, "get">;

/** The collaborators `admin/analytics.ts` resolves through the seam. */
export interface AdminAnalyticsRouteDeps {
  /**
   * Resolves the Redis client behind the composer's `redisGet` port.
   *
   * A FACTORY returning a promise, not an instance, so the `await` stays
   * exactly where it was — per COMMAND, inside the lambda the composer calls.
   * The route's original expression resolved the client on every `redisGet`
   * invocation (four times per request); that is preserved rather than
   * "optimised" into one resolution, because collapsing it would change when a
   * Redis outage surfaces relative to the composer's `Promise.allSettled`
   * per-signal degradation.
   */
  readonly redis: () => Promise<AdminAnalyticsRouteRedisClient>;
}

/**
 * Fastify plugin options. Overrides nest under `deps` so no member collides
 * with a Fastify-reserved register option (`prefix`, `logLevel`,
 * `logSerializers`); omitted or partial → the production default fills the
 * remainder, so the registration in routes/admin/index.ts is unchanged.
 */
export interface AdminAnalyticsRoutesOptions {
  readonly deps?: Partial<AdminAnalyticsRouteDeps>;
}

/** The production set — byte-for-byte the resolution this file did inline. */
function defaultAdminAnalyticsRouteDeps(): AdminAnalyticsRouteDeps {
  return { redis: () => getRedisClient() };
}

function resolveAdminAnalyticsRouteDeps(
  options?: AdminAnalyticsRoutesOptions,
): AdminAnalyticsRouteDeps {
  return { ...defaultAdminAnalyticsRouteDeps(), ...(options?.deps ?? {}) };
}

export async function analyticsRoutes(
  server: FastifyInstance,
  options?: AdminAnalyticsRoutesOptions,
): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();
  // Resolved ONCE per registration. The member is a factory, so NOTHING is
  // resolved here — the client is still awaited per `redisGet` call.
  const deps = resolveAdminAnalyticsRouteDeps(options);

  // ── GET /api/admin/analytics/summary ──────────────────────────────────────
  // Thin HTTP shell over the shared `composeSalesAnalytics` (NEW-012): ONE
  // implementation now backs BOTH this route AND the ops-actor `ops_sales_
  // analytics` READ tool. The per-signal-zeros resilience the inline handler had
  // (a try/catch per read) is preserved by the composer's Promise.allSettled +
  // fallback; the flat response contract below is unchanged (the admin panel's
  // `formatBRL` reads revenue/aov as integer centavos).
  app.get(
    "/api/admin/analytics/summary",
    {
      schema: {
        tags: ["admin"],
        summary: "Resumo de análises (admin)",
        response: { 200: AnalyticsSummaryResponse },
      },
    },
    async (_request, reply) => {
      const view = await composeSalesAnalytics({
        medusaAdmin: (path) => medusaAdmin(path),
        countNewCustomers: (since) =>
          prisma.customer.count({ where: { createdAt: { gte: since } } }),
        redisGet: async (key) => (await deps.redis()).get(key),
        now: new Date(),
        log: server.log,
      });

      return reply.send({
        ordersToday: view.orders.ordersCount,
        revenueToday: view.orders.revenueCentavos,
        aov: view.orders.aovCentavos,
        activeCarts: view.activeCarts,
        newCustomers30d: view.newCustomers30d,
        outreachWeekly: view.whatsapp.outreachWeekly,
        waConversionRate: view.whatsapp.conversionRatePct,
        avgMessagesToCheckout: view.whatsapp.avgMessagesToCheckout,
        degraded: [...view.degraded],
      });
    },
  );
}
