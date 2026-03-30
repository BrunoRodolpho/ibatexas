/**
 * Shared formatting utilities — single source of truth.
 * Consolidates 6+ duplicated formatBRL() across admin organisms + web.
 */

/**
 * Format centavos to BRL currency string.
 * @param centavos - Price in centavos (8900 = R$89,00)
 * @example formatBRL(8900) // "R$ 89,00"
 */
export function formatBRL(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

/**
 * Format ISO date string to localized pt-BR date.
 * @param iso - ISO 8601 date string
 * @param options - Intl.DateTimeFormat options (defaults to short date)
 */
export function formatDate(
  iso: string,
  options?: Intl.DateTimeFormatOptions
): string {
  const defaultOptions: Intl.DateTimeFormatOptions = {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }
  return new Date(iso).toLocaleDateString('pt-BR', options ?? defaultOptions)
}

/**
 * Format date with time.
 * @param iso - ISO 8601 date string
 */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Format a numeric rating to display string.
 * @param rating - Rating value (e.g., 4.5)
 * @example formatRating(4.5) // "4,5"
 */
export function formatRating(rating: number): string {
  return rating.toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
}
