// Cart recovery message builder — 3-tier personalized WhatsApp recovery sequence.
// Tier 1: gentle nudge (2h after abandonment)
// Tier 2: discount incentive (6h after abandonment)
// Tier 3: scarcity/urgency (24h after abandonment)

/**
 * Build a personalized cart recovery message for the given tier.
 *
 * @param tier - Recovery tier (1 = gentle, 2 = incentive, 3 = scarcity)
 * @param itemNames - Resolved product names from the cart
 * @param customerName - Optional customer first name for personalization
 */
export function buildCartRecoveryMessage(
  tier: 1 | 2 | 3,
  itemNames: string[],
  customerName?: string,
): string {
  const nameClause = customerName ? `, ${customerName}` : "";
  const nameStart = customerName ? `${customerName}, ` : "";

  const hasItems = itemNames.length > 0;
  const item1 = hasItems ? itemNames[0] : "seus itens";
  const fallbackItem = "seu pedido";

  let andMore = "";
  if (hasItems && itemNames.length > 1) {
    const extra = itemNames.length - 1;
    andMore = extra === 1 ? ` e mais ${extra} item` : ` e mais ${extra} itens`;
  }

  if (tier === 1) {
    const cartRef = hasItems ? `${item1}${andMore}` : "seus itens";
    return `Oi${nameClause}! Parece que ${cartRef} ficou no seu carrinho. Quer finalizar? Responda "meu carrinho" 🛒`;
  }

  if (tier === 2) {
    return `Ainda pensando${nameClause}? Use o codigo VOLTA10 pra 10% off no seu pedido! Responda "meu carrinho" 🎁`;
  }

  // tier === 3
  const scarcityItem = hasItems ? item1 : fallbackItem;
  return `${nameStart}Ultimas chances de garantir ${scarcityItem}! Seu carrinho expira em breve. Responda "meu carrinho" 🔥`;
}
