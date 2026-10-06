// R5 rollout, webhook/chat family — `routes/health.ts`'s Redis-client seam,
// BORN GUARDED.
//
// This is the file that needed the ADAPTER EXTENSION, and the only one left in
// class (c) that did: `ping` is now modelled by `@ibatexas/tools/testing`'s
// canonical in-memory client, with this route as its named production consumer.
//
// Two sites, two Picks, and the resolver is passed to each check rather than
// resolved once in the handler:
//
//   `checkRedis(resolveRedis)`   `ping`   the liveness probe
//   `checkQueues(resolveRedis)`  `lLen`   the DLQ + outbox depth sweep
//
// They run CONCURRENTLY under `Promise.all` and are individually
// failure-isolated, which is why the FACTORY is threaded rather than a
// resolved client — see the route's seam note.
//
// ── The liveness pin is DIRECTIONAL, because a health check's whole job is
//    to be wrong in the right direction ──────────────────────────────────────
//
// `checkRedis` discards `ping`'s return value. Its entire contract is
// throw / don't-throw, mapped by `withTimeout` to `"fail"` / `"ok"`, and Redis
// is a CRITICAL dependency — so that one bit is the difference between HTTP
// 200 and HTTP 503 on the endpoint every prober and load balancer reads. A
// suite that only pins a PASSING ping would stay green against a route that
// can no longer report an outage at all, which is the exact failure a health
// check exists to prevent.
//
// So the FAILING ping is pinned first, and the passing one is its control in
// the same describe. The failure is driven by a client whose `ping` REJECTS —
// which is what a real outage hands `checkRedis` — rather than by a knob on
// the adapter. That is deliberate: this adapter cannot lose a connection, and
// a `failNextPing()` switch would be invented surface no production caller can
// trigger. The rejecting client WRAPS the adapter (spy-delegate) so every
// other command keeps its real semantics.
//
// ── Why the decoy/injected pair ──────────────────────────────────────────────
//
// `decoy` is what `getRedisClient()` returns and nothing in an injected case
// may touch it; `injected` is what `deps.redis` hands over. The DEFAULT arms
// are what make the injected cases non-vacuous, are NOT themselves seam
// evidence, and are EXCLUDED from the revert-to-red counts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";

// Assigned in beforeEach. The `vi.mock` factory closes over it LAZILY.
let decoy: InMemoryRedis;

const FROZEN = 1_700_000_000_000;

vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return { ...real, getRedisClient: vi.fn(async () => decoy.client) };
});

// The three non-Redis checks. Each is stubbed to SUCCEED so every verdict this
// file reads is attributable to Redis alone — a failing Postgres would also
// produce a 503 and would make the liveness pin unable to tell which
// dependency it measured.
vi.mock("@ibatexas/domain", () => ({
  prisma: { $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]) },
}));

vi.mock("@ibatexas/nats-client", () => ({
  getNatsConnection: vi.fn(async () => ({ isClosed: () => false })),
}));

function freshInjected(): InMemoryRedis {
  return createInMemoryRedis({ now: () => FROZEN });
}

/**
 * `injected` omitted ⇒ the DEFAULT arm: no `deps.redis`, so the route must
 * fall back to `getRedisClient()` — i.e. the decoy.
 */
async function buildServer(
  injected?: { client: unknown },
): Promise<FastifyInstance> {
  const { healthRoutes } = await import("../health.js");
  const app = Fastify({ logger: false });
  await app.register(healthRoutes, {
    deps: injected
      ? { redis: async () => injected.client as never }
      : undefined,
  });
  await app.ready();
  return app;
}

interface HealthBody {
  status: string;
  checks: { redis: string; postgres: string; nats: string; typesense: string };
  dlq?: Record<string, number>;
  outbox?: Record<string, number>;
}

async function getHealth(app: FastifyInstance): Promise<{ statusCode: number; body: HealthBody }> {
  const res = await app.inject({ method: "GET", url: "/health" });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as HealthBody };
}

beforeEach(() => {
  vi.clearAllMocks();
  decoy = createInMemoryRedis({ now: () => FROZEN });
  // Typesense is reached over `fetch`. Stubbed OK so it never contributes a
  // "degraded" verdict this file would then have to explain away.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // Deliberately NO `vi.resetModules()` — see #548's counterfeit-signal note.
});

