// apply_coupon tool — apply a promotion code to the Medusa cart

import { ApplyCouponInputSchema, type ApplyCouponInput, type AgentContext } from "@ibatexas/types";
import { medusaStoreFetch } from "./_shared.js";
import { assertCartOwnership } from "./assert-cart-ownership.js"; // AUDIT-FIX: TOOL-C02

export async function applyCoupon(
  input: ApplyCouponInput,
  ctx: AgentContext,
): Promise<unknown> {
  const parsed = ApplyCouponInputSchema.parse(input);
  // AUDIT-FIX: TOOL-C02 — verify cart ownership before modifying
  await assertCartOwnership(parsed.cartId, ctx.customerId);
  try {
    return await medusaStoreFetch(`/store/carts/${parsed.cartId}/promotions`, {
      method: "POST",
      body: JSON.stringify({ promo_codes: [parsed.code] }),
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
