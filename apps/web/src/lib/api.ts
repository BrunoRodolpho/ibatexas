import type { ZodType } from 'zod'

export { getApiBase, MEDUSA_ADMIN_URL } from '@ibatexas/tools/api'

import { getApiBase } from '@ibatexas/tools/api'

const API_BASE = getApiBase()

/** Default request timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 10_000

interface ApiFetchOptions<T> extends RequestInit {
  /** Optional Zod schema — when provided, the response is validated at runtime. */
  schema?: ZodType<T>
}

/**
 * Type-safe API fetch.
 *
 * - When called with a `schema`, the response JSON is parsed + validated and
 *   the return type is inferred from the schema.
 * - When called without a schema, the return type is `unknown` (callers must
 *   narrow it themselves — no more silent `any`).
 * - A 10 s timeout is applied automatically unless the caller provides a signal.
 */
export async function apiFetch<T = unknown>(
  endpoint: string,
  options?: ApiFetchOptions<T>,
): Promise<T> {
  const url = `${API_BASE}${endpoint}`

  // Apply a default timeout unless the caller already provides a signal
  const timeoutController = options?.signal ? null : new AbortController()
  const timeoutId = timeoutController
    ? setTimeout(() => timeoutController.abort(), DEFAULT_TIMEOUT_MS)
    : null

  try {
    const opts: ApiFetchOptions<T> = options ?? {}
    const { schema, ...fetchOptions } = opts

    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        "Content-Type": "application/json",
        ...fetchOptions.headers,
      },
      ...fetchOptions,
      signal: fetchOptions.signal ?? timeoutController?.signal,
    })

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`)
    }

    const json = await response.json()

    if (schema) {
      return schema.parse(json)
    }

    return json as T
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

// AUDIT-FIX: FE-M2 — Accept optional AbortSignal to allow cancellation on unmount
export const apiStream = async (endpoint: string, onChunk: (chunk: unknown) => void, signal?: AbortSignal) => {
  const url = `${API_BASE}${endpoint}`
  const response = await fetch(url, {
    credentials: 'include',
    signal,
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
          } catch {
            // Malformed JSON chunk — skip and continue processing stream
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
