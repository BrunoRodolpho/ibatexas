/**
 * Resolve the API base URL. On the server (SSR) we use the env var directly.
 * In the browser, if the configured URL points to localhost but the page is
 * being accessed from a LAN IP (e.g. mobile device testing), we swap to the
 * current hostname so the phone can actually reach the Mac's API server.
 */
function getApiBase(): string {
  if (typeof window === "undefined") {
    return process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
  }
  const configured = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
  try {
    const url = new URL(configured)
    if (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      window.location.hostname !== "localhost" &&
      window.location.hostname !== "127.0.0.1"
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

export const MEDUSA_ADMIN_URL = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "http://localhost:9000"

export const apiFetch = async (endpoint: string, options?: RequestInit) => {
  const url = `${API_BASE}${endpoint}`
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

export const apiStream = async (endpoint: string, onChunk: (chunk: unknown) => void) => {
  const url = `${API_BASE}${endpoint}`
  const response = await fetch(url, {
    credentials: 'include',
  })

  if (!response.ok) {
    throw new Error(`Stream error: ${response.status}`)
  }

  if (!response.body) {
    throw new Error("No response body")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split("\n")

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6))
            onChunk(data)
          } catch (err) {
            console.warn("Failed to parse chunk:", line)
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
