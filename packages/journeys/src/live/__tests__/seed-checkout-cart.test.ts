// seed-checkout-cart.test.ts — FE-T12 cart-seeding: `targetCentavosForCase`
// (pure) plus `seedCheckoutCart`'s error paths and happy path against a
// SCRIPTED `@ibatexas/tools` double (no live Medusa/Redis — the actual
// combos were hand-verified against the ephemeral stack; see the PR body).

import { describe, expect, it, vi } from "vitest"

describe("targetCentavosForCase", () => {
  it("maps every money-boundary case id to its own specific target", async () => {
    const { targetCentavosForCase } = await import("../seed-checkout-cart.js")
    expect(targetCentavosForCase("money-boundary-confirm-exact-threshold")).toBe(100_000)
    expect(targetCentavosForCase("money-boundary-confirm-just-below-refuse-cap")).toBe(999_900)
    expect(targetCentavosForCase("money-boundary-refuse-exact-cap")).toBe(1_000_000)
    expect(targetCentavosForCase("money-boundary-refuse-well-above-cap")).toBe(1_500_000)
    expect(targetCentavosForCase("money-boundary-confirm-well-above-threshold")).toBe(300_000)
    expect(targetCentavosForCase("money-boundary-confirm-just-above-threshold")).toBe(100_100)
  })

  it("defaults every OTHER case id to the modest R$50,00 total", async () => {
    const { targetCentavosForCase } = await import("../seed-checkout-cart.js")
    expect(targetCentavosForCase("pix-pickup-direct")).toBe(5_000)
    expect(targetCentavosForCase("slots-incomplete-neither-bare")).toBe(5_000)
    expect(targetCentavosForCase("some-unknown-future-case-id")).toBe(5_000)
  })
})

describe("CART_LINE_ITEM_PLANS", () => {
  it("has a plan for every target targetCentavosForCase can produce", async () => {
    const { CART_LINE_ITEM_PLANS, targetCentavosForCase } = await import("../seed-checkout-cart.js")
    const allCaseIds = [
      "pix-pickup-direct",
      "money-boundary-confirm-exact-threshold",
      "money-boundary-confirm-just-below-refuse-cap",
      "money-boundary-refuse-exact-cap",
      "money-boundary-refuse-well-above-cap",
      "money-boundary-confirm-well-above-threshold",
      "money-boundary-confirm-just-above-threshold",
    ]
    for (const caseId of allCaseIds) {
      const target = targetCentavosForCase(caseId)
      expect(CART_LINE_ITEM_PLANS.has(target)).toBe(true)
    }
  })
})

function mockTools(overrides: {
  medusaStore?: (path: string, opts?: RequestInit) => Promise<unknown>
  redisSet?: (...args: unknown[]) => Promise<unknown>
}): void {
  vi.doMock("@ibatexas/tools", () => ({
    medusaStore: overrides.medusaStore ?? vi.fn(),
    getRedisClient: vi.fn(async () => ({
      set: overrides.redisSet ?? vi.fn(async () => "OK"),
    })),
    rk: vi.fn((key: string) => `ibx:${key}`),
  }))
}

