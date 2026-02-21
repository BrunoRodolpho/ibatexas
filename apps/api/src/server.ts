import Fastify, { type FastifyInstance } from "fastify";
import { registerCors } from "./plugins/cors.js";
import { registerHelmet } from "./plugins/helmet.js";
import { registerSensible } from "./plugins/sensible.js";
import { registerErrorHandler } from "./errors/handler.js";
import { registerRoutes } from "./routes/index.js";

export async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  await registerHelmet(server);
  await registerCors(server);
  await registerSensible(server);

  registerErrorHandler(server);

  await registerRoutes(server);

  return server;
}
