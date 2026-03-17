/**
 * API client for the admin app.
 */
import { getApiBase, MEDUSA_ADMIN_URL } from '@ibatexas/tools'

export { getApiBase, MEDUSA_ADMIN_URL }

const API_BASE = getApiBase()

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
