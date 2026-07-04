import { formatBRL } from '@/lib/format'

/**
 * One special as returned by the PUBLIC read GET /api/specials/today (NEW-038 (a)).
 * The server projects ONLY the customer fields (no internal id / timestamps).
 */
export interface SpecialResponseItem {
  productId: string
  promoPriceCentavos: number | null
  headline: string | null
}

/** The GET /api/specials/today response envelope. */
export interface SpecialsResponse {
  specials: SpecialResponseItem[]
}

/** A display-ready special: the headline + a formatted BRL promo price (or null). */
export interface SpecialDisplay {
  productId: string
  headline: string | null
  /** formatBRL(promoPriceCentavos), or null when the special carries no discount. */
  promoPrice: string | null
}

/**
 * PURE transform: the public specials API response → display rows.
 *
 * - Empty-safe: a null response, a non-array `specials`, or an empty array → [].
 * - Skips a row with no usable `productId` (can't key / link / track it).
 * - Formats the INTEGER-CENTAVOS promo price to a BRL string via the shared
 *   `formatBRL`; a null/undefined/non-number promo price → `promoPrice: null`
 *   (featured with no discount). Never a raw centavos integer in the UI.
 * - Order preserved (the server already ordered by createdAt).
 *
 * Kept as a pure function (no React) so the promo-price formatting + empty-safety
 * are unit-tested without rendering.
 */
export function toSpecialsDisplay(response: SpecialsResponse | null | undefined): SpecialDisplay[] {
  if (!response || !Array.isArray(response.specials)) return []
  return response.specials
    .filter((s) => typeof s?.productId === 'string' && s.productId.length > 0)
    .map((s) => ({
      productId: s.productId,
      headline: typeof s.headline === 'string' && s.headline.length > 0 ? s.headline : null,
      promoPrice: typeof s.promoPriceCentavos === 'number' ? formatBRL(s.promoPriceCentavos) : null,
    }))
}
