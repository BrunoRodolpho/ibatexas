// change_delivery_address tool — update shipping address on a delivery order.
//
// Rules (from decision matrix §4.8):
// - Only for delivery orders
// - Allowed on pending/confirmed within PONR
// - Preparing → escalate
// - ready/in_delivery/delivered/canceled → denied
//
// ── Task 15 (M3) — consolidation under OrderCommandService ───────────────
//
// Previously this tool wrote `prisma.orderProjection.update` directly,
// bypassing the version counter (investigation 03 P0 #2). The tool now
// routes through `OrderCommandService.changeAddressFromEnvelope`, which:
//
//   - Adjudicates via `orderProjectionPolicyBundle` (`order.address.change`)
//   - Bumps `OrderProjection.version` consistently with other writers
//   - Appends an OrderStatusHistory row keyed to the new version
//   - Emits a governance audit record via the configured AuditSink

import { randomUUID } from "node:crypto";
import { NonRetryableError, canPerformAction, type AgentContext, type OrderFulfillmentStatus } from "@ibatexas/types";
import {
  createOrderQueryService,
  createOrderCommandService,
  type OrderAddressChangePayload,
} from "@ibatexas/domain";
import { buildEnvelope } from "@adjudicate/core";
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

  if (order?.customerId !== ctx.customerId) {
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

  // ── Build the IntentEnvelope ────────────────────────────────────────
  const payload: OrderAddressChangePayload = {
    orderId: input.orderId,
    customerId: ctx.customerId,
    address: input.address,
  };
  const envelope = buildEnvelope({
    kind: "order.address.change" as const,
    payload,
    nonce: randomUUID(),
    actor: {
      principal: "llm",
      sessionId: ctx.sessionId ?? `customer:${ctx.customerId}`,
    },
    taint: "UNTRUSTED",
  });

  const orderCmdSvc = createOrderCommandService();
  const result = await orderCmdSvc.changeAddressFromEnvelope(envelope);

  if (result.decision.kind !== "EXECUTE" && result.decision.kind !== "REWRITE") {
    const message =
      result.decision.kind === "REFUSE"
        ? result.decision.refusal.userFacing
        : "Não foi possível alterar o endereço no momento.";
    return { success: false, message };
  }

  await publishNatsEvent("order.address_changed", {
    eventType: "order.address_changed",
    orderId: input.orderId,
    customerId: ctx.customerId,
    newAddress: input.address,
    timestamp: new Date().toISOString(),
  });

  return { success: true, message: "Endereço de entrega atualizado." };
}
