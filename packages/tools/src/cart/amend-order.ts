// amend_order tool — modify an existing order (add/remove/update items with PONR)
//
// Rules:
// - add: Always allowed unless order is in delivery
// - remove / update_qty: Subject to per-item AMEND_PONR window
// - Escalates to admin when PONR has expired

import type Stripe from "stripe";
import { AmendOrderInputSchema, NonRetryableError, type AmendOrderInput, type AmendOrderResult, type AgentContext } from "@ibatexas/types";
import { createOrderService } from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { medusaAdmin } from "../medusa/client.js";
import { cancelStalePaymentIntent, getStripe } from "./_stripe-helpers.js";

/**
 * After a successful amendment, cancel the old Stripe PI and create a new one
 * with the updated total. Returns PIX data for the customer if applicable.
 */
async function regeneratePixIfNeeded(
  orderId: string,
  oldPiId: string | undefined,
  svc: ReturnType<typeof createOrderService>,
): Promise<{ newPixQrCodeText?: string; newPixQrCodeUrl?: string } | null> {
  if (!oldPiId) return null;

  await cancelStalePaymentIntent(oldPiId);

  // Fetch updated order total after amendment
  const { order: updatedOrder } = await svc.getOrder(orderId);
  const newTotal = updatedOrder.total ?? 0;
  if (newTotal <= 0) return null;

  const stripe = getStripe();
  const newPi = await stripe.paymentIntents.create({
    amount: newTotal,
    currency: "brl",
    payment_method_types: ["pix"],
    metadata: { medusaOrderId: orderId },
  }) as Stripe.PaymentIntent & {
    next_action?: { pix_display_qr_code?: { data?: string; image_url_svg?: string } };
  };

  // Update order metadata with new PI ID
  await medusaAdmin(`/admin/orders/${orderId}`, {
    method: "POST",
    body: JSON.stringify({
      metadata: { stripePaymentIntentId: newPi.id },
    }),
  });

  const pixData = newPi.next_action?.pix_display_qr_code;
  return {
    newPixQrCodeText: pixData?.data,
    newPixQrCodeUrl: pixData?.image_url_svg,
  };
}

