/**
 * LGPD self-service (CUS-064) — customer data portability (LGPD Art. 18).
 *
 * The API is complete (`GET /api/me/data`, adjudicated + per-customer locked);
 * this is the web on-ramp. `fetchMyData` is the testable seam (the network
 * call); `downloadAsJson` is browser glue that turns the payload into a file.
 */

import { apiFetch } from '@/lib/api'

/** Fetch the authenticated customer's exportable data (LGPD portability). */
export async function fetchMyData(): Promise<unknown> {
  // apiFetch sends credentials + throws on non-2xx (incl. the 409 lock-contention
  // case), which the caller surfaces as a retry-able error.
  return apiFetch<unknown>('/api/me/data', { credentials: 'include' })
}

/** Default filename for the exported data file. */
export const LGPD_EXPORT_FILENAME = 'ibatexas-meus-dados.json'

/**
 * Trigger a browser download of `data` as a pretty-printed JSON file. Browser
 * glue (Blob + object URL + a transient anchor); no-op outside a DOM.
 */
export function downloadAsJson(data: unknown, filename = LGPD_EXPORT_FILENAME): void {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}
