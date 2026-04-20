// change_delivery_address tool — update shipping address on a delivery order.
//
// Rules (from decision matrix §4.8):
// - Only for delivery orders
// - Allowed on pending/confirmed within PONR
// - Preparing → escalate
// - ready/in_delivery/delivered/canceled → denied

import { NonRetryableError, canPerformAction, type AgentContext, type OrderFulfillmentStatus } from "@ibatexas/types";
import { createOrderQueryService, prisma } from "@ibatexas/domain";
import { publishNatsEvent } from "@ibatexas/nats-client";

interface ChangeAddressInput {
  orderId: string;
  address: {
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postalCode: string;
    neighborhood?: string;
  };
}

interface ChangeAddressResult {
  success: boolean;
  message: string;
  needsEscalation?: boolean;
}

export async function changeDeliveryAddress(
  input: ChangeAddressInput,
  ctx: AgentContext,
): Promise<ChangeAddressResult> {
  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para alterar endereço.");
  }

  const orderQuerySvc = createOrderQueryService();
  const order = await orderQuerySvc.getById(input.orderId);

  if (!order || order.customerId !== ctx.customerId) {
    return { success: false, message: "Pedido não encontrado." };
  }

  const check = canPerformAction("change_delivery_address", {
    fulfillmentStatus: order.fulfillmentStatus as OrderFulfillmentStatus,
    orderType: (order.deliveryType as "delivery" | "pickup" | "dine_in") ?? "delivery",
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

  await prisma.orderProjection.update({
    where: { id: input.orderId },
    data: {
      shippingAddressJson: input.address as never,
    },
  });

  await publishNatsEvent("order.address_changed", {
    eventType: "order.address_changed",
    orderId: input.orderId,
    customerId: ctx.customerId,
    newAddress: input.address,
    timestamp: new Date().toISOString(),
  });

  return { success: true, message: "Endereço de entrega atualizado." };
}
