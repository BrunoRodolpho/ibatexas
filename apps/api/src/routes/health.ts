// Deep health check that pings Redis, Postgres, NATS, and Typesense.
// Returns JSON with individual check results and overall status.
// HTTP 503 if any critical dependency (redis, postgres) fails; 200 otherwise.

import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { getRedisClient, rk } from "@ibatexas/tools";
import { prisma } from "@ibatexas/domain";
import { getNatsConnection } from "@ibatexas/nats-client";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

const HEALTH_CHECK_TIMEOUT_MS = 3_000;

type CheckResult = "ok" | "fail";

interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  timestamp: string;
  checks: {
    redis: CheckResult;
    postgres: CheckResult;
    nats: CheckResult;
    typesense: CheckResult;
  };
  dlq?: Record<string, number>;
  outbox?: Record<string, number>;
  /**
   * Environment handshake (T1a-10, D-010): present ONLY when the process was
   * booted with IBX_TEST_FINGERPRINT set — the ephemeral test profile
   * (.env.test) is the only env that sets it; dev/prod never do. The journeys
   * harness pre-flight refuses to drive any stack that does not present a
   * matching value.
   */
  testFingerprint?: string;
}

/** Run a check with a timeout. Returns "ok" on success, "fail" on error or timeout. */
async function withTimeout(fn: () => Promise<void>): Promise<CheckResult> {
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Health check timeout")), HEALTH_CHECK_TIMEOUT_MS),
      ),
    ]);
    return "ok";
  } catch {
    return "fail";
  }
}

// ── R5 rollout, webhook/chat family — this route's Redis client seam ────────
//
// The two `getRedisClient()` calls this module made inline now resolve through
// `HealthRouteDeps.redis`. This file had no composition root before; the one
// below is `redis`-only by design — Postgres, NATS and Typesense are separate
// seam questions and are untouched here.
//
// This is the file that needed an ADAPTER EXTENSION, and the only one left in
// class (c) that did: `ping` is now modelled by
// `@ibatexas/tools/testing`'s canonical in-memory client, with THIS route as
// its named production consumer (the standing rule since R5-S7 — a command
// arrives with a caller or not at all). `lLen` was already modelled.
//
// ── THE FAIL-CLOSED PICK ANALYSIS (the #539 / #543 / #548 rule) ─────────────
//
// {issued} = `ping` (the liveness probe) ∪ `lLen` (the DLQ/outbox depth
// sweep). {optionally consumed downstream} = {} — neither `checkRedis` nor
// `checkQueues` passes its client anywhere; both bind it to a function-local
// `const` and issue on it directly. No `eval` / `multi` / `evalSha` appears in
// this module's own text, and none of the other three checks touches Redis.
//
// The two commands are in ONE type on purpose even though they serve different
// endpoints of the response, because they share a client and a failure in
// either is a failure of the same dependency.
//
// ── Why both checks take the resolver rather than a resolved client ────────
//
// `checkRedis` and `checkQueues` run CONCURRENTLY under `Promise.all`, and
// each is individually failure-isolated — `checkRedis` by `withTimeout`,
// `checkQueues` by its own swallowing `catch`. Passing the FACTORY keeps the
// resolution inside each check's isolation boundary, which is where it was: a
// client resolved once in the handler and shared would make a resolution
// failure fail BOTH, turning a queue-depth outage into a liveness verdict.
//
// ── Feature detection: MEASURED, none ─────────────────────────────────────
//
// `typeof client.X === "function"` was swept over `apps/api/src/routes`,
// `apps/api/src/middleware` and `packages/tools/src`: no live Redis probe on
// any path this file reaches.

type RedisClient = Awaited<ReturnType<typeof getRedisClient>>;

/**
 * `checkRedis` — the liveness probe. `ping` only, and its RESULT is discarded:
 * the entire contract is throw / don't-throw, mapped by `withTimeout` to
 * `"fail"` / `"ok"`. Redis is a CRITICAL dependency, so that one bit is the
 * difference between HTTP 200 and HTTP 503.
 */
type HealthLivenessRedis = Pick<RedisClient, "ping">;

