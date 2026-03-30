// Machine types — events, context, and synthesized prompt for the Hybrid State-Flow architecture.
// The state machine (XState) processes events with guards and actions.
// The LLM only generates natural language from the synthesized prompt.

// ── Secondary intent (lightweight signal attached to primary events) ─────────

export type SecondaryIntent = {
  type: "OBJECTION" | "URGENCY" | "CONDITIONAL"
  subtype?: string
}

// ── Events (Router output) ─────────────────────────────────────────────────

export type OrderEvent =
  | { type: "START_ORDER" }
  | { type: "ADD_ITEM"; productName: string; quantity: number; variantHint?: string; secondaryIntent?: SecondaryIntent }
  | { type: "REMOVE_ITEM"; productName: string }
  | { type: "UPDATE_QTY"; productName: string; quantity: number }
  | { type: "VIEW_CART" }
  | { type: "CLEAR_CART" }
  | { type: "APPLY_COUPON"; code: string }
  | { type: "SET_FULFILLMENT"; method: "pickup" | "delivery"; cep?: string; lat?: number; lng?: number }
  | { type: "SET_PAYMENT"; method: "pix" | "card" | "cash" }
  | { type: "CHECKOUT_START" }
  | { type: "CONFIRM_ORDER" }
  | { type: "CANCEL_ORDER" }
  | { type: "ASK_MENU"; subtype?: "food" | "frozen" | "merch" }
  | { type: "ASK_PRODUCT"; productName: string }
  | { type: "ASK_PRICE"; productName: string }
  | { type: "ASK_HOURS" }
  | { type: "ASK_DELIVERY"; cep?: string; lat?: number; lng?: number }
  | { type: "RESERVE_TABLE"; date?: string; time?: string; partySize?: number }
  | { type: "ASK_LOYALTY" }
  | { type: "ASK_REORDER" }
  | { type: "ASK_ORDER_STATUS" }
  | { type: "CANCEL_ITEM"; productName: string }
  | { type: "AMEND_ORDER_ADD"; productName: string; quantity: number }
  | { type: "AMEND_ORDER_REMOVE"; productName: string }
  | { type: "HANDOFF_HUMAN" }
  | { type: "OBJECTION"; subtype: "expensive" | "thinking" | "later" | "unknown" }
  | { type: "GREETING" }
  | { type: "UPSELL_ACCEPT"; productName: string }
  | { type: "UPSELL_DECLINE" }
  | { type: "UNKNOWN_INPUT"; raw: string }

// ── Cart item (mirror of Medusa line item) ──────────────────────────────────

export type ItemCategory = "meat" | "sandwich" | "side" | "drink" | "dessert" | "frozen" | "combo" | "merch"

export interface CartItem {
  productId: string
  variantId: string
  name: string
  category: ItemCategory
  quantity: number
  priceInCentavos: number
  lineItemId?: string // Medusa line item ID for updates/removes
  preparationTimeMinutes?: number // per-item prep time (0 = ready immediately)
  amendPonrMinutes?: number // PONR: amend window in minutes
  cancelPonrMinutes?: number // PONR: cancel window in minutes
}

// ── Machine context (persisted to Redis via XState snapshot) ─────────────────

export interface OrderContext {
  // Session
  channel: "whatsapp" | "web"
  customerId: string | null
  customerName: string | null
  isAuthenticated: boolean
  isNewCustomer: boolean // orderCount === 0

  // Cart (lightweight mirror of Medusa cart, kept in sync after each action)
  cartId: string | null
  items: CartItem[]
  totalInCentavos: number
  couponApplied: string | null

  // Slots (filled progressively from user messages)
  fulfillment: "pickup" | "delivery" | null
  deliveryCep: string | null
  deliveryFeeInCentavos: number | null
  deliveryEtaMinutes: number | null
  paymentMethod: "pix" | "card" | "cash" | null
  tipInCentavos: number

  // Upsell tracking
  upsellRound: number // 0, 1, or 2
  hasMainDish: boolean
  hasSide: boolean
  hasDrink: boolean
  isCombo: boolean // combo = skip upsell

  // Time awareness (set at machine init, refreshed each message)
  mealPeriod: "lunch" | "dinner" | "closed"

  // State machine metadata
  lastError: string | null
  pendingProduct: string | null // product being resolved (e.g., variant selection)
  alternatives: string[] // suggested alternatives when item unavailable

  // Search result cache (populated by searchProduct action)
  lastSearchResult: unknown | null

  // Checkout result (populated by processCheckout action)
  checkoutResult: unknown | null

  // Post-checkout order data (extracted from checkoutResult)
  orderId: string | null
  orderCreatedAt: string | null // ISO string — used for PONR calculations

  // Last action marker (for cancel/amend confirmation prompts)
  lastAction: "cancelled" | "amended" | null

  // Loyalty (populated post-checkout)
  loyaltyStamps: number | null

  // Secondary intent (lightweight tone modifier set by router, cleared on state entry)
  secondaryIntent: SecondaryIntent | null

