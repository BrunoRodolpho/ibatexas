// Tests for lib/medusa.ts — Medusa helpers.
// Tests pure utility functions (validateTag, getMedusaUrl) and mocks fetch for API helpers.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// ── Mock global fetch ────────────────────────────────────────────────────────

const mockFetch = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", mockFetch)

// ── Import source after mocks ────────────────────────────────────────────────

import {
  ALLOWED_TAGS,
  validateTag,
  getMedusaUrl,
  getAdminToken,
  resetAdminToken,
  medusaFetch,
  findProductByHandle,
  type MedusaProduct,
} from "../lib/medusa.js"

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ALLOWED_TAGS", () => {
  it("is a non-empty array", () => {
    expect(ALLOWED_TAGS.length).toBeGreaterThan(0)
  })

  it("contains expected core tags", () => {
    expect(ALLOWED_TAGS).toContain("popular")
    expect(ALLOWED_TAGS).toContain("chef_choice")
    expect(ALLOWED_TAGS).toContain("sem_gluten")
    expect(ALLOWED_TAGS).toContain("congelado")
    expect(ALLOWED_TAGS).toContain("defumado")
  })

  it("all tags are lowercase with underscores only", () => {
    for (const tag of ALLOWED_TAGS) {
      expect(tag).toMatch(/^[a-z_]+$/)
    }
  })
})

describe("validateTag", () => {
  it("returns true for allowed tags", () => {
    expect(validateTag("popular")).toBe(true)
    expect(validateTag("chef_choice")).toBe(true)
    expect(validateTag("sem_gluten")).toBe(true)
  })

  it("returns false for unknown tags", () => {
    expect(validateTag("not-a-tag")).toBe(false)
    expect(validateTag("")).toBe(false)
    expect(validateTag("POPULAR")).toBe(false) // case-sensitive
  })
})

describe("getMedusaUrl", () => {
  const originalExit = process.exit

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.exit = vi.fn() as any
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    process.exit = originalExit
  })

  it("returns MEDUSA_BACKEND_URL when set", () => {
    const original = process.env.MEDUSA_BACKEND_URL
    process.env.MEDUSA_BACKEND_URL = "http://localhost:9000"
    const url = getMedusaUrl()
    expect(url).toBe("http://localhost:9000")
    process.env.MEDUSA_BACKEND_URL = original
  })

  it("calls process.exit(1) when MEDUSA_BACKEND_URL is not set", () => {
    const original = process.env.MEDUSA_BACKEND_URL
    delete process.env.MEDUSA_BACKEND_URL
    getMedusaUrl()
    expect(process.exit).toHaveBeenCalledWith(1)
    process.env.MEDUSA_BACKEND_URL = original
  })
})

describe("getAdminToken", () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    vi.clearAllMocks()
    resetAdminToken()
    savedEnv.MEDUSA_BACKEND_URL = process.env.MEDUSA_BACKEND_URL
    savedEnv.MEDUSA_ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL
    savedEnv.MEDUSA_ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD
    process.env.MEDUSA_BACKEND_URL = "http://localhost:9000"
    process.env.MEDUSA_ADMIN_EMAIL = "admin@test.com"
    process.env.MEDUSA_ADMIN_PASSWORD = "secret"
  })

  afterEach(() => {
    process.env.MEDUSA_BACKEND_URL = savedEnv.MEDUSA_BACKEND_URL
    process.env.MEDUSA_ADMIN_EMAIL = savedEnv.MEDUSA_ADMIN_EMAIL
    process.env.MEDUSA_ADMIN_PASSWORD = savedEnv.MEDUSA_ADMIN_PASSWORD
    resetAdminToken()
  })

  it("authenticates and returns a token", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "jwt-token-123" }),
    })

    const token = await getAdminToken()
    expect(token).toBe("jwt-token-123")
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:9000/auth/user/emailpass",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "admin@test.com", password: "secret" }),
      }),
    )
  })

  it("caches token on subsequent calls", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "jwt-cached" }),
    })

    const token1 = await getAdminToken()
    const token2 = await getAdminToken()
    expect(token1).toBe("jwt-cached")
    expect(token2).toBe("jwt-cached")
    expect(mockFetch).toHaveBeenCalledTimes(1) // only called once
  })

  it("throws when email/password not set", async () => {
    delete process.env.MEDUSA_ADMIN_EMAIL
    await expect(getAdminToken()).rejects.toThrow(
      /MEDUSA_ADMIN_EMAIL/,
    )
  })

  it("throws when auth response is not ok", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    })

    await expect(getAdminToken()).rejects.toThrow(/Admin auth failed.*401/)
  })

  it("throws when auth response is missing token", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })

    await expect(getAdminToken()).rejects.toThrow(/missing token/)
  })
})

describe("medusaFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAdminToken()
    process.env.MEDUSA_BACKEND_URL = "http://localhost:9000"
    process.env.MEDUSA_ADMIN_EMAIL = "admin@test.com"
    process.env.MEDUSA_ADMIN_PASSWORD = "secret"
  })

  afterEach(() => {
    resetAdminToken()
  })

  it("makes a GET request with token", async () => {
    // First call: auth
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "tok" }),
    })
    // Second call: actual request
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ products: [] }),
    })

    const data = await medusaFetch<{ products: unknown[] }>("/admin/products")
    expect(data.products).toEqual([])
  })

  it("uses provided token instead of auto-authenticating", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: 42 }),
    })

    await medusaFetch("/admin/test", { token: "pre-existing-token" })
    expect(mockFetch).toHaveBeenCalledTimes(1) // no auth call
    const [, init] = mockFetch.mock.calls[0]
    expect(init.headers.Authorization).toBe("Bearer pre-existing-token")
  })

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "tok" }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    })

    await expect(medusaFetch("/admin/missing")).rejects.toThrow(
      /Medusa API 404/,
    )
  })

  it("sends body for POST requests", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "tok" }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    })

    await medusaFetch("/admin/products/123", {
      method: "POST",
      body: { tags: [{ id: "tag-1" }] },
    })

    const [, init] = mockFetch.mock.calls[1]
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({ tags: [{ id: "tag-1" }] })
  })
})

describe("findProductByHandle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAdminToken()
    process.env.MEDUSA_BACKEND_URL = "http://localhost:9000"
  })

  afterEach(() => {
    resetAdminToken()
  })

  it("returns the product when found", async () => {
    const product: MedusaProduct = {
      id: "prod_123",
      title: "Brisket",
      handle: "brisket-americano",
      tags: [],
    }

    // Auth call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "tok" }),
    })
    // Product search call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ products: [product] }),
    })

    const result = await findProductByHandle("brisket-americano")
    expect(result).toEqual(product)
  })

  it("returns null when no product matches", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: "tok" }),
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ products: [] }),
    })

    const result = await findProductByHandle("nonexistent-product")
    expect(result).toBeNull()
  })

  it("uses provided token", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ products: [] }),
    })

    await findProductByHandle("test", "pre-auth-token")
    // Should not make an auth call
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
