/**
 * Cross-sell category pairing map.
 * Defines which categories complement each other for upselling.
 *
 * This is product domain knowledge that shouldn't live in React components.
 */

/** Given a product's primary category, return paired cross-sell categories */
export const CROSS_SELL_MAP: Record<string, string[]> = {
  'carnes-defumadas': ['acompanhamentos', 'bebidas'],
  'sanduiches': ['acompanhamentos', 'sobremesas'],
  'acompanhamentos': ['carnes-defumadas', 'bebidas'],
  'sobremesas': ['bebidas'],
  'bebidas': ['carnes-defumadas', 'sanduiches'],
  'congelados': ['acompanhamentos'],
  'kits': ['bebidas', 'acompanhamentos'],
  'camisetas': ['carnes-defumadas', 'kits'],
}

/**
 * Get the primary cross-sell category for a given product category.
 * Returns undefined if no pairing exists.
 */
export function getCrossSellCategory(categoryHandle: string): string | undefined {
  return CROSS_SELL_MAP[categoryHandle]?.[0]
}