  // Forward momentum signal — modulates synthesizer tone
  momentum: "high" | "cooling" | "lost"

  // Objection subtype for prompt routing (set on OBJECTION events)
  lastObjectionSubtype: "expensive" | "thinking" | "later" | "unknown" | null

  // Fallback misunderstanding counter (reset on entry to non-fallback states)
  fallbackCount: number
}

// ── Synthesized prompt (output of prompt synthesizer) ───────────────────────

export interface SynthesizedPrompt {
  systemPrompt: string // targeted instructions for LLM
  availableTools: string[] // only tools LLM can call in this state
  maxTokens: number // response length limit
}

// ── Meal period helper ──────────────────────────────────────────────────────

export function getCurrentMealPeriod(schedule?: import("@ibatexas/types").RestaurantSchedule): "lunch" | "dinner" | "closed" {
  const tz = process.env.RESTAURANT_TIMEZONE || "America/Sao_Paulo"

  if (schedule) {
    return getMealPeriodFromScheduleInline(schedule, tz)
  }

  // Fallback: env vars (backward compat for tests)
  const hour = getLocalHour(tz)

  const lunchStart = Number.parseInt(process.env.RESTAURANT_LUNCH_START_HOUR || "11", 10)
  const lunchEnd = Number.parseInt(process.env.RESTAURANT_LUNCH_END_HOUR || "15", 10)
  const dinnerStart = Number.parseInt(process.env.RESTAURANT_DINNER_START_HOUR || "18", 10)
  const dinnerEnd = Number.parseInt(process.env.RESTAURANT_DINNER_END_HOUR || "23", 10)

  if (hour >= lunchStart && hour < lunchEnd) return "lunch"
  if (hour >= dinnerStart && hour < dinnerEnd) return "dinner"
  return "closed"
}

// Inline timezone helper using Intl (avoids circular import with @ibatexas/tools)
function getLocalHour(tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).formatToParts(new Date())
  const hourPart = parts.find((p) => p.type === "hour")
  const hour = Number.parseInt(hourPart?.value ?? "0", 10)
  return hour === 24 ? 0 : hour
}

function getMealPeriodFromScheduleInline(
  schedule: import("@ibatexas/types").RestaurantSchedule,
  tz: string,
): "lunch" | "dinner" | "closed" {
  const now = new Date()
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false })
  const parts = dtf.formatToParts(now)
  let hour = 0, minute = 0
  for (const p of parts) {
    if (p.type === "hour") hour = Number.parseInt(p.value, 10)
    if (p.type === "minute") minute = Number.parseInt(p.value, 10)
  }
  if (hour === 24) hour = 0
  const timeMinutes = hour * 60 + minute

  // Get day of week in target timezone
  const dayStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now)
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const dayOfWeek = dayMap[dayStr] ?? now.getDay()

  const day = schedule.days.find((d) => d.dayOfWeek === dayOfWeek)
  if (!day || !day.isOpen) return "closed"

  // Check holidays
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now)
  if (schedule.holidays.some((h) => h.date === todayStr)) return "closed"

  if (day.lunchStart && day.lunchEnd) {
    const [lh, lm] = day.lunchStart.split(":").map(Number)
    const [leh, lem] = day.lunchEnd.split(":").map(Number)
    if (timeMinutes >= (lh! * 60 + lm!) && timeMinutes < (leh! * 60 + lem!)) return "lunch"
  }
  if (day.dinnerStart && day.dinnerEnd) {
    const [dh, dm] = day.dinnerStart.split(":").map(Number)
    const [deh, dem] = day.dinnerEnd.split(":").map(Number)
    if (timeMinutes >= (dh! * 60 + dm!) && timeMinutes < (deh! * 60 + dem!)) return "dinner"
  }
  return "closed"
}

// ── Default context factory ─────────────────────────────────────────────────

export function createDefaultContext(
  channel: "whatsapp" | "web",
  customerId: string | null,
): OrderContext {
  return {
    channel,
    customerId,
    customerName: null,
    isAuthenticated: customerId !== null,
    isNewCustomer: true, // default; overridden by get_customer_profile
    cartId: null,
    items: [],
    totalInCentavos: 0,
    couponApplied: null,
    fulfillment: null,
    deliveryCep: null,
    deliveryFeeInCentavos: null,
    deliveryEtaMinutes: null,
    paymentMethod: null,
    tipInCentavos: 0,
    upsellRound: 0,
    hasMainDish: false,
    hasSide: false,
    hasDrink: false,
    isCombo: false,
    mealPeriod: getCurrentMealPeriod(),
    lastError: null,
    pendingProduct: null,
    alternatives: [],
    lastSearchResult: null,
    checkoutResult: null,
    orderId: null,
    orderCreatedAt: null,
    lastAction: null,
    loyaltyStamps: null,
    secondaryIntent: null,
    momentum: "high",
    lastObjectionSubtype: null,
    fallbackCount: 0,
  }
}
