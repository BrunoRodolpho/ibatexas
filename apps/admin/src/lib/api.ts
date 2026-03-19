/**
 * API client for the admin app.
 */
export { getApiBase, MEDUSA_ADMIN_URL } from '@ibatexas/tools/api'

import { getApiBase } from '@ibatexas/tools/api'

const API_BASE = getApiBase()

// AUDIT-FIX: SEC-F01/FE-H3 — include x-admin-key header in all admin API calls
export const apiFetch = async (endpoint: string, options?: RequestInit) => {
  const url = `${API_BASE}${endpoint}`
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': process.env.NEXT_PUBLIC_ADMIN_API_KEY ?? '',
      ...options?.headers,
    },
    ...options,
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}
