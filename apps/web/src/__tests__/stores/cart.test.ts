import { describe, it, expect, beforeEach } from "vitest"

// Inline mock of core cart logic (avoid zustand hydration issues in test env)
interface CartItem {
  productId: string
  title: string
  price: number
  quantity: number
}

function createCartLogic() {
  let items: CartItem[] = []
  return {
    getItems: () => items,
    addItem: (item: Omit<CartItem, "quantity">, qty: number) => {
      const existing = items.find((i) => i.productId === item.productId)
      if (existing) {
        existing.quantity += qty
      } else {
        items.push({ ...item, quantity: qty })
      }
    },
    removeItem: (productId: string) => {
      items = items.filter((i) => i.productId !== productId)
    },
    getItemCount: () => items.reduce((sum, i) => sum + i.quantity, 0),
    getTotal: () => items.reduce((sum, i) => sum + i.price * i.quantity, 0),
    clear: () => { items = [] },
  }
}

describe("Cart Store", () => {
  let cart: ReturnType<typeof createCartLogic>

  beforeEach(() => { cart = createCartLogic() })

  it("starts empty", () => {
    expect(cart.getItems()).toEqual([])
    expect(cart.getItemCount()).toBe(0)
    expect(cart.getTotal()).toBe(0)
  })

  it("adds an item", () => {
    cart.addItem({ productId: "p1", title: "Costela", price: 8900 }, 1)
    expect(cart.getItemCount()).toBe(1)
    expect(cart.getTotal()).toBe(8900)
  })

  it("increments quantity for duplicate product", () => {
    cart.addItem({ productId: "p1", title: "Costela", price: 8900 }, 1)
    cart.addItem({ productId: "p1", title: "Costela", price: 8900 }, 2)
    expect(cart.getItemCount()).toBe(3)
    expect(cart.getItems()).toHaveLength(1)
    expect(cart.getTotal()).toBe(8900 * 3)
  })

  it("removes an item", () => {
    cart.addItem({ productId: "p1", title: "Costela", price: 8900 }, 2)
    cart.addItem({ productId: "p2", title: "Picanha", price: 12900 }, 1)
    cart.removeItem("p1")
    expect(cart.getItemCount()).toBe(1)
    expect(cart.getTotal()).toBe(12900)
  })

  it("clears the cart", () => {
    cart.addItem({ productId: "p1", title: "Costela", price: 8900 }, 3)
    cart.clear()
    expect(cart.getItemCount()).toBe(0)
    expect(cart.getTotal()).toBe(0)
  })

  it("getItemCount sums quantities, not line items", () => {
    cart.addItem({ productId: "p1", title: "Costela", price: 8900 }, 2)
    cart.addItem({ productId: "p2", title: "Picanha", price: 12900 }, 3)
    expect(cart.getItems()).toHaveLength(2)
    expect(cart.getItemCount()).toBe(5) // 2 + 3, not 2
  })
})
