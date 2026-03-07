/**
 * API client for the admin app.
 * Same as @ibatexas/web's lib/api.ts but scoped to the admin app.
 */

function getApiBase(): string {
  if (typeof window === 'undefined') {
    return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
  }
  const configured = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
  try {
    const url = new URL(configured)
    if (
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1'
    ) {
      url.hostname = window.location.hostname
    }
    return url.origin
  } catch {
    return configured
  }
}

export { getApiBase }

const API_BASE = getApiBase()

export const MEDUSA_ADMIN_URL = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || 'http://localhost:9000'

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
