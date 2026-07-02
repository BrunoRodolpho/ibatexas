// Unit tests for apiFetch — caller-supplied headers must MERGE with the
// default Content-Type (the `...options` spread used to clobber the merged
// headers object, dropping Content-Type whenever a caller passed any header).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@ibatexas/tools/api", () => ({ MEDUSA_ADMIN_URL: "http://localhost:9000" }))

import { apiFetch } from "../lib/api"

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(jsonResponse({ ok: true }))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("apiFetch", () => {
  it("prefixes endpoints with /api/proxy and defaults Content-Type", async () => {
    await apiFetch("/api/admin/orders")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/proxy/api/admin/orders")
    expect(init.credentials).toBe("include")
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" })
  })

  it("merges caller headers WITH the default Content-Type (Idempotency-Key case)", async () => {
    await apiFetch("/api/admin/orders/o1/payment/refund", {
      method: "POST",
      headers: { "Idempotency-Key": "idem-123" },
      body: JSON.stringify({ reason: "x" }),
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // Both headers present — the regression dropped Content-Type here (415).
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "Idempotency-Key": "idem-123",
    })
    expect(init.method).toBe("POST")
    expect(init.body).toBe(JSON.stringify({ reason: "x" }))
    expect(init.credentials).toBe("include")
  })

  it("lets a caller override Content-Type explicitly", async () => {
    await apiFetch("/api/admin/upload", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ "Content-Type": "text/plain" })
  })

  it("returns parsed JSON on success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ orders: [1, 2] }))
    await expect(apiFetch("/api/admin/orders")).resolves.toEqual({ orders: [1, 2] })
  })

  it("throws on non-ok responses", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 415, statusText: "Unsupported Media Type" }))
    await expect(apiFetch("/api/admin/orders")).rejects.toThrow("API error: 415")
  })
})
