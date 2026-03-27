/**
 * Consolidated price formatting utilities.
 * Single source of truth — no more Intl.NumberFormat scattered across components.
 *
 * @example
 *   formatBRL(8900)          // "R$ 89,00"
 *   formatPerPerson(8900, 4) // "R$ 22,25 por pessoa"
 */

const brlFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
})

/**
 * Format a price in centavos to BRL string.
 * @param centavos — integer price in centavos (8900 = R$89,00)
 */
export function formatBRL(centavos: number): string {
  return brlFormatter.format(centavos / 100)
}

/**
 * Format per-person price from total centavos.
 * @param centavos — total price in centavos
 * @param servings — number of servings/persons
 */
export function formatPerPerson(centavos: number, servings: number): string {
  if (servings <= 0) return formatBRL(centavos)
  return brlFormatter.format(centavos / 100 / servings)
}

/**
 * Split a BRL price into prefix and value for display-oriented layouts.
 * @param centavos — integer price in centavos
 * @returns { prefix: "R$", value: "89,00" }
 */
export function splitBRL(centavos: number): { prefix: string; value: string } {
  const formatted = (centavos / 100).toFixed(2).replace('.', ',')
  return { prefix: 'R$', value: formatted }
}

/** Format a numeric rating for display (e.g., 4.7 → "4,7"). Uses comma for pt-BR. */
export function formatRating(rating: number): string {
  return rating.toFixed(1).replace('.', ',')
}
