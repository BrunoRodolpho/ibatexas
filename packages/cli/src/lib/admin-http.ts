// Shared admin-route HTTP transport for the CLI (x-admin-key auth).
//
// First introduced inline by `ibx agent` (BKL-120) as "the tiny helper …
// intentionally minimal, not a generic HTTP layer"; the SECOND admin-route caller
// (`ibx staff`, AUT-038) promotes it to this shared module so the transport is not
// duplicated. Still intentionally minimal — base-URL + key resolution + a
// never-throws fetch wrapper — command-specific status→message mapping stays in
// each command (the agent kill-switch and staff-CRUD routes speak different error
// shapes and pt-BR copy).

/** API base URL. Default port 3001 per packages/cli/src/services.ts. */
export function getAdminApiUrl(): string {
  return process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
}

/**
 * The admin API key sent as `x-admin-key`. `ADMIN_API_KEY` may be a
 * comma-separated rotation list (routes/admin/index.ts treats every listed key
 * as valid), so send the first non-empty entry. Returns null when unset —
 * callers refuse rather than call the route unauthenticated.
 */
export function resolveAdminKey(): string | null {
  const raw = process.env.ADMIN_API_KEY ?? ""
  return (
    raw
      .split(",")
      .map((k) => k.trim())
      .find((k) => k.length > 0) ?? null
  )
}

export type AdminOutcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: string }

/**
 * Call an admin route with the admin key. Never throws: a missing key or an
 * unreachable API is returned as `{ ok: false }`. On a reachable API the raw
 * status + parsed body are returned (including non-2xx) for the caller to map.
 * A request body is only attached when supplied — routes with no body schema
 * would 400 on an unparseable body if sent `content-type: application/json` with
 * an empty body.
 */
export async function callAdmin(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
): Promise<AdminOutcome> {
  const key = resolveAdminKey()
  if (key === null) {
    return {
      ok: false,
      error:
        "ADMIN_API_KEY is not set — set the admin API key in your environment (.env) to reach the admin routes.",
    }
  }
  const url = `${getAdminApiUrl()}${path}`
  const headers: Record<string, string> = { "x-admin-key": key }
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers["content-type"] = "application/json"
    init.body = JSON.stringify(body)
  }
  try {
    const res = await fetch(url, init)
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    return { ok: true, status: res.status, body: parsed }
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach the API at ${getAdminApiUrl()} — is it running? (ibx dev)  [${(err as Error).message}]`,
    }
  }
}
