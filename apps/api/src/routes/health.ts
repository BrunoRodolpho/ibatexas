import type { FastifyInstance } from "fastify";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require("../../package.json") as { version: string };

export async function healthRoutes(server: FastifyInstance): Promise<void> {
  server.get("/health", async () => {
    return {
      status: "ok",
      version,
      timestamp: new Date().toISOString(),
    };
  });
}
