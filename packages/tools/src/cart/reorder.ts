// reorder tool — create a new cart from a previous order's items
//
// ── W3 P1-L (audit remediation) ────────────────────────────────────────
//
// `reorder.ts` was incorrectly listed under `ALLOWED_MEDUSA_DIRECT` in
// `bypass-detection.test.ts` as "read-only fetches". It actually POSTs
// to `/store/carts` (cart create) and `/store/carts/:id/line-items`
// (item add) — both kernel-owned mutations. Per Wave 3 of the audit
// remediation, the writes now route through `medusaAdjudicated()`
// (Task 17 wrapper), so each cart create + line-item add produces an
// audit record and the carve-out can be removed from the allow-list.

import { ReorderInputSchema, NonRetryableError, type ReorderInput, type AgentContext } from "@ibatexas/types";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { getAuditSink } from "@ibatexas/audit-sink";
import { withOrderOwnership } from "../guards/with-ownership.js";
import { medusaAdjudicated } from "../medusa/adjudicated.js";
import { medusaAdminFetch } from "./_shared.js";

async function reorderImpl(
  input: ReorderInput,
  ctx: AgentContext,
): Promise<{ cartId?: string; message: string }> {
  const parsed = ReorderInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para refazer pedido.");
  }

  const data = await medusaAdminFetch(`/admin/orders/${parsed.orderId}`) as {
    order: {
      customer_id?: string;
      items: Array<{ variant_id: string; quantity: number; title: string }>;
    };
  };

  const items = data.order.items;
  if (!items || items.length === 0) {
    return { message: "Não foi possível carregar os itens do pedido anterior." };
  }

  // Create a new cart — adjudicated egress (kind: medusa.cart.create)
  const cartData = await medusaAdjudicated<{ customer_id: string }, { cart?: { id: string } }>({
    scope: "store",
    method: "POST",
    path: "/store/carts",
    payload: { customer_id: ctx.customerId },
    sourceSubject: "tool:reorder",
    auditSink: getAuditSink(),
  });

  const cartId = cartData.cart?.id;
  if (!cartId) {
    return { message: "Erro ao criar novo carrinho." };
  }

  // Add each item — adjudicated egress (kind: medusa.cart.line_items.add)
  const errors: string[] = [];
  for (const item of items) {
    if (!item.variant_id) continue;
    try {
      await medusaAdjudicated<{ variant_id: string; quantity: number }, unknown>({
        scope: "store",
        method: "POST",
        path: `/store/carts/${cartId}/line-items`,
        payload: { variant_id: item.variant_id, quantity: item.quantity },
        sourceSubject: "tool:reorder",
        auditSink: getAuditSink(),
      });
    } catch {
      errors.push(item.title);
    }
  }

  // TODO: Add subscriber for cart.item_added when cart analytics pipeline is built
  void publishNatsEvent("cart.item_added", {
    eventType: "cart.item_added",
    cartId,
    customerId: ctx.customerId,
    sessionId: ctx.sessionId,
    reorderFromOrderId: parsed.orderId,
  }).catch((err) => console.error("[reorder] NATS publish error:", (err as Error).message));

  const errorNote = errors.length > 0 ? ` (item(ns) indisponível(is): ${errors.join(", ")})` : "";
  return {
    cartId,
    message: `Carrinho criado com os itens do pedido anterior${errorNote}. CartId: ${cartId}`,
  };
}

// SEC-002: Ownership guard wrapper — rejects before any business logic
export const reorder = withOrderOwnership(reorderImpl);

export const ReorderTool = {
  name: "reorder",
  description:
    "Cria um novo carrinho com os itens de um pedido anterior para refazer o pedido. Requer autenticação.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "ID do pedido anterior" },
    },
    required: ["orderId"],
  },
} as const;
