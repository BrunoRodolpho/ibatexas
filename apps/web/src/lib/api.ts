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
 * A non-2xx API response.
 *
 * Carries the HTTP `status` so callers can branch on it structurally instead of
 * parsing the message (BKL-286: the chat needs to tell "your session credential
 * is dead" (403) from any other failure, and `message` is developer text that
 * must never be shown to a customer).
 */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, statusText: string) {
    super(`API error: ${status} ${statusText}`)
    this.name = "ApiError"
    this.status = status
  }
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
    const { schema, headers: callerHeaders, ...fetchOptions } = opts

    const response = await fetch(url, {
      credentials: 'include',
      ...fetchOptions,
      headers: {
        "Content-Type": "application/json",
        ...callerHeaders,
      },
      signal: fetchOptions.signal ?? timeoutController?.signal,
    })

    if (!response.ok) {
      throw new ApiError(response.status, response.statusText)
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

/**
 * Read an SSE endpoint.
 *
 * NB (BKL-286): this is a **fetch**-based reader, not an `EventSource` — so it
 * CAN carry request headers, and session credentials must travel as headers.
 * Never move a credential into the query string: URLs land in access logs,
 * proxy logs and `Referer`, which an `x-` header does not.
 *
 * @param signal   optional AbortSignal to allow cancellation on unmount
 * @param headers  per-request headers (session credentials); pass them fresh at
 *                 call time so a re-minted credential is never sent stale.
 */
export const apiStream = async (
  endpoint: string,
  onChunk: (chunk: unknown) => void,
  signal?: AbortSignal,
  headers?: Record<string, string>,
) => {
  const url = `${API_BASE}${endpoint}`
  const response = await fetch(url, {
    credentials: 'include',
    signal,
    ...(headers && { headers }),
  })

  if (!response.ok) {
    throw new ApiError(response.status, response.statusText)
  }

  if (!response.body) {
    throw new Error("No response body")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  // BKL-286: carry the trailing partial line across reads. A TCP read boundary
  // can land mid-frame, and the previous split-per-read parse dropped whatever
  // straddled it — including, on a denied stream, the single `error` frame that
  // is the client's ONLY signal. (The CLI and journeys SSE readers both buffer;
  // this one was the outlier.)
  let buffer = ""

  const emitLine = (line: string): void => {
    if (!line.startsWith("data: ")) return
    try {
      onChunk(JSON.parse(line.slice(6)))
    } catch {
      // Malformed JSON frame — skip and continue processing the stream
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      // The last element is either "" (the read ended on a boundary) or a
      // partial line — either way it is not yet complete, so hold it back.
      buffer = lines.pop() ?? ""
      for (const line of lines) emitLine(line)
    }
    // Flush a final frame that arrived without a trailing newline.
    emitLine(buffer)
  } finally {
    reader.releaseLock()
  }
}
