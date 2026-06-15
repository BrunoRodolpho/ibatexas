// OrderService — egress-governance tests (W7-P6 + W8-V1).
//
// Verifies that the 6 mutating Medusa egresses in order.service.ts route
// through the injected `adminAdjudicated` DI rather than the bare
// `medusaAdminFn`. Wave 6 finding: these mutations historically went via
// raw fetchAdmin, bypassing the adjudicate kernel + audit emit.
//
// The 6 sites under test:
//   1. cancelOrder()            — POST /admin/orders/:id/cancel
//   2. cancelItem() (collapse)  — POST /admin/orders/:id/cancel (1-item)
//   3. cancelItem() (edit)      — POST /admin/orders/:id/edits
//   4. cancelItem() (remove)    — DELETE /admin/orders/:id/edits/:editId/items/:itemId
//   5. cancelItem() (confirm)   — POST /admin/orders/:id/edits/:editId/confirm
//   6. capturePayment() ×2      — POST /admin/orders/:id/capture-payment
//                                  + POST /admin/orders/:id (metadata)
//
// W8-V1 (NEW-W7-V1) hardened the contract: the old silent fallback to
// bare fetchAdmin when `adminAdjudicated` was undefined is now a hard
// throw at the first mutation attempt. The "legacy bare-fetchAdmin"
// test was flipped to assert the throw — see the
// `[W8-V1] cancelOrder THROWS when adminAdjudicated is omitted` case.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { createOrderService, type AdminAdjudicated } from "../order.service.js"

