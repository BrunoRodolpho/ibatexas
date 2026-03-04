// submit_review tool
// Creates a Review in Prisma, updates aggregate rating in Typesense,
// and publishes ibatexas.review.submitted NATS event.

import type { AgentContext } from "@ibatexas/types";
import { prisma } from "@ibatexas/domain";
import { getTypesenseClient, COLLECTION } from "../typesense/client.js";
import { publishNatsEvent } from "@ibatexas/nats-client";

export interface SubmitReviewInput {
  productId: string;
  orderId: string;
  rating: number; // 1–5
  comment?: string;
}

export async function submitReview(
  input: SubmitReviewInput,
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }> {
  if (!ctx.customerId) {
    throw new Error("Autenticação necessária para enviar avaliação.");
  }

  const { productId, orderId, rating, comment } = input;

  if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
    return { success: false, message: "Avaliação deve ser entre 1 e 5 estrelas." };
  }

  // Create/upsert review in Prisma
  await prisma.review.upsert({
    where: { orderId_customerId: { orderId, customerId: ctx.customerId } },
    create: {
      orderId,
      productId,
      productIds: [productId],
      customerId: ctx.customerId,
      rating,
      comment: comment ?? null,
      channel: ctx.channel,
    },
    update: { rating, comment: comment ?? null },
  });

  // Recompute aggregate rating from all reviews for this product
  const stats = await prisma.review.aggregate({
    where: { productId },
    _avg: { rating: true },
    _count: { rating: true },
  });

  const avgRating = stats._avg.rating ?? rating;
  const reviewCount = stats._count.rating;

  // Update Typesense document
  const typesense = getTypesenseClient();
  try {
    await typesense
      .collections<Record<string, unknown>>(COLLECTION)
      .documents(productId)
      .update({ rating: avgRating, reviewCount });
  } catch {
    // Non-fatal: product may not be in Typesense yet
  }

  // Publish NATS event
  await publishNatsEvent("ibatexas.review.submitted", {
    eventType: "review.submitted",
    productId,
    orderId,
    customerId: ctx.customerId,
    rating,
    reviewCount,
    newAvgRating: avgRating,
  });

  const stars = "⭐".repeat(rating);
  return {
    success: true,
    message: `Avaliação enviada! ${stars} Obrigado pelo seu feedback.`,
  };
}

export const SubmitReviewTool = {
  name: "submit_review",
  description:
    "Envia a avaliação do cliente para um produto após a entrega. Rating entre 1 e 5 estrelas.",
  inputSchema: {
    type: "object",
    properties: {
      productId: { type: "string", description: "ID do produto avaliado" },
      orderId: { type: "string", description: "ID do pedido ao qual o produto pertence" },
      rating: { type: "number", description: "Nota de 1 a 5 estrelas" },
      comment: { type: "string", description: "Comentário opcional" },
    },
    required: ["productId", "orderId", "rating"],
  },
} as const;
