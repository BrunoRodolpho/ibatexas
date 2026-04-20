/**
 * API client for the admin app.
 *
 * All requests are routed through /api/proxy which adds the x-admin-key
 * header server-side, keeping the secret out of the browser bundle.
 */
export { MEDUSA_ADMIN_URL } from '@ibatexas/tools/api'

const API_BASE = "/api/proxy"

export const apiFetch = async (endpoint: string, options?: RequestInit) => {
  const url = `${API_BASE}${endpoint}`
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}
