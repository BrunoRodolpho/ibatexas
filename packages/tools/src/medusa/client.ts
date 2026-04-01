// Shared Medusa HTTP client — single source of truth for all Medusa API calls.
//
// Used by: cart tools, API routes, OrderService (via injection).
// Throws MedusaRequestError with structured fields (statusCode, responseText).

const MEDUSA_URL = process.env.MEDUSA_URL ?? "http://localhost:9000"
const DEFAULT_TIMEOUT_MS = 10_000

/** Convert Medusa v2 price (reais, e.g. 89.00) to centavos (8900). */
export function reaisToCentavos(amount: number): number {
  return Math.round(amount * 100)
}

// ── Error class ──────────────────────────────────────────────────────────────

export class MedusaRequestError extends Error {
  readonly statusCode: number
  readonly upstream = "Medusa" as const
  readonly responseText: string

  constructor(statusCode: number, responseText: string, path: string) {
    super(`Medusa ${statusCode}: ${path}`)
    this.name = "MedusaRequestError"
    this.statusCode = statusCode
    this.responseText = responseText
  }
}

// ── Admin API (Authorization: Basic <secret-key>) ───────────────────────────

export async function medusaAdmin(path: string, options?: RequestInit): Promise<unknown> {
  const apiKey = process.env.MEDUSA_API_KEY
  if (!apiKey) {
    throw new Error("MEDUSA_API_KEY environment variable is not set")
  }
  const res = await fetch(`${MEDUSA_URL}${path}`, {
    ...options,
    signal: options?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${apiKey}`,
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    console.error(`[medusa-admin] ${res.status} ${path}: ${text}`)
    throw new MedusaRequestError(res.status, text, path)
  }
  return res.json()
}

// ── Store API (x-publishable-api-key) ────────────────────────────────────────

export async function medusaStore(path: string, options?: RequestInit): Promise<unknown> {
  const publishableKey = process.env.MEDUSA_PUBLISHABLE_KEY ?? ""
  const res = await fetch(`${MEDUSA_URL}${path}`, {
    ...options,
    signal: options?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: {
      "x-publishable-api-key": publishableKey,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    const reqBody = options?.body ? String(options.body).slice(0, 500) : "(no body)"
    console.error(`[medusa-store] ${res.status} ${path}\n  request: ${reqBody}\n  response: ${text.slice(0, 500)}`)
    throw new MedusaRequestError(res.status, text, path)
  }
  return res.json()
}
