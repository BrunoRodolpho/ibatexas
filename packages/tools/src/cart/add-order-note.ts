// add_order_note tool — add a note to an existing order (WhatsApp).
//
// Allows authenticated customers to add notes to their orders via the
// WhatsApp AI agent. Validates ownership and fulfillment status.

import { NonRetryableError, type AgentContext } from "@ibatexas/types";
import { canPerformAction } from "@ibatexas/types";
import { createOrderQueryService, prisma } from "@ibatexas/domain";
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

  const note = await prisma.orderNote.create({
    data: {
      orderId: input.orderId,
      author: "customer",
      authorId: ctx.customerId,
      content: input.content,
    },
  });

  await publishNatsEvent("order.note_added", {
    eventType: "order.note_added",
    orderId: input.orderId,
    noteId: note.id,
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
