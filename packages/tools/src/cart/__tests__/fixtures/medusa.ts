// Typed Medusa request/response factories for cart tests
// Prices in integer centavos (8900 = R$89,00), allergens always explicit []

import type { AgentContext } from "@ibatexas/types"

// ── AgentContext factories ───────────────────────────────────────────────────

export function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    channel: "whatsapp" as AgentContext["channel"],
    sessionId: "sess_test_01",
    customerId: "cus_01",
    userType: "customer" as AgentContext["userType"],
    ...overrides,
  }
}

export function makeGuestCtx(overrides?: Partial<AgentContext>): AgentContext {
  return makeCtx({ customerId: undefined, userType: "guest" as AgentContext["userType"], ...overrides })
}

// ── Line item ────────────────────────────────────────────────────────────────

export interface MedusaLineItem {
  id: string
  variant_id: string
  title: string
  quantity: number
  unit_price: number
  subtotal: number
  metadata?: Record<string, unknown>
}

export function makeLineItem(overrides?: Partial<MedusaLineItem>): MedusaLineItem {
  return {
    id: "item_01",
    variant_id: "variant_costela_500g",
    title: "Costela Bovina Defumada 500g",
    quantity: 2,
    unit_price: 8900,
    subtotal: 17800,
    metadata: {},
    ...overrides,
  }
}

// ── Cart ─────────────────────────────────────────────────────────────────────

export interface MedusaCart {
  id: string
  items: MedusaLineItem[]
  total: number
  subtotal: number
  discount_total: number
  region_id: string
  customer_id?: string
  metadata?: Record<string, string>
  payment_sessions?: MedusaPaymentSession[]
}

export function makeCart(overrides?: Partial<MedusaCart>): MedusaCart {
  const items = overrides?.items ?? [makeLineItem()]
  return {
    id: "cart_01",
    items,
    total: items.reduce((s, i) => s + i.subtotal, 0),
    subtotal: items.reduce((s, i) => s + i.subtotal, 0),
    discount_total: 0,
    region_id: "reg_br",
    customer_id: "cus_01",
    metadata: {},
    ...overrides,
  }
}

// ── Payment session ──────────────────────────────────────────────────────────

export interface MedusaPaymentSession {
  provider_id: string
  data?: {
    client_secret?: string
    id?: string
  }
}

export function makePaymentSession(overrides?: Partial<MedusaPaymentSession>): MedusaPaymentSession {
  return {
    provider_id: "stripe",
    data: {
      client_secret: "pi_secret_test123",
      id: "pi_test123",
    },
    ...overrides,
  }
}

// ── Order ────────────────────────────────────────────────────────────────────

export interface MedusaOrder {
  id: string
  status: string
  customer_id?: string
  items: Array<{ variant_id: string; quantity: number; title: string }>
  total: number
  metadata?: Record<string, string>
  fulfillment_status?: string
  payment_status?: string
}

export function makeOrder(overrides?: Partial<MedusaOrder>): MedusaOrder {
  return {
    id: "order_01",
    status: "pending",
    customer_id: "cus_01",
    items: [
      { variant_id: "variant_costela_500g", quantity: 2, title: "Costela Bovina Defumada 500g" },
      { variant_id: "variant_linguica_1kg", quantity: 1, title: "Lingui\u00e7a Artesanal 1kg" },
    ],
    total: 26700,
    metadata: {},
    fulfillment_status: "not_fulfilled",
    payment_status: "awaiting",
    ...overrides,
  }
}

// ── Response wrappers (match Medusa API shapes) ──────────────────────────────

export function cartResponse(cart?: Partial<MedusaCart>) {
  return { cart: makeCart(cart) }
}

export function orderResponse(order?: Partial<MedusaOrder>) {
  return { order: makeOrder(order) }
}

export function ordersListResponse(orders?: MedusaOrder[]) {
  return {
    orders: orders ?? [makeOrder(), makeOrder({ id: "order_02", status: "completed" })],
    count: orders?.length ?? 2,
    limit: 20,
    offset: 0,
  }
}
