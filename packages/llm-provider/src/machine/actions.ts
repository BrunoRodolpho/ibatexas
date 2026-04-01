// Action functions (side effects) for the XState order machine.
// These call existing tools from @ibatexas/tools as async side effects.
// The machine invokes them — the LLM never sees cart/checkout tools.

import type { AgentContext, SearchProductsOutput, ProductDTO } from "@ibatexas/types"
import type { OrderContext, CartItem, ItemCategory } from "./types.js"
import {
  searchProducts,
  getOrCreateCart,
  addToCart,
  createCheckout,
  estimateDelivery,
  getLoyaltyBalance,
  scheduleFollowUp,
  getCustomerProfile,
  reaisToCentavos,
  getRedisClient,
  rk,
} from "@ibatexas/tools"
import { Channel } from "@ibatexas/types"
import { createCustomerService } from "@ibatexas/domain"
import { computeCartFlags } from "./guards.js"

// ── Helper: build tool context from machine context ──────────────────────────

export function buildToolContext(ctx: OrderContext, sessionId: string): AgentContext {
  return {
    channel: ctx.channel === "whatsapp" ? Channel.WhatsApp : Channel.Web,
    sessionId,
    customerId: ctx.customerId ?? undefined,
    userType: ctx.customerId ? "customer" : "guest",
  }
}

// ── Search product ───────────────────────────────────────────────────────────

export interface SearchResult {
  found: boolean
  products: Array<{
    productId: string
    variantId: string
    name: string
    priceInCentavos: number
    category: ItemCategory
    isAvailableNow: boolean
    availabilityWindow?: string
    preparationTimeMinutes?: number
    amendPonrMinutes?: number
    cancelPonrMinutes?: number
  }>
  alternatives: string[]
}

/**
 * Search for a product by name. Returns structured result for the machine
 * to decide next transition (item available vs unavailable).
 */
export async function searchProduct(
  productName: string,
  ctx: OrderContext,
  sessionId: string,
): Promise<SearchResult> {
  try {
    const toolCtx = buildToolContext(ctx, sessionId)
    const searchCtx = {
      channel: toolCtx.channel,
      sessionId: toolCtx.sessionId,
      userId: toolCtx.customerId,
      userType: toolCtx.userType,
    }

    // When closed: only frozen items available for pickup
    // When open + WhatsApp: hot food priority (filter out frozen/merch)
    const productType = ctx.mealPeriod === "closed"
      ? "frozen" as const
      : ctx.channel === "whatsapp" ? "food" as const : undefined

    const result = await searchProducts(
      {
        query: productName,
        limit: 5,
        productType,
        availableNow: true,
      },
      searchCtx,
    ) as SearchProductsOutput

    function dtoToProduct(p: ProductDTO) {
      return {
        productId: p.id,
        variantId: p.variants[0]?.id ?? "",
        name: p.title,
        priceInCentavos: p.variants[0]?.price ?? 0,
        category: (p.productType ?? "meat") as ItemCategory,
        isAvailableNow: p.isAvailableNow ?? true,
        availabilityWindow: p.availabilityWindow,
        preparationTimeMinutes: p.preparationTimeMinutes ?? 0,
        amendPonrMinutes: p.amendPonrMinutes,
        cancelPonrMinutes: p.cancelPonrMinutes,
      }
    }

    // Expand multi-variant products so each variant is a separate entry.
    // E.g. Refrigerante (Coca-Cola, Guaraná) → 2 entries → LLM asks which one.
    const products = result.products.flatMap((p) => {
      if (p.variants.length <= 1) return [dtoToProduct(p)]
      return p.variants.map((v) => ({
        ...dtoToProduct(p),
        variantId: v.id,
        name: v.title ? `${p.title} — ${v.title}` : p.title,
        priceInCentavos: v.price,
      }))
    })

    const available = products.filter((p) => p.isAvailableNow)
    const unavailable = products.filter((p) => !p.isAvailableNow)

    if (available.length > 0) {
      return {
        found: true,
        products: available,
        alternatives: [],
      }
    }

    // Product found but unavailable — suggest alternatives from available products
    const alternatives = unavailable.length > 0
      ? unavailable.map((p) => p.name).slice(0, 2)
      : []

    // Search for available alternatives in same category
    if (unavailable.length > 0) {
      try {
        const altProductType = ctx.mealPeriod === "closed" ? "frozen" as const : undefined
        const altResult = await searchProducts(
          { query: productName, limit: 3, availableNow: true, productType: altProductType },
          searchCtx,
        ) as SearchProductsOutput

        const altNames = altResult.products
          .filter((p) => p.isAvailableNow !== false)
          .map((p) => p.title)
          .slice(0, 2)

        return {
          found: false,
          products: unavailable,
          alternatives: altNames,
        }
      } catch {
        // Fallback: return unavailable products as-is
      }
    }

    return {
      found: false,
      products: unavailable,
      alternatives,
    }
  } catch (err) {
    console.error("[machine:searchProduct]", (err as Error).message)
    return { found: false, products: [], alternatives: [] }
  }
}

