// Public banner text — no auth required.
//
// GET /api/banner/text — current banner text
//
// Read from Redis via getBannerText(). Cached via HTTP Cache-Control (30s).

import type { FastifyInstance } from "fastify";
import { getBannerText } from "@ibatexas/tools";

export async function bannerRoutes(server: FastifyInstance): Promise<void> {
  server.get(
    "/api/banner/text",
    {
      config: { rateLimit: false },
      schema: { tags: ["banner"], summary: "Texto do banner (público)" },
    },
    async (_request, reply) => {
      const text = await getBannerText();

      void reply
        .header("Cache-Control", "public, max-age=30")
        .send({ text });
    },
  );
}
