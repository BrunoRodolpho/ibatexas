// Seed script: creates customers + reviews so every homepage section renders.
// Run via: pnpm --filter @ibatexas/domain db:seed:homepage
// Or via:  ibx db seed:homepage
//
// Requires: Medusa running (to fetch product IDs)

import { prisma } from "./client.js"
import { SEED_CUSTOMERS, SEED_CUSTOMER_PHONES } from "./seed-constants.js"

// ── Review templates (handle-based assignment) ──────────────────────────────
// Distribution: ≥5 per top product to meet cold-start threshold.
// Rating variance: ~50% ★★★★★, ~30% ★★★★, ~15% ★★★, ~5% ★★

interface ReviewTemplate {
  handle: string
  rating: number
  comment: string
}

const REVIEW_TEMPLATES: ReviewTemplate[] = [
  // ── costela-bovina-defumada (6 reviews, avg ~4.5) ─────────────────────────
  { handle: "costela-bovina-defumada", rating: 5, comment: "Melhor costela que já comi! Carne desfiando no garfo." },
  { handle: "costela-bovina-defumada", rating: 5, comment: "Perfeita para o churrasco do final de semana. Todo mundo pediu bis." },
  { handle: "costela-bovina-defumada", rating: 4, comment: "Muito boa, mas achei um pouco salgada." },
  { handle: "costela-bovina-defumada", rating: 5, comment: "A costela desmancha no garfo. Melhor de Campinas sem dúvida." },
  { handle: "costela-bovina-defumada", rating: 4, comment: "Ótima relação custo-benefício. A porção é generosa." },
  { handle: "costela-bovina-defumada", rating: 4, comment: "Carne suculenta e bem temperada. Voltarei com certeza." },

  // ── brisket-americano (6 reviews, avg ~4.7) ───────────────────────────────
  { handle: "brisket-americano", rating: 5, comment: "Melhor brisket que já comi! A carne desmancha na boca." },
  { handle: "brisket-americano", rating: 5, comment: "Defumação perfeita, sabor incrível. Voltarei sempre." },
  { handle: "brisket-americano", rating: 5, comment: "O smoke ring é lindo. Padrão texano de verdade." },
  { handle: "brisket-americano", rating: 4, comment: "Muito bom! Só queria a fatia um pouco mais grossa." },
  { handle: "brisket-americano", rating: 5, comment: "Já é a terceira vez que peço. Não troco por nada." },
  { handle: "brisket-americano", rating: 4, comment: "Surpreendeu pela qualidade. Parece que saiu direto do Texas." },

  // ── frango-defumado-inteiro (5 reviews, avg ~4.2) ─────────────────────────
  { handle: "frango-defumado-inteiro", rating: 5, comment: "Frango suculento demais! A pele crocante é sensacional." },
  { handle: "frango-defumado-inteiro", rating: 4, comment: "Bom sabor defumado. Alimenta a família toda." },
  { handle: "frango-defumado-inteiro", rating: 4, comment: "Entrega rápida e frango quentinho. Recomendo demais." },
  { handle: "frango-defumado-inteiro", rating: 3, comment: "Gostoso mas esperava mais tempero na parte interna." },
  { handle: "frango-defumado-inteiro", rating: 5, comment: "Perfeito pra jantar especial. A família adorou." },

  // ── barriga-de-porco-defumada (5 reviews, avg ~4.4) ───────────────────────
  { handle: "barriga-de-porco-defumada", rating: 5, comment: "Cada pedaço tem aquele sabor de lenha. Sensacional." },
  { handle: "barriga-de-porco-defumada", rating: 5, comment: "A crocância da casca é viciante. Pedi duas vezes." },
  { handle: "barriga-de-porco-defumada", rating: 4, comment: "Muito saboroso. Perfeito para uma noite especial." },
  { handle: "barriga-de-porco-defumada", rating: 4, comment: "Boa combinação de gordura e carne. Textura incrível." },
  { handle: "barriga-de-porco-defumada", rating: 4, comment: "Embalagem impecável, chegou perfeito. Vou pedir de novo." },

  // ── pulled-pork (5 reviews, avg ~4.6) ─────────────────────────────────────
  { handle: "pulled-pork", rating: 5, comment: "O pulled pork é absurdo. Meu novo restaurante favorito." },
  { handle: "pulled-pork", rating: 5, comment: "Fiz um jantar com amigos e todos pediram o contato. Incrível!" },
  { handle: "pulled-pork", rating: 5, comment: "Qualidade absurda. Encomendei para um churrasco e todo mundo elogiou." },
  { handle: "pulled-pork", rating: 4, comment: "Muito bom! Carne suculenta e bem desfiada." },
  { handle: "pulled-pork", rating: 4, comment: "Ótimo com o molho barbecue. Prato completo." },

  // ── smash-burger-defumado (4 reviews, avg ~4.3) ───────────────────────────
  { handle: "smash-burger-defumado", rating: 5, comment: "Melhor burger de Campinas. A carne defumada faz toda diferença." },
  { handle: "smash-burger-defumado", rating: 4, comment: "Smash perfeito, pão macio e carne com sabor." },
  { handle: "smash-burger-defumado", rating: 4, comment: "Muito gostoso mas veio sem guardanapo." },
  { handle: "smash-burger-defumado", rating: 4, comment: "Repetindo o pedido. Agora com batata. Imbatível." },

  // ── brownie-com-sorvete (4 reviews, avg ~4.5) ─────────────────────────────
  { handle: "brownie-com-sorvete", rating: 5, comment: "Brownie quentinho com sorvete gelado. Combinação perfeita!" },
  { handle: "brownie-com-sorvete", rating: 5, comment: "A sobremesa favorita da família. Sempre pedimos." },
  { handle: "brownie-com-sorvete", rating: 4, comment: "Chocolate intenso e sorvete de qualidade. Aprovado!" },
  { handle: "brownie-com-sorvete", rating: 4, comment: "Muito bom, mas poderia ter mais sorvete." },

  // ── linguica-artesanal-defumada (4 reviews, avg ~4.0) ─────────────────────
  { handle: "linguica-artesanal-defumada", rating: 5, comment: "A linguiça defumada é viciante. Já pedi 4 vezes esse mês." },
  { handle: "linguica-artesanal-defumada", rating: 4, comment: "Boa linguiça, sabor defumado marcante." },
  { handle: "linguica-artesanal-defumada", rating: 3, comment: "Gostei mas achei um pouco apimentada." },
  { handle: "linguica-artesanal-defumada", rating: 4, comment: "Ótima para churrasco. Suculenta e temperada." },

  // ── farofa-de-bacon-defumado (3 reviews, avg ~4.3) ────────────────────────
  { handle: "farofa-de-bacon-defumado", rating: 5, comment: "Farofa crocante com bacon defumado. Acompanhamento perfeito." },
  { handle: "farofa-de-bacon-defumado", rating: 4, comment: "Boa textura e sabor. Combina com tudo." },
  { handle: "farofa-de-bacon-defumado", rating: 4, comment: "Porção generosa. A família toda gostou." },

  // ── mandioca-frita (3 reviews, avg ~4.0) ──────────────────────────────────
  { handle: "mandioca-frita", rating: 5, comment: "Mandioca sequinha por fora, macia por dentro. Top!" },
  { handle: "mandioca-frita", rating: 3, comment: "Boa mas veio morna. Quando quente deve ser melhor." },
  { handle: "mandioca-frita", rating: 4, comment: "Crocante e bem temperada. Bom acompanhamento." },

  // ── feijao-tropeiro (3 reviews, avg ~3.7) ─────────────────────────────────
  { handle: "feijao-tropeiro", rating: 4, comment: "Tropeiro bem feito, sabor caseiro." },
  { handle: "feijao-tropeiro", rating: 3, comment: "Bom mas já comi melhor. Faltou um pouco de tempero." },
  { handle: "feijao-tropeiro", rating: 4, comment: "Porção boa, combina demais com a costela." },

  // ── combo-brisket (3 reviews, avg ~4.3) ───────────────────────────────────
  { handle: "combo-brisket", rating: 5, comment: "O combo família valeu cada centavo. Comida de verdade." },
  { handle: "combo-brisket", rating: 4, comment: "Boa opção para dividir. Todos os itens de qualidade." },
  { handle: "combo-brisket", rating: 4, comment: "Combo completo, ótimo custo-benefício." },

  // ── pudim-de-leite-condensado (3 reviews, avg ~4.7) ───────────────────────
  { handle: "pudim-de-leite-condensado", rating: 5, comment: "Pudim da vovó! Textura cremosa, calda perfeita." },
  { handle: "pudim-de-leite-condensado", rating: 5, comment: "Sobremesa impecável. Lembra o da minha avó." },
  { handle: "pudim-de-leite-condensado", rating: 4, comment: "Muito bom, ponto certo. Poderia ser maior." },

  // ── costela-defumada-congelada (3 reviews, avg ~4.3) ──────────────────────
  { handle: "costela-defumada-congelada", rating: 5, comment: "Praticidade com qualidade. Só esquentar e servir." },
  { handle: "costela-defumada-congelada", rating: 4, comment: "Boa opção pra ter sempre no freezer." },
  { handle: "costela-defumada-congelada", rating: 4, comment: "Sabor ótimo mesmo congelada. Surpreendente." },

  // ── pulled-pork-congelado (3 reviews, avg ~4.0) ───────────────────────────
  { handle: "pulled-pork-congelado", rating: 5, comment: "Perfeito pra sanduíche rápido. Carne desfia fácil." },
  { handle: "pulled-pork-congelado", rating: 3, comment: "Bom mas perde um pouco do sabor no congelamento." },
  { handle: "pulled-pork-congelado", rating: 4, comment: "Boa porção. Rende bastante pra família." },
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
  handle: string
}

