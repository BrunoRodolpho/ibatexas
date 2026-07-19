// seed-owned-order.test.ts — BKL-141: the executor's dry-run, idempotent
// reuse, create path, and error paths against SCRIPTED `@ibatexas/tools` +
// `@ibatexas/domain` doubles (no live Medusa / prisma — the live e2e usage is
// deferred per the owner skip-live directive; the real draft-order ->
// convert-to-order round-trip is the SAME one seed-item-order.ts already runs).

import { describe, expect, it, vi } from "vitest"

interface MedusaAdminMock {
  medusaAdmin: ReturnType<typeof vi.fn>
}

/** A `@ibatexas/tools` double exposing only the `medusaAdmin` the seeder uses. */
function mockTools(medusaAdmin: ReturnType<typeof vi.fn>): void {
  vi.doMock("@ibatexas/tools", () => ({ medusaAdmin }))
}

/** A `@ibatexas/domain` double: findUnique + $transaction + toOrderProjectionData. */
function mockDomain(overrides?: {
  existingProjection?: unknown
  projectionCreate?: ReturnType<typeof vi.fn>
  statusHistoryCreate?: ReturnType<typeof vi.fn>
}): { projectionCreate: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> } {
  const projectionCreate =
    overrides?.projectionCreate ?? vi.fn(async (args: { data: { id: string } }) => ({ id: args.data.id }))
  const statusHistoryCreate = overrides?.statusHistoryCreate ?? vi.fn(async () => ({}))
  const findUnique = vi.fn(async () => overrides?.existingProjection ?? null)
  vi.doMock("@ibatexas/domain", () => ({
    prisma: {
      orderProjection: { findUnique },
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          orderProjection: { create: projectionCreate },
          orderStatusHistory: { create: statusHistoryCreate },
        }),
    },
    toOrderProjectionData: vi.fn((order: { id: string }, opts?: { customerId?: string }) => ({
      id: order.id,
      displayId: 900_123,
      customerId: opts?.customerId ?? null,
      customerEmail: null,
      customerName: null,
      customerPhone: null,
      fulfillmentStatus: "pending",
      paymentStatus: "pending",
      totalInCentavos: 5_000,
      subtotalInCentavos: 5_000,
      shippingInCentavos: 0,
      itemCount: 4,
      itemsJson: [],
      itemsSchemaVersion: 1,
      shippingAddressJson: null,
      deliveryType: null,
      paymentMethod: null,
      tipInCentavos: 0,
      medusaCreatedAt: new Date(0),
    })),
  }))
  return { projectionCreate, findUnique }
}

/** medusaAdmin double for the full create path (no pre-existing order). */
function fullCreateMedusaAdmin(): MedusaAdminMock {
  const medusaAdmin = vi.fn(async (path: string, opts?: { method?: string }) => {
    if (path.startsWith("/admin/orders?metadata[seedKey]")) return { orders: [] }
    if (path === "/admin/regions") return { regions: [{ id: "reg_1" }] }
    if (path === "/admin/sales-channels") {
      return { sales_channels: [{ id: "sc_default", name: "Default Sales Channel" }, { id: "sc_loja", name: "Loja Online" }] }
    }
    if (path.startsWith("/admin/products?handle=refrigerante")) {
      return {
        products: [
          {
            id: "prod_r",
            handle: "refrigerante",
            variants: [
              { id: "var_coca", title: "Coca-Cola" },
              { id: "var_guarana", title: "Guaraná Antarctica" },
            ],
          },
        ],
      }
    }
    if (path.startsWith("/admin/products?handle=smash-burger-defumado")) {
      return { products: [{ id: "prod_s", handle: "smash-burger-defumado", variants: [{ id: "var_smash", title: "Unidade" }] }] }
    }
    if (path.startsWith("/admin/products?handle=mandioca-frita")) {
      return { products: [{ id: "prod_m", handle: "mandioca-frita", variants: [{ id: "var_mand", title: "Porção" }] }] }
    }
    if (path === "/admin/draft-orders" && opts?.method === "POST") {
      return { draft_order: { id: "draft_1" } }
    }
    if (path === "/admin/draft-orders/draft_1/convert-to-order" && opts?.method === "POST") {
      return { order: { id: "order_owned_1", display_id: 900_123 } }
    }
    if (path === "/admin/orders/order_owned_1") {
      return { order: { id: "order_owned_1", display_id: 900_123, items: [{}, {}, {}, {}] } }
    }
    throw new Error(`unexpected path: ${path} (${opts?.method ?? "GET"})`)
  })
  return { medusaAdmin }
}

