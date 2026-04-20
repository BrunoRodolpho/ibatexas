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

async function checkRedis(): Promise<CheckResult> {
  return withTimeout(async () => {
    const redis = await getRedisClient();
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
    const host = process.env.TYPESENSE_HOST || "http://localhost:8108";
    const apiKey = process.env.TYPESENSE_API_KEY || "";
    const res = await fetch(`${host}/health`, {
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
async function checkQueues(): Promise<{ dlq: Record<string, number>; outbox: Record<string, number>; hasDlqEntries: boolean; hasOutboxBacklog: boolean }> {
  const dlq: Record<string, number> = {};
  const outbox: Record<string, number> = {};
  let hasDlqEntries = false;
  let hasOutboxBacklog = false;
  try {
    const redis = await getRedisClient();
    const envPrefix = process.env.APP_ENV || "development";
    for (const event of DLQ_EVENTS) {
      const len = await redis.lLen(rk(`dlq:${event}`));
      if (len > 0) { dlq[event] = len; hasDlqEntries = true; }
    }
    for (const event of OUTBOX_EVENTS) {
      const key = `${envPrefix}:outbox:${event}`;
      const len = await redis.lLen(key);
      if (len > 0) { outbox[event] = len; if (len > 100) hasOutboxBacklog = true; }
    }
  } catch { /* non-fatal */ }
  return { dlq, outbox, hasDlqEntries, hasOutboxBacklog };
}

export async function healthRoutes(server: FastifyInstance): Promise<void> {
  server.get("/health", { config: { rateLimit: false }, logLevel: "silent" as const, schema: { tags: ["health"], summary: "Deep health check" } }, async (request, reply) => {
    const [redis, postgres, nats, typesense, queues] = await Promise.all([
      checkRedis(),
      checkPostgres(),
      checkNats(),
      checkTypesense(),
      checkQueues(),
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

    const body: HealthResponse = {
      status,
      version,
      timestamp: new Date().toISOString(),
      checks,
      ...(Object.keys(queues.dlq).length > 0 && { dlq: queues.dlq }),
      ...(Object.keys(queues.outbox).length > 0 && { outbox: queues.outbox }),
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
