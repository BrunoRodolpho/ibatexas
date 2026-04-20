// amend_order tool — modify an existing order (add/remove/update items with PONR)
//
// Rules:
// - add: Always allowed unless order is in delivery
// - remove / update_qty: Subject to per-item AMEND_PONR window
// - Escalates to admin when PONR has expired

import type Stripe from "stripe";
import { AmendOrderInputSchema, NonRetryableError, canPerformAction, type AmendOrderInput, type AmendOrderResult, type AgentContext, type CustomerAction, type OrderFulfillmentStatus } from "@ibatexas/types";
import { createOrderService, createOrderQueryService, createPaymentQueryService, createPaymentCommandService } from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { medusaAdmin } from "../medusa/client.js";
import { withLock } from "../redis/distributed-lock.js";
import { cancelStalePaymentIntent, getStripe } from "./_stripe-helpers.js";

/**
 * After a successful amendment, cancel the old Stripe PI and create a new one
 * with the updated total. Returns PIX data for the customer if applicable.
 */
async function regeneratePixIfNeeded(
  orderId: string,
  oldPiId: string | undefined,
  svc: ReturnType<typeof createOrderService>,
): Promise<{ newPixQrCodeText?: string; newPixQrCodeUrl?: string; newStripePaymentIntentId?: string } | null> {
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
    newStripePaymentIntentId: newPi.id,
  };
}

/**
 * After an amendment changes the order total, sync the Payment table:
 * 1. Cancel the old Payment row (best effort)
 * 2. Create a new Payment row with the updated amount and new Stripe PI
 */