describe("seedOwnedOrder — dry run (no IO)", () => {
  it("returns the IO-free plan and never touches @ibatexas/tools", async () => {
    vi.resetModules()
    const medusaAdmin = vi.fn(async () => {
      throw new Error("medusaAdmin must NOT be called on a dry run")
    })
    mockTools(medusaAdmin)
    const { seedOwnedOrder } = await import("../seed-owned-order.js")

    const result = await seedOwnedOrder({ customerId: "cust_owner", label: "hp", dryRun: true })

    expect(result.dryRun).toBe(true)
    expect(result.reused).toBe(false)
    expect(result.customerId).toBe("cust_owner")
    expect(result.orderId).toBe(`dry-run:${result.seedKey}`)
    expect(result.plan?.metadata["customerId"]).toBe("cust_owner")
    expect(medusaAdmin).not.toHaveBeenCalled()
  })
})

describe("seedOwnedOrder — create path (no pre-existing order)", () => {
  it("creates a real Medusa order with metadata.customerId, then writes the owned projection", async () => {
    vi.resetModules()
    const { medusaAdmin } = fullCreateMedusaAdmin()
    mockTools(medusaAdmin)
    const { projectionCreate } = mockDomain()
    const { seedOwnedOrder } = await import("../seed-owned-order.js")

    const result = await seedOwnedOrder({ customerId: "cust_owner", label: "hp" })

    expect(result).toMatchObject({
      orderId: "order_owned_1",
      displayId: 900_123,
      itemCount: 4,
      customerId: "cust_owner",
      reused: false,
      dryRun: false,
    })

    // The draft POST body must bind metadata.customerId (the ownership anchor).
    const draftCall = medusaAdmin.mock.calls.find(([p]) => p === "/admin/draft-orders")
    expect(draftCall).toBeDefined()
    const body = JSON.parse(String((draftCall?.[1] as { body?: string })?.body)) as {
      metadata: Record<string, string>
      sales_channel_id: string
    }
    expect(body.metadata["customerId"]).toBe("cust_owner")
    expect(body.metadata["seedKey"]).toBe(result.seedKey)
    // Resolves the real "Loja Online" channel, never "Default Sales Channel".
    expect(body.sales_channel_id).toBe("sc_loja")

    // The projection is stamped with the owning customer id.
    expect(projectionCreate).toHaveBeenCalledTimes(1)
    expect(projectionCreate.mock.calls[0][0].data.customerId).toBe("cust_owner")
  })
})

