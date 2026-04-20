// Machine types — events, context, and synthesized prompt for the Hybrid State-Flow architecture.
// The state machine (XState) processes events with guards and actions.
// The LLM only generates natural language from the synthesized prompt.

// ── Secondary intent (lightweight signal attached to primary events) ─────────

export type SecondaryIntent = {
  type: "OBJECTION" | "URGENCY" | "CONDITIONAL"
  subtype?: string
}

// ── Events (Router output) ─────────────────────────────────────────────────

// Base confidence field — optional so existing consumers that don't read it still work.
// Range: 0.0 (no confidence) to 1.0 (exact match). Set by the router on every emitted event.
type WithConfidence = { confidence?: number }

export type OrderEvent =
  | ({ type: "START_ORDER" } & WithConfidence)
  | ({ type: "ADD_ITEM"; productName: string; quantity: number; variantHint?: string; secondaryIntent?: SecondaryIntent } & WithConfidence)
  | ({ type: "REMOVE_ITEM"; productName: string } & WithConfidence)
  | ({ type: "UPDATE_QTY"; productName: string; quantity: number } & WithConfidence)
  | ({ type: "VIEW_CART" } & WithConfidence)
  | ({ type: "CLEAR_CART" } & WithConfidence)
  | ({ type: "APPLY_COUPON"; code: string } & WithConfidence)
  | ({ type: "SET_FULFILLMENT"; method: "pickup" | "delivery"; cep?: string; lat?: number; lng?: number } & WithConfidence)
  | ({ type: "SET_PAYMENT"; method: "pix" | "card" | "cash" } & WithConfidence)
  | ({ type: "CHECKOUT_START" } & WithConfidence)
  | ({ type: "CONFIRM_ORDER" } & WithConfidence)
  | ({ type: "CANCEL_ORDER" } & WithConfidence)
  | ({ type: "ASK_MENU"; subtype?: "food" | "frozen" | "merch" } & WithConfidence)
  | ({ type: "ASK_PRODUCT"; productName: string } & WithConfidence)
  | ({ type: "ASK_PRICE"; productName: string } & WithConfidence)
  | ({ type: "ASK_HOURS" } & WithConfidence)
  | ({ type: "ASK_DELIVERY"; cep?: string; lat?: number; lng?: number } & WithConfidence)
  | ({ type: "RESERVE_TABLE"; date?: string; time?: string; partySize?: number } & WithConfidence)
  | ({ type: "ASK_LOYALTY" } & WithConfidence)
  | ({ type: "ASK_REORDER" } & WithConfidence)
  | ({ type: "ASK_ORDER_STATUS" } & WithConfidence)
  | ({ type: "CANCEL_ITEM"; productName: string } & WithConfidence)
  | ({ type: "AMEND_ORDER_ADD"; productName: string; quantity: number } & WithConfidence)
  | ({ type: "AMEND_ORDER_REMOVE"; productName: string } & WithConfidence)
  | ({ type: "HANDOFF_HUMAN" } & WithConfidence)
  | ({ type: "OBJECTION"; subtype: "expensive" | "thinking" | "later" | "unknown" } & WithConfidence)
  | ({ type: "GREETING" } & WithConfidence)
  | ({ type: "UPSELL_ACCEPT"; productName: string } & WithConfidence)
  | ({ type: "UPSELL_DECLINE" } & WithConfidence)
  | ({ type: "UNKNOWN_INPUT"; raw: string } & WithConfidence)
  | ({ type: "SET_PIX_DETAILS"; email: string; taxId: string; fullName?: string } & WithConfidence)
  | ({ type: "PIX_DETAILS_COLLECTED"; payload: { name?: string; email?: string; cpf?: string } } & WithConfidence)
  // Payment lifecycle events (fed by orchestrator / webhooks during active session)
  | ({ type: "PAYMENT_STATUS_CHANGED"; paymentId: string; paymentStatus: string; method?: string; pixExpiresAt?: string | null } & WithConfidence)
  | ({ type: "PAYMENT_RETRY_RESULT"; success: boolean; message: string; pixCopyPaste?: string; pixQrCode?: string } & WithConfidence)

/** Events that tools may inject post-LLM response */
export const ALLOWED_POST_LLM_EVENTS = new Set([
  "PIX_DETAILS_COLLECTED",
  "SET_NAME",
  "PAYMENT_STATUS_CHANGED",
]) as ReadonlySet<string>

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
  customerEmail: string | null
  customerTaxId: string | null  // CPF format: 000.000.000-00

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

  // Active order context (populated from OrderProjection on session init)
  activeOrderId: string | null
  activeOrderDisplayId: number | null
  activeOrderStatus: string | null

  // Payment lifecycle (populated from Payment table after checkout / on session init)
  paymentId: string | null
  paymentStatus: string | null  // PaymentStatus enum value
  pixExpiresAt: string | null   // ISO 8601 — for countdown display
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

// ── IllusionContext (Layer 2 — perception/UX fields, NOT business logic) ────

export interface IllusionContext {
  momentum: "high" | "cooling" | "lost"
  secondaryIntent: SecondaryIntent | null
  lastObjectionSubtype: "expensive" | "thinking" | "later" | "unknown" | null
}

/** Extract ILLUSION fields from OrderContext for Layer 2 orchestrator. */
export function extractIllusionContext(ctx: OrderContext): IllusionContext {
  return {
    momentum: ctx.momentum,
    secondaryIntent: ctx.secondaryIntent,
    lastObjectionSubtype: ctx.lastObjectionSubtype,
  }
}

// ── DerivedFields (computable from CORE context — not persisted separately) ──

