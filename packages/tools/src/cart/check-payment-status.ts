// check_payment_status tool — fetch current payment status for an order
// READ_ONLY tool: returns payment status, method, PIX expiry, retry eligibility.

import { NonRetryableError, type AgentContext } from "@ibatexas/types";
import { createPaymentQueryService } from "@ibatexas/domain";
import { isTerminalPaymentStatus, PAYMENT_STATUS_LABELS_PT, type PaymentStatus } from "@ibatexas/types";

interface CheckPaymentStatusInput {
  orderId: string;
}

interface CheckPaymentStatusOutput {
  hasPayment: boolean;
  paymentId?: string;
  method?: string;
  status?: string;
  statusLabel?: string;
  amountInCentavos?: number;
  pixExpiresAt?: string | null;
  isTerminal?: boolean;
  canRetry?: boolean;
  canRegenPix?: boolean;
  canSwitchMethod?: boolean;
  attemptCount?: number;
}

export async function checkPaymentStatus(
  input: CheckPaymentStatusInput,
  ctx: AgentContext,
): Promise<CheckPaymentStatusOutput> {
  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária.");
  }

  const querySvc = createPaymentQueryService();

  // Get active payment
  const active = await querySvc.getActiveByOrderId(input.orderId).catch(() => null);

  if (!active) {
    // Check if there are any historical attempts
    const { payments } = await querySvc.listByOrderId(input.orderId, { limit: 1 });
    return {
      hasPayment: payments.length > 0,
      ...(payments.length > 0 ? { status: payments[0]!.status, isTerminal: true } : {}),
    };
  }

  const status = active.status as PaymentStatus;
  const terminal = isTerminalPaymentStatus(status);
  const retryable = ["payment_failed", "payment_expired"].includes(status);
  const canRegenPix = status === "payment_expired" && active.method === "pix";
  const canSwitch = !terminal && status !== "paid";

  // Count total attempts for this order
  const { payments: allAttempts } = await querySvc.listByOrderId(input.orderId);

  return {
    hasPayment: true,
    paymentId: active.id,
    method: active.method,
    status: active.status,
    statusLabel: PAYMENT_STATUS_LABELS_PT[status] ?? active.status,
    amountInCentavos: active.amountInCentavos,
    pixExpiresAt: active.pixExpiresAt?.toISOString() ?? null,
    isTerminal: terminal,
    canRetry: retryable,
    canRegenPix,
    canSwitchMethod: canSwitch,
    attemptCount: allAttempts.length,
  };
}

export const CheckPaymentStatusTool = {
  name: "check_payment_status",
  description:
    "Verifica o status do pagamento de um pedido. Retorna status, método, expiração PIX, e se o cliente pode tentar novamente ou trocar forma de pagamento.",
  inputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "ID do pedido" },
    },
    required: ["orderId"],
  },
} as const;