async function getAdminToken(): Promise<string> {
  const base = getMedusaUrl()
  const email = process.env.MEDUSA_ADMIN_EMAIL
  const password = process.env.MEDUSA_ADMIN_PASSWORD
  if (!email || !password) {
    throw new Error(
      "MEDUSA_ADMIN_EMAIL e MEDUSA_ADMIN_PASSWORD devem estar definidos no .env",
    )
  }

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

async function fetchProducts(): Promise<MedusaProduct[]> {
  const base = getMedusaUrl()
  const token = await getAdminToken()

  const allProducts: MedusaProduct[] = []
  let offset = 0
  const limit = 100

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(
      `${base}/admin/products?limit=${limit}&offset=${offset}&fields=id,title,handle`,
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
    const products = data.products ?? []
    allProducts.push(...products)
    if (products.length < limit) break
    offset += limit
  }

  return allProducts
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

  // Check if Medusa is reachable before attempting API calls
  const base = getMedusaUrl()
  try {
    const healthRes = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })
    if (!healthRes.ok) throw new Error(`status ${healthRes.status}`)
  } catch {
    console.log("⚠️   Medusa is not running. Start it first: ibx dev start")
    console.log("     Then re-run: ibx db seed:homepage")
    return
  }

  // Fetch all products from Medusa (with handles)
  const products = await fetchProducts()
  if (products.length === 0) {
    console.log("⚠️   No products found in Medusa. Run: ibx db seed first.")
    return
  }

  // Build handle → product lookup
  const handleMap = new Map(products.map((p) => [p.handle, p]))

  // Get seeded customer IDs
  const customers = await prisma.customer.findMany({
    where: { phone: { in: [...SEED_CUSTOMER_PHONES] } },
    select: { id: true, phone: true },
  })

  if (customers.length === 0) {
    console.log("⚠️   No seed customers found. Aborting reviews.")
    return
  }

  let reviewCount = 0
  let skipped = 0

  for (let i = 0; i < REVIEW_TEMPLATES.length; i++) {
    const template = REVIEW_TEMPLATES[i]
    const product = handleMap.get(template.handle)
    if (!product) {
      console.log(`  ⚠️  Product handle "${template.handle}" not found in Medusa, skipping`)
      skipped++
      continue
    }

    const customer = customers[i % customers.length]
    const fakeOrderId = `seed-review-${i + 1}`

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

  const productCount = new Set(REVIEW_TEMPLATES.map((t) => t.handle)).size
  console.log(`✅  ${reviewCount} reviews created across ${productCount} products` +
    (skipped > 0 ? ` (${skipped} skipped)` : ""))
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

try {
  await main()
} catch (err) {
  console.error(err)
  process.exit(1)
}