/**
 * `checkQueues` — the DLQ + outbox depth sweep. `lLen` only, over 12 known
 * keys. Best-effort: its `catch` swallows, so an absent command here would be
 * INVISIBLE (a clean bill of health over a real backlog) rather than loud.
 * That is the #539 shape, and it is why this Pick is declared from what the
 * function issues rather than from what a caller happens to observe.
 */
type HealthQueueDepthRedis = Pick<RedisClient, "lLen">;

/**
 * The EXHAUSTIVE union of Redis commands this route issues — the type
 * `HealthRouteDeps.redis` resolves to.
 *
 * Hand-written on purpose rather than derived from the two per-consumer types
 * above: a derived union can never disagree with its consumers, so it could
 * not catch a consumer that grew a command nobody declared (F-14).
 */
export type HealthRouteRedisClient = Pick<RedisClient, "ping" | "lLen">;

/** The collaborators `health.ts` resolves through the seam. */
export interface HealthRouteDeps {
  /**
   * Resolves the Redis client behind the liveness probe and the queue-depth
   * sweep.
   *
   * A FACTORY returning a promise, not an instance, so the `await` stays
   * exactly where it was — per CHECK, inside each check's own failure
   * isolation. See the note above on why that placement is load-bearing.
   */
  readonly redis: () => Promise<HealthRouteRedisClient>;
}

/**
 * Fastify plugin options. Overrides nest under `deps` so no member collides
 * with a Fastify-reserved register option (`prefix`, `logLevel`,
 * `logSerializers`); omitted or partial → the production default fills the
 * remainder, so the registration in routes/index.ts is unchanged.
 */
export interface HealthRoutesOptions {
  readonly deps?: Partial<HealthRouteDeps>;
}

/** The production set — byte-for-byte the resolution this file did inline. */
function defaultHealthRouteDeps(): HealthRouteDeps {
  return { redis: () => getRedisClient() };
}

function resolveHealthRouteDeps(options?: HealthRoutesOptions): HealthRouteDeps {
  return { ...defaultHealthRouteDeps(), ...(options?.deps ?? {}) };
}

async function checkRedis(
  /** The seam. REQUIRED — `withTimeout` maps any throw to `"fail"`, so a
   *  silent fallback to the singleton would be indistinguishable from a
   *  working injection at every assertion that only reads the response. */
  resolveRedis: () => Promise<HealthLivenessRedis>,
): Promise<CheckResult> {
  return withTimeout(async () => {
    const redis: HealthLivenessRedis = await resolveRedis();
    await redis.ping();
  });
}

async function checkPostgres(): Promise<CheckResult> {
  return withTimeout(async () => {
    await prisma.$queryRawUnsafe("SELECT 1");
  });
}

async function checkNats(): Promise<CheckResult> {
  return withTimeout(async () => {
    const conn = await getNatsConnection();
    if (!conn || conn.isClosed()) {
      throw new Error("NATS connection closed");
    }
  });
}

