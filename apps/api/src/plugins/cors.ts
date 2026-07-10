import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

// Dev origins: localhost + private/shared LAN IPs (mobile device testing).
// Covers RFC 1918 (10.x, 172.16-31.x, 192.168.x) and RFC 6598 CGNAT
// (100.64-127.x). Safe even if misconfigured: these IPs can't be routed from
// the public internet.
const DEV_ORIGINS: RegExp[] = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/,
  /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
  /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
  /^http:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(:\d+)?$/,
];

function resolveOrigin(): (string | RegExp)[] | string {
  const explicit = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  // Dev: ALWAYS allow localhost/LAN, plus any explicit CORS_ORIGIN entries. This
  // is what lets local dev tools on any port (e.g. the qa-viewer Investigation
  // Workbench on :3010 → api :3001) work without enumerating every port in
  // CORS_ORIGIN. Previously an explicit CORS_ORIGIN shadowed the dev regexes,
  // which silently blocked the cross-origin dev bridge.
  if (process.env.NODE_ENV !== "production") {
    return [...DEV_ORIGINS, ...explicit];
  }

  // Production: explicit CORS_ORIGIN wins; otherwise the public web URL.
  if (explicit.length > 0) return explicit.length === 1 ? explicit[0]! : explicit;
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
    // Standard REST verbs. The default omitted PUT/PATCH/DELETE, which blocked
    // the dev qa-control bridge's prompt-override save (PUT) / revert (DELETE)
    // cross-origin preflight. Allow-methods is not a security boundary (auth is
    // separate); this just lets browsers issue the requests the API already has.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
}
