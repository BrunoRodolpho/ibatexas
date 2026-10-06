// get_loyalty_balance tool
// Returns the customer's punch-card stamp balance and a human-readable message.
//
// The reward coupon is a DECLARED EXTERNAL REFERENCE (LE2-018):
// `promotion.loyalty-reward` in @ibatexas/catalog's src/external-references.ts,
// sourced from LOYALTY_REWARD_COUPON_CODE and verified to exist in Medusa at
// api boot. It used to be the literal `FIEL20` in this sentence — a code this
// tool promised customers in pt-BR with nothing checking it was real.

import { createLoyaltyService } from "@ibatexas/domain"
import type { AgentContext } from "@ibatexas/types"
import { requireExternalReferenceKey } from "../external-references/index.js"

export async function getLoyaltyBalance(
  _input: Record<string, never>,
  ctx: AgentContext,
): Promise<{ stamps: number; stampsNeeded: number; totalEarned: number; message: string }> {
  if (!ctx.customerId) {
    return {
      stamps: 0,
      stampsNeeded: 10,
      totalEarned: 0,
      message: "Faca login para ver seus selos de fidelidade.",
    }
  }

  const svc = createLoyaltyService()
  const balance = await svc.getBalance(ctx.customerId)

  const plural = balance.stampsNeeded > 1 ? "s" : ""
  const message =
    balance.stampsNeeded === 0
      ? `Parabens! Voce tem um desconto disponivel! Use o codigo ${requireExternalReferenceKey("promotion.loyalty-reward")}.`
      : `Voce tem ${balance.stamps} de 10 selos. Mais ${balance.stampsNeeded} pedido${plural} e ganha R$20 de desconto! 🏆`

  return { ...balance, message }
}

export const GetLoyaltyBalanceTool = {
  name: "get_loyalty_balance",
  description:
    "Consulta o saldo de selos de fidelidade do cliente. Cada pedido = 1 selo. 10 selos = R$20 de desconto.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
} as const
