import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

export async function healthRoutes(server: FastifyInstance): Promise<void> {
  server.get("/health", { schema: { tags: ["health"], summary: "Health check" } }, async () => {
    return {
      status: "ok",
      version,
      timestamp: new Date().toISOString(),
    };
  });
}
