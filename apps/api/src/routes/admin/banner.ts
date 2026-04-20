// Admin banner CRUD — manage the curved banner text on the homepage.
//
// GET    /api/admin/banner  — read current text
// PUT    /api/admin/banner  — update text (manager+)
// DELETE /api/admin/banner  — clear text (manager+)

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getBannerText, setBannerText, clearBannerText } from "@ibatexas/tools";
import { requireManagerRole } from "../../middleware/staff-auth.js";

const BannerBody = z.object({
  text: z.string().min(1, "Texto obrigatório").max(500, "Máximo 500 caracteres"),
});

export async function adminBannerRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Read current banner text
  app.get(
    "/api/admin/banner",
    { schema: { tags: ["admin"], summary: "Ler texto do banner" } },
    async (_request, reply) => {
      const text = await getBannerText();
      return reply.send({ text });
    },
  );

  // Update banner text (manager/owner only)
  app.put(
    "/api/admin/banner",
    {
      preHandler: requireManagerRole,
      schema: {
        tags: ["admin"],
        summary: "Atualizar texto do banner",
        body: BannerBody,
      },
    },
    async (request, reply) => {
      const { text } = request.body as z.infer<typeof BannerBody>;
      await setBannerText(text);
      return reply.send({ ok: true });
    },
  );

  // Clear banner text (manager/owner only)
  app.delete(
    "/api/admin/banner",
    {
      preHandler: requireManagerRole,
      schema: { tags: ["admin"], summary: "Limpar texto do banner" },
    },
    async (_request, reply) => {
      await clearBannerText();
      return reply.send({ ok: true });
    },
  );
}
