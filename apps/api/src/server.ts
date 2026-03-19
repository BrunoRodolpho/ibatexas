import Fastify, { type FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyCookie from "@fastify/cookie";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerCors } from "./plugins/cors.js";
import { registerHelmet } from "./plugins/helmet.js";
import { registerSensible } from "./plugins/sensible.js";
import { registerSwagger } from "./plugins/swagger.js";
import { registerRateLimit } from "./plugins/rate-limit.js";
import { registerErrorHandler } from "./errors/handler.js";
import { registerRoutes } from "./routes/index.js";

export async function buildServer(): Promise<FastifyInstance> {
  // AUDIT-FIX: INFRA-14 — Add request/connection/keepAlive timeouts to prevent slowloris attacks
  // AUDIT-FIX: SEC-F13 — Enable trustProxy when behind a reverse proxy (ALB, nginx, Cloudflare)
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty", options: { colorize: true } },
    },
    trustProxy: process.env.TRUST_PROXY === "true",
    connectionTimeout: 30_000,
    requestTimeout: 60_000,
    keepAliveTimeout: 72_000,
  });

  // Zod schema validation/serialization (must be set before routes)
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  await registerHelmet(server);
  await registerCors(server);

  // Cookie parser — must be registered before JWT (JWT reads from cookies)
  await server.register(fastifyCookie);

  // JWT — reads from `token` cookie automatically when cookie is set
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret && process.env.NODE_ENV !== "test") {
    throw new Error("JWT_SECRET env var is required");
  }
  await server.register(fastifyJwt, {
    secret: jwtSecret ?? "test-secret-do-not-use-in-production",
    cookie: { cookieName: "token", signed: false },
  });

  await registerSensible(server);
  await registerSwagger(server);
  await registerRateLimit(server);

  registerErrorHandler(server);

  await registerRoutes(server);

  return server;
}
