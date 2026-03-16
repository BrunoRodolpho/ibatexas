// lib/simulator.ts — Simulation engine.
// Generates realistic commerce behavior over time using seeded PRNG.
// Deterministic: same seed → same customers, orders, reviews, timestamps.
//
// Flow:
// 1. Generate customers with behavior profiles
// 2. For each day in the range, generate orders based on profile frequency
// 3. Each order: pick products weighted by profile preferences
// 4. Optionally generate reviews after orders
// 5. Write everything to DB via Prisma upserts (idempotent)
// 6. Rebuild intelligence (co-purchase, global scores, review stats)

import seedrandom from "seedrandom"
import chalk from "chalk"
import ora from "ora"

import { PROFILES, type BehaviorProfile, SCALE_PRESETS } from "./profiles.js"
import { StepRegistry } from "./steps.js"
import { getAdminToken, medusaFetch, type MedusaProduct } from "./medusa.js"

// ── Types ────────────────────────────────────────────────────────────────────

export interface SimulationOptions {
  customers: number
  days: number
  ordersPerDay: number
  seed: number
  /** Profile distribution fractions (must sum to 1.0). */
  behavior?: Record<string, number>
  /** Review generation config. */
  reviews?: {
    probability: number
    ratingAvg: number
  }
  /** Scale preset name — overrides customers/ordersPerDay/days. */
  scale?: string
}

export interface SimulationResult {
  customersCreated: number
  ordersCreated: number
  reviewsCreated: number
  durationMs: number
}

interface SimCustomer {
  id: string
  phone: string
  name: string
  profile: BehaviorProfile
  lastOrderDay: number
}

interface SimOrder {
  customerId: string
  orderId: string
  productIds: string[]
  variantIds: string[]
  quantities: number[]
  prices: number[]
  orderedAt: Date
}

interface SimReview {
  customerId: string
  orderId: string
  productId: string
  rating: number
  comment: string | null
  channel: string
  createdAt: Date
}

// ── Review comment templates (pt-BR) ────────────────────────────────────────

const REVIEW_COMMENTS = {
  5: [
    "Excelente! Superou todas as expectativas.",
    "Melhor que já experimentei. Nota 10!",
    "Perfeito! Voltarei com certeza.",
    "Incrível, recomendo para todos.",
    "Produto de qualidade excepcional.",
    "Sabor inigualável. Estou apaixonado(a)!",
    "Top demais! Já virou meu favorito.",
    "Atendimento e produto impecáveis.",
  ],
  4: [
    "Muito bom! Quase perfeito.",
    "Ótima qualidade, voltarei.",
    "Gostei bastante, recomendo.",
    "Produto de qualidade, só faltou um toque.",
    "Bem feito e saboroso.",
    "Boa opção, fiquei satisfeito(a).",
    "Gostei, mas pode melhorar em alguns detalhes.",
  ],
  3: [
    "Razoável, esperava um pouco mais.",
    "Bom, mas nada excepcional.",
    "Cumpre o que promete, sem surpresas.",
    "Mediano, já tive melhores.",
    "OK para o preço.",
  ],
  2: [
    "Abaixo da expectativa.",
    "Não gostei muito, precisa melhorar.",
    "Deixou a desejar.",
  ],
  1: [
    "Péssimo, muito decepcionante.",
    "Não recomendo.",
  ],
} as Record<number, string[]>

// ── Name generation ──────────────────────────────────────────────────────────

const FIRST_NAMES = [
  "Maria", "João", "Ana", "Carlos", "Fernanda", "Lucas", "Beatriz", "Rafael",
  "Gabriela", "Pedro", "Juliana", "Thiago", "Camila", "Bruno", "Larissa",
  "Diego", "Amanda", "Matheus", "Patricia", "Leonardo", "Isabella", "Felipe",
  "Letícia", "Rodrigo", "Mariana", "Gustavo", "Natália", "Eduardo", "Bianca",
  "André", "Renata", "Vinícius", "Daniela", "Ricardo", "Tatiana", "Marcelo",
]

const LAST_NAMES = [
  "Silva", "Santos", "Oliveira", "Pereira", "Costa", "Mendes", "Lima",
  "Almeida", "Souza", "Rocha", "Ribeiro", "Ferreira", "Carvalho", "Gomes",
  "Nascimento", "Barbosa", "Araujo", "Moreira", "Martins", "Correia",
  "Nogueira", "Pinto", "Melo", "Teixeira", "Monteiro", "Cardoso", "Lopes",
]

