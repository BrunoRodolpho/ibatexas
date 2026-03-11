// Seed script: creates order history and reservations for testing
// co-purchase matrix, recommendations, and reservation flow.
// Run via: pnpm --filter @ibatexas/domain db:seed:orders
// Or via:  ibx db seed:orders
//
// Requires: Medusa running (to fetch product IDs and variant IDs)

import { prisma } from "./client.js"
import { SEED_CUSTOMER_PHONES } from "./seed-constants.js"

// ── Medusa helpers ──────────────────────────────────────────────────────────

function getMedusaUrl(): string {
  const url = process.env.MEDUSA_BACKEND_URL
  if (!url) {
    console.error("❌  MEDUSA_BACKEND_URL is not set. Run: ibx env check")
    process.exit(1)
  }
  return url
}

async function getAdminToken(): Promise<string> {
  const base = getMedusaUrl()
  const email = process.env.MEDUSA_ADMIN_EMAIL ?? "REDACTED_EMAIL"
  const password = process.env.MEDUSA_ADMIN_PASSWORD ?? "REDACTED_PASSWORD"

  const res = await fetch(`${base}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })

  if (!res.ok) {
    throw new Error(`Admin auth failed (${res.status}): ${await res.text()}`)
  }

  const data = (await res.json()) as { token?: string }
  if (!data.token) throw new Error("Admin auth response missing token")
  return data.token
}

interface MedusaPrice {
  amount?: number
  currency_code?: string
}

interface MedusaPriceSet {
  prices?: MedusaPrice[]
}

interface MedusaVariant {
  id: string
  title: string
  price_set?: MedusaPriceSet
  /** Medusa v2 returns prices directly on variant (not nested in price_set). */
  prices?: MedusaPrice[]
}

interface MedusaProduct {
  id: string
  title: string
  handle: string
  variants?: MedusaVariant[]
}

async function fetchProductsWithVariants(): Promise<MedusaProduct[]> {
  const base = getMedusaUrl()
  const token = await getAdminToken()

  const res = await fetch(
    `${base}/admin/products?limit=100&fields=id,title,handle,*variants,*variants.price_set,*variants.price_set.prices`,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
  )

  if (!res.ok) {
    throw new Error(`Failed to fetch products (${res.status}): ${await res.text()}`)
  }

  const data = (await res.json()) as { products?: MedusaProduct[] }
  return data.products ?? []
}

function extractVariantPrice(variant: MedusaVariant): number {
  // Medusa v2 returns prices on variant.prices[] (not variant.price_set.prices[])
  const prices = variant.prices ?? variant.price_set?.prices ?? []
  const brl = prices.find((p) => p.currency_code === "brl") ?? prices[0]
  if (!brl?.amount) return 0
  // Medusa v2 stores amounts in BRL (reais), not centavos — convert to centavos
  return Math.round(brl.amount * 100)
}

// ── Order templates ─────────────────────────────────────────────────────────

interface OrderItem {
  handle: string
  variantTitle: string
  quantity: number
}

interface OrderTemplate {
  phone: string
  orderId: string
  daysAgo: number
  items: OrderItem[]
}

const ORDER_TEMPLATES: OrderTemplate[] = [
  // Maria Silva — repeat brisket customer, orders with sides
  {
    phone: "+5519900000001",
    orderId: "seed-order-hist-01",
    daysAgo: 75,
    items: [
      { handle: "brisket-americano", variantTitle: "400g", quantity: 1 },
      { handle: "farofa-de-bacon-defumado", variantTitle: "Porção", quantity: 1 },
      { handle: "limonada-suica", variantTitle: "500ml", quantity: 2 },
    ],
  },
  {
    phone: "+5519900000001",
    orderId: "seed-order-hist-02",
    daysAgo: 30,
    items: [
      { handle: "brisket-americano", variantTitle: "400g", quantity: 2 },
      { handle: "coleslaw-da-casa", variantTitle: "Porção", quantity: 1 },
      { handle: "brownie-com-sorvete", variantTitle: "Porção", quantity: 1 },
    ],
  },
  {
    phone: "+5519900000001",
    orderId: "seed-order-hist-03",
    daysAgo: 7,
    items: [
      { handle: "costela-bovina-defumada", variantTitle: "1kg", quantity: 1 },
      { handle: "mandioca-frita", variantTitle: "Porção", quantity: 1 },
      { handle: "cerveja-artesanal-ipa", variantTitle: "500ml", quantity: 2 },
    ],
  },
  // João Santos — frozen food buyer + merchandise
  {
    phone: "+5519900000002",
    orderId: "seed-order-hist-04",
    daysAgo: 60,
    items: [
      { handle: "costela-defumada-congelada", variantTitle: "1kg (família)", quantity: 1 },
      { handle: "molho-barbecue-artesanal", variantTitle: "300ml", quantity: 2 },
    ],
  },
  {
    phone: "+5519900000002",
    orderId: "seed-order-hist-05",
    daysAgo: 20,
    items: [
      { handle: "pulled-pork-congelado", variantTitle: "300g", quantity: 2 },
      { handle: "camiseta-ibatexas-preta", variantTitle: "G", quantity: 1 },
    ],
  },
  // Ana Oliveira — dessert & drink lover
  {
    phone: "+5519900000003",
    orderId: "seed-order-hist-06",
    daysAgo: 45,
    items: [
      { handle: "brownie-com-sorvete", variantTitle: "Porção", quantity: 2 },
      { handle: "pudim-de-leite-condensado", variantTitle: "Fatia", quantity: 1 },
      { handle: "limonada-suica", variantTitle: "300ml", quantity: 1 },
    ],
  },
  {
    phone: "+5519900000003",
    orderId: "seed-order-hist-07",
    daysAgo: 10,
    items: [
      { handle: "smash-burger-defumado", variantTitle: "Unidade", quantity: 1 },
      { handle: "batata-rustica-assada", variantTitle: "Porção", quantity: 1 },
      { handle: "refrigerante", variantTitle: "Guaraná Antarctica", quantity: 1 },
      { handle: "pudim-de-leite-condensado", variantTitle: "Fatia", quantity: 1 },
    ],
  },
  // Carlos Pereira — big meat orders
  {
    phone: "+5519900000004",
    orderId: "seed-order-hist-08",
    daysAgo: 50,
    items: [
      { handle: "costela-bovina-defumada", variantTitle: "1kg", quantity: 1 },
      { handle: "pulled-pork", variantTitle: "300g", quantity: 1 },
      { handle: "feijao-tropeiro", variantTitle: "Porção", quantity: 1 },
      { handle: "farofa-de-bacon-defumado", variantTitle: "Porção", quantity: 1 },
    ],
  },
  {
    phone: "+5519900000004",
    orderId: "seed-order-hist-09",
    daysAgo: 15,
    items: [
      { handle: "barriga-de-porco-defumada", variantTitle: "300g", quantity: 1 },
      { handle: "linguica-artesanal-defumada", variantTitle: "4 unidades", quantity: 1 },
      { handle: "cerveja-artesanal-ipa", variantTitle: "500ml", quantity: 3 },
    ],
  },
  // Fernanda Costa — vegetarian-leaning, sides + drinks
  {
    phone: "+5519900000005",
    orderId: "seed-order-hist-10",
    daysAgo: 40,
    items: [
      { handle: "mandioca-frita", variantTitle: "Porção", quantity: 1 },
      { handle: "coleslaw-da-casa", variantTitle: "Porção", quantity: 1 },
      { handle: "batata-rustica-assada", variantTitle: "Porção", quantity: 1 },
      { handle: "suco-do-dia", variantTitle: "400ml", quantity: 2 },
    ],
  },
  {
    phone: "+5519900000005",
    orderId: "seed-order-hist-11",
    daysAgo: 5,
    items: [
      { handle: "brownie-com-sorvete", variantTitle: "Porção", quantity: 1 },
      { handle: "limonada-suica", variantTitle: "300ml", quantity: 1 },
    ],
  },
  // Cross-customer: Maria orders frozen (creates co-purchase overlap with João)
  {
    phone: "+5519900000001",
    orderId: "seed-order-hist-12",
    daysAgo: 3,
    items: [
      { handle: "costela-defumada-congelada", variantTitle: "1kg (família)", quantity: 2 },
      { handle: "pulled-pork-congelado", variantTitle: "300g", quantity: 1 },
      { handle: "molho-barbecue-artesanal", variantTitle: "300ml", quantity: 1 },
    ],
  },
]

// ── Reservation templates ───────────────────────────────────────────────────

interface ReservationTemplate {
  phone: string
  partySize: number
  status: "pending" | "confirmed" | "seated" | "completed" | "cancelled" | "no_show"
  specialRequests: string[]
  daysOffset: number // negative = past, positive = future, 0 = today
  startTime: string
  tableNumbers: string[]
}

const RESERVATION_TEMPLATES: ReservationTemplate[] = [
  {
    phone: "+5519900000001",
    partySize: 2,
    status: "completed",
    specialRequests: ["Mesa perto da janela"],
    daysOffset: -14,
    startTime: "20:00",
    tableNumbers: ["2"],
  },
  {
    phone: "+5519900000002",
    partySize: 4,
    status: "completed",
    specialRequests: ["Aniversário — bolo surpresa"],
    daysOffset: -7,
    startTime: "18:30",
    tableNumbers: ["3"],
  },
  {
    phone: "+5519900000003",
    partySize: 6,
    status: "confirmed",
    specialRequests: [],
    daysOffset: 3,
    startTime: "20:00",
    tableNumbers: ["5"],
  },
  {
    phone: "+5519900000004",
    partySize: 4,
    status: "pending",
    specialRequests: ["Sem lactose no acompanhamento"],
    daysOffset: 7,
    startTime: "21:30",
    tableNumbers: ["4"],
  },
  {
    phone: "+5519900000001",
    partySize: 8,
    status: "cancelled",
    specialRequests: ["Evento corporativo"],
    daysOffset: -3,
    startTime: "18:30",
    tableNumbers: ["6"],
  },
  {
    phone: "+5519900000005",
    partySize: 2,
    status: "no_show",
    specialRequests: [],
    daysOffset: -5,
    startTime: "20:00",
    tableNumbers: ["B1"],
  },
  {
    phone: "+5519900000003",
    partySize: 4,
    status: "seated",
    specialRequests: ["Cadeirão para criança"],
    daysOffset: 0,
    startTime: "13:00",
    tableNumbers: ["7"],
  },
  {
    phone: "+5519900000002",
    partySize: 2,
    status: "confirmed",
    specialRequests: [],
    daysOffset: 1,
    startTime: "20:00",
    tableNumbers: ["1"],
  },
]

// ── Seeding functions ───────────────────────────────────────────────────────

async function seedOrderItems(products: MedusaProduct[]) {
  console.log("📦  Seeding order history…")

  // Build lookup: handle → { id, variants: Map<title, { id, price }> }
  const productMap = new Map<
    string,
    { id: string; variants: Map<string, { id: string; price: number }> }
  >()
  for (const p of products) {
    const variantMap = new Map<string, { id: string; price: number }>()
    for (const v of p.variants ?? []) {
      variantMap.set(v.title, { id: v.id, price: extractVariantPrice(v) })
    }
    productMap.set(p.handle, { id: p.id, variants: variantMap })
  }

  // Look up customer IDs by phone
  const customers = await prisma.customer.findMany({
    where: { phone: { in: SEED_CUSTOMER_PHONES } },
    select: { id: true, phone: true },
  })
  const customerMap = new Map(customers.map((c) => [c.phone, c.id]))

  let itemCount = 0
  let skippedOrders = 0

  for (const order of ORDER_TEMPLATES) {
    const customerId = customerMap.get(order.phone)
    if (!customerId) {
      console.log(`  ⚠️  Customer ${order.phone} not found, skipping order ${order.orderId}`)
      continue
    }

    // Idempotency: skip if this order already has items
    const existingCount = await prisma.customerOrderItem.count({
      where: { medusaOrderId: order.orderId },
    })
    if (existingCount > 0) {
      skippedOrders++
      continue
    }

    const orderedAt = new Date()
    orderedAt.setDate(orderedAt.getDate() - order.daysAgo)

    for (const item of order.items) {
      const product = productMap.get(item.handle)
      if (!product) {
        console.log(`  ⚠️  Product ${item.handle} not found in Medusa, skipping`)
        continue
      }
      const variant = product.variants.get(item.variantTitle)
      if (!variant) {
        console.log(
          `  ⚠️  Variant "${item.variantTitle}" not found for ${item.handle}, skipping`,
        )
        continue
      }

      await prisma.customerOrderItem.create({
        data: {
          customerId,
          medusaOrderId: order.orderId,
          productId: product.id,
          variantId: variant.id,
          quantity: item.quantity,
          priceInCentavos: variant.price,
          orderedAt,
        },
      })
      itemCount++
    }
  }

  if (skippedOrders > 0) {
    console.log(`  ℹ️  ${skippedOrders} orders already seeded, skipped`)
  }
  console.log(`✅  ${itemCount} order items created across ${ORDER_TEMPLATES.length - skippedOrders} orders`)
}

async function seedReservations() {
  console.log("📋  Seeding reservations…")

  const customers = await prisma.customer.findMany({
    where: { phone: { in: SEED_CUSTOMER_PHONES } },
    select: { id: true, phone: true },
  })
  const customerMap = new Map(customers.map((c) => [c.phone, c.id]))

  // Skip if reservations already exist for seed customers
  const customerIds = [...customerMap.values()]
  const existingCount = await prisma.reservation.count({
    where: { customerId: { in: customerIds } },
  })
  if (existingCount > 0) {
    console.log(`  ℹ️  ${existingCount} reservations already exist for seed customers, skipping`)
    return
  }

  let count = 0
  for (const template of RESERVATION_TEMPLATES) {
    const customerId = customerMap.get(template.phone)
    if (!customerId) {
      console.log(`  ⚠️  Customer ${template.phone} not found, skipping reservation`)
      continue
    }

    // Calculate the target date
    const targetDate = new Date()
    targetDate.setUTCHours(0, 0, 0, 0)
    targetDate.setUTCDate(targetDate.getUTCDate() + template.daysOffset)

    // Find the matching time slot
    const timeSlot = await prisma.timeSlot.findFirst({
      where: { date: targetDate, startTime: template.startTime },
    })
    if (!timeSlot) {
      console.log(
        `  ⚠️  No time slot for ${targetDate.toISOString().slice(0, 10)} ${template.startTime}, skipping`,
      )
      continue
    }

    // Find table IDs
    const tables = await prisma.table.findMany({
      where: { number: { in: template.tableNumbers } },
      select: { id: true },
    })

    // Compute timestamps based on status
    const now = new Date()
    const confirmedAt = ["confirmed", "seated", "completed"].includes(template.status)
      ? now
      : null
    const checkedInAt = ["seated", "completed"].includes(template.status) ? now : null
    const cancelledAt = template.status === "cancelled" ? now : null

    await prisma.reservation.create({
      data: {
        customerId,
        partySize: template.partySize,
        status: template.status,
        specialRequests: JSON.stringify(template.specialRequests),
        timeSlotId: timeSlot.id,
        confirmedAt,
        checkedInAt,
        cancelledAt,
        tables: {
          create: tables.map((t) => ({ tableId: t.id })),
        },
      },
    })

    // Update reservedCovers on the time slot (only for non-cancelled/no_show)
    if (!["cancelled", "no_show"].includes(template.status)) {
      await prisma.timeSlot.update({
        where: { id: timeSlot.id },
        data: { reservedCovers: { increment: template.partySize } },
      })
    }

    count++
  }

  console.log(`✅  ${count} reservations created`)
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    // Fetch products from Medusa (needed for order items)
    const products = await fetchProductsWithVariants()
    if (products.length === 0) {
      console.log("⚠️   No products found in Medusa. Run: ibx db seed first.")
      return
    }

    await seedOrderItems(products)
    await seedReservations()
    console.log("\n🎉  Orders seed complete\n")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