export interface DerivedFields {
  isAuthenticated: boolean
  hasMainDish: boolean
  hasSide: boolean
  hasDrink: boolean
  isCombo: boolean
}

/** Compute DERIVED fields from CORE context. */
export function computeDerivedFields(ctx: OrderContext): DerivedFields {
  const hasMainDish = ctx.items.some((i) => ["meat", "sandwich", "combo"].includes(i.category))
  const hasSide = ctx.items.some((i) => i.category === "side")
  const hasDrink = ctx.items.some((i) => i.category === "drink")
  const isCombo = ctx.items.some((i) => i.category === "combo")
  return {
    isAuthenticated: ctx.customerId !== null,
    hasMainDish,
    hasSide,
    hasDrink,
    isCombo,
  }
}

// ── Event Bridge contract types (3-Layer Architecture) ──────────────────────

/** Layer 1 → Layer 2: Kernel output after processing events. */
export interface KernelOutput {
  stateValue: string
  context: OrderContext
  illusionContext: IllusionContext
  pendingAction: PendingAction | null
  transitionMetadata: {
    fromState: string
    toState: string
    eventType: string
    timestamp: number
  }
}

/** Async side-effect the orchestrator must execute between transitions. */
export type PendingAction =
  | { type: "SEARCH_PRODUCT"; productName: string }
  | { type: "ADD_TO_CART"; variantId: string; quantity: number }
  | { type: "ENSURE_CART" }
  | { type: "ESTIMATE_DELIVERY"; cep?: string; lat?: number; lng?: number }
  | { type: "PROCESS_CHECKOUT" }
  | { type: "FETCH_LOYALTY" }
  | { type: "FETCH_PROFILE" }
  | { type: "SCHEDULE_FOLLOW_UP"; reason: string; delayHours: number }

/** Layer 2 → Layer 3: Evaluation request for the Supervisor. */
export interface SupervisorInput {
  userMessage: string
  stateValue: string
  contextSnapshot: Readonly<OrderContext>
  illusionContext: Readonly<IllusionContext>
  candidateResponse: string
  latencyBudgetMs: number
  conversationHistory: ReadonlyArray<{ role: string; content: string }>
}

/** Supervisor operating mode. */
export type SupervisorMode = "SPEED_MODE" | "EMPATHY_MODE" | "DIRECT_MODE" | "RECOVERY_MODE"

/** Layer 3 → Layer 2: Supervisor evaluation result. */
export interface SupervisorOutput {
  mode: SupervisorMode
  modifiers: {
    toneAdjustment?: string
    verbosityScale: number
    suggestedPhrasing?: string
    skipUpsell?: boolean
  }
  confidence: number
  reasoning?: string
}

/** Latency envelope tracking — passed through the orchestrator pipeline. */
export interface LatencyEnvelope {
  ttfbDeadlineMs: number   // 800ms from message receipt
  softDeadlineMs: number   // 2500ms from message receipt
  hardDeadlineMs: number   // 4000ms from message receipt
  messageReceivedAt: number
}

/** Create a LatencyEnvelope from the current timestamp. */
export function createLatencyEnvelope(messageReceivedAt: number = Date.now()): LatencyEnvelope {
  return {
    ttfbDeadlineMs: 800,
    softDeadlineMs: 2500,
    hardDeadlineMs: 4000,
    messageReceivedAt,
  }
}

// ── Tool classification (Zero-Trust LLM model) ─────────────────────────────

/**
 * Tool classification for the Zero-Trust LLM model.
 *
 * READ_ONLY: Tools that only query data. LLM can call these freely (within state-gate).
 * MUTATING: Tools that change system state. These MUST go through the kernel executor.
 *           The LLM may PROPOSE calling them, but the Machine DECIDES and EXECUTES.
 */
export const TOOL_CLASSIFICATION = {
  READ_ONLY: new Set([
    "search_products",
    "get_product_details",
    "estimate_delivery",
    "check_inventory",
    "get_nutritional_info",
    "check_table_availability",
    "get_my_reservations",
    "get_cart",
    "get_order_history",
    "check_order_status",
    "get_customer_profile",
    "get_recommendations",
    "get_also_added",
    "get_ordered_together",
    "get_loyalty_balance",
    "check_payment_status",
  ]),

  MUTATING: new Set([
    "add_to_cart",
    "remove_from_cart",
    "update_cart",
    "apply_coupon",
    "get_or_create_cart",
    "create_checkout",
    "cancel_order",
    "amend_order",
    "add_order_note",
    "reorder",
    "create_reservation",
    "modify_reservation",
    "cancel_reservation",
    "join_waitlist",
    "submit_review",
    "update_preferences",
    "handoff_to_human",
    "schedule_follow_up",
    "regenerate_pix",
    "set_pix_details",
  ]),
} as const

// ── Intent Bridge (LLM proposes, Machine decides) ───────────────────────────

/**
 * When the LLM calls a mutating tool, instead of executing it directly,
 * the system captures it as a ToolIntent. The kernel executor validates
 * the intent against the current machine state and decides whether to execute.
 */
export interface ToolIntent {
  /** Tool name the LLM wants to call */
  toolName: string
  /** Raw input from the LLM (pre-validated) */
  input: unknown
  /** Tool use ID from the Anthropic API (for returning results) */
  toolUseId: string
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
    customerEmail: null,
    customerTaxId: null,
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
    activeOrderId: null,
    activeOrderDisplayId: null,
    activeOrderStatus: null,
    paymentId: null,
    paymentStatus: null,
    pixExpiresAt: null,
  }
}