// ── Helpers ──────────────────────────────────────────────────────────────────

function pickWeighted<T>(items: T[], weights: number[], rng: () => number): T {
  const total = weights.reduce((a, b) => a + b, 0)
  let roll = rng() * total
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return items[i]
  }
  return items.at(-1)!
}

function normalRandom(mean: number, stddev: number, rng: () => number): number {
  // Box-Muller transform
  const u1 = rng()
  const u2 = rng()
  const z = Math.sqrt(-2 * Math.log(u1 || 0.0001)) * Math.cos(2 * Math.PI * u2)
  return mean + z * stddev
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

// ── Product catalog loader ──────────────────────────────────────────────────

interface CatalogProduct {
  id: string
  handle: string
  title: string
  category: string
  price: number       // centavos
  variantId: string
}

/** Extract price (centavos) from a Medusa variant's price_set, defaulting to R$50. */
function extractVariantPrice(variant: Record<string, unknown>): number {
  const priceSet = variant.price_set as Record<string, unknown> | undefined
  const prices = priceSet?.prices as Array<{ amount?: number }> | undefined
  return prices?.[0]?.amount ?? 5000
}

/** Parse a single MedusaProduct into a CatalogProduct, or return undefined if not usable. */
function parseCatalogProduct(p: MedusaProduct): CatalogProduct | undefined {
  if (p.status !== "published") return undefined
  const variant = (p.variants as Array<Record<string, unknown>>)?.[0]
  if (!variant) return undefined

  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    category: (p.categories as Array<{ name?: string }>)?.[0]?.name ?? "uncategorized",
    price: extractVariantPrice(variant),
    variantId: variant.id as string,
  }
}

async function loadCatalog(): Promise<CatalogProduct[]> {
  const token = await getAdminToken()
  const allProducts: CatalogProduct[] = []
  let offset = 0
  const limit = 100

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await medusaFetch<{ products?: MedusaProduct[] }>(
      `/admin/products?limit=${limit}&offset=${offset}&fields=id,title,handle,status,*variants,*variants.price_set,*variants.price_set.prices,*categories`,
      { token },
    )
    const products = data.products ?? []

    for (const p of products) {
      const parsed = parseCatalogProduct(p)
      if (parsed) allProducts.push(parsed)
    }

    if (products.length < limit) break
    offset += limit
  }

  return allProducts
}

// ── Product selection by profile ─────────────────────────────────────────────

function pickProductForProfile(
  catalog: CatalogProduct[],
  profile: BehaviorProfile,
  rng: () => number,
): CatalogProduct | undefined {
  const weights = catalog.map((p) => {
    if (profile.preferredProducts.includes(p.handle)) return 5
    if (profile.preferredCategories.some((cat) => p.category.toLowerCase().includes(cat.toLowerCase()))) return 3
    return 1
  })
  return pickWeighted(catalog, weights, rng)
}

// ── Simulation sub-steps ─────────────────────────────────────────────────────

interface SimConfig {
  profileNames: string[]
  profileWeights: number[]
  reviewProb: number
  ratingAvg: number
}

function resolveSimConfig(opts: SimulationOptions): SimConfig {
  if (opts.scale && SCALE_PRESETS[opts.scale]) {
    const preset = SCALE_PRESETS[opts.scale]
    opts.customers = preset.customers
    opts.ordersPerDay = preset.ordersPerDay
    opts.days = preset.days
  }

  const behaviorDist = opts.behavior ?? {
    pitmaster: 0.15,
    family: 0.35,
    casual: 0.4,
    congelados: 0.05,
    superfan: 0.05,
  }

  return {
    profileNames: Object.keys(behaviorDist),
    profileWeights: Object.values(behaviorDist),
    reviewProb: opts.reviews?.probability ?? 0.3,
    ratingAvg: opts.reviews?.ratingAvg ?? 4.3,
  }
}

