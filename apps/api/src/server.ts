import Fastify, { type FastifyInstance } from "fastify";
import { multistream, stdTimeFunctions } from "pino";
import fastifyJwt from "@fastify/jwt";
import fastifyCookie from "@fastify/cookie";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { buildLogStreams } from "./lib/logger.js";
import { registerSentry } from "./plugins/sentry.js";
import { registerCors } from "./plugins/cors.js";
import { registerHelmet } from "./plugins/helmet.js";
import { registerSensible } from "./plugins/sensible.js";
import { registerSwagger } from "./plugins/swagger.js";
import { registerRateLimit } from "./plugins/rate-limit.js";
import { genRequestId, registerRequestId } from "./plugins/request-id.js";
import { registerAccessLog } from "./plugins/access-log.js";
import { registerErrorHandler } from "./errors/handler.js";
import { registerRoutes } from "./routes/index.js";
import { requireSecret } from "./utils/require-secret.js";
import { JWT_AUDIENCE_CUSTOMER, JWT_AUDIENCE_STAFF } from "./jwt-audiences.js";

export async function buildServer(): Promise<FastifyInstance> {
  // Request/connection timeouts prevent slowloris; trustProxy for reverse proxy (ALB, nginx)
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      timestamp: stdTimeFunctions.isoTime,
      // Same fan-out as the standalone logger: pretty-in-dev / json-in-prod to
      // the terminal, plus failure-isolated shipping to VictoriaLogs when
      // VICTORIALOGS_URL is set. Fastify keeps its req/res/err serializers.
      stream: multistream(buildLogStreams()),
    },
    // Suppress the built-in "incoming request"/"request completed" pair on EVERY
    // request (OPTIONS preflight + 20–30s health/admin polls drowned the signal).
    // registerAccessLog below replaces it with a hook that only logs 4xx/5xx/slow.
    // (Top-level Fastify option, NOT a logger sub-option.)
    disableRequestLogging: true,
    trustProxy: process.env.TRUST_PROXY === "true",
    connectionTimeout: 30_000,
    requestTimeout: 60_000,
    keepAliveTimeout: 72_000,
    // OBS-001: Use client-provided x-request-id or generate a UUID for distributed tracing
    genReqId: genRequestId,
  });

  // Zod schema validation/serialization (must be set before routes)
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  // Sentry error tracking — must be registered before routes/hooks
  await registerSentry(server);

  // OBS-001: Request ID — Sentry tagging + response header (genReqId set above)
  registerRequestId(server);

  // Access log — replaces Fastify's disabled default request logging; only emits
  // for 4xx/5xx/slow responses (skips OPTIONS + benign polls). See plugins/access-log.ts.
  registerAccessLog(server);

  await registerHelmet(server);
  await registerCors(server);

  // Cookie parser — must be registered before JWT (JWT reads from cookies)
  await server.register(fastifyCookie);

  // JWT — JWTSPLIT (audit): customer and staff tiers use SEPARATE signing secrets +
  // audiences, so a leak of one tier's secret cannot forge the other, and a token minted
  // for one tier is cryptographically invalid for the other (defense beyond the
  // application-level `userType` claim check).
  //
  // Customer = the DEFAULT instance: request.jwtVerify() auto-reads the `token` cookie;
  // server.jwt.sign issues customer tokens; allowedAud rejects any non-customer token.
  // (The customer `aud` is set per-call in issueJwtToken — @fastify/jwt drops
  // registration-level sign options whenever a per-call options object is supplied.)
  const jwtSecret = requireSecret("JWT_SECRET");
  await server.register(fastifyJwt, {
    secret: jwtSecret,
    cookie: { cookieName: "token", signed: false },
    verify: { allowedAud: JWT_AUDIENCE_CUSTOMER },
  });

  // Staff = a dedicated NAMESPACED instance reachable at server.jwt.staff.{sign,verify}
  // (read by middleware/auth.ts staff path + routes/auth.ts issueStaffJwtToken). No cookie
  // config: the staff path reads `staff_token` and verifies it explicitly. MUST register
  // AFTER the default instance — @fastify/jwt only sets up the shared `jwt`/`user`
  // decorators on the first (non-namespaced) registration; reversing the order
  // double-decorates and throws at boot.
  const staffJwtSecret = requireSecret("STAFF_JWT_SECRET");
  if (staffJwtSecret === jwtSecret) {
    // The entire point of the split is two distinct keys — fail closed if they coincide.
    throw new Error(
      "STAFF_JWT_SECRET must differ from JWT_SECRET (separate staff/customer signing keys)",
    );
  }
  await server.register(fastifyJwt, {
    secret: staffJwtSecret,
    namespace: "staff",
    verify: { allowedAud: JWT_AUDIENCE_STAFF },
  });

  await registerSensible(server);
  await registerSwagger(server);
  await registerRateLimit(server);

  registerErrorHandler(server);

  await registerRoutes(server);

  return server;
}
