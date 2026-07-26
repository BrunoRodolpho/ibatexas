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
//
// ── BKL-243 — two entry points, so a conductor turn adjudicates ONCE ──────
//
// Same defect and same fix shape as BKL-232 (`reservation.modify`, PR #386).
// This tool has two callers, and only ONE of them has already adjudicated:
//
//   - `submitReview` (SELF-ADJUDICATING) — the REST `POST /api/me/reviews`
//     route (apps/api/src/routes/me.ts), which reaches the tool with no kernel
//     decision behind it. It MUST mint and adjudicate its own envelope or the
//     mutation would run ungated (CLAUDE.md rule #9).
//   - `submitReviewPreAdjudicated` (BKL-243) — the claustrum tool registry
//     (apps/api/src/tools/register-ibatexas-tool-packs.ts). The Conductor has
//     ALREADY adjudicated this exact `order.review.submit` envelope through the
//     audited kernel AND claimed its execution-ledger key; re-minting a second
//     envelope here adjudicated the same intent a second time, and that second
//     adjudication is AUDIT-BLIND — `createCustomerService()` is called with no
//     `auditSink`, so an inner REFUSE would silently contradict the audited
//     EXECUTE with nothing in the trail to show for it.
//
// `order.review.submit` is in AUTORESOLVE_CONFIRM_KINDS, so the live shape is a
// park-then-confirm turn exactly like `reservation.cancel`'s; the resume leg is
// what dispatches this handler.
//
// The inner bundle was also a strict SUBSET of the Conductor's: the composed
// router carries `refuseUnresolvedReviewProductGuard`
// (apps/api/src/claustrum/compose-policy-packs.ts) on top of `ordersPolicyBundle`,
// and it reads a resolver-stamped flag this tool never set. Deleting the inner
// run removes an unaudited decision without removing any guard coverage.

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

/**
 * How the caller reached this tool — i.e. who owns the kernel decision.
 *
 * `"self"`      — nobody adjudicated yet; mint + adjudicate an envelope here.
 * `"conductor"` — the claustrum Conductor already adjudicated this intent and
 *                 claimed its execution-ledger key; execute, do NOT re-adjudicate
 *                 (BKL-243).
 */
type SubmitReviewAuthority = "self" | "conductor"

/**
 * The post-write cache refresh + NATS publish + pt-BR result, shared by both
 * entry points so the pre-adjudicated path cannot drift from the
 * self-adjudicating one.
 */
async function succeed(
  parsed: SubmitReviewInput,
  customerId: string,
  aggregate: { avgRating: number; reviewCount: number },
): Promise<{ success: boolean; message: string }> {
  const { productId, orderId, rating } = parsed
  const { avgRating, reviewCount } = aggregate

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
    customerId,
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

export function submitReview(
  input: SubmitReviewInput,
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }> {
  return submitReviewImpl(input, ctx, "self")
}

/**
 * BKL-243 — the entry point the claustrum tool registry dispatches on a kernel
 * EXECUTE. Identical to {@link submitReview} (same auth check, same write, same
 * Typesense + NATS side effects, same pt-BR result) except that it does NOT
 * re-adjudicate: the Conductor's audited, ledger-claimed decision is the single
 * authorization for this mutation.
 */
export function submitReviewPreAdjudicated(
  input: SubmitReviewInput,
  ctx: AgentContext,
): Promise<{ success: boolean; message: string }> {
  return submitReviewImpl(input, ctx, "conductor")
}

async function submitReviewImpl(
  input: SubmitReviewInput,
  ctx: AgentContext,
  authority: SubmitReviewAuthority,
): Promise<{ success: boolean; message: string }> {
  const parsed = SubmitReviewInputSchema.parse(input)

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para enviar avaliação.")
  }

  const { productId, orderId, rating, comment } = parsed

  // ── BKL-243 — the Conductor already authorized this intent ─────────
  // Execute the mutation under its decision. No second envelope, no second
  // adjudication, no audit-blind inner run.
  if (authority === "conductor") {
    const svc = createCustomerService()
    const aggregate = await svc.submitReview({
      customerId: ctx.customerId,
      productId,
      orderId,
      rating,
      ...(comment === undefined ? {} : { comment }),
      channel: ctx.channel,
    })
    return succeed(parsed, ctx.customerId, aggregate)
  }

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

  return succeed(parsed, ctx.customerId, outcome.result!)
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
