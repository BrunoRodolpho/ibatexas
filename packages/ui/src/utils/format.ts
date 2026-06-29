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

/**
 * Aging threshold for no-reply incidents, in minutes. An OPEN incident older
 * than this is "aged" — the customer is hanging — and renders its idade in red.
 */
export const INCIDENT_AGING_MINUTES = 20

/**
 * Relative pt-BR age formatter for the Incidentes queue/drawer.
 * Orders only ever showed an absolute `toLocaleString`; aging needs relative time.
 * @example formatAge('2026-06-29T14:00:00Z') // "há 31 min" | "há 2 h" | "agora"
 */
export function formatAge(date: string | Date, now: Date = new Date()): string {
  const then = typeof date === 'string' ? new Date(date) : date
  const diffMs = now.getTime() - then.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'agora'
  if (diffMin < 60) return `há ${diffMin} min`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `há ${diffH} h`
  const diffD = Math.floor(diffH / 24)
  return `há ${diffD} d`
}

/**
 * Whether an incident opened-at timestamp has crossed the aging threshold
 * (drives the red `text-accent-red` idade styling).
 */
export function isAged(
  date: string | Date,
  thresholdMinutes: number = INCIDENT_AGING_MINUTES,
  now: Date = new Date(),
): boolean {
  const then = typeof date === 'string' ? new Date(date) : date
  return now.getTime() - then.getTime() > thresholdMinutes * 60_000
}