describe("OrderService — egress governance (W7-P6)", () => {
  let fetchAdmin: ReturnType<typeof vi.fn>
  let adminAdjudicated: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchAdmin = vi.fn()
    adminAdjudicated = vi.fn()
  })

  // ── cancelOrder ───────────────────────────────────────────────────────

  it("cancelOrder routes the cancel POST through adminAdjudicated when injected", async () => {
    // First call returns the order (GET via fetchAdmin); subsequent
    // mutations go via adminAdjudicated.
    fetchAdmin.mockResolvedValueOnce({
      order: {
        id: "order_01",
        status: "pending",
        customer_id: "cust_01",
        created_at: new Date().toISOString(),
        items: [{ id: "li_1", title: "Costela", quantity: 1, unit_price: 8900, variant_id: "var_1" }],
      },
    })
    adminAdjudicated.mockResolvedValue({})

    const svc = createOrderService(fetchAdmin, {
      adminAdjudicated: adminAdjudicated as unknown as AdminAdjudicated,
    })

    const result = await svc.cancelOrder("order_01", "cust_01", { force: true })

    expect(result.success).toBe(true)
    // Mutation went through adjudicated, NOT bare fetchAdmin.
    expect(adminAdjudicated).toHaveBeenCalledOnce()
    const args = adminAdjudicated.mock.calls[0][0]
    expect(args.method).toBe("POST")
    expect(args.path).toBe("/admin/orders/order_01/cancel")
    expect(args.sourceSubject).toBe("service:order.cancel")
    expect(args.idempotencyKey).toBe("order.cancel:order_01")
    // GET (the initial order fetch) still uses fetchAdmin.
    expect(fetchAdmin).toHaveBeenCalledOnce()
    expect(fetchAdmin.mock.calls[0][0]).toBe("/admin/orders/order_01")
  })

  it("[W8-V1] cancelOrder THROWS when adminAdjudicated is omitted (no silent kernel bypass)", async () => {
    // W8-V1 closure (NEW-W7-V1): the pre-W8 silent fallback to bare
    // fetchAdmin was the source of the cart-tool hand-off bypass. The
    // mutate() helper now hard-throws when adminAdjudicated is undefined
    // rather than silently sending the POST through fetchAdmin. The GET
    // (read) is unaffected — only mutations trip the gate.
    fetchAdmin.mockImplementation((path: string) => {
      if (path === "/admin/orders/order_01") {
        return Promise.resolve({
          order: {
            id: "order_01",
            status: "pending",
            customer_id: "cust_01",
            created_at: new Date().toISOString(),
            items: [{ id: "li_1", title: "X", quantity: 1, unit_price: 100, variant_id: "v" }],
          },
        })
      }
      return Promise.resolve({})
    })

    const svc = createOrderService(fetchAdmin)

    await expect(
      svc.cancelOrder("order_01", "cust_01", { force: true }),
    ).rejects.toThrow(
      /createOrderService called without adjudicated medusa client/,
    )

    // GET still fired (the throw is in mutate(), not in the constructor).
    expect(fetchAdmin).toHaveBeenCalledWith("/admin/orders/order_01")
    // The POST was NOT issued — kernel bypass refused.
    expect(adminAdjudicated).not.toHaveBeenCalled()
    const postCalls = fetchAdmin.mock.calls.filter((call) => {
      const init = call[1] as RequestInit | undefined
      return init?.method === "POST"
    })
    expect(postCalls).toEqual([])
  })

  // ── cancelItem — single-item collapse ─────────────────────────────────

  it("cancelItem collapses to cancelOrder when only one item exists, via adminAdjudicated", async () => {
    fetchAdmin.mockResolvedValueOnce({
      order: {
        id: "order_01",
        status: "pending",
        customer_id: "cust_01",
        created_at: new Date().toISOString(),
        items: [{ id: "li_1", title: "Sole", quantity: 1, unit_price: 100, variant_id: "var_1" }],
      },
    })
    adminAdjudicated.mockResolvedValue({})

    const svc = createOrderService(fetchAdmin, {
      adminAdjudicated: adminAdjudicated as unknown as AdminAdjudicated,
    })

    const result = await svc.cancelItem("order_01", "cust_01", "Sole")

    expect(result.success).toBe(true)
    expect(adminAdjudicated).toHaveBeenCalledOnce()
    expect(adminAdjudicated.mock.calls[0][0].path).toBe(
      "/admin/orders/order_01/cancel",
    )
    expect(adminAdjudicated.mock.calls[0][0].sourceSubject).toBe(
      "service:order.cancel-item-collapses-order",
    )
  })

  // ── cancelItem — multi-item: edit + remove + confirm sequence ──────────

  it("cancelItem with multiple items routes ALL 3 edit-sequence calls through adminAdjudicated", async () => {
    fetchAdmin.mockResolvedValueOnce({
      order: {
        id: "order_01",
        status: "pending",
        customer_id: "cust_01",
        created_at: new Date().toISOString(),
        items: [
          { id: "li_1", title: "Costela", quantity: 1, unit_price: 100, variant_id: "var_1" },
          { id: "li_2", title: "Picanha", quantity: 1, unit_price: 100, variant_id: "var_2" },
        ],
      },
    })
    // Edit-create returns the edit row; the other 2 calls return whatever.
    adminAdjudicated
      .mockResolvedValueOnce({ order_edit: { id: "edit_99" } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    const svc = createOrderService(fetchAdmin, {
      adminAdjudicated: adminAdjudicated as unknown as AdminAdjudicated,
    })

    const result = await svc.cancelItem("order_01", "cust_01", "Costela")

    expect(result.success).toBe(true)
    // 3 mutation calls — all via adjudicated.
    expect(adminAdjudicated).toHaveBeenCalledTimes(3)
    expect(adminAdjudicated.mock.calls[0][0].method).toBe("POST")
    expect(adminAdjudicated.mock.calls[0][0].path).toBe(
      "/admin/orders/order_01/edits",
    )
    expect(adminAdjudicated.mock.calls[0][0].sourceSubject).toBe(
      "service:order.edit.create",
    )
    expect(adminAdjudicated.mock.calls[1][0].method).toBe("DELETE")
    expect(adminAdjudicated.mock.calls[1][0].path).toBe(
      "/admin/orders/order_01/edits/edit_99/items/li_1",
    )
    expect(adminAdjudicated.mock.calls[1][0].sourceSubject).toBe(
      "service:order.edit.items.remove",
    )
    expect(adminAdjudicated.mock.calls[2][0].method).toBe("POST")
    expect(adminAdjudicated.mock.calls[2][0].path).toBe(
      "/admin/orders/order_01/edits/edit_99/confirm",
    )
    expect(adminAdjudicated.mock.calls[2][0].sourceSubject).toBe(
      "service:order.edit.confirm",
    )
  })

  // ── capturePayment ─────────────────────────────────────────────────────

  it("capturePayment routes capture-payment POST and metadata POST through adminAdjudicated", async () => {
    // GET returns a pending order (no stripePaymentIntentId metadata yet).
    fetchAdmin.mockResolvedValueOnce({
      order: {
        id: "order_01",
        status: "pending",
        display_id: 1001,
        total: 8900,
        items: [
          {
            id: "li_1",
            title: "Costela",
            quantity: 1,
            unit_price: 89, // reais
            variant_id: "var_1",
          },
        ],
        customer_id: "cust_01",
        metadata: {},
        email: "test@example.com",
        customer: { first_name: "Test" },
      },
    })
    adminAdjudicated.mockResolvedValue({})

    const svc = createOrderService(fetchAdmin, {
      adminAdjudicated: adminAdjudicated as unknown as AdminAdjudicated,
    })

    const result = await svc.capturePayment("order_01", "pi_123")

    expect(result).not.toBeNull()
    expect(adminAdjudicated).toHaveBeenCalledTimes(2)
    expect(adminAdjudicated.mock.calls[0][0].path).toBe(
      "/admin/orders/order_01/capture-payment",
    )
    expect(adminAdjudicated.mock.calls[0][0].sourceSubject).toBe(
      "service:order.capture-payment",
    )
    expect(adminAdjudicated.mock.calls[1][0].path).toBe("/admin/orders/order_01")
    expect(adminAdjudicated.mock.calls[1][0].sourceSubject).toBe(
      "service:order.update-metadata",
    )
    // Metadata payload is forwarded as a typed POST body.
    expect(adminAdjudicated.mock.calls[1][0].payload).toEqual({
      metadata: { stripePaymentIntentId: "pi_123" },
    })
  })

  // ── Smoke: GET passes through fetchAdmin directly (no adjudication) ───

  it("getOrder (read) bypasses adminAdjudicated even when injected", async () => {
    fetchAdmin.mockResolvedValueOnce({
      order: {
        id: "order_01",
        status: "pending",
        customer_id: "cust_01",
        items: [],
      },
    })

    const svc = createOrderService(fetchAdmin, {
      adminAdjudicated: adminAdjudicated as unknown as AdminAdjudicated,
    })

    const { order } = await svc.getOrder("order_01")
    expect(order.id).toBe("order_01")
    // Reads stay on the bare transport — wrapper auto-bypasses GET too.
    expect(adminAdjudicated).not.toHaveBeenCalled()
    expect(fetchAdmin).toHaveBeenCalledOnce()
  })
})