// ── Cart operations ──────────────────────────────────────────────────────────

export interface CartActionResult {
  success: boolean
  cartId: string
  items: CartItem[]
  totalInCentavos: number
  error?: string
  staleVariant?: boolean
}

/** Get or create a Medusa cart and return normalized result. */
export async function ensureCart(
  ctx: OrderContext,
  sessionId: string,
): Promise<CartActionResult> {
  try {
    const toolCtx = buildToolContext(ctx, sessionId)
    const result = await getOrCreateCart({}, toolCtx) as {
      cartId: string
      items: Array<{ variantId: string; title: string; quantity: number; unitPrice: number }>
      total: number
    }

    const items: CartItem[] = result.items.map((i) => ({
      productId: "",
      variantId: i.variantId,
      name: i.title,
      category: "meat" as ItemCategory,
      quantity: i.quantity,
      priceInCentavos: i.unitPrice,
    }))

    return {
      success: true,
      cartId: result.cartId,
      items,
      totalInCentavos: result.total,
    }
  } catch (err) {
    console.error("[machine:ensureCart]", (err as Error).message)
    return { success: false, cartId: "", items: [], totalInCentavos: 0, error: (err as Error).message }
  }
}

/** Add an item to the cart. */
export async function addItemToCart(
  cartId: string,
  variantId: string,
  quantity: number,
  ctx: OrderContext,
  sessionId: string,
): Promise<CartActionResult> {
  try {
    const toolCtx = buildToolContext(ctx, sessionId)
    const result = await addToCart(
      { cartId, variantId, quantity },
      toolCtx,
    ) as { cart?: { items?: Array<{ variant_id: string; title?: string; quantity: number; unit_price: number }>; total?: number }; success?: boolean; message?: string }

    // addToCart may return an availability error or stale variant
    if (result.success === false) {
      return {
        success: false,
        cartId,
        items: ctx.items,
        totalInCentavos: ctx.totalInCentavos,
        error: result.message ?? "Item indisponível",
        staleVariant: (result as { staleVariant?: boolean }).staleVariant,
      }
    }

    const cart = result.cart
    if (!cart) {
      return { success: true, cartId, items: ctx.items, totalInCentavos: ctx.totalInCentavos }
    }

    const items: CartItem[] = (cart.items ?? []).map((i) => ({
      productId: "",
      variantId: i.variant_id,
      name: i.title ?? "",
      category: "meat" as ItemCategory,
      quantity: i.quantity,
      priceInCentavos: reaisToCentavos(i.unit_price),
    }))

    return {
      success: true,
      cartId,
      items,
      totalInCentavos: reaisToCentavos(cart.total ?? 0),
    }
  } catch (err) {
    console.error("[machine:addItemToCart]", (err as Error).message)
    return {
      success: false,
      cartId,
      items: ctx.items,
      totalInCentavos: ctx.totalInCentavos,
      error: (err as Error).message,
    }
  }
}

