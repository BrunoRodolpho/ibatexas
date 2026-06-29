// switch_order_type tool — switch between delivery/pickup/dine_in.
//
// Rules (from decision matrix §4.9):
// - Only pending within PONR
// - confirmed → escalate
// - preparing+ → denied
// - If switching TO delivery from pickup/dine_in, cash must switch to PIX/card
// - If switching FROM delivery, delivery fee removed
//
// ── Task 15 (M3) — consolidation under OrderCommandService ───────────────
//
// Previously this tool wrote `prisma.orderProjection.update` directly,
// bypassing the version counter (investigation 03 P0 #2). The tool now
// routes through `OrderCommandService.switchTypeFromEnvelope`, which:
//
//   - Adjudicates via `orderProjectionPolicyBundle` (`order.type.switch`)
//   - Bumps `OrderProjection.version` consistently with other writers
//   - Appends an OrderStatusHistory row keyed to the new version
//   - Emits a governance audit record via the configured AuditSink

import { randomUUID } from "node:crypto";
import { NonRetryableError, canPerformAction, type AgentContext, type OrderFulfillmentStatus, type OrderType } from "@ibatexas/types";
import {
  createOrderQueryService,
  createPaymentQueryService,
  createOrderCommandService,
  type OrderTypeSwitchPayload,
} from "@ibatexas/domain";
import { buildEnvelope } from "@adjudicate/core";
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

  if (order?.customerId !== ctx.customerId) {
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

  // ── Build the IntentEnvelope ────────────────────────────────────────
  const payload: OrderTypeSwitchPayload = {
    orderId: input.orderId,
    newType: input.newType,
    customerId: ctx.customerId,
  };
  const envelope = buildEnvelope({
    kind: "order.type.switch" as const,
    payload,
    nonce: randomUUID(),
    actor: {
      principal: "llm",
      sessionId: ctx.sessionId ?? `customer:${ctx.customerId}`,
    },
    taint: "UNTRUSTED",
  });

  const orderCmdSvc = createOrderCommandService();
  const result = await orderCmdSvc.switchTypeFromEnvelope(envelope);

  if (result.decision.kind !== "EXECUTE" && result.decision.kind !== "REWRITE") {
    const message =
      result.decision.kind === "REFUSE"
        ? result.decision.refusal.userFacing
        : "Não foi possível alterar o tipo do pedido no momento.";
    return { success: false, message };
  }

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