async function checkTypesense(): Promise<CheckResult> {
  return withTimeout(async () => {
    // Match packages/tools/src/typesense/client.ts: TYPESENSE_HOST is a bare
    // hostname, protocol/port are separate env vars. The old fallback was a
    // full URL, which silently broke once the compose wired in the correct
    // hostname-only form.
    const host = process.env.TYPESENSE_HOST || "localhost";
    const port = process.env.TYPESENSE_PORT || "8108";
    const protocol = process.env.TYPESENSE_PROTOCOL || "http";
    const apiKey = process.env.TYPESENSE_API_KEY || "";
    const res = await fetch(`${protocol}://${host}:${port}/health`, {
      headers: { "X-TYPESENSE-API-KEY": apiKey },
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Typesense health returned ${res.status}`);
  });
}

// Known DLQ and outbox event keys for monitoring
const DLQ_EVENTS = [
  "order.status_changed", "order.placed", "notification.send",
  "support.handoff_requested", "conversation.message.appended",
];
const OUTBOX_EVENTS = [
  "order.placed", "reservation.created", "order.status_changed",
  "order.refunded", "order.disputed", "order.canceled", "order.payment_failed",
];

/** Check DLQ and outbox queue sizes. Best-effort — never fails the health check. */
async function checkQueues(
  /** The seam. REQUIRED — this function's `catch` swallows everything, so a
   *  silent fallback would be invisible at every assertion. */
  resolveRedis: () => Promise<HealthQueueDepthRedis>,
): Promise<{ dlq: Record<string, number>; outbox: Record<string, number>; hasDlqEntries: boolean; hasOutboxBacklog: boolean }> {
  const dlq: Record<string, number> = {};
  const outbox: Record<string, number> = {};
  let hasDlqEntries = false;
  let hasOutboxBacklog = false;
  try {
    const redis: HealthQueueDepthRedis = await resolveRedis();
    for (const event of DLQ_EVENTS) {
      const len = await redis.lLen(rk(`dlq:${event}`));
      if (len > 0) { dlq[event] = len; hasDlqEntries = true; }
    }
    for (const event of OUTBOX_EVENTS) {
      // Hard Rule #7 — through `rk()`, like the dlq loop above. This used to
      // interpolate `process.env.APP_ENV || "development"` inline, which made
      // this the only reader of the outbox key family using `||`: canonical
      // `rk` and the WRITER (`outboxKey` in @ibatexas/nats-client, called with
      // `?? "development"`) both treat an empty APP_ENV as PRESENT, so on an
      // empty APP_ENV the route read `development:outbox:…` while the writer
      // wrote `:outbox:…` — a clean bill of health over a real backlog, and
      // two namespaces inside this one function. `rk("outbox:" + event)` is
      // byte-identical to `outboxKey(process.env.APP_ENV ?? "development",
      // event)` for EVERY value of APP_ENV, empty and unset included.
      const len = await redis.lLen(rk(`outbox:${event}`));
      if (len > 0) { outbox[event] = len; if (len > 100) hasOutboxBacklog = true; }
    }
  } catch { /* non-fatal */ }
  return { dlq, outbox, hasDlqEntries, hasOutboxBacklog };
}

export async function healthRoutes(
  server: FastifyInstance,
  options?: HealthRoutesOptions,
): Promise<void> {
  // Resolved ONCE per registration. The member is a factory, so NOTHING is
  // resolved here — each check still awaits the client itself.
  const deps = resolveHealthRouteDeps(options);

  server.get("/health", { config: { rateLimit: false }, logLevel: "silent" as const, schema: { tags: ["health"], summary: "Deep health check" } }, async (request, reply) => {
    const [redis, postgres, nats, typesense, queues] = await Promise.all([
      checkRedis(deps.redis),
      checkPostgres(),
      checkNats(),
      checkTypesense(),
      checkQueues(deps.redis),
    ]);

    const checks = { redis, postgres, nats, typesense };

    // Critical dependencies: redis, postgres
    const criticalFail = redis === "fail" || postgres === "fail";
    // Non-critical: nats, typesense, DLQ entries, outbox backlog
    const anyFail = nats === "fail" || typesense === "fail" || queues.hasDlqEntries || queues.hasOutboxBacklog;

    let status: HealthResponse["status"];
    if (criticalFail) {
      status = "unhealthy";
    } else if (anyFail) {
      status = "degraded";
    } else {
      status = "healthy";
    }

    // Test-profile fingerprint (read per request so it can never be cached
    // from a stale boot). Empty string counts as unset — never expose it.
    const testFingerprint = process.env.IBX_TEST_FINGERPRINT;

    const body: HealthResponse = {
      status,
      version,
      timestamp: new Date().toISOString(),
      checks,
      ...(Object.keys(queues.dlq).length > 0 && { dlq: queues.dlq }),
      ...(Object.keys(queues.outbox).length > 0 && { outbox: queues.outbox }),
      ...(testFingerprint ? { testFingerprint } : {}),
    };

    // Only log when something is wrong — healthy polls are silent
    if (criticalFail) {
      request.log.error({ checks }, "[health] UNHEALTHY");
    } else if (anyFail) {
      request.log.warn({ checks }, "[health] DEGRADED");
    }

    // Return 503 if critical dependency fails
    const statusCode = criticalFail ? 503 : 200;
    return reply.status(statusCode).send(body);
  });
}
