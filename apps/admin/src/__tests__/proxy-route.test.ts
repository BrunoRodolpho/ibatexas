// Unit tests for the admin Next proxy route — it rebuilds a fresh Headers()
// for the upstream call, so every header the API needs must be explicitly
// forwarded. Regression under test: Idempotency-Key was stripped, breaking
// refund step 1 (the API 400s without it).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { POST, GET } from "../app/api/proxy/[...path]/route"

const upstreamFetch = vi.fn()

beforeEach(() => {
  upstreamFetch.mockReset()
  upstreamFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )
  vi.stubGlobal("fetch", upstreamFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeRequest(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): NextRequest {
  return new NextRequest(`http://localhost:3002/api/proxy/${path}`, {
    // Node's fetch primitives require `duplex` whenever a body is streamed.
    ...(init.body === undefined ? {} : { duplex: "half" }),
    ...init,
  } as ConstructorParameters<typeof NextRequest>[1])
}

function contextFor(path: string) {
  return { params: Promise.resolve({ path: path.split("/") }) }
}

describe("admin proxy route", () => {
  it("forwards Idempotency-Key to the upstream API", async () => {
    const path = "api/admin/orders/o1/payment/refund"
    const request = makeRequest(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-123",
        // S1 — admin proxying now requires an authenticated staff session cookie.
        cookie: "staff_token=t",
      },
      body: JSON.stringify({ reason: "teste" }),
    })

    const response = await POST(request, contextFor(path))

    expect(response.status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledTimes(1)
    const [, init] = upstreamFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Headers
    expect(headers.get("idempotency-key")).toBe("idem-123")
    // Content-type must survive alongside it (the apiFetch regression pair).
    expect(headers.get("content-type")).toBe("application/json")
  })

  it("forwards content-type and cookie but not arbitrary headers", async () => {
    const path = "api/admin/orders"
    const request = makeRequest(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "staff_token=abc",
        "x-evil": "nope",
      },
      body: JSON.stringify({}),
    })

    await POST(request, contextFor(path))

    const [, init] = upstreamFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Headers
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("cookie")).toBe("staff_token=abc")
    expect(headers.get("x-evil")).toBeNull()
  })

  it("never forwards a shared x-admin-key upstream (S1 — key is CLI-only)", async () => {
    // The proxy previously injected the shared key on every forward, which let a
    // forged, presence-only staff_token cookie ride it into the key-eligible
    // staff/agents groups. Browser calls must authenticate with a real staff JWT
    // (forwarded as the cookie); the key is never attached here.
    const path = "api/admin/staff"
    const request = makeRequest(path, {
      method: "GET",
      headers: { cookie: "staff_token=abc" },
    })

    await GET(request, contextFor(path))

    const [, init] = upstreamFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Headers
    expect(headers.get("x-admin-key")).toBeNull()
    // The staff JWT cookie is still forwarded so the API's DOM-001 guard can auth it.
    expect(headers.get("cookie")).toBe("staff_token=abc")
  })

  it("omits idempotency-key upstream when the client sent none", async () => {
    const path = "api/admin/orders/o1/force-cancel"
    const request = makeRequest(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "staff_token=t" },
      body: JSON.stringify({}),
    })

    await POST(request, contextFor(path))

    const [, init] = upstreamFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Headers
    expect(headers.get("idempotency-key")).toBeNull()
  })

  it("401s an admin path without a staff session (S1 defense-in-depth)", async () => {
    // No staff_token cookie → the proxy early-bounces the logged-out browser
    // rather than forwarding to a raw upstream 401. The API's DOM-001 guard (which
    // validates the JWT) is the real boundary; this is only a UX belt.
    const path = "api/admin/orders"
    const request = makeRequest(path, { method: "GET" })

    const response = await GET(request, contextFor(path))

    expect(response.status).toBe(401)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it("still 403s non-admin paths", async () => {
    const path = "api/public/whatever"
    const request = makeRequest(path, { method: "GET" })

    const response = await GET(request, contextFor(path))

    expect(response.status).toBe(403)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })
})
