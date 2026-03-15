/**
 * Shared constants for the web app.
 * Single source of truth for values used across multiple components.
 */

/** Free delivery threshold in centavos (R$150,00) */
export const FREE_DELIVERY_THRESHOLD = 15000

/** Tiny warm-gray SVG shimmer — used as blurDataURL for remote images */
export const BLUR_PLACEHOLDER =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="10"><rect fill="#e8e4e0" width="8" height="10"/></svg>'
  )
