// submit_review tool
// Creates a Review via CustomerCommandService.submitReviewFromEnvelope,
// updates aggregate rating in Typesense, and publishes review.submitted
// NATS event.
//
// ── Kernel routing ──────────────────────────────────────────────────────────
//
// Previously this tool invoked `svc.submitReview(...)` directly,
// bypassing the adjudicate kernel. Per CLAUDE.md rule #9, every mutating
// tool dispatch must flow through an IntentEnvelope.
//
// We now build an `order.review.submit` envelope (UNTRUSTED, principal="llm")
// and route via `submitReviewFromEnvelope`, which:
//   - Adjudicates against `ordersPolicyBundle` (reviews live in the orders
//     Pack — `order.review.submit` is the canonical intent kind for them)
//   - Enforces the rating-range guard (1–5 integer)
//   - Enforces orderId presence via the requireOrderIdForMutation guard
//   - Emits a governance audit record via the configured AuditSink
//   - Delegates to the legacy `submitReview()` for the Prisma write +
//     aggregate stats lookup

import { randomUUID } from "node:crypto"
import { SubmitReviewInputSchema, NonRetryableError, type SubmitReviewInput, type AgentContext } from "@ibatexas/types"
import { createCustomerService } from "@ibatexas/domain"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { buildEnvelope } from "@adjudicate/core"
import type {
  OrderReviewSubmitPayload,
  OrderState,
} from "@ibatexas/pack-orders"
import { getTypesenseClient, COLLECTION } from "../typesense/client.js"

export async function submitReview(
  input: SubmitReviewInput,
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }> {
  const parsed = SubmitReviewInputSchema.parse(input)

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para enviar avaliação.")
  }

  const { productId, orderId, rating, comment } = parsed

  // ── Build the IntentEnvelope ────────────────────────────────────────
  // LLM-dispatched mutation → UNTRUSTED taint, principal="llm". The kernel
  // adjudicates against `ordersPolicyBundle` and emits an audit record
  // before any Prisma write.
  const payload: OrderReviewSubmitPayload = {
    orderId,
    productId,
    rating,
    ...(comment === undefined ? {} : { comment }),
  }

  // ── Project state for the pack policies ────────────────────────────
  // The pack's `requireOrderIdForMutation` guard reads `state.ctx.orderId`.
  // The auth guard reads `state.ctx.customerId`. The channel determines
  // which auth path applies. We supply both from the agent context.
  const channelForState: OrderState["ctx"]["channel"] =
    ctx.channel === "whatsapp" ? "whatsapp" : "web"
  const state: OrderState = {
    ctx: {
      channel: channelForState,
      customerId: ctx.customerId,
      cartId: null,
      orderId,
    },
  }

  const envelope = buildEnvelope<"order.review.submit", OrderReviewSubmitPayload>({
    kind: "order.review.submit",
    payload,
    nonce: randomUUID(),
    actor: {
      principal: "llm",
      sessionId: `customer:${ctx.customerId}`,
    },
    taint: "UNTRUSTED",
  })

  const svc = createCustomerService()
  const outcome = await svc.submitReviewFromEnvelope(envelope, state, {
    customerId: ctx.customerId,
    channel: ctx.channel,
  })

  if (outcome.decision.kind !== "EXECUTE" && outcome.decision.kind !== "REWRITE") {
    const message =
      outcome.decision.kind === "REFUSE"
        ? outcome.decision.refusal.userFacing
        : "Não foi possível enviar a avaliação no momento."
    throw new NonRetryableError(message)
  }

  const { avgRating, reviewCount } = outcome.result!

  // Update Typesense document (cache layer — stays in tools)
  const typesense = getTypesenseClient()
  try {
    await typesense
      .collections<Record<string, unknown>>(COLLECTION)
      .documents(productId)
      .update({ rating: avgRating, reviewCount })
  } catch {
    // Non-fatal: product may not be in Typesense yet
  }

  // TODO: Add subscriber for review.submitted when review analytics pipeline is built
  void publishNatsEvent("review.submitted", {
    eventType: "review.submitted",
    productId,
    orderId,
    customerId: ctx.customerId,
    rating,
    reviewCount,
    newAvgRating: avgRating,
  }).catch((err) => console.error("[submit_review] NATS publish error:", (err as Error).message))

  const stars = "⭐".repeat(rating)
  return {
    success: true,
    message: `Avaliação enviada! ${stars} Obrigado pelo seu feedback.`,
  }
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
} as const
