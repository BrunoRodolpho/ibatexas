// switch_order_type tool — switch between delivery/pickup/dine_in.
//
// Rules (from decision matrix §4.9):
// - Only pending within PONR
// - confirmed → escalate
// - preparing+ → denied
// - If switching TO delivery from pickup/dine_in, cash must switch to PIX/card
// - If switching FROM delivery, delivery fee removed

import { NonRetryableError, canPerformAction, type AgentContext, type OrderFulfillmentStatus, type OrderType } from "@ibatexas/types";
import { createOrderQueryService, createPaymentQueryService, prisma } from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";

interface SwitchOrderTypeInput {
  orderId: string;
  newType: "delivery" | "pickup" | "dine_in";
}

interface SwitchOrderTypeResult {
  success: boolean;
  message: string;
  needsEscalation?: boolean;
  paymentMethodChangeRequired?: boolean;
}

export async function switchOrderType(
  input: SwitchOrderTypeInput,
  ctx: AgentContext,
): Promise<SwitchOrderTypeResult> {
  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para alterar tipo do pedido.");
  }

  const orderQuerySvc = createOrderQueryService();
  const order = await orderQuerySvc.getById(input.orderId);

  if (!order || order.customerId !== ctx.customerId) {
    return { success: false, message: "Pedido não encontrado." };
  }

  const currentType = (order.deliveryType as OrderType) ?? "delivery";

  if (currentType === input.newType) {
    return { success: false, message: "Pedido já é deste tipo." };
  }

  const check = canPerformAction("switch_order_type", {
    fulfillmentStatus: order.fulfillmentStatus as OrderFulfillmentStatus,
    orderCreatedAt: order.createdAt,
    ponrMinutes: 5,
  });

  if (!check.allowed) {
    return {
      success: false,
      message: check.reason,
      needsEscalation: check.escalate,
    };
  }

  // Check if payment method needs to change (cash not allowed for delivery)
  const paymentQuerySvc = createPaymentQueryService();
  const activePayment = await paymentQuerySvc.getActiveByOrderId(input.orderId).catch(() => null);
  let paymentMethodChangeRequired = false;

  if (input.newType === "delivery" && activePayment?.method === "cash") {
    paymentMethodChangeRequired = true;
  }

  await prisma.orderProjection.update({
    where: { id: input.orderId },
    data: {
      deliveryType: input.newType,
      // Remove shipping fee if switching away from delivery
      ...(input.newType !== "delivery" && currentType === "delivery"
        ? { shippingInCentavos: 0 }
        : {}),
    },
  });

  await publishNatsEvent("order.type_changed", {
    eventType: "order.type_changed",
    orderId: input.orderId,
    customerId: ctx.customerId,
    previousType: currentType,
    newType: input.newType,
    timestamp: new Date().toISOString(),
  });

  const typeLabels: Record<string, string> = {
    delivery: "entrega",
    pickup: "retirada",
    dine_in: "no local",
  };

  let message = `Tipo do pedido alterado para ${typeLabels[input.newType]}.`;
  if (paymentMethodChangeRequired) {
    message += " Pagamento em dinheiro não é aceito para entrega — escolha PIX ou cartão.";
  }

  return {
    success: true,
    message,
    paymentMethodChangeRequired,
  };
}
