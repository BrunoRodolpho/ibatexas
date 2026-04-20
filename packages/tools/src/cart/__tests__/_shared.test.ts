// Tests for _shared.ts — medusaStoreFetch / medusaAdminFetch
// Mock global.fetch to test headers, error handling, timeout signals
//
// Scenarios:
// - medusaStoreFetch: correct headers, publishable key, JSON parse, error status
// - medusaAdminFetch: correct admin token header, JSON parse, error status
// - Both: timeout signal, custom options passthrough

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { medusaStoreFetch, medusaAdminFetch } from "../_shared.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockFetch = vi.hoisted(() => vi.fn())

// ── Mock global.fetch ────────────────────────────────────────────────────────

vi.stubGlobal("fetch", mockFetch)

// Admin auth is resolved via /auth/user/emailpass at runtime; these env vars
// satisfy the client's guard. The publishable key is resolved from the admin
// API on first store call — see the priming beforeAll below.
process.env.MEDUSA_ADMIN_EMAIL = "test@example.com"
process.env.MEDUSA_ADMIN_PASSWORD = "test-password"

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOkResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

function makeErrorResponse(status: number, text: string) {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error("not json")),
    text: () => Promise.resolve(text),
  }
}

// Build a fake JWT whose payload has an `exp` far in the future so the
// admin-token cache never triggers a refresh during tests.
function makeFakeJwt(expSecondsFromNow = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }),
  ).toString("base64url")
  return `${header}.${payload}.sig`
}

function makeAuthResponse() {
  return makeOkResponse({ token: makeFakeJwt() })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("medusaStoreFetch", () => {
  // Prime the module-level admin-token and publishable-key caches once up
  // front so individual tests can use simple mockResolvedValue(...) without
  // having to handle the intermediate /auth/user/emailpass and
  // /admin/api-keys calls. Caches persist for the process lifetime.
  beforeAll(async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/auth/user/emailpass")) {
        return Promise.resolve(makeAuthResponse())
      }
      if (typeof url === "string" && url.includes("/admin/api-keys")) {
        return Promise.resolve(makeOkResponse({ api_keys: [{ token: "pk_resolved" }] }))
      }
      return Promise.resolve(makeOkResponse({}))
    })
    await medusaStoreFetch("/store/__prime__")
    mockFetch.mockReset()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("sends correct headers with publishable API key", async () => {
    const responseBody = { cart: { id: "cart_01" } }
    mockFetch.mockResolvedValue(makeOkResponse(responseBody))

    await medusaStoreFetch("/store/carts/cart_01")

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain("/store/carts/cart_01")
    expect(opts.headers["x-publishable-api-key"]).toBeDefined()
    expect(opts.headers["Content-Type"]).toBe("application/json")
  })

  it("returns parsed JSON on success", async () => {
    const responseBody = { cart: { id: "cart_01", items: [] } }
    mockFetch.mockResolvedValue(makeOkResponse(responseBody))

    const result = await medusaStoreFetch("/store/carts/cart_01")

    expect(result).toEqual(responseBody)
  })

  it("throws on non-ok response with status code and body", async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(404, "Cart not found"))

    await expect(medusaStoreFetch("/store/carts/cart_999")).rejects.toThrow("Medusa 404")
  })

  it("throws on 500 error", async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(500, "Internal Server Error"))

    await expect(medusaStoreFetch("/store/carts/cart_01")).rejects.toThrow("Medusa 500")
  })

  it("passes custom options through", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({}))

    await medusaStoreFetch("/store/carts", {
      method: "POST",
      body: JSON.stringify({ test: true }),
    })

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.method).toBe("POST")
    expect(opts.body).toBe(JSON.stringify({ test: true }))
  })

  it("merges custom headers with defaults", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({}))

    await medusaStoreFetch("/store/carts", {
      headers: { "X-Custom": "value" },
    })

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers["X-Custom"]).toBe("value")
    expect(opts.headers["Content-Type"]).toBe("application/json")
  })

  it("includes a timeout signal by default", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({}))

    await medusaStoreFetch("/store/carts")

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.signal).toBeDefined()
  })

  it("preserves caller-provided signal over default", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({}))
    const controller = new AbortController()

    await medusaStoreFetch("/store/carts", { signal: controller.signal })

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.signal).toBe(controller.signal)
  })
})

describe("medusaAdminFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: any fetch returns a fresh auth token. Individual tests override
    // with mockResolvedValueOnce for the actual admin endpoint response.
    // The token cache is module-level so the auth call happens at most once
    // across the whole describe block after the first cache miss.
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/auth/user/emailpass")) {
        return Promise.resolve(makeAuthResponse())
      }
      return Promise.resolve(makeOkResponse({}))
    })
  })

  // Call index of the admin endpoint fetch (0 if auth was cached from a prior
  // test, 1 if this test triggered a fresh auth call first).
  function adminCallIndex(): number {
    const idx = mockFetch.mock.calls.findIndex(
      ([u]) => typeof u === "string" && !u.includes("/auth/user/emailpass"),
    )
    return idx >= 0 ? idx : 0
  }

  it("sends correct admin access token header", async () => {
    const responseBody = { order: { id: "order_01" } }
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/auth/user/emailpass")) {
        return Promise.resolve(makeAuthResponse())
      }
      return Promise.resolve(makeOkResponse(responseBody))
    })

    await medusaAdminFetch("/admin/orders/order_01")

    const [url, opts] = mockFetch.mock.calls[adminCallIndex()]
    expect(url).toContain("/admin/orders/order_01")
    expect(opts.headers["Authorization"]).toMatch(/^Bearer /)
    expect(opts.headers["Content-Type"]).toBe("application/json")
  })

  it("returns parsed JSON on success", async () => {
    const responseBody = { order: { id: "order_01", status: "pending" } }
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/auth/user/emailpass")) {
        return Promise.resolve(makeAuthResponse())
      }
      return Promise.resolve(makeOkResponse(responseBody))
    })

    const result = await medusaAdminFetch("/admin/orders/order_01")

    expect(result).toEqual(responseBody)
  })

  it("throws on non-ok response with status code and body", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/auth/user/emailpass")) {
        return Promise.resolve(makeAuthResponse())
      }
      return Promise.resolve(makeErrorResponse(403, "Forbidden"))
    })

    await expect(medusaAdminFetch("/admin/orders/order_01")).rejects.toThrow("Medusa 403")
  })

  it("throws on 500 error", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/auth/user/emailpass")) {
        return Promise.resolve(makeAuthResponse())
      }
      return Promise.resolve(makeErrorResponse(500, "Server Error"))
    })

    await expect(medusaAdminFetch("/admin/orders/order_01")).rejects.toThrow("Medusa 500")
  })

  it("passes custom method and body", async () => {
    await medusaAdminFetch("/admin/orders/order_01/cancel", {
      method: "POST",
      body: JSON.stringify({}),
    })

    const [, opts] = mockFetch.mock.calls[adminCallIndex()]
    expect(opts.method).toBe("POST")
  })

  it("includes a timeout signal by default", async () => {
    await medusaAdminFetch("/admin/orders")

    const [, opts] = mockFetch.mock.calls[adminCallIndex()]
    expect(opts.signal).toBeDefined()
  })
})