async function syncPaymentAfterAmendment(
  orderId: string,
  newStripePaymentIntentId: string | undefined,
  updatedTotal: number,
): Promise<void> {
  if (!newStripePaymentIntentId) return;

  const paymentQuerySvc = createPaymentQueryService();
  const paymentCmdSvc = createPaymentCommandService();

  const activePayment = await paymentQuerySvc.getActiveByOrderId(orderId).catch(() => null);
  if (!activePayment) return;

  // Cancel old Payment row (best effort — may already be terminal)
  try {
    await paymentCmdSvc.transitionStatus(activePayment.id, {
      newStatus: "canceled",
      actor: "system",
      actorId: "amendment",
      reason: "order_amended_total_changed",
      expectedVersion: activePayment.version,
    });
  } catch {
    // Already terminal or concurrent modification — non-critical
  }

  // Create new Payment row with updated amount
  await paymentCmdSvc.create({
    orderId,
    method: activePayment.method as "pix" | "card" | "cash",
    amountInCentavos: updatedTotal,
    stripePaymentIntentId: newStripePaymentIntentId,
  });
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

  // Validate action against domain fulfillment status (not Medusa status)
  const orderQuerySvc = createOrderQueryService();
  const projection = await orderQuerySvc.getById(parsed.orderId);
  const fulfillmentStatus = projection?.fulfillmentStatus ?? "pending";

  // Map action to validator action type
  const actionMap: Record<string, CustomerAction> = {
    add: "amend_add_item",
    remove: "amend_remove_item",
    update_qty: "amend_update_qty",
    change_payment: "change_payment_method",
  };
  const validatorAction = actionMap[parsed.action];

  if (validatorAction && parsed.action !== "change_payment") {
    const check = canPerformAction(validatorAction, {
      fulfillmentStatus: fulfillmentStatus as OrderFulfillmentStatus,
    });
    if (!check.allowed) {
      return {
        success: false,
        message: check.reason,
        needsEscalation: check.escalate,
      };
    }
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
      if (pixResult?.newStripePaymentIntentId) {
        const { order: updated } = await svc.getOrder(parsed.orderId);
        await syncPaymentAfterAmendment(parsed.orderId, pixResult.newStripePaymentIntentId, updated.total ?? 0);
      }
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
      if (pixResult?.newStripePaymentIntentId) {
        const { order: updated } = await svc.getOrder(parsed.orderId);
        await syncPaymentAfterAmendment(parsed.orderId, pixResult.newStripePaymentIntentId, updated.total ?? 0);
      }
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
      if (pixResult?.newStripePaymentIntentId) {
        const { order: updated } = await svc.getOrder(parsed.orderId);
        await syncPaymentAfterAmendment(parsed.orderId, pixResult.newStripePaymentIntentId, updated.total ?? 0);
      }
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

    const paymentQuerySvc = createPaymentQueryService();
    const paymentCmdSvc = createPaymentCommandService();
    const activePayment = await paymentQuerySvc.getActiveByOrderId(parsed.orderId).catch(() => null);

    // If no Payment row exists, fall back to legacy Medusa metadata path
    if (!activePayment) {
      const oldPiId = order.metadata?.["stripePaymentIntentId"] as string | undefined;
      if (oldPiId) await cancelStalePaymentIntent(oldPiId);
      return { success: true, message: `Pagamento alterado para ${parsed.paymentMethod === "cash" ? "dinheiro" : parsed.paymentMethod === "pix" ? "PIX" : "cartão"}.` };
    }

    // Block switch if already paid or terminal
    const terminalForSwitch = ["paid", "refunded", "canceled", "waived"];
    if (terminalForSwitch.includes(activePayment.status)) {
      return { success: false, message: "Pagamento já finalizado — não pode trocar." };
    }

    // Same method — no-op
    if (activePayment.method === parsed.paymentMethod) {
      return { success: false, message: "Já está usando este método de pagamento." };
    }

    // Atomic switch via distributed lock on payment
    const switchResult = await withLock<AmendOrderResult>(`payment:${activePayment.id}`, async () => {
      // 1. Transition → switching_method
      await paymentCmdSvc.transitionStatus(activePayment.id, {
        newStatus: "switching_method",
        actor: "customer",
        actorId: ctx.customerId,
        reason: `switch_to_${parsed.paymentMethod}`,
        expectedVersion: activePayment.version,
      });

      // 2. Cancel old Stripe PI
      if (activePayment.stripePaymentIntentId) {
        await cancelStalePaymentIntent(activePayment.stripePaymentIntentId);
      }

      // 3. Transition old payment → canceled
      const afterSwitch = await paymentQuerySvc.getById(activePayment.id);
      await paymentCmdSvc.transitionStatus(activePayment.id, {
        newStatus: "canceled",
        actor: "customer",
        actorId: ctx.customerId,
        reason: "method_switch_completed",
        expectedVersion: afterSwitch?.version ?? activePayment.version + 1,
      });

      // 4. Create new Payment row with new method
      let newStripePI: Stripe.PaymentIntent | null = null;
      let pixExpiresAt: Date | undefined;

      if (parsed.paymentMethod === "pix" || parsed.paymentMethod === "card") {
        const stripe = getStripe();
        newStripePI = await stripe.paymentIntents.create({
          amount: activePayment.amountInCentavos,
          currency: "brl",
          payment_method_types: [parsed.paymentMethod],
          metadata: { orderId: parsed.orderId },
        }) as Stripe.PaymentIntent;

        if (parsed.paymentMethod === "pix") {
          const pixData = (newStripePI as Stripe.PaymentIntent & {
            next_action?: { pix_display_qr_code?: { expires_at?: number } };
          }).next_action?.pix_display_qr_code;
          if (pixData?.expires_at) {
            pixExpiresAt = new Date(pixData.expires_at * 1000);
          }
        }
      }

      const newPayment = await paymentCmdSvc.create({
        orderId: parsed.orderId,
        method: parsed.paymentMethod!,
        amountInCentavos: activePayment.amountInCentavos,
        stripePaymentIntentId: newStripePI?.id ?? undefined,
        pixExpiresAt,
      });

      // 5. Publish events
      void publishNatsEvent("payment.method_changed", {
        orderId: parsed.orderId,
        paymentId: newPayment.id,
        previousMethod: activePayment.method,
        newMethod: parsed.paymentMethod,
        timestamp: new Date().toISOString(),
      });

      void publishNatsEvent("payment.status_changed", {
        orderId: parsed.orderId,
        paymentId: newPayment.id,
        previousStatus: "awaiting_payment",
        newStatus: parsed.paymentMethod === "cash" ? "cash_pending" : "payment_pending",
        method: parsed.paymentMethod,
        version: newPayment.version,
        timestamp: new Date().toISOString(),
      });

      // Build response
      if (parsed.paymentMethod === "cash") {
        return { success: true, message: "Pagamento alterado para dinheiro. Pague na retirada." };
      }

      if (parsed.paymentMethod === "pix" && newStripePI) {
        const pixData = (newStripePI as Stripe.PaymentIntent & {
          next_action?: { pix_display_qr_code?: { data?: string; image_url_svg?: string } };
        }).next_action?.pix_display_qr_code;
        return {
          success: true,
          message: "Pagamento alterado para PIX. Novo código gerado.",
          newPixQrCodeText: pixData?.data,
          newPixQrCodeUrl: pixData?.image_url_svg,
        };
      }

      if (parsed.paymentMethod === "card" && newStripePI) {
        return {
          success: true,
          message: "Pagamento alterado para cartão.",
          stripeClientSecret: newStripePI.client_secret ?? undefined,
        };
      }

      return { success: true, message: "Forma de pagamento alterada." };
    });

    return switchResult ?? { success: false, message: "Operação em andamento. Tente novamente em instantes." };
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