// ═══════════════════════════════════════════════════════════════════════════
// checkRedis — `ping`, the liveness probe
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — health liveness probe drives the INJECTED client", () => {
  it("[directional — a FAILING ping turns the endpoint 503] a client whose ping rejects reports redis:fail and unhealthy, while a healthy client in the SAME test reports 200", async () => {
    const injected = freshInjected();

    // A spy-delegate that WRAPS the adapter: every other command keeps its
    // real semantics, and only `ping` is made to fail — which is how a real
    // Redis outage reaches `checkRedis`.
    const failing = {
      client: new Proxy(injected.client as object, {
        get(target, prop) {
          if (prop === "ping") {
            return vi.fn(async () => {
              throw new Error("ECONNREFUSED");
            });
          }
          return Reflect.get(target, prop) as unknown;
        },
      }),
    };

    const sickApp = await buildServer(failing);
    try {
      const sick = await getHealth(sickApp);
      // The whole point: an unreachable Redis must be VISIBLE.
      expect(sick.body.checks.redis).toBe("fail");
      expect(sick.body.status).toBe("unhealthy");
      expect(sick.statusCode).toBe(503);
      // …and it must be Redis that caused it, not a collaborator.
      expect(sick.body.checks.postgres).toBe("ok");
    } finally {
      await sickApp.close();
    }

    // The CONTROL, in the SAME test. Without it, "503" is equally satisfied by
    // a route that reports every dependency dead — including a healthy one.
    const healthyApp = await buildServer(injected);
    try {
      const well = await getHealth(healthyApp);
      expect(well.body.checks.redis).toBe("ok");
      expect(well.body.status).toBe("healthy");
      expect(well.statusCode).toBe(200);
    } finally {
      await healthyApp.close();
    }
  });

  it("issues PING on the INJECTED client and never touches the singleton", async () => {
    const injected = freshInjected();
    const app = await buildServer(injected);
    try {
      const res = await getHealth(app);
      expect(res.body.checks.redis).toBe("ok");

      // This is the ONE check in the route that writes nothing, so the call
      // log is the only evidence it ran at all — a keyspace assertion is
      // structurally unavailable here.
      expect(injected.calls.filter((c) => c.command === "ping")).toHaveLength(1);
      // Filtered to `ping`, NOT a bare `decoy.calls` length. The two checks
      // share a request, so an unfiltered assertion here would also red when
      // the OTHER seam (checkQueues) is broken — which would make the
      // revert-to-red attribution unreadable: every experiment would red every
      // case. Each assertion names the command of the seam it belongs to.
      expect(decoy.calls.filter((c) => c.command === "ping")).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("[default arm — EXCLUDED from the RTR counts] with no deps.redis the probe runs on the SINGLETON", async () => {
    const app = await buildServer();
    try {
      const res = await getHealth(app);
      expect(res.body.checks.redis).toBe("ok");
      expect(decoy.calls.filter((c) => c.command === "ping")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// checkQueues — `lLen`, the DLQ + outbox depth sweep
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — health queue-depth sweep drives the INJECTED client", () => {
  it("[directional — a real BACKLOG on the injected keyspace degrades the verdict] a DLQ entry surfaces in the body and flips healthy to degraded, while an empty keyspace in the SAME test stays healthy", async () => {
    const { rk } = await import("@ibatexas/tools");

    // The empty-keyspace CONTROL first, so "degraded" cannot be the file's
    // default state.
    const empty = freshInjected();
    const emptyApp = await buildServer(empty);
    try {
      const res = await getHealth(emptyApp);
      expect(res.body.status).toBe("healthy");
      expect(res.body.dlq).toBeUndefined();
      expect(res.statusCode).toBe(200);
    } finally {
      await emptyApp.close();
    }

    const injected = freshInjected();
    // A REAL list on the injected keyspace — `lLen` reads its true length.
    // This is what a constant-answering double cannot do: it would report the
    // same depth for an empty queue and a backlogged one.
    await injected.client.lPush(rk("dlq:order.placed"), "failure-1");
    await injected.client.lPush(rk("dlq:order.placed"), "failure-2");

    const app = await buildServer(injected);
    try {
      const res = await getHealth(app);
      expect(res.body.dlq).toEqual({ "order.placed": 2 });
      // A DLQ entry is non-critical, so the endpoint stays 200 — but it must
      // stop claiming to be healthy.
      expect(res.body.status).toBe("degraded");
      expect(res.statusCode).toBe(200);
      // Redis itself is fine; only the queue depth degraded the verdict.
      expect(res.body.checks.redis).toBe("ok");
      // Filtered to `lLen` — this seam's command. See the note in the liveness
      // case for why an unfiltered length would destroy the RTR attribution.
      expect(decoy.calls.filter((c) => c.command === "lLen")).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("reads the OUTBOX family off the injected keyspace under the same rk() namespace the writer uses", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    await injected.client.lPush(rk("outbox:reservation.created"), "pending-1");

    const app = await buildServer(injected);
    try {
      const res = await getHealth(app);
      expect(res.body.outbox).toEqual({ "reservation.created": 1 });
      expect(decoy.calls.filter((c) => c.command === "lLen")).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("[default arm — EXCLUDED from the RTR counts] with no deps.redis the sweep runs on the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    await decoy.client.lPush(rk("dlq:order.placed"), "failure-1");

    const app = await buildServer();
    try {
      const res = await getHealth(app);
      expect(res.body.dlq).toEqual({ "order.placed": 1 });
    } finally {
      await app.close();
    }
  });
});
