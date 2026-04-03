// Tests for _shared.ts — medusaStoreFetch / medusaAdminFetch
// Mock global.fetch to test headers, error handling, timeout signals
//
// Scenarios:
// - medusaStoreFetch: correct headers, publishable key, JSON parse, error status
// - medusaAdminFetch: correct admin token header, JSON parse, error status
// - Both: timeout signal, custom options passthrough

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { medusaStoreFetch, medusaAdminFetch } from "../_shared.js"

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mockFetch = vi.hoisted(() => vi.fn())

// ── Mock global.fetch ────────────────────────────────────────────────────────

vi.stubGlobal("fetch", mockFetch)

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("medusaStoreFetch", () => {
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
    process.env.MEDUSA_API_KEY = "test-admin-key"
  })

  afterEach(() => {
    delete process.env.MEDUSA_API_KEY
  })

  it("sends correct admin access token header", async () => {
    const responseBody = { order: { id: "order_01" } }
    mockFetch.mockResolvedValue(makeOkResponse(responseBody))

    await medusaAdminFetch("/admin/orders/order_01")

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toContain("/admin/orders/order_01")
    expect(opts.headers["Authorization"]).toBeDefined()
    expect(opts.headers["Content-Type"]).toBe("application/json")
  })

  it("returns parsed JSON on success", async () => {
    const responseBody = { order: { id: "order_01", status: "pending" } }
    mockFetch.mockResolvedValue(makeOkResponse(responseBody))

    const result = await medusaAdminFetch("/admin/orders/order_01")

    expect(result).toEqual(responseBody)
  })

  it("throws on non-ok response with status code and body", async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(403, "Forbidden"))

    await expect(medusaAdminFetch("/admin/orders/order_01")).rejects.toThrow("Medusa 403")
  })

  it("throws on 500 error", async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(500, "Server Error"))

    await expect(medusaAdminFetch("/admin/orders/order_01")).rejects.toThrow("Medusa 500")
  })

  it("passes custom method and body", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({}))

    await medusaAdminFetch("/admin/orders/order_01/cancel", {
      method: "POST",
      body: JSON.stringify({}),
    })

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.method).toBe("POST")
  })

  it("includes a timeout signal by default", async () => {
    mockFetch.mockResolvedValue(makeOkResponse({}))

    await medusaAdminFetch("/admin/orders")

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.signal).toBeDefined()
  })
})
