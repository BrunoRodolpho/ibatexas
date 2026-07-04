// sales-analytics-compose.ts — the shared sales-analytics composition (NEW-012).
//
// The sibling of `ops-snapshot-compose.ts`: ONE implementation backs BOTH
// consumers of the "how were today's sales?" read:
//   - GET /api/admin/analytics/summary (the manager analytics panel), and
//   - the ops-actor conductor's `ops_sales_analytics` READ tool (NEW-012) — the
//     LLM-visible sales read answering "como foram as vendas hoje? / quanto
//     faturamos? / qual o ticket médio?".
//
// It reimplements NO query: it calls the SAME reads the analytics route already
// ran inline (Medusa admin orders HTTP, `prisma.customer.count`, the Redis
// WhatsApp-funnel metrics) ONCE each and folds them into a compact view. The
// three accessors are INJECTED so the composition is unit-testable with fakes
// (no DB, no HTTP, no Redis); the route + the executor pass the real clients.
//
// Resilience (a sales overview must survive one bad signal): the four reads are
// INDEPENDENT, so they run concurrently under `Promise.allSettled` (NOT
// `Promise.all`). If ONE read rejects, `unwrap` LOGS it and substitutes that
// signal's zero fallback, so the view still returns with the other summaries
// intact — the SAME per-signal-zeros posture the old inline route had (one
// try/catch per read), now shared. This read is READ-ONLY: zero mutation, no
// owner scope, no money authority.

import { rk } from "@ibatexas/tools";

// ── View-composition types (NOT domain state) ───────────────────────────────

/** Today's sales headline — order count + money (integer centavos). */
export interface SalesTodaySummary {
  readonly ordersCount: number;
  /** Sum of today's order totals, integer centavos (Medusa `order.total`). */
  readonly revenueCentavos: number;
  /** Average order value = round(revenue / orders), integer centavos. */
  readonly aovCentavos: number;
}

/** WhatsApp funnel headline — conversion + engagement. */
export interface WhatsappFunnelSummary {
  /** WA orders ÷ WA conversations today, as an integer percentage (0–100). */
  readonly conversionRatePct: number;
  /** Rolling avg messages exchanged before a checkout (rounded). */
  readonly avgMessagesToCheckout: number;
  /** Weekly proactive-outreach count. */
  readonly outreachWeekly: number;
}

/** The composed sales-analytics view (mirrors the flat analytics-summary API). */
export interface SalesAnalytics {
  /** The instant the view was assembled (ISO). */
  readonly now: string;
  readonly orders: SalesTodaySummary;
  /** Open (pending) carts right now. */
  readonly activeCarts: number;
  /** Customers created in the last 30 days. */
  readonly newCustomers30d: number;
  readonly whatsapp: WhatsappFunnelSummary;
}

// ── Injected dependencies ────────────────────────────────────────────────────

/** Minimal logger surface — only `.error` is used (a degraded signal). */
export interface SalesAnalyticsLog {
  error(obj: unknown, msg?: string): void;
}

/**
 * The three read accessors + `now` + a logger. Kept as thin functions so a
 * partial mock is only touched when its signal actually reads (the route passes
 * the real `medusaAdmin` / `prisma.customer.count` / Redis client; a test passes
 * fakes). `now` is injected so the today-boundary + the ISO instant are
 * deterministic under test.
 */
export interface SalesAnalyticsComposeDeps {
  /** Medusa admin JSON fetch for a path (the SAME `medusaAdmin` the route uses). */
  readonly medusaAdmin: (path: string) => Promise<unknown>;
  /** Count customers created since `since` (a `prisma.customer.count` wrapper). */
  readonly countNewCustomers: (since: Date) => Promise<number>;
  /** Read a Redis string value by key (keys are built inside via `rk()`). */
  readonly redisGet: (key: string) => Promise<string | null>;
  /** Wall-clock now — the today boundary + the snapshot instant derive from it. */
  readonly now: Date;
  readonly log: SalesAnalyticsLog;
}

// ── Resilient accessor (DRY — one place for settle→summary-or-fallback) ──────

/**
 * Map a settled read to its value, or LOG + substitute the fallback on
 * rejection. A single signal's failure degrades to its zero sub-summary, never
 * a throw — the whole resilience contract in one helper.
 */
