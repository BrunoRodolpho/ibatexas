// oracle/http-verify-client.ts — GET-only verify HTTP client (T1a-9).
//
// Containment: journey VERIFY steps may read public HTTP surfaces (e.g.
// /health depth checks) but must never mutate the SUT over HTTP — mutations
// belong to acts (ChatClient / http acts), which the reconciliation gate
// audits against `intent_audit`. This client makes non-GET requests:
//
//   1. impossible at the TYPE level — the surface exposes only `get()`, and
//      `HttpVerifyGetInit` has no `method`/`body` members (writing
//      `client.post(...)` or `get(path, { method: "POST" })` is a compile
//      error — pinned by @ts-expect-error blocks in the unit tests), AND
//   2. impossible at RUNTIME — an init smuggled past the compiler (cast,
//      plain-JS caller) carrying a non-GET `method` or any `body` throws
//      `HttpVerifyMethodError` BEFORE any fetch happens, and the underlying
//      fetch is always invoked with a hardcoded `method: "GET"`.
//
// As a second containment axis the client is origin-pinned: every request
// resolves against `baseUrl` and must land on the same origin (no verify-step
// probing of arbitrary hosts) — violations throw `HttpVerifyOriginError`.

/** Thrown when a non-GET method or a request body reaches the client at runtime. */
export class HttpVerifyMethodError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HttpVerifyMethodError"
  }
}

/** Thrown when a request would leave the client's pinned base origin. */
export class HttpVerifyOriginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HttpVerifyOriginError"
  }
}

/**
 * Per-request options. Deliberately NOT `RequestInit`: no `method`, no `body`
 * — their absence here is the type-level half of the GET-only guarantee.
 */
export interface HttpVerifyGetInit {
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** Normalized response — headers lowercased, body pre-read as text. */
export interface HttpVerifyResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  bodyText: string
  /** Parse `bodyText` as JSON; throws a descriptive Error on invalid JSON. */
  json(): unknown
}

/**
 * Structural fetch contract (the global `fetch` satisfies it; unit tests
 * inject a stub). The init's `method` is the literal `"GET"` — the client
 * never constructs anything else.
 */
export type HttpVerifyFetch = (
  url: string,
  init: { method: "GET"; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number
  headers: { forEach(callback: (value: string, key: string) => void): void }
  text(): Promise<string>
}>

export interface HttpVerifyClientOptions {
  /** Origin the client is pinned to, e.g. `http://localhost:3001`. */
  baseUrl: string
  /** Injection point for tests; defaults to the global `fetch`. */
  fetchImpl?: HttpVerifyFetch
  /** Headers sent on every request (per-request headers win on conflict). */
  defaultHeaders?: Record<string, string>
}

/** The whole public surface: `get` and nothing else. */
export interface HttpVerifyClient {
  readonly baseUrl: string
  get(path: string, init?: HttpVerifyGetInit): Promise<HttpVerifyResponse>
}

const WRITE_METHODS = ["POST", "PUT", "DELETE", "PATCH"] as const

/**
 * Coerce a smuggled `method` value to a display string for the error message.
 * Typed `unknown` (not the call site's narrowed object type) so the coercion is
 * exactly `String(method)` for every input — including the `[object Object]`
 * default for objects — without surfacing as a stringification lint at the call site.
 */
function methodLabel(method: unknown): string {
  return String(method)
}

/**
 * Runtime half of the GET-only guarantee: reject any init that smuggles a
 * non-GET method or a body past the type system (cast / plain-JS callers).
 */
function assertGetOnlyInit(init: HttpVerifyGetInit | undefined): void {
  if (init === undefined || init === null) return
  const raw = init as Record<string, unknown>
  const method = raw["method"]
  if (method !== undefined && method !== null) {
    const name = typeof method === "string" ? method.toUpperCase() : methodLabel(method)
    if (name !== "GET") {
      throw new HttpVerifyMethodError(
        `http-verify-client is GET-only: refusing method "${methodLabel(method)}" ` +
          `(${WRITE_METHODS.join("/")} and friends are containment violations — ` +
          `mutations belong to journey acts, never verify steps)`,
      )
    }
  }
  if (raw["body"] !== undefined && raw["body"] !== null) {
    throw new HttpVerifyMethodError(
      "http-verify-client is GET-only: refusing a request body (GET reads carry no body)",
    )
  }
}

export function createHttpVerifyClient(options: HttpVerifyClientOptions): HttpVerifyClient {
  const { baseUrl, defaultHeaders } = options
  const fetchImpl: HttpVerifyFetch = options.fetchImpl ?? globalThis.fetch
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    throw new HttpVerifyOriginError(`invalid baseUrl: "${baseUrl}"`)
  }

  async function get(path: string, init?: HttpVerifyGetInit): Promise<HttpVerifyResponse> {
    assertGetOnlyInit(init)

    let url: URL
    try {
      url = new URL(path, base)
    } catch {
      throw new HttpVerifyOriginError(`cannot resolve path "${path}" against ${base.origin}`)
    }
    if (url.origin !== base.origin) {
      throw new HttpVerifyOriginError(
        `http-verify-client is pinned to ${base.origin} — refusing cross-origin GET ${url.toString()}`,
      )
    }

    const response = await fetchImpl(url.toString(), {
      // Hardcoded — never derived from caller input.
      method: "GET",
      headers: { ...defaultHeaders, ...init?.headers },
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    })

    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    const bodyText = await response.text()

    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers,
      bodyText,
      json(): unknown {
        try {
          return JSON.parse(bodyText)
        } catch (error) {
          throw new Error(
            `http-verify-client: response from GET ${url.pathname} is not valid JSON ` +
              `(status ${response.status}): ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      },
    }
  }

  return { baseUrl: base.toString(), get }
}
