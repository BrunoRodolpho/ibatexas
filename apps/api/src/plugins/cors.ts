import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

function resolveOrigin(): string | string[] | RegExp[] | true {
  // Explicit CORS_ORIGIN takes priority (comma-separated list supported)
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    return corsOrigin.includes(",")
      ? corsOrigin.split(",").map((o) => o.trim())
      : corsOrigin;
  }

  if (process.env.NODE_ENV !== "production") {
    // Allow localhost + private/shared LAN IPs for mobile device testing.
    // Covers RFC 1918 (10.x, 172.16-31.x, 192.168.x) and RFC 6598 CGNAT (100.64-127.x).
    // Safe even if misconfigured: these IPs can't be routed from the public internet.
    return [
      /^http:\/\/localhost(:\d+)?$/,
      /^http:\/\/127\.0\.0\.1(:\d+)?$/,
      /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/,
      /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
      /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
      /^http:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
    ];
  }

  const webUrl = process.env.WEB_URL;
  if (!webUrl) {
    throw new Error("WEB_URL environment variable is required in production");
  }
  return webUrl;
}

export async function registerCors(server: FastifyInstance): Promise<void> {
  await server.register(cors, {
    origin: resolveOrigin(),
    credentials: true,
  });
}