async function generateCustomers(
  count: number,
  config: SimConfig,
  rng: () => number,
): Promise<SimCustomer[]> {
  const { prisma } = await import("@ibatexas/domain")
  const customers: SimCustomer[] = []

  for (let i = 0; i < count; i++) {
    const profileName = pickWeighted(config.profileNames, config.profileWeights, rng)
    const profile = PROFILES[profileName]
    const firstName = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)]
    const lastName = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)]
    const phone = `+5519${String(900000000 + Math.floor(rng() * 99999999)).padStart(9, "0")}`

    const customer = await prisma.customer.upsert({
      where: { phone },
      update: { name: `${firstName} ${lastName}` },
      create: { phone, name: `${firstName} ${lastName}` },
    })

    customers.push({
      id: customer.id,
      phone,
      name: `${firstName} ${lastName}`,
      profile,
      lastOrderDay: -profile.frequencyDays,
    })
  }

  return customers
}

/** Build a single order for a customer, or return undefined if no products were selected. */
function buildOrder(
  customer: SimCustomer,
  catalog: CatalogProduct[],
  orderId: string,
  dayDate: Date,
  rng: () => number,
): SimOrder | undefined {
  const numItems = Math.max(1, Math.round(normalRandom(customer.profile.avgItemsPerOrder, 1, rng)))
  const orderProducts: CatalogProduct[] = []

  for (let item = 0; item < numItems; item++) {
    const product = pickProductForProfile(catalog, customer.profile, rng)
    if (product && !orderProducts.some((p) => p.id === product.id)) {
      orderProducts.push(product)
    }
  }

  if (orderProducts.length === 0) return undefined

  const hour = 11 + Math.floor(rng() * 10)
  const minute = Math.floor(rng() * 60)
  const orderedAt = new Date(dayDate)
  orderedAt.setHours(hour, minute, 0, 0)

  return {
    customerId: customer.id,
    orderId,
    productIds: orderProducts.map((p) => p.id),
    variantIds: orderProducts.map((p) => p.variantId),
    quantities: orderProducts.map(() => Math.max(1, Math.round(normalRandom(1, 0.5, rng)))),
    prices: orderProducts.map((p) => p.price),
    orderedAt,
  }
}

/** Maybe generate a review for an order. Returns undefined if RNG decides no review. */
function maybeBuildReview(
  order: SimOrder,
  config: SimConfig,
  rng: () => number,
): SimReview | undefined {
  if (rng() >= config.reviewProb) return undefined

  const productIdx = Math.floor(rng() * order.productIds.length)
  const rating = clamp(Math.round(normalRandom(config.ratingAvg, 0.8, rng)), 1, 5)
  const comments = REVIEW_COMMENTS[rating] ?? REVIEW_COMMENTS[3]
  const comment = rng() < 0.7 ? comments[Math.floor(rng() * comments.length)] : null

  return {
    customerId: order.customerId,
    orderId: order.orderId,
    productId: order.productIds[productIdx],
    rating,
    comment,
    channel: rng() < 0.7 ? "web" : "whatsapp",
    createdAt: new Date(order.orderedAt.getTime() + Math.floor(rng() * 3 * 24 * 60 * 60 * 1000)),
  }
}

/** Generate all orders and reviews over the simulation day range. */
function generateOrdersAndReviews(
  opts: SimulationOptions,
  config: SimConfig,
  customers: SimCustomer[],
  catalog: CatalogProduct[],
  rng: () => number,
): { orders: SimOrder[]; reviews: SimReview[] } {
  const orders: SimOrder[] = []
  const reviews: SimReview[] = []
  const now = new Date()
  const startDate = new Date(now.getTime() - opts.days * 24 * 60 * 60 * 1000)

  for (let day = 0; day < opts.days; day++) {
    const dayDate = new Date(startDate.getTime() + day * 24 * 60 * 60 * 1000)
    const ordersToday = Math.max(1, Math.round(opts.ordersPerDay + normalRandom(0, opts.ordersPerDay * 0.2, rng)))

    for (let o = 0; o < ordersToday; o++) {
      const eligible = customers.filter((c) => day - c.lastOrderDay >= c.profile.frequencyDays * 0.7)
      if (eligible.length === 0) continue

      const customer = eligible[Math.floor(rng() * eligible.length)]
      customer.lastOrderDay = day

      const order = buildOrder(customer, catalog, `sim-${opts.seed}-${day}-${o}`, dayDate, rng)
      if (!order) continue

      orders.push(order)
      const review = maybeBuildReview(order, config, rng)
      if (review) reviews.push(review)
    }
  }

  return { orders, reviews }
}

