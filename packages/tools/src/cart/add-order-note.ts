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
// intent. The tool routes through `OrderCommandService` so the write happens
// at the domain chokepoint rather than from the tools package.
//
// ── BKL-242 — this tool is dispatch-only, and dispatch is post-decision ───
//
// The claustrum tool registry (apps/api/src/tools/register-ibatexas-tool-packs.ts)
// is this handler's ONLY caller — there is no REST `add order note` route
// reaching it — and the registry dispatches it on a kernel EXECUTE the
// Conductor has ALREADY adjudicated and ledger-claimed. So there is no second
// caller to keep a self-adjudicating entry point for, and the tool is converted
// in place rather than split into a twin the way `reservation.cancel` was.
//
// Pre-fix this handler minted a SECOND `order.note.add` envelope
// (`nonce: randomUUID()`) and re-adjudicated it via `addNoteFromEnvelope`. That
// second adjudication was AUDIT-BLIND: `createOrderCommandService()` was called
// with no `auditSink`, so the inner run emitted NO governance record. Live proof
// is the missing row, not a duplicate one — conductor EXECUTE `intent_audit`
// 5278 with the note row written 9ms later and no second audit row anywhere. An
// inner REFUSE would therefore have silently contradicted the audited EXECUTE
// with nothing in the trail to show for it.
//
// `writeAdjudicatedNote` (order-command.service.ts) is the sanctioned
// post-decision persistence body, extracted for exactly this shape in BKL-083b
// and already used by the governed ops-plane note path. Its contract — THE
// CALLER MUST HOLD A POSITIVE composed-router `Decision` for `order.note.add` —
// is what registry dispatch supplies.
//
// The tool-boundary guards below (auth, content length, ownership,
// `canPerformAction`) are NOT kernel guards and are unchanged: they run on
// every call, before the write, exactly as they did.

import {
  NonRetryableError,
  canPerformAction,
  type AgentContext,
  type OrderFulfillmentStatus,
} from "@ibatexas/types";
import { createOrderQueryService, createOrderCommandService } from "@ibatexas/domain";
import { type OrderNoteAddPayload } from "@ibatexas/pack-orders";
import { publishNatsEvent } from "@ibatexas/nats-client";

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

  if (order?.customerId !== ctx.customerId) {
    return { success: false, message: "Pedido não encontrado." };
  }

  const check = canPerformAction("add_notes", {
    fulfillmentStatus: order.fulfillmentStatus as OrderFulfillmentStatus,
  });

  if (!check.allowed) {
    return { success: false, message: check.reason };
  }

  // ── Persist under the Conductor's decision ──────────────────────────
  // BKL-242: no envelope is minted here and no second adjudication runs. The
  // registry dispatched this handler because the kernel already returned
  // EXECUTE for this `order.note.add` intent and claimed its execution-ledger
  // key; `writeAdjudicatedNote` is the post-decision persistence body for
  // exactly that caller.
  const payload: OrderNoteAddPayload = {
    orderId: input.orderId,
    body: input.content,
  };

  const orderCmdSvc = createOrderCommandService();
  const note = await orderCmdSvc.writeAdjudicatedNote(payload, {
    author: "customer",
    authorId: ctx.customerId,
  });

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