describe("seedCheckoutCart — error paths", () => {
  it("throws SeedCheckoutCartError for a target with no CART_LINE_ITEM_PLANS entry (never silently seeds the wrong total)", async () => {
    vi.resetModules()
    mockTools({})
    const { seedCheckoutCart, SeedCheckoutCartError } = await import("../seed-checkout-cart.js")

    await expect(
      seedCheckoutCart({ sessionId: "sess-1", targetCentavos: 999_999_999 }),
    ).rejects.toThrow(SeedCheckoutCartError)
    await expect(
      seedCheckoutCart({ sessionId: "sess-1", targetCentavos: 999_999_999 }),
    ).rejects.toThrow(/no CART_LINE_ITEM_PLANS entry/)
  })

  it("throws SeedCheckoutCartError when the resulting Medusa cart total does NOT match the target exactly (never silently proceeds with a wrong total)", async () => {
    vi.resetModules()
    const medusaStore = vi.fn(async (path: string) => {
      if (path === "/store/regions") return { regions: [{ id: "reg_1" }] }
      if (path.startsWith("/store/products")) {
        return { products: [{ id: "prod_1", handle: "refrigerante", variants: [{ id: "variant_1" }] }] }
      }
      if (path === "/store/carts") return { cart: { id: "cart_1", total: 0 } }
      if (path.includes("/line-items")) return { cart: { id: "cart_1", total: 49 } } // WRONG — plan expects 50
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools({ medusaStore })
    const { seedCheckoutCart, SeedCheckoutCartError } = await import("../seed-checkout-cart.js")

    await expect(
      seedCheckoutCart({ sessionId: "sess-1", targetCentavos: 5_000 }),
    ).rejects.toThrow(SeedCheckoutCartError)
    await expect(
      seedCheckoutCart({ sessionId: "sess-1", targetCentavos: 5_000 }),
    ).rejects.toThrow(/totals 4900 centavos, expected EXACTLY 5000/)
  })

  it("throws SeedCheckoutCartError when a plan's product handle doesn't resolve (catalog drift)", async () => {
    vi.resetModules()
    const medusaStore = vi.fn(async (path: string) => {
      if (path === "/store/regions") return { regions: [{ id: "reg_1" }] }
      if (path === "/store/carts") return { cart: { id: "cart_1", total: 0 } }
      if (path.startsWith("/store/products")) return { products: [] } // handle not found
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools({ medusaStore })
    const { seedCheckoutCart, SeedCheckoutCartError } = await import("../seed-checkout-cart.js")

    await expect(
      seedCheckoutCart({ sessionId: "sess-1", targetCentavos: 5_000 }),
    ).rejects.toThrow(SeedCheckoutCartError)
    await expect(
      seedCheckoutCart({ sessionId: "sess-1", targetCentavos: 5_000 }),
    ).rejects.toThrow(/no product with handle/)
  })
})

describe("seedCheckoutCart — happy path", () => {
  it("creates a cart, adds every plan line item, and binds it to the EXACT sessionId in Redis under cart:active:session:<id>", async () => {
    vi.resetModules()
    const postedLineItems: Array<{ variant_id: string; quantity: number }> = []
    const medusaStore = vi.fn(async (path: string, opts?: RequestInit) => {
      if (path === "/store/regions") return { regions: [{ id: "reg_1" }] }
      if (path.startsWith("/store/products?handle=refrigerante")) {
        return { products: [{ id: "prod_r", handle: "refrigerante", variants: [{ id: "variant_r" }] }] }
      }
      if (path.startsWith("/store/products?handle=smash-burger-defumado")) {
        return { products: [{ id: "prod_s", handle: "smash-burger-defumado", variants: [{ id: "variant_s" }] }] }
      }
      if (path === "/store/carts") return { cart: { id: "cart_new", total: 0 } }
      if (path === "/store/carts/cart_new/line-items") {
        const body = JSON.parse(String(opts?.body)) as { variant_id: string; quantity: number }
        postedLineItems.push(body)
        // Second call (smash-burger) returns the FINAL total.
        const total = postedLineItems.length === 1 ? 8 : 50
        return { cart: { id: "cart_new", total } }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    const redisSet = vi.fn(async () => "OK")
    mockTools({ medusaStore, redisSet })
    const { seedCheckoutCart } = await import("../seed-checkout-cart.js")

    const result = await seedCheckoutCart({ sessionId: "sess-rotated-1", targetCentavos: 5_000 })

    expect(result).toEqual({ cartId: "cart_new", totalCentavos: 5_000 })
    expect(postedLineItems).toEqual([
      { variant_id: "variant_r", quantity: 1 },
      { variant_id: "variant_s", quantity: 1 },
    ])
    expect(redisSet).toHaveBeenCalledWith(
      "ibx:cart:active:session:sess-rotated-1",
      "cart_new",
      { EX: 24 * 60 * 60 },
    )
  })

  it("resolves a SPECIFIC variant by title for a multi-variant product (never variants[0] blindly)", async () => {
    vi.resetModules()
    let requestedVariant: string | undefined
    const medusaStore = vi.fn(async (path: string, opts?: RequestInit) => {
      if (path === "/store/regions") return { regions: [{ id: "reg_1" }] }
      if (path.startsWith("/store/products?handle=limonada-suica")) {
        return {
          products: [
            {
              id: "prod_l",
              handle: "limonada-suica",
              variants: [
                { id: "variant_300ml", title: "300ml" },
                { id: "variant_500ml", title: "500ml" },
              ],
            },
          ],
        }
      }
      if (path.startsWith("/store/products?handle=refrigerante")) {
        return { products: [{ id: "prod_r", handle: "refrigerante", variants: [{ id: "variant_r" }] }] }
      }
      if (path === "/store/carts") return { cart: { id: "cart_x", total: 0 } }
      if (path === "/store/carts/cart_x/line-items") {
        const body = JSON.parse(String(opts?.body)) as { variant_id: string }
        requestedVariant = body.variant_id
        return { cart: { id: "cart_x", total: 1001 } }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools({ medusaStore })
    const { seedCheckoutCart } = await import("../seed-checkout-cart.js")

    await seedCheckoutCart({ sessionId: "sess-2", targetCentavos: 100_100 })

    // The LAST line-item POST in the 100_100-centavos plan is the 500ml variant.
    expect(requestedVariant).toBe("variant_500ml")
  })
})

// ── retry-once-on-transient-failure (live-caught: a bounded, non-SeedCheckoutCartError-specific retry) ──

describe("seedCheckoutCart — bounded retry on a transient (non-SeedCheckoutCartError) failure", () => {
  it("retries ONCE after a transient failure (e.g. a Medusa auth blip) and succeeds on the second attempt", async () => {
    vi.resetModules()
    vi.useFakeTimers()
    let attempt = 0
    const medusaStore = vi.fn(async (path: string, opts?: RequestInit) => {
      if (path === "/store/regions") {
        attempt += 1
        if (attempt === 1) throw new Error("Medusa 401: /auth/user/emailpass")
        return { regions: [{ id: "reg_1" }] }
      }
      if (path.startsWith("/store/products?handle=refrigerante")) {
        return { products: [{ id: "prod_r", handle: "refrigerante", variants: [{ id: "variant_r" }] }] }
      }
      if (path.startsWith("/store/products?handle=smash-burger-defumado")) {
        return { products: [{ id: "prod_s", handle: "smash-burger-defumado", variants: [{ id: "variant_s" }] }] }
      }
      if (path === "/store/carts") return { cart: { id: "cart_retry", total: 0 } }
      if (path === "/store/carts/cart_retry/line-items") {
        const body = JSON.parse(String(opts?.body)) as { variant_id: string }
        const total = body.variant_id === "variant_r" ? 8 : 50
        return { cart: { id: "cart_retry", total } }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools({ medusaStore })
    const { seedCheckoutCart } = await import("../seed-checkout-cart.js")

    const resultPromise = seedCheckoutCart({ sessionId: "sess-retry", targetCentavos: 5_000 })
    // Advance past the 3s backoff so the retry actually fires.
    await vi.advanceTimersByTimeAsync(3_000)
    const result = await resultPromise

    expect(result).toEqual({ cartId: "cart_retry", totalCentavos: 5_000 })
    expect(attempt).toBe(2) // failed once, succeeded on retry
    vi.useRealTimers()
  })

  it("a SeedCheckoutCartError (plan/total/product mismatch) is NEVER retried — it propagates immediately", async () => {
    vi.resetModules()
    let regionCalls = 0
    const medusaStore = vi.fn(async (path: string) => {
      if (path === "/store/regions") {
        regionCalls += 1
        return { regions: [{ id: "reg_1" }] }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools({ medusaStore })
    const { seedCheckoutCart, SeedCheckoutCartError } = await import("../seed-checkout-cart.js")

    await expect(
      seedCheckoutCart({ sessionId: "sess-1", targetCentavos: 999_999_999 }),
    ).rejects.toThrow(SeedCheckoutCartError)
    // The plan-not-found check happens before ANY Medusa call at all.
    expect(regionCalls).toBe(0)
  })

  it("a SECOND consecutive transient failure still propagates — never retried more than once", async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const medusaStore = vi.fn(async (path: string) => {
      if (path === "/store/regions") throw new Error("Medusa 401: /auth/user/emailpass")
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools({ medusaStore })
    const { seedCheckoutCart } = await import("../seed-checkout-cart.js")

    const resultPromise = seedCheckoutCart({ sessionId: "sess-2", targetCentavos: 5_000 })
    const assertion = expect(resultPromise).rejects.toThrow("Medusa 401")
    await vi.advanceTimersByTimeAsync(3_000)
    await assertion
    // regions was attempted exactly twice: the original call + ONE retry.
    expect(medusaStore.mock.calls.filter(([p]) => p === "/store/regions")).toHaveLength(2)
    vi.useRealTimers()
  })
})
