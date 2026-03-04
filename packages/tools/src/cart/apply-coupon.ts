// apply_coupon tool — apply a promotion code to the Medusa cart

import type { AgentContext } from "@ibatexas/types";
import { medusaStoreFetch } from "./_shared.js";

export async function applyCoupon(
  input: { cartId: string; code: string },
  _ctx: AgentContext,
): Promise<unknown> {
  try {
    return await medusaStoreFetch(`/store/carts/${input.cartId}/promotions`, {
      method: "POST",
      body: JSON.stringify({ promo_codes: [input.code] }),
    });
  } catch (err) {
    console.error("[apply_coupon] Medusa error:", err);
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
