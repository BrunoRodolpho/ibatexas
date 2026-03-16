/**
 * API client for the admin app.
 * Same as @ibatexas/web's lib/api.ts but scoped to the admin app.
 */

function getApiBase(): string {
  if (typeof globalThis.window === 'undefined') {
    return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
  }
  const configured = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
  try {
    const url = new URL(configured)
    if (
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      globalThis.location.hostname !== 'localhost' &&
      globalThis.location.hostname !== '127.0.0.1'
    ) {
      url.hostname = globalThis.location.hostname
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