// ── Delivery estimation ──────────────────────────────────────────────────────

export interface DeliveryResult {
  success: boolean
  inZone: boolean
  feeInCentavos: number
  etaMinutes: number
  zoneName?: string
  error?: string
}

export async function estimateDeliveryAction(
  cep?: string,
  lat?: number,
  lng?: number,
): Promise<DeliveryResult> {
  try {
    const input: { cep?: string; latitude?: number; longitude?: number } = {}
    if (cep) input.cep = cep
    if (lat !== undefined && lng !== undefined) {
      input.latitude = lat
      input.longitude = lng
    }

    const result = await estimateDelivery(input) as {
      success: boolean
      feeInCentavos?: number
      estimatedMinutes?: number
      zoneName?: string
      message?: string
    }

    if (!result.success) {
      return { success: false, inZone: false, feeInCentavos: 0, etaMinutes: 0, error: result.message }
    }

    return {
      success: true,
      inZone: true,
      feeInCentavos: result.feeInCentavos ?? 0,
      etaMinutes: result.estimatedMinutes ?? 40,
      zoneName: result.zoneName,
    }
  } catch (err) {
    console.error("[machine:estimateDelivery]", (err as Error).message)
    return { success: false, inZone: false, feeInCentavos: 0, etaMinutes: 0, error: (err as Error).message }
  }
}

// ── Checkout ─────────────────────────────────────────────────────────────────

export interface CheckoutResult {
  success: boolean
  paymentMethod: string
  pixQrCodeUrl?: string
  pixQrCodeText?: string
  stripeClientSecret?: string
  orderId?: string
  message: string
}

export async function processCheckout(
  ctx: OrderContext,
  sessionId: string,
): Promise<CheckoutResult> {
  if (!ctx.cartId || !ctx.paymentMethod) {
    return { success: false, paymentMethod: ctx.paymentMethod ?? "unknown", message: "Carrinho ou método de pagamento não definido." }
  }

  if (ctx.items.length === 0) {
    return { success: false, paymentMethod: ctx.paymentMethod, message: "Carrinho vazio — adicione itens antes de finalizar." }
  }

  try {
    const toolCtx = buildToolContext(ctx, sessionId)
    const result = await createCheckout(
      {
        cartId: ctx.cartId,
        paymentMethod: ctx.paymentMethod,
        tipInCentavos: ctx.tipInCentavos > 0 ? ctx.tipInCentavos : undefined,
        deliveryCep: ctx.deliveryCep ?? undefined,
      },
      toolCtx,
      {
        customerName: ctx.customerName ?? undefined,
        customerEmail: ctx.customerEmail ?? undefined,
        customerTaxId: ctx.customerTaxId ?? undefined,
      },
    ) as {
      success: boolean
      paymentMethod: string
      pixQrCodeUrl?: string
      pixQrCodeText?: string
      stripeClientSecret?: string
      orderId?: string
      message: string
    }

    // NOTE: PIX details caching is now handled by the machine via CACHE_PIX_DETAILS
    // event after CHECKOUT_RESULT success. The kernel detects checkout.order_placed
    // and triggers the cache action. This ensures the side effect is machine-controlled.

    return result
  } catch (err) {
    console.error("[machine:processCheckout]", (err as Error).message)
    return { success: false, paymentMethod: ctx.paymentMethod, message: (err as Error).message }
  }
}

// ── PIX details cache ────────────────────────────────────────────────────────

const PIX_CACHE_TTL = 90 * 86400 // 90 days

/** Cache PIX details (name, email, CPF) for returning customers.
 *  Exported so the kernel can invoke it as a machine-controlled side effect
 *  after CHECKOUT_RESULT success (via CACHE_PIX_DETAILS event). */
