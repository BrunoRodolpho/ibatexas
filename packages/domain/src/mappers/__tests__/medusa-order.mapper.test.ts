// Unit tests for the Medusa → OrderProjection mapper (pure; no DB/network).
// FE-D15 focus: Medusa's stable line-item id is threaded through the projection.

import { describe, it, expect } from "vitest"
import {
  toOrderEventItems,
  toOrderProjectionData,
  type MedusaOrderExpanded,
} from "../medusa-order.mapper.js"

describe("toOrderEventItems — FE-D15 line-item id threading", () => {
  it("preserves Medusa's stable line-item id when present", () => {
    const items = toOrderEventItems(
      [
        { id: "item_01ABC", product_id: "prod_1", variant_id: "var_1", title: "Picanha", quantity: 2, unit_price: 89 },
      ],
    )
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe("item_01ABC")
    // The rest of the shape is unchanged (reais → centavos).
    expect(items[0]).toMatchObject({
      productId: "prod_1",
      variantId: "var_1",
      title: "Picanha",
      quantity: 2,
      priceInCentavos: 8900,
    })
  })

  it("omits id entirely when the Medusa item has none (additive — no empty-string fake)", () => {
    const items = toOrderEventItems([
      { product_id: "prod_1", variant_id: "var_1", title: "Picanha", quantity: 1, unit_price: 50 },
    ])
    expect(items[0]!.id).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(items[0], "id")).toBe(false)
  })

  it("threads a distinct id per line", () => {
    const items = toOrderEventItems([
      { id: "item_A", product_id: "p1", title: "A", quantity: 1, unit_price: 10 },
      { id: "item_B", product_id: "p2", title: "B", quantity: 1, unit_price: 20 },
    ])
    expect(items.map((i) => i.id)).toEqual(["item_A", "item_B"])
  })

  it("does not double-convert when prices are already centavos", () => {
    const items = toOrderEventItems([{ id: "item_A", product_id: "p1", title: "A", quantity: 1, unit_price: 8900 }], true)
    expect(items[0]).toMatchObject({ id: "item_A", priceInCentavos: 8900 })
  })
})

describe("toOrderProjectionData — carries line-item ids into itemsJson", () => {
  const order: MedusaOrderExpanded = {
    id: "order_1",
    display_id: 4242,
    email: "maria@example.com",
    total: 178,
    subtotal: 178,
    shipping_total: 0,
    fulfillment_status: "pending",
    payment_status: "captured",
    created_at: "2026-07-16T12:00:00.000Z",
    items: [
      { id: "item_01ABC", product_id: "prod_1", variant_id: "var_1", title: "Picanha", quantity: 2, unit_price: 89 },
    ],
  } as MedusaOrderExpanded

  it("the projection's itemsJson retains the stable line-item id", () => {
    const projection = toOrderProjectionData(order)
    expect(projection.itemsJson).toHaveLength(1)
    expect(projection.itemsJson[0]!.id).toBe("item_01ABC")
    expect(projection.itemCount).toBe(1)
  })
})
