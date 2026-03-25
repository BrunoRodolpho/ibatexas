// get_loyalty_balance tool
// Returns the customer's punch-card stamp balance and a human-readable message.

import type { AgentContext } from "@ibatexas/types"
import { createLoyaltyService } from "@ibatexas/domain"

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

  const message =
    balance.stampsNeeded === 0
      ? "Parabens! Voce tem um desconto disponivel! Use o codigo FIEL20."
      : `Voce tem ${balance.stamps} de 10 selos. Mais ${balance.stampsNeeded} pedido${balance.stampsNeeded > 1 ? "s" : ""} e ganha R$20 de desconto! 🏆`

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
