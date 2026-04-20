import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { prisma } from "@ibatexas/domain";

export async function reviewRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // GET /api/admin/reviews
  app.get(
    "/api/admin/reviews",
    {
      schema: {
        tags: ["admin"],
        summary: "Listar todas as avaliações (admin)",
        querystring: z.object({
          rating: z.coerce.number().int().min(1).max(5).optional(),
          productId: z.string().optional(),
          page: z.coerce.number().int().min(1).optional().default(1),
          limit: z.coerce.number().int().min(1).max(100).optional().default(20),
        }),
        response: {
          200: z.object({
            reviews: z.array(
              z.object({
                id: z.string(),
                orderId: z.string(),
                productId: z.string().nullable(),
                customerId: z.string(),
                customerPhone: z.string().nullable(),
                rating: z.number(),
                comment: z.string().nullable(),
                channel: z.string(),
                createdAt: z.string(),
              }),
            ),
            total: z.number(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { rating, productId, page, limit } = request.query as {
        rating?: number
        productId?: string
        page: number
        limit: number
      };

      const where: Record<string, unknown> = {};
      if (rating !== undefined) where.rating = rating;
      if (productId) where.productId = productId;

      const offset = (page - 1) * limit;

      const [reviews, total] = await Promise.all([
        prisma.review.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
          include: {
            customer: { select: { id: true, name: true, phone: true } },
          },
        }),
        prisma.review.count({ where }),
      ]);

      return reply.send({
        reviews: reviews.map((r) => ({
          id: r.id,
          orderId: r.orderId,
          productId: r.productId,
          customerId: r.customerId,
          customerPhone: r.customer?.phone
            ? `****${r.customer.phone.slice(-4)}`
            : null,
          rating: r.rating,
          comment: r.comment,
          channel: r.channel,
          createdAt: r.createdAt.toISOString(),
        })),
        total,
      });
    },
  );
}
