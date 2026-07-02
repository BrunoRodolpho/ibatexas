import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyCookie from "@fastify/cookie";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerSentry } from "./plugins/sentry.js";
import { registerCors } from "./plugins/cors.js";
import { registerHelmet } from "./plugins/helmet.js";
import { registerSensible } from "./plugins/sensible.js";
import { registerSwagger } from "./plugins/swagger.js";
import { registerRateLimit } from "./plugins/rate-limit.js";
import { genRequestId, registerRequestId } from "./plugins/request-id.js";
import { installKernelMetricsSink } from "./plugins/kernel-bootstrap.js";
import { parseBoolEnv } from "@ibatexas/types";
import { registerErrorHandler } from "./errors/handler.js";
import { registerRoutes } from "./routes/index.js";
import { metricsRoutes } from "./routes/metrics.js";
import { requireSecret } from "./utils/require-secret.js";
import { buildMultistreamLogger } from "./observability/log-streams.js";

export async function buildServer(): Promise<FastifyInstance> {
  // When the obs stack is up (VICTORIALOGS_URL set), log through a multistream
  // (raw JSON → VictoriaLogs + human → stdout); otherwise keep the single
  // pretty/raw transport. Fastify v5 takes a pre-built instance via
  // `loggerInstance` and plain options via `logger` — exactly one of the two.
  const multistreamLogger = buildMultistreamLogger();

  // Request/connection timeouts prevent slowloris; trustProxy for reverse proxy (ALB, nginx)
  // The options object is annotated FastifyServerOptions so the conditional
  // logger wiring below doesn't leak a concrete pino.Logger into Fastify's
  // logger generic (it stays the default FastifyBaseLogger the routes expect).
  const serverOptions: FastifyServerOptions = {
    // NEW-P1-ENV: was `=== "true"` — silently rejected "TRUE", "1", "yes".
    // parseBoolEnv accepts the canonical truthy lexicon.
    trustProxy: parseBoolEnv(process.env.TRUST_PROXY, false),
    connectionTimeout: 30_000,
    requestTimeout: 60_000,
    keepAliveTimeout: 72_000,
    // OBS-001: Use client-provided x-request-id or generate a UUID for distributed tracing
    genReqId: genRequestId,
    // SIGNAL-1: Fastify's per-request autolog ("incoming request"/"request
    // completed") was ~66% of all VictoriaLogs volume — dominated by /metrics
    // scrapes + /health probes that no human reads. Disable it and emit ONE
    // signal-only access line per request via the onResponse hook below.
    disableRequestLogging: true,
  };
  if (multistreamLogger) {
    // Obs stack up: log through the multistream (raw JSON → VictoriaLogs +
    // human → stdout). Fastify v5 takes a pre-built instance via loggerInstance.
    serverOptions.loggerInstance = multistreamLogger;
  } else {
    serverOptions.logger = {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty", options: { colorize: true } },
    };
  }

  const server = Fastify(serverOptions);

  // SIGNAL-1: signal-only access log (replaces Fastify's disabled autolog).
  // Emits ONE line per request, tagged `component:http` so VMUI can slice it,
  // and DROPS the /metrics + /health scrape/probe noise unless it errored or
  // was slow. Net effect: ~2/3 of prior VictoriaLogs volume disappears while
  // every genuinely interesting request (4xx/5xx, or > SLOW_REQUEST_MS) stays.
  const REQUEST_LOG_SKIP = new Set(["/metrics", "/health"]);
  const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS ?? 1000);
  server.addHook("onResponse", (req, reply, done) => {
    const path = req.url.split("?")[0];
    const status = reply.statusCode;
    const ms = reply.elapsedTime; // Fastify v5 per-request wall time (ms)
    if (REQUEST_LOG_SKIP.has(path) && status < 400 && ms < SLOW_REQUEST_MS) {
      return done();
    }
    // Level MIRRORS status so `level:error` / `level:warn` failure queries work
    // (a 5xx tagged event:request_error at info would be invisible to them).
    req.log[status >= 500 ? "error" : status >= 400 ? "warn" : "info"](
      {
        component: "http",
        event:
          status >= 500
            ? "request_error"
            : status >= 400
              ? "request_warn"
              : "request",
        method: req.method,
        path,
        statusCode: status,
        durationMs: Math.round(ms),
      },
      `${req.method} ${path} ${status} ${Math.round(ms)}ms`,
    );
    done();
  });

  // Zod schema validation/serialization (must be set before routes)
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  // Sentry error tracking — must be registered before routes/hooks
  await registerSentry(server);

  // Kernel MetricsSink — install before routes so the first adjudicate() call
  // already has a producer for the 8 audit_* PostHog events + Prometheus
  // counters. Registry is reused by the /metrics scrape route below.
  const kernelRegister = installKernelMetricsSink();

  // OBS-001: Request ID — Sentry tagging + response header (genReqId set above)
  registerRequestId(server);

  await registerHelmet(server);
  await registerCors(server);

  // Cookie parser — must be registered before JWT (JWT reads from cookies)
  await server.register(fastifyCookie);

  // JWT — JWTSPLIT (audit): customer and staff tiers use SEPARATE signing
  // secrets + audiences, so a leak of one tier's secret cannot forge the other,
  // and a token minted for one tier is cryptographically invalid for the other
  // (defense BELOW the application-level `userType` and `aud` checks in
  // middleware/auth.ts). Customer = the DEFAULT instance: request.jwtVerify()
  // auto-reads the `token` cookie; server.jwt.sign issues customer tokens;
  // allowedAud rejects any non-customer token at the crypto layer.
  const jwtSecret = requireSecret("JWT_SECRET");
  await server.register(fastifyJwt, {
    secret: jwtSecret,
    cookie: { cookieName: "token", signed: false },
    verify: { allowedAud: "token" },
  });

  // Staff = a dedicated NAMESPACED instance reachable at server.jwt.staff.{sign,
  // verify} (used by middleware/auth.ts staff path + routes/auth.ts
  // issueStaffJwtToken). MUST register AFTER the default instance — @fastify/jwt
  // only installs the shared `jwt`/`user` decorators on the first (non-namespaced)
  // registration; reversing the order double-decorates and throws at boot.
  const staffJwtSecret = requireSecret("STAFF_JWT_SECRET");
  if (staffJwtSecret === jwtSecret) {
    // The entire point of the split is two distinct keys — fail closed if equal.
    throw new Error(
      "STAFF_JWT_SECRET must differ from JWT_SECRET (separate staff/customer signing keys)",
    );
  }
  await server.register(fastifyJwt, {
    secret: staffJwtSecret,
    namespace: "staff",
    verify: { allowedAud: "staff_token" },
  });

  await registerSensible(server);
  await registerSwagger(server);
  await registerRateLimit(server);

  registerErrorHandler(server);

  // Prometheus scrape endpoint — registered before the rest of the routes so
  // it is unaffected by domain-route middleware ordering. Auth is enforced
  // inside the handler via PROMETHEUS_TOKEN.
  await server.register(metricsRoutes({ register: kernelRegister }));

  await registerRoutes(server);

  return server;
}