async function writeOrdersToDB(
  orders: SimOrder[],
  prisma: Awaited<typeof import("@ibatexas/domain")>["prisma"],
): Promise<number> {
  let created = 0
  for (const order of orders) {
    for (let i = 0; i < order.productIds.length; i++) {
      try {
        await prisma.customerOrderItem.create({
          data: {
            customerId: order.customerId,
            medusaOrderId: order.orderId,
            productId: order.productIds[i],
            variantId: order.variantIds[i],
            quantity: order.quantities[i],
            priceInCentavos: order.prices[i],
            orderedAt: order.orderedAt,
          },
        })
        created++
      } catch {
        // Duplicate — skip (idempotent)
      }
    }
  }
  return created
}

async function writeReviewsToDB(
  reviews: SimReview[],
  prisma: Awaited<typeof import("@ibatexas/domain")>["prisma"],
): Promise<number> {
  let created = 0
  for (const review of reviews) {
    try {
      await prisma.review.create({
        data: {
          orderId: review.orderId,
          customerId: review.customerId,
          productId: review.productId,
          productIds: [review.productId],
          rating: review.rating,
          comment: review.comment,
          channel: review.channel,
          createdAt: review.createdAt,
        },
      })
      created++
    } catch {
      // Duplicate (unique constraint on orderId+customerId) — skip
    }
  }
  return created
}

// ── Simulation engine ────────────────────────────────────────────────────────

export async function runSimulation(opts: SimulationOptions): Promise<SimulationResult> {
  const start = Date.now()
  const config = resolveSimConfig(opts)
  const rng = seedrandom(String(opts.seed))

  console.log(chalk.bold("\n  Simulation Configuration"))
  console.log(chalk.dim(`  Customers: ${opts.customers}, Days: ${opts.days}, Orders/day: ${opts.ordersPerDay}`))
  console.log(chalk.dim(`  Seed: ${opts.seed}, Profiles: ${config.profileNames.join(", ")}`))
  console.log()

  // 1. Load product catalog
  const spinner = ora("Loading product catalog…").start()
  const catalog = await loadCatalog()
  if (catalog.length === 0) {
    spinner.fail(chalk.red("No products found — run ibx db seed first"))
    return { customersCreated: 0, ordersCreated: 0, reviewsCreated: 0, durationMs: Date.now() - start }
  }
  spinner.text = `Catalog: ${catalog.length} products`

  // 2. Generate customers
  spinner.text = `Generating ${opts.customers} customers…`
  const customers = await generateCustomers(opts.customers, config, rng)

  // 3. Generate orders and reviews
  spinner.text = "Generating orders…"
  const { orders, reviews } = generateOrdersAndReviews(opts, config, customers, catalog, rng)

  // 4. Write to DB
  const { prisma } = await import("@ibatexas/domain")

  spinner.text = `Writing ${orders.length} orders to database…`
  const ordersCreated = await writeOrdersToDB(orders, prisma)

  spinner.text = `Writing ${reviews.length} reviews to database…`
  const reviewsCreated = await writeReviewsToDB(reviews, prisma)

  await prisma.$disconnect()
  spinner.succeed(chalk.green(`  Simulation complete: ${customers.length} customers, ${ordersCreated} order items, ${reviewsCreated} reviews`))

  return {
    customersCreated: customers.length,
    ordersCreated,
    reviewsCreated,
    durationMs: Date.now() - start,
  }
}

// ── Rebuild intelligence after simulation ────────────────────────────────────

export async function rebuildAfterSimulation(): Promise<void> {
  console.log(chalk.bold("\n  Rebuilding Intelligence"))
  const spinner = ora("  Syncing review stats…").start()
  try {
    await StepRegistry["sync-reviews"].run()
    spinner.succeed(chalk.green("  Review stats synced"))
  } catch (err) {
    spinner.fail(chalk.red(`  Sync failed: ${(err as Error).message}`))
  }

  const spinner2 = ora("  Rebuilding co-purchase matrix…").start()
  try {
    await StepRegistry["intel-copurchase"].run()
    spinner2.succeed(chalk.green("  Co-purchase matrix rebuilt"))
  } catch (err) {
    spinner2.fail(chalk.red(`  Rebuild failed: ${(err as Error).message}`))
  }

  const spinner3 = ora("  Rebuilding global scores…").start()
  try {
    await StepRegistry["intel-global-score"].run()
    spinner3.succeed(chalk.green("  Global scores rebuilt"))
  } catch (err) {
    spinner3.fail(chalk.red(`  Rebuild failed: ${(err as Error).message}`))
  }
  console.log()
}
