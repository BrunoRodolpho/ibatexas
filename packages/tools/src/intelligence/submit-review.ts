// submit_review tool
// Creates a Review via CustomerService, updates aggregate rating in Typesense,
// and publishes review.submitted NATS event.

import { SubmitReviewInputSchema, NonRetryableError, type SubmitReviewInput, type AgentContext } from "@ibatexas/types";
import { createCustomerService } from "@ibatexas/domain";
import { getTypesenseClient, COLLECTION } from "../typesense/client.js";
import { publishNatsEvent } from "@ibatexas/nats-client";

export async function submitReview(
  input: SubmitReviewInput,
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }> {
  const parsed = SubmitReviewInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para enviar avaliação.");
  }

  const { productId, orderId, rating, comment } = parsed;

  const svc = createCustomerService();
  const { avgRating, reviewCount } = await svc.submitReview({
    customerId: ctx.customerId,
    productId,
    orderId,
    rating,
    comment,
    channel: ctx.channel,
  });

  // Update Typesense document (cache layer — stays in tools)
  const typesense = getTypesenseClient();
  try {
    await typesense
      .collections<Record<string, unknown>>(COLLECTION)
      .documents(productId)
      .update({ rating: avgRating, reviewCount });
  } catch {
    // Non-fatal: product may not be in Typesense yet
  }

  // AUDIT-FIX: EVT-F04 — review.submitted has no subscriber yet. Keeping for future review analytics.
  // TODO: [AUDIT-REVIEW] Add subscriber for review.submitted when review analytics pipeline is built
  void publishNatsEvent("review.submitted", {
    eventType: "review.submitted",
    productId,
    orderId,
    customerId: ctx.customerId,
    rating,
    reviewCount,
    newAvgRating: avgRating,
  }).catch((err) => console.error("[submit_review] NATS publish error:", err));

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
