// AUDIT-FIX: INFRA-01 — Deep health check that pings Redis, Postgres, NATS, and Typesense.
// Returns JSON with individual check results and overall status.
// HTTP 503 if any critical dependency (redis, postgres) fails; 200 otherwise.

import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { getRedisClient } from "@ibatexas/tools";
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

export async function healthRoutes(server: FastifyInstance): Promise<void> {
  server.get("/health", { schema: { tags: ["health"], summary: "Deep health check" } }, async (_request, reply) => {
    const [redis, postgres, nats, typesense] = await Promise.all([
      checkRedis(),
      checkPostgres(),
      checkNats(),
      checkTypesense(),
    ]);

    const checks = { redis, postgres, nats, typesense };

    // Critical dependencies: redis, postgres
    const criticalFail = redis === "fail" || postgres === "fail";
    // Non-critical: nats, typesense
    const anyFail = nats === "fail" || typesense === "fail";

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
    };

    // AUDIT-FIX: INFRA-01 — Return 503 if critical dependency fails
    const statusCode = criticalFail ? 503 : 200;
    return reply.status(statusCode).send(body);
  });
}