export async function amendOrder(
  input: AmendOrderInput,
  ctx: AgentContext,
): Promise<AmendOrderResult> {
  const parsed = AmendOrderInputSchema.parse(input);

  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para modificar pedido.");
  }

  const svc = createOrderService(medusaAdmin);
  const { order, ownershipValid } = await svc.getOrder(parsed.orderId, ctx.customerId);

  if (!ownershipValid) {
    return { success: false, message: "Pedido não encontrado." };
  }

  // Block all amendments when order is in delivery
  const inDeliveryStatuses = ["shipped", "in_delivery", "delivered"];
  if (inDeliveryStatuses.includes(order.status)) {
    return {
      success: false,
      message: "Pedido já saiu para entrega — não pode ser modificado.",
      needsEscalation: true,
    };
  }

  // Block amendments on non-modifiable statuses
  const modifiableStatuses = ["pending", "requires_action"];
  if (!modifiableStatuses.includes(order.status)) {
    return {
      success: false,
      message: "Pedido não pode ser modificado neste momento.",
      needsEscalation: true,
    };
  }

  if (parsed.action === "add") {
    // Adding new items has no PONR restriction (unless in delivery, caught above)
    if (!parsed.variantId) {
      return { success: false, message: "ID da variante necessário para adicionar item." };
    }
    try {
      // Create order edit → add item → confirm
      const editData = await medusaAdmin(`/admin/orders/${parsed.orderId}/edits`, {
        method: "POST",
      }) as { order_edit: { id: string } };
      const editId = editData.order_edit.id;

      await medusaAdmin(`/admin/orders/${parsed.orderId}/edits/${editId}/items`, {
        method: "POST",
        body: JSON.stringify({
          variant_id: parsed.variantId,
          quantity: parsed.quantity ?? 1,
        }),
      });

      await medusaAdmin(`/admin/orders/${parsed.orderId}/edits/${editId}/confirm`, {
        method: "POST",
      });

      const pixResult = await regeneratePixIfNeeded(parsed.orderId, order.metadata?.["stripePaymentIntentId"], svc);
      return {
        success: true,
        message: pixResult?.newPixQrCodeText
          ? "Item adicionado ao pedido. Novo código PIX gerado — use o código abaixo para pagar."
          : "Item adicionado ao pedido.",
        ...pixResult,
      };
    } catch (err) {
      return {
        success: false,
        message: `Erro ao adicionar item: ${(err as Error).message}`,
        needsEscalation: true,
      };
    }
  }

  if (parsed.action === "remove") {
    if (!parsed.itemTitle) {
      return { success: false, message: "Nome do item necessário para remover." };
    }
    const result = await svc.cancelItem(parsed.orderId, ctx.customerId, parsed.itemTitle);

    if (result.needsEscalation) {
      void publishNatsEvent("order.escalation_needed", {
        orderId: parsed.orderId,
        customerId: ctx.customerId,
        reason: "amend_remove_past_ponr",
        itemTitle: parsed.itemTitle,
        timestamp: new Date().toISOString(),
      });
    }

    // Regenerate PIX if item was removed successfully (total changed)
    if (result.success) {
      const pixResult = await regeneratePixIfNeeded(parsed.orderId, order.metadata?.["stripePaymentIntentId"], svc);
      if (pixResult?.newPixQrCodeText) {
        return {
          ...result,
          message: result.message + " Novo código PIX gerado — use o código abaixo para pagar.",
          ...pixResult,
        };
      }
    }

    return result;
  }

  if (parsed.action === "update_qty") {
    if (!parsed.itemTitle || !parsed.quantity) {
      return { success: false, message: "Nome do item e quantidade necessários." };
    }

    // Find the item
    const item = (order.items ?? []).find(
      (i) => i.title.toLowerCase() === parsed.itemTitle!.toLowerCase(),
    );
    if (!item) {
      return { success: false, message: `Item "${parsed.itemTitle}" não encontrado no pedido.` };
    }

    // PONR check for quantity change
    if (order.created_at) {
      const { getEffectivePonr, isWithinPonr } = await import("@ibatexas/domain");
      const metadata = (item as unknown as { metadata?: Record<string, unknown> }).metadata;
      const amendMinutes = typeof metadata?.amendPonrMinutes === "number"
        ? metadata.amendPonrMinutes
        : undefined;
      const ponr = getEffectivePonr({ amendMinutes });
      if (!isWithinPonr(new Date(order.created_at), ponr.amendMinutes)) {
        void publishNatsEvent("order.escalation_needed", {
          orderId: parsed.orderId,
          customerId: ctx.customerId,
          reason: "amend_qty_past_ponr",
          itemTitle: parsed.itemTitle,
          timestamp: new Date().toISOString(),
        });
        return {
          success: false,
          message: `Prazo para alterar "${parsed.itemTitle}" já passou. Um atendente foi notificado.`,
          needsEscalation: true,
        };
      }
    }

    // Update quantity via order edit
    try {
      const editData = await medusaAdmin(`/admin/orders/${parsed.orderId}/edits`, {
        method: "POST",
      }) as { order_edit: { id: string } };
      const editId = editData.order_edit.id;

      await medusaAdmin(`/admin/orders/${parsed.orderId}/edits/${editId}/items/${item.id}`, {
        method: "POST",
        body: JSON.stringify({ quantity: parsed.quantity }),
      });

      await medusaAdmin(`/admin/orders/${parsed.orderId}/edits/${editId}/confirm`, {
        method: "POST",
      });

      const pixResult = await regeneratePixIfNeeded(parsed.orderId, order.metadata?.["stripePaymentIntentId"], svc);
      return {
        success: true,
        message: pixResult?.newPixQrCodeText
          ? `Quantidade de "${parsed.itemTitle}" atualizada para ${parsed.quantity}. Novo código PIX gerado — use o código abaixo para pagar.`
          : `Quantidade de "${parsed.itemTitle}" atualizada para ${parsed.quantity}.`,
        ...pixResult,
      };
    } catch (err) {
      return {
        success: false,
        message: `Erro ao atualizar quantidade: ${(err as Error).message}`,
        needsEscalation: true,
      };
    }
  }

  if (parsed.action === "change_payment") {
    if (!parsed.paymentMethod) {
      return { success: false, message: "Método de pagamento necessário." };
    }

    const oldPiId = order.metadata?.["stripePaymentIntentId"] as string | undefined;

    if (parsed.paymentMethod === "cash") {
      // Cancel old Stripe PI, mark as cash
      if (oldPiId) await cancelStalePaymentIntent(oldPiId);
      await medusaAdmin(`/admin/orders/${parsed.orderId}`, {
        method: "POST",
        body: JSON.stringify({ metadata: { paymentMethod: "cash", stripePaymentIntentId: "" } }),
      });
      return { success: true, message: "Pagamento alterado para dinheiro. Pague na retirada." };
    }

    if (parsed.paymentMethod === "pix") {
      // Cancel old PI and create new one
      const pixResult = await regeneratePixIfNeeded(parsed.orderId, oldPiId, svc);
      return {
        success: true,
        message: pixResult?.newPixQrCodeText
          ? "Pagamento alterado para PIX. Novo código gerado."
          : "Pagamento alterado para PIX.",
        ...pixResult,
      };
    }

    if (parsed.paymentMethod === "card") {
      // Cancel old PI, create card PI
      if (oldPiId) await cancelStalePaymentIntent(oldPiId);
      const stripe = getStripe();
      const newPi = await stripe.paymentIntents.create({
        amount: order.total ?? 0,
        currency: "brl",
        payment_method_types: ["card"],
        metadata: { medusaOrderId: parsed.orderId },
      });
      await medusaAdmin(`/admin/orders/${parsed.orderId}`, {
        method: "POST",
        body: JSON.stringify({ metadata: { stripePaymentIntentId: newPi.id, paymentMethod: "card" } }),
      });
      return {
        success: true,
        message: "Pagamento alterado para cartão.",
        stripeClientSecret: newPi.client_secret,
      };
    }

    return { success: false, message: "Método de pagamento inválido." };
  }

  return { success: false, message: "Ação não reconhecida." };
}

export const AmendOrderTool = {
  name: "amend_order",
  description: "Modifica um pedido existente: adicionar item, remover item, alterar quantidade ou trocar forma de pagamento. Verifica prazo de alteração (PONR). Requer autenticação.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "ID do pedido" },
      action: { type: "string", enum: ["add", "remove", "update_qty", "change_payment"], description: "Ação: add, remove, update_qty, change_payment" },
      variantId: { type: "string", description: "ID da variante (para add)" },
      itemTitle: { type: "string", description: "Nome do item (para remove/update_qty)" },
      quantity: { type: "number", description: "Quantidade (para add e update_qty)" },
      paymentMethod: { type: "string", enum: ["pix", "card", "cash"], description: "Novo método de pagamento (para change_payment)" },
    },
    required: ["orderId", "action"],
  },
} as const;