export async function cachePixDetails(
  customerId: string,
  data: { name: string | null; email: string | null; cpf: string | null },
): Promise<void> {
  const redis = await getRedisClient()
  const key = rk(`customer:pix:${customerId}`)

  const pipeline = redis.multi()
  if (data.name) pipeline.hSet(key, "name", data.name)
  if (data.email) pipeline.hSet(key, "email", data.email)
  if (data.cpf) pipeline.hSet(key, "cpf", data.cpf)
  pipeline.expire(key, PIX_CACHE_TTL)
  await pipeline.exec()

  // Persist to Prisma
  const svc = createCustomerService()
  await svc.updatePixDetails(customerId, {
    name: data.name ?? undefined,
    email: data.email ?? undefined,
    cpf: data.cpf ?? undefined,
  })
}

export async function loadCachedPixDetails(
  customerId: string,
): Promise<{ name?: string; email?: string; cpf?: string } | null> {
  try {
    const redis = await getRedisClient()
    const key = rk(`customer:pix:${customerId}`)
    const hash = await redis.hGetAll(key)
    if (hash && Object.keys(hash).length > 0) {
      // Reset sliding TTL on read
      await redis.expire(key, PIX_CACHE_TTL)
      return {
        name: hash.name || undefined,
        email: hash.email || undefined,
        cpf: hash.cpf || undefined,
      }
    }
    // Fallback to DB
    const svc = createCustomerService()
    const customer = await svc.getById(customerId)
    const cpf = (customer as Record<string, unknown>).cpf as string | null | undefined
    if (customer.email || cpf) {
      return {
        name: customer.name ?? undefined,
        email: customer.email ?? undefined,
        cpf: cpf ?? undefined,
      }
    }
    return null
  } catch {
    return null
  }
}

// ── Loyalty ──────────────────────────────────────────────────────────────────

export async function fetchLoyaltyBalance(
  ctx: OrderContext,
  sessionId: string,
): Promise<number | null> {
  if (!ctx.customerId) return null
  try {
    const toolCtx = buildToolContext(ctx, sessionId)
    const result = await getLoyaltyBalance({}, toolCtx) as { stamps?: number }
    return result.stamps ?? null
  } catch {
    return null
  }
}

// ── Follow-up scheduling ─────────────────────────────────────────────────────

export async function scheduleFollowUpAction(
  ctx: OrderContext,
  sessionId: string,
  reason: string,
  delayHours: number,
): Promise<void> {
  if (!ctx.customerId) return
  try {
    const toolCtx = buildToolContext(ctx, sessionId)
    await scheduleFollowUp(
      { delayHours, reason },
      toolCtx,
    )
  } catch (err) {
    console.error("[machine:scheduleFollowUp]", (err as Error).message)
  }
}

// ── Customer profile ─────────────────────────────────────────────────────────

export interface CustomerProfileResult {
  isNewCustomer: boolean
  orderCount: number
  name?: string
  // Last order preferences for returning customers (pre-fill slots)
  lastFulfillment?: "pickup" | "delivery"
  lastPaymentMethod?: "pix" | "card" | "cash"
  lastDeliveryCep?: string
}

export async function fetchCustomerProfile(
  ctx: OrderContext,
  sessionId: string,
): Promise<CustomerProfileResult> {
  if (!ctx.customerId) return { isNewCustomer: true, orderCount: 0 }
  try {
    const toolCtx = buildToolContext(ctx, sessionId)
    const result = await getCustomerProfile(
      {},
      toolCtx,
    ) as {
      orderCount?: number
      name?: string
      lastFulfillment?: "pickup" | "delivery"
      lastPaymentMethod?: "pix" | "card" | "cash"
      lastDeliveryCep?: string
    }

    const orderCount = result.orderCount ?? 0
    return {
      isNewCustomer: orderCount === 0,
      orderCount,
      name: result.name,
      lastFulfillment: result.lastFulfillment,
      lastPaymentMethod: result.lastPaymentMethod,
      lastDeliveryCep: result.lastDeliveryCep,
    }
  } catch {
    return { isNewCustomer: true, orderCount: 0 }
  }
}
