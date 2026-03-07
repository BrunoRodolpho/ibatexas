// Seed script: creates customers + reviews so every homepage section renders.
// Run via: pnpm --filter @ibatexas/domain db:seed:homepage
// Or via:  ibx db seed:homepage
//
// Requires: Medusa running (to fetch product IDs)

import { prisma } from "./client.js"

// ── Seed customers ──────────────────────────────────────────────────────────

const SEED_CUSTOMERS = [
  { phone: "+5519900000001", name: "Maria Silva" },
  { phone: "+5519900000002", name: "João Santos" },
  { phone: "+5519900000003", name: "Ana Oliveira" },
  { phone: "+5519900000004", name: "Carlos Pereira" },
  { phone: "+5519900000005", name: "Fernanda Costa" },
]

// ── Seed reviews (assigned to products dynamically) ─────────────────────────

const REVIEW_TEMPLATES = [
  { rating: 5, comment: "Melhor brisket que já comi! A carne desmancha na boca." },
  { rating: 5, comment: "Defumação perfeita, sabor incrível. Voltarei sempre." },
  { rating: 5, comment: "Qualidade absurda. Encomendei para um churrasco e todo mundo elogiou." },
  { rating: 4, comment: "Muito bom! Carne suculenta e bem temperada." },
  { rating: 5, comment: "A costela desmancha no garfo. Melhor de Campinas sem dúvida." },
  { rating: 4, comment: "Entrega rápida e carne quentinha. Recomendo demais." },
  { rating: 5, comment: "Já é a terceira vez que peço. Não troco por nada." },
  { rating: 5, comment: "Surpreendeu todas as expectativas. O smoke ring é lindo." },
  { rating: 4, comment: "Muito saboroso. Perfeito para uma noite especial." },
  { rating: 5, comment: "Padrão texano de verdade aqui em Campinas. Nota 10!" },
  { rating: 4, comment: "Ótima relação custo-benefício. A porção é generosa." },
  { rating: 5, comment: "Cada pedaço tem aquele sabor de lenha. Sensacional." },
  { rating: 5, comment: "O pulled pork é absurdo. Meu novo restaurante favorito." },
  { rating: 4, comment: "Embalagem impecável, chegou perfeito. Vou pedir de novo." },
  { rating: 5, comment: "Fiz um jantar com amigos e todos pediram o contato. Incrível!" },
  { rating: 5, comment: "A linguiça defumada é viciante. Já pedi 4 vezes esse mês." },
  { rating: 4, comment: "Surpreendeu pela qualidade. Parece que saiu direto do Texas." },
  { rating: 5, comment: "O combo família valeu cada centavo. Comida de verdade." },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMedusaUrl(): string {
  const url = process.env.MEDUSA_BACKEND_URL
  if (!url) {
    console.error("❌  MEDUSA_BACKEND_URL is not set. Run: ibx env check")
    process.exit(1)
  }
  return url
}

interface MedusaProduct {
  id: string
  title: string
}

async function getAdminToken(): Promise<string> {
  const base = getMedusaUrl()
  const email = process.env.MEDUSA_ADMIN_EMAIL ?? "admin@ibatexas.com.br"
  const password = process.env.MEDUSA_ADMIN_PASSWORD ?? "IbateXas2024!"

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

async function fetchProductIds(): Promise<MedusaProduct[]> {
  const base = getMedusaUrl()
  const token = await getAdminToken()

  const res = await fetch(`${base}/admin/products?limit=10&fields=id,title`, {
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
  })

  if (!res.ok) {
    throw new Error(`Failed to fetch products from Medusa (${res.status}): ${await res.text()}`)
  }

  const data = (await res.json()) as { products?: MedusaProduct[] }
  return data.products ?? []
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function seedCustomers() {
  console.log("👤  Seeding customers…")

  await prisma.$transaction(
    SEED_CUSTOMERS.map((c) =>
      prisma.customer.upsert({
        where: { phone: c.phone },
        update: { name: c.name },
        create: { phone: c.phone, name: c.name },
      }),
    ),
  )

  console.log(`✅  ${SEED_CUSTOMERS.length} customers upserted`)
}

async function seedReviews() {
  console.log("⭐  Seeding reviews…")

  // Fetch real product IDs from Medusa
  const products = await fetchProductIds()
  if (products.length === 0) {
    console.log("⚠️   No products found in Medusa. Run: ibx db seed first.")
    return
  }

  // Get seeded customer IDs
  const customers = await prisma.customer.findMany({
    where: { phone: { in: SEED_CUSTOMERS.map((c) => c.phone) } },
    select: { id: true, phone: true },
  })

  if (customers.length === 0) {
    console.log("⚠️   No seed customers found. Aborting reviews.")
    return
  }

  // Take top 6 products for reviews
  const targetProducts = products.slice(0, 6)
  let reviewCount = 0

  for (let i = 0; i < REVIEW_TEMPLATES.length; i++) {
    const template = REVIEW_TEMPLATES[i]
    const product = targetProducts[i % targetProducts.length]
    const customer = customers[i % customers.length]
    const fakeOrderId = `seed-order-${i + 1}`

    try {
      await prisma.review.upsert({
        where: {
          orderId_customerId: { orderId: fakeOrderId, customerId: customer.id },
        },
        update: {
          rating: template.rating,
          comment: template.comment,
          productId: product.id,
          productIds: [product.id],
        },
        create: {
          orderId: fakeOrderId,
          productId: product.id,
          productIds: [product.id],
          customerId: customer.id,
          rating: template.rating,
          comment: template.comment,
          channel: "web",
        },
      })
      reviewCount++
    } catch (err) {
      // Skip duplicates or constraint violations
      console.log(`  ⚠️  Skipped review ${i + 1}: ${(err as Error).message.slice(0, 80)}`)
    }
  }

  console.log(`✅  ${reviewCount} reviews created across ${targetProducts.length} products`)
}

async function main() {
  try {
    await seedCustomers()
    await seedReviews()
    console.log("\n🎉  Homepage seed complete\n")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
