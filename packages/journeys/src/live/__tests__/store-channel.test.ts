// BKL-193 — resolveDefaultSalesChannelId: the cart seeders' defense-in-depth
// channel resolver (explicit sales_channel_id on /store/carts so a
// multi-channel publishable key can't 400 the bare create).

import { describe, expect, it, vi } from "vitest"
import { resolveDefaultSalesChannelId } from "../_store-channel.js"

describe("resolveDefaultSalesChannelId (BKL-193)", () => {
  it("returns the store singleton's default_sales_channel_id", async () => {
    const medusaAdmin = vi.fn().mockResolvedValue({
      stores: [{ id: "store_1", default_sales_channel_id: "sc_loja" }],
    })
    await expect(resolveDefaultSalesChannelId(medusaAdmin)).resolves.toBe("sc_loja")
    expect(medusaAdmin).toHaveBeenCalledWith(
      "/admin/stores?fields=id,default_sales_channel_id&limit=1",
    )
  })

  it("returns undefined when the store has no default channel (bare create fallback)", async () => {
    const medusaAdmin = vi.fn().mockResolvedValue({
      stores: [{ id: "store_1", default_sales_channel_id: null }],
    })
    await expect(resolveDefaultSalesChannelId(medusaAdmin)).resolves.toBeUndefined()
  })

  it("returns undefined when no store exists at all", async () => {
    const medusaAdmin = vi.fn().mockResolvedValue({ stores: [] })
    await expect(resolveDefaultSalesChannelId(medusaAdmin)).resolves.toBeUndefined()
  })
})
