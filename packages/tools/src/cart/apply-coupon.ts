// apply_coupon tool — apply a promotion code to the Medusa cart

import { ApplyCouponInputSchema, type ApplyCouponInput, type AgentContext } from "@ibatexas/types";
import { getAuditSink } from "@ibatexas/audit-sink";
import {
  medusaStoreAdjudicated,
  MedusaStoreAdjudicateRefusedError,
} from "../medusa/store-adjudicated.js";
import { assertCartOwnership } from "./assert-cart-ownership.js";

export async function applyCoupon(
  input: ApplyCouponInput,
  ctx: AgentContext,
): Promise<unknown> {
  const parsed = ApplyCouponInputSchema.parse(input);
  await assertCartOwnership(parsed.cartId, ctx.customerId);
  try {
    return await medusaStoreAdjudicated.carts.promotions.add(
      { cartId: parsed.cartId, promoCodes: [parsed.code] },
      {
        sourceSubject: "cart:apply-coupon",
        actorPrincipal: "llm",
        auditSink: getAuditSink(),
        ...(ctx.customerId !== undefined ? { customerId: ctx.customerId } : {}),
        sessionId: ctx.sessionId,
      },
    );
  } catch (err) {
    // audit-2026-05-24 P2-2: kernel REFUSE attaches a kind-specific pt-BR
    // userFacing copy — surface it instead of the generic fallback.
    if (err instanceof MedusaStoreAdjudicateRefusedError) {
      return { success: false, message: err.userFacing };
    }
    console.error("[apply_coupon] Medusa error:", (err as Error).message);
    return { success: false, message: "Cupom inválido ou erro ao aplicar desconto. Verifique o código e tente novamente." };
  }
}

export const ApplyCouponTool = {
  name: "apply_coupon",
  description: "Aplica um código de desconto ou cupom ao carrinho.",
  inputSchema: {
    type: "object",
    properties: {
      cartId: { type: "string" },
      code: { type: "string", description: "Código do cupom ou promoção" },
    },
    required: ["cartId", "code"],
  },
} as const;
