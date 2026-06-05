import Fastify, { type FastifyInstance } from "fastify";
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

export async function buildServer(): Promise<FastifyInstance> {
  // Request/connection timeouts prevent slowloris; trustProxy for reverse proxy (ALB, nginx)
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty", options: { colorize: true } },
    },
    // NEW-P1-ENV: was `=== "true"` — silently rejected "TRUE", "1", "yes".
    // parseBoolEnv accepts the canonical truthy lexicon.
    trustProxy: parseBoolEnv(process.env.TRUST_PROXY, false),
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

  // JWT — reads from `token` cookie automatically when cookie is set
  const jwtSecret = requireSecret("JWT_SECRET");
  await server.register(fastifyJwt, {
    secret: jwtSecret,
    cookie: { cookieName: "token", signed: false },
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