describe("seedOwnedOrder — idempotent reuse", () => {
  it("re-finds an existing order by seedKey and does NOT create a duplicate draft", async () => {
    vi.resetModules()
    const medusaAdmin = vi.fn(async (path: string) => {
      if (path.startsWith("/admin/orders?metadata[seedKey]")) {
        // The hardened reuse verifies the candidate's stamped seedKey (BKL-187).
        return {
          orders: [
            { id: "order_prior", display_id: 900_999, metadata: { seedKey: "bkl141-owned-cust_owner-hp" } },
          ],
        }
      }
      if (path === "/admin/orders/order_prior") {
        return { order: { id: "order_prior", display_id: 900_999, items: [{}, {}, {}, {}] } }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools(medusaAdmin)
    // Projection already exists → ensureProjection skips the write.
    const { projectionCreate } = mockDomain({ existingProjection: { id: "order_prior" } })
    const { seedOwnedOrder } = await import("../seed-owned-order.js")

    const result = await seedOwnedOrder({ customerId: "cust_owner", label: "hp" })

    expect(result).toMatchObject({ orderId: "order_prior", displayId: 900_999, reused: true, dryRun: false })
    expect(medusaAdmin.mock.calls.some(([p]) => p === "/admin/draft-orders")).toBe(false)
    expect(projectionCreate).not.toHaveBeenCalled()
  })

  it("back-fills a missing projection when reusing an order whose projection is gone", async () => {
    vi.resetModules()
    const medusaAdmin = vi.fn(async (path: string) => {
      if (path.startsWith("/admin/orders?metadata[seedKey]")) {
        // The hardened reuse verifies the candidate's stamped seedKey (BKL-187).
        return {
          orders: [
            { id: "order_prior", display_id: 900_999, metadata: { seedKey: "bkl141-owned-cust_owner-hp" } },
          ],
        }
      }
      if (path === "/admin/orders/order_prior") {
        return { order: { id: "order_prior", display_id: 900_999, items: [{}, {}, {}, {}] } }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools(medusaAdmin)
    const { projectionCreate } = mockDomain({ existingProjection: null })
    const { seedOwnedOrder } = await import("../seed-owned-order.js")

    const result = await seedOwnedOrder({ customerId: "cust_owner", label: "hp" })

    expect(result.reused).toBe(true)
    expect(projectionCreate).toHaveBeenCalledTimes(1)
    expect(projectionCreate.mock.calls[0][0].data.customerId).toBe("cust_owner")
  })
})

describe("seedOwnedOrder — error paths (never silently produces an unowned/partial seed)", () => {
  it("throws SeedOwnedOrderError on an empty customerId", async () => {
    vi.resetModules()
    mockTools(vi.fn())
    const { seedOwnedOrder, SeedOwnedOrderError } = await import("../seed-owned-order.js")
    await expect(seedOwnedOrder({ customerId: "   " })).rejects.toThrow(SeedOwnedOrderError)
  })

  it("throws when no Medusa region exists", async () => {
    vi.resetModules()
    const medusaAdmin = vi.fn(async (path: string) => {
      if (path.startsWith("/admin/orders?metadata[seedKey]")) return { orders: [] }
      if (path === "/admin/regions") return { regions: [] }
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools(medusaAdmin)
    mockDomain()
    const { seedOwnedOrder, SeedOwnedOrderError } = await import("../seed-owned-order.js")
    await expect(seedOwnedOrder({ customerId: "cust_owner" })).rejects.toThrow(SeedOwnedOrderError)
  })

  it("throws when a plan product handle doesn't resolve (catalog drift)", async () => {
    vi.resetModules()
    const medusaAdmin = vi.fn(async (path: string) => {
      if (path.startsWith("/admin/orders?metadata[seedKey]")) return { orders: [] }
      if (path === "/admin/regions") return { regions: [{ id: "reg_1" }] }
      if (path === "/admin/sales-channels") return { sales_channels: [{ id: "sc_loja", name: "Loja Online" }] }
      if (path.startsWith("/admin/products")) return { products: [] }
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools(medusaAdmin)
    mockDomain()
    const { seedOwnedOrder } = await import("../seed-owned-order.js")
    await expect(seedOwnedOrder({ customerId: "cust_owner" })).rejects.toThrow(/no product with handle/)
  })

  it("throws when convert-to-order returns no order id", async () => {
    vi.resetModules()
    const { medusaAdmin } = fullCreateMedusaAdmin()
    medusaAdmin.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.startsWith("/admin/orders?metadata[seedKey]")) return { orders: [] }
      if (path === "/admin/regions") return { regions: [{ id: "reg_1" }] }
      if (path === "/admin/sales-channels") return { sales_channels: [{ id: "sc_loja", name: "Loja Online" }] }
      if (path.startsWith("/admin/products?handle=refrigerante")) {
        return { products: [{ id: "prod_r", handle: "refrigerante", variants: [{ id: "var_coca", title: "Coca-Cola" }, { id: "var_guarana", title: "Guaraná Antarctica" }] }] }
      }
      if (path.startsWith("/admin/products?handle=smash-burger-defumado")) {
        return { products: [{ id: "prod_s", handle: "smash-burger-defumado", variants: [{ id: "var_smash", title: "Unidade" }] }] }
      }
      if (path.startsWith("/admin/products?handle=mandioca-frita")) {
        return { products: [{ id: "prod_m", handle: "mandioca-frita", variants: [{ id: "var_mand", title: "Porção" }] }] }
      }
      if (path === "/admin/draft-orders" && opts?.method === "POST") return { draft_order: { id: "draft_1" } }
      if (path === "/admin/draft-orders/draft_1/convert-to-order") return { order: undefined }
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools(medusaAdmin)
    mockDomain()
    const { seedOwnedOrder } = await import("../seed-owned-order.js")
    await expect(seedOwnedOrder({ customerId: "cust_owner" })).rejects.toThrow(/convert-to-order returned no order id/)
  })
})

// ── BKL-187 — the --fresh-window flag (PONR-safe fresh order) ────────────────
// The PONR check reads the PROJECTION row's own createdAt (@default(now())),
// so freshness == a genuinely NEW row; the flag's whole job is bypassing the
// (customer,label) idempotent REUSE via a per-invocation label suffix. Proven
// IO-free through the dry-run plan (the same derivation the live path stamps).
describe("BKL-187 — freshWindow uniquifies the seedKey (never reuses a stale order)", () => {
  it("dry-run: freshWindow yields a time-suffixed seedKey DIFFERENT from the plain label's", async () => {
    const { seedOwnedOrder } = await import("../seed-owned-order.js")
    const plain = await seedOwnedOrder({ customerId: "cus_1", label: "unpaid-200", dryRun: true })
    const fresh = await seedOwnedOrder({
      customerId: "cus_1",
      label: "unpaid-200",
      dryRun: true,
      freshWindow: true,
    })
    expect(fresh.seedKey).not.toBe(plain.seedKey)
    expect(fresh.seedKey).toMatch(/-w\d{8}T\d/)
  })

  it("dry-run: the PLAN's seedKey + stamped metadata match the returned seedKey (no lookup/stamp mismatch)", async () => {
    const { seedOwnedOrder } = await import("../seed-owned-order.js")
    const fresh = await seedOwnedOrder({ customerId: "cus_1", dryRun: true, freshWindow: true })
    expect(fresh.plan?.seedKey).toBe(fresh.seedKey)
    expect(fresh.plan?.metadata.seedKey).toBe(fresh.seedKey)
    expect(fresh.plan?.lookupPath).toContain(encodeURIComponent(fresh.seedKey))
  })

  it("without the flag the derivation is byte-identical to before (default label)", async () => {
    const { seedOwnedOrder } = await import("../seed-owned-order.js")
    const a = await seedOwnedOrder({ customerId: "cus_1", dryRun: true })
    const b = await seedOwnedOrder({ customerId: "cus_1", dryRun: true })
    expect(a.seedKey).toBe(b.seedKey)
  })
})

// ── BKL-187 hardening — the idempotency lookup must never SPURIOUSLY reuse ───
// Smoke-caught on the live stack: Medusa's `metadata[seedKey]` query filter can
// return an ARBITRARY order (the filter silently not filtering), so a blind
// orders[0] reuse hands back someone else's stale order — the exact stale-age
// trap. The reuse now verifies the candidate's stamped metadata.seedKey; a
// freshWindow run skips the lookup entirely (unique key — nothing to re-find).
describe("BKL-187 — spurious-reuse hardening", () => {
  it("REJECTS a lookup candidate whose stamped seedKey does not match (creates fresh instead)", async () => {
    vi.resetModules()
    const medusaAdmin = vi.fn(async (path: string) => {
      if (path.startsWith("/admin/orders?metadata[seedKey]")) {
        // The broken-filter case: an unrelated order comes back.
        return { orders: [{ id: "order_unrelated", display_id: 1, metadata: { seedKey: "someone-elses" } }] }
      }
      if (path === "/admin/regions") return { regions: [{ id: "reg_1" }] }
      if (path === "/admin/sales-channels")
        return { sales_channels: [{ id: "sc_1", name: "Loja Online" }] }
      if (path.startsWith("/admin/products?handle=")) {
        return {
          products: [
            {
              id: "prod_1",
              handle: "x",
              variants: [
                { id: "var_1", title: "Unidade" },
                { id: "var_2", title: "Coca-Cola" },
                { id: "var_3", title: "Guaraná Antarctica" },
                { id: "var_4", title: "Porção" },
              ],
            },
          ],
        }
      }
      if (path === "/admin/draft-orders") return { draft_order: { id: "draft_1" } }
      if (path === "/admin/draft-orders/draft_1/convert-to-order")
        return { order: { id: "order_new", display_id: 2 } }
      if (path === "/admin/orders/order_new")
        return { order: { id: "order_new", display_id: 2, items: [{}] } }
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools(medusaAdmin)
    mockDomain()
    const { seedOwnedOrder } = await import("../seed-owned-order.js")

    const result = await seedOwnedOrder({ customerId: "cust_owner", label: "hp" })
    expect(result).toMatchObject({ orderId: "order_new", reused: false })
  })

  it("freshWindow SKIPS the idempotency lookup entirely (no metadata[seedKey] GET)", async () => {
    vi.resetModules()
    const medusaAdmin = vi.fn(async (path: string) => {
      if (path === "/admin/regions") return { regions: [{ id: "reg_1" }] }
      if (path === "/admin/sales-channels")
        return { sales_channels: [{ id: "sc_1", name: "Loja Online" }] }
      if (path.startsWith("/admin/products?handle=")) {
        return {
          products: [
            {
              id: "prod_1",
              handle: "x",
              variants: [
                { id: "var_1", title: "Unidade" },
                { id: "var_2", title: "Coca-Cola" },
                { id: "var_3", title: "Guaraná Antarctica" },
                { id: "var_4", title: "Porção" },
              ],
            },
          ],
        }
      }
      if (path === "/admin/draft-orders") return { draft_order: { id: "draft_1" } }
      if (path === "/admin/draft-orders/draft_1/convert-to-order")
        return { order: { id: "order_new", display_id: 3 } }
      if (path === "/admin/orders/order_new")
        return { order: { id: "order_new", display_id: 3, items: [{}] } }
      throw new Error(`unexpected path: ${path}`)
    })
    mockTools(medusaAdmin)
    mockDomain()
    const { seedOwnedOrder } = await import("../seed-owned-order.js")

    const result = await seedOwnedOrder({ customerId: "cust_owner", freshWindow: true })
    expect(result.reused).toBe(false)
    expect(
      medusaAdmin.mock.calls.some(([p]) => String(p).startsWith("/admin/orders?metadata[seedKey]")),
    ).toBe(false)
  })
})
