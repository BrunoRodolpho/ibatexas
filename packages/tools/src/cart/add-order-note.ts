// add_order_note tool — add a note to an existing order (WhatsApp).
//
// Allows authenticated customers to add notes to their orders via the
// WhatsApp AI agent. Validates ownership and fulfillment status.
//
// ── Task 15 (M3) — consolidation under OrderCommandService ───────────────
//
// Previously this tool wrote `prisma.orderNote.create` directly. Per
// investigation 03 P0 #2, that bypass meant the orderProjection.version
// counter was not updated and there was no kernel adjudication of the
// intent. The tool now routes through `OrderCommandService.addNoteFromEnvelope`
// which:
//
//   - Adjudicates via @ibatexas/pack-orders' `order.note.add` policy
//   - Emits a governance audit record via the configured AuditSink
//   - Persists the note row via the service (same Prisma write, but
//     wrapped at the chokepoint)

import { randomUUID } from "node:crypto";
import { NonRetryableError, type AgentContext } from "@ibatexas/types";
import { canPerformAction } from "@ibatexas/types";
import { createOrderQueryService, createOrderCommandService } from "@ibatexas/domain";
import { buildEnvelope } from "@adjudicate/core";
import { type OrderNoteAddPayload, type OrderState } from "@ibatexas/pack-orders";
import { publishNatsEvent } from "@ibatexas/nats-client";
import type { OrderFulfillmentStatus } from "@ibatexas/types";

interface AddOrderNoteInput {
  orderId: string;
  content: string;
}

interface AddOrderNoteResult {
  success: boolean;
  message: string;
}

export async function addOrderNote(
  input: AddOrderNoteInput,
  ctx: AgentContext,
): Promise<AddOrderNoteResult> {
  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para adicionar observação.");
  }

  if (!input.content || input.content.length > 500) {
    return { success: false, message: "Observação deve ter entre 1 e 500 caracteres." };
  }

  const orderQuerySvc = createOrderQueryService();
  const order = await orderQuerySvc.getById(input.orderId);

  if (!order || order.customerId !== ctx.customerId) {
    return { success: false, message: "Pedido não encontrado." };
  }

  const check = canPerformAction("add_notes", {
    fulfillmentStatus: order.fulfillmentStatus as OrderFulfillmentStatus,
  });

  if (!check.allowed) {
    return { success: false, message: check.reason };
  }

  // ── Build the IntentEnvelope ────────────────────────────────────────
  // The LLM-tool dispatch path is UNTRUSTED — the customer (via the LLM)
  // is proposing the mutation. `actor.principal = "llm"` per the
  // CLAUDE.md rule #9 LLM-authority discipline. The audit trail carries
  // the customer's id in the session.
  const payload: OrderNoteAddPayload = {
    orderId: input.orderId,
    body: input.content,
  };
  // Build OrderState the way @ibatexas/pack-orders policies expect it.
  // ctx.customerId is set (auth check above); orderId is the in-flight one.
  // Other Pack-policy-relevant fields are read off the order row.
  const orderState: OrderState = {
    ctx: {
      channel: "whatsapp",
      customerId: ctx.customerId,
      cartId: null,
      orderId: input.orderId,
      paymentMethod: (order.paymentMethod as "pix" | "card" | "cash" | null) ?? null,
      paymentStatus: order.paymentStatus,
      totalInCentavos: order.totalInCentavos,
    },
  };
  const envelope = buildEnvelope({
    kind: "order.note.add" as const,
    payload,
    nonce: randomUUID(),
    actor: {
      principal: "llm",
      sessionId: ctx.sessionId ?? `customer:${ctx.customerId}`,
    },
    taint: "UNTRUSTED",
  });

  const orderCmdSvc = createOrderCommandService();
  const result = await orderCmdSvc.addNoteFromEnvelope(
    envelope,
    orderState,
    { author: "customer", authorId: ctx.customerId },
  );

  if (result.decision.kind !== "EXECUTE" && result.decision.kind !== "REWRITE") {
    // Surface the kernel's pt-BR refusal copy. The mutation did NOT run.
    const message =
      result.decision.kind === "REFUSE"
        ? result.decision.refusal.userFacing
        : "Não foi possível adicionar a observação no momento.";
    return { success: false, message };
  }

  const note = result.result!;

  await publishNatsEvent("order.note_added", {
    eventType: "order.note_added",
    orderId: input.orderId,
    noteId: note.noteId,
    author: "customer",
    timestamp: new Date().toISOString(),
  });

  return { success: true, message: "Observação adicionada ao pedido." };
}

export const AddOrderNoteTool = {
  name: "add_order_note",
  description: "Adiciona uma observação ao pedido existente. Máximo 500 caracteres. Requer autenticação.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "ID do pedido" },
      content: { type: "string", description: "Texto da observação (máx 500 caracteres)" },
    },
    required: ["orderId", "content"],
  },
} as const;