function unwrap<T>(
  settled: PromiseSettledResult<T>,
  fallback: T,
  signal: string,
  log: SalesAnalyticsLog,
): T {
  if (settled.status === "fulfilled") {
    return settled.value;
  }
  log.error(
    { err: settled.reason, signal },
    "sales-analytics: signal read failed — degrading to zero fallback",
  );
  return fallback;
}

/** Parse a Redis integer string, or 0 when absent/empty. */
function toInt(value: string | null): number {
  return value ? Number.parseInt(value, 10) : 0;
}

/**
 * Compose today's sales analytics from the four INDEPENDENT reads. Never throws
 * — a single failing signal degrades to its zero fallback. Reimplements no
 * query: the Medusa/Prisma/Redis reads mirror the analytics-summary route's
 * exact keys + arithmetic.
 */
export async function composeSalesAnalytics(
  deps: SalesAnalyticsComposeDeps,
): Promise<SalesAnalytics> {
  const { medusaAdmin, countNewCustomers, redisGet, now, log } = deps;

  // Today boundary (midnight, local) for the orders window, and the YYYY-MM-DD
  // key suffix for the daily WA-funnel counters — both derived from injected now.
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const todayDateStr = now.toISOString().slice(0, 10);

  // Four INDEPENDENT reads, concurrent. Each async IIFE both reads AND folds its
  // result into the compact summary, so `allSettled` captures a read OR a
  // mapping failure and `unwrap` degrades exactly that one signal.
  const [ordersR, cartsR, customersR, waR] = await Promise.allSettled([
    // 1. Today's orders — count + revenue (Σ total, integer centavos) + AOV.
    (async (): Promise<SalesTodaySummary> => {
      const qs = new URLSearchParams({
        "created_at[gte]": todayIso,
        limit: "500",
        offset: "0",
        fields: "id,total,status",
      });
      const data = (await medusaAdmin(`/admin/orders?${qs}`)) as Record<
        string,
        unknown
      >;
      const orders = (data.orders ?? []) as { total?: number }[];
      const ordersCount = orders.length;
      const revenueCentavos = orders.reduce(
        (sum, o) => sum + (o.total ?? 0),
        0,
      );
      const aovCentavos =
        ordersCount > 0 ? Math.round(revenueCentavos / ordersCount) : 0;
      return { ordersCount, revenueCentavos, aovCentavos };
    })(),
    // 2. Active carts — the count of pending orders (Medusa `count`).
    (async (): Promise<number> => {
      const data = (await medusaAdmin(
        `/admin/orders?status[]=pending&limit=1&offset=0&fields=id`,
      )) as Record<string, unknown>;
      return (data.count as number) ?? 0;
    })(),
    // 3. New customers in the last 30 days.
    (async (): Promise<number> => {
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return countNewCustomers(thirtyDaysAgo);
    })(),
    // 4. WhatsApp funnel — weekly outreach + today's conversion + avg messages.
    (async (): Promise<WhatsappFunnelSummary> => {
      const [outreachVal, convsVal, waOrdersVal, avgMsgsVal] = await Promise.all(
        [
          redisGet(rk("outreach:weekly:count")),
          redisGet(rk(`metrics:conversations:daily:${todayDateStr}`)),
          redisGet(rk(`metrics:wa_orders:daily:${todayDateStr}`)),
          redisGet(rk("metrics:avg_messages_to_checkout")),
        ],
      );
      const conversations = toInt(convsVal);
      const waOrders = toInt(waOrdersVal);
      return {
        outreachWeekly: toInt(outreachVal),
        conversionRatePct:
          conversations > 0
            ? Math.round((waOrders / conversations) * 100)
            : 0,
        avgMessagesToCheckout: avgMsgsVal
          ? Math.round(Number.parseFloat(avgMsgsVal))
          : 0,
      };
    })(),
  ]);

  return {
    now: new Date().toISOString(),
    orders: unwrap(
      ordersR,
      { ordersCount: 0, revenueCentavos: 0, aovCentavos: 0 },
      "orders",
      log,
    ),
    activeCarts: unwrap(cartsR, 0, "activeCarts", log),
    newCustomers30d: unwrap(customersR, 0, "newCustomers30d", log),
    whatsapp: unwrap(
      waR,
      { conversionRatePct: 0, avgMessagesToCheckout: 0, outreachWeekly: 0 },
      "whatsapp",
      log,
    ),
  };
}
