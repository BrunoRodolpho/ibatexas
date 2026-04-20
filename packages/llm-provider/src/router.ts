// router.ts — Keyword-based message router for IbateXas WhatsApp bot.
// Takes a user message + conversation history and returns structured XState events.
// No LLM calls — pure string matching.

import type { AgentMessage } from "@ibatexas/types"
import Fuse from "fuse.js"
import type { OrderEvent, SecondaryIntent } from "./machine/types.js"
import { getCurrentMenuProducts } from "./prompt-sections.js"

// ── Normalization ──────────────────────────────────────────────────────────────

/**
 * Lowercase and strip diacritics so all matching is accent-insensitive.
 */
export function normalize(msg: string): string {
  return msg
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
}

// ── Secondary intent detection ─────────────────────────────────────────────────

/**
 * Scan a normalized message for secondary signals (price sensitivity, urgency,
 * conditionality). Returns a SecondaryIntent if found, undefined otherwise.
 */
function detectSecondaryIntent(norm: string): SecondaryIntent | undefined {
  if (/\b(caro|cara|preco|barato|em\s+conta|mais\s+acessivel)\b/.test(norm)) {
    return { type: "OBJECTION", subtype: "price_sensitive" }
  }
  if (/\b(rapido|pressa|urgente|correndo)\b/.test(norm)) {
    return { type: "URGENCY" }
  }
  if (/\b(se\s+tiver|caso|talvez|depende)\b/.test(norm)) {
    return { type: "CONDITIONAL" }
  }
  return undefined
}

// ── Product catalog ────────────────────────────────────────────────────────────

// Each entry: canonical name + regex aliases (applied to normalized text).
const PRODUCT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "costela", pattern: /\bcostela\b/ },
  { name: "brisket", pattern: /\bbrisket\b/ },
  { name: "barriga", pattern: /\bbarriga\b/ },
  { name: "frango", pattern: /\bfrango\b/ },
  { name: "linguica", pattern: /\blinguica\b/ },
  { name: "pulled pork", pattern: /\bpulled\s*pork\b/ },
  { name: "smash", pattern: /\bsmash\b/ },
  { name: "burger", pattern: /\bburger\b/ },
  { name: "combo", pattern: /\bcombo\b/ },
  { name: "farofa", pattern: /\bfarofa\b/ },
  { name: "mandioca", pattern: /\bmandioca\b/ },
  { name: "feijao", pattern: /\bfeijao\b/ },
  { name: "coleslaw", pattern: /\bcoleslaw\b/ },
  { name: "batata", pattern: /\bbatata\b/ },
  { name: "brownie", pattern: /\bbrownie\b/ },
  { name: "pudim", pattern: /\bpudim\b/ },
  { name: "refrigerante", pattern: /\brefrigerante\b/ },
  { name: "coca", pattern: /\bcoca\b/ },
  { name: "guarana", pattern: /\bguarana\b/ },
  { name: "limonada", pattern: /\blimonada\b/ },
  { name: "cerveja", pattern: /\bcerveja\b/ },
  { name: "ipa", pattern: /\bipa\b/ },
  { name: "suco", pattern: /\bsuco\b/ },
  { name: "molho bbq", pattern: /\bmolho\s*bbq\b/ },
]

// ── Fuse.js menu catalog ───────────────────────────────────────────────────────

// Menu items with canonical names + attribute tags for query expansion (Fuse.js)
const MENU_ITEMS = [
  { id: "costela", name: "Costela", tags: ["defumada", "defumado", "carne", "bbq", "barbecue", "bovina", "costela"] },
  { id: "brisket", name: "Brisket", tags: ["defumado", "carne", "bbq", "barbecue", "bovino", "brisket"] },
  { id: "barriga", name: "Barriga de Porco", tags: ["defumada", "porco", "suino", "carne", "barriga"] },
  { id: "frango", name: "Frango", tags: ["defumado", "ave", "galinha", "frango"] },
  { id: "linguica", name: "Linguica", tags: ["defumada", "porco", "embutido", "linguica"] },
  { id: "pulled pork", name: "Pulled Pork", tags: ["porco", "desfiado", "sanduiche", "carne", "pulled"] },
  { id: "smash", name: "Smash Burger", tags: ["hamburguer", "burger", "sanduiche", "lanche", "smash"] },
  { id: "combo", name: "Combo", tags: ["combo", "promocao"] },
  { id: "farofa", name: "Farofa", tags: ["acompanhamento", "lado", "farofa"] },
  { id: "mandioca", name: "Mandioca Frita", tags: ["acompanhamento", "lado", "frita", "mandioca"] },
  { id: "feijao", name: "Feijao Tropeiro", tags: ["acompanhamento", "feijao", "tropeiro"] },
  { id: "coleslaw", name: "Coleslaw", tags: ["acompanhamento", "salada", "coleslaw"] },
  { id: "batata", name: "Batata", tags: ["acompanhamento", "frita", "batata"] },
  { id: "brownie", name: "Brownie", tags: ["sobremesa", "doce", "chocolate", "brownie"] },
  { id: "pudim", name: "Pudim", tags: ["sobremesa", "doce", "pudim"] },
  { id: "refrigerante", name: "Refrigerante", tags: ["bebida", "coca", "guarana", "refri", "refrigerante"] },
  { id: "limonada", name: "Limonada", tags: ["bebida", "suco", "drink", "limonada"] },
  { id: "cerveja", name: "Cerveja", tags: ["bebida", "cerveja", "ipa", "chopp"] },
  { id: "suco", name: "Suco", tags: ["bebida", "suco", "natural"] },
  { id: "molho bbq", name: "Molho BBQ", tags: ["molho", "bbq", "barbecue"] },
]

const productFuse = new Fuse(MENU_ITEMS, {
  keys: [
    { name: "name", weight: 0.6 },
    { name: "tags", weight: 0.4 },
  ],
  threshold: 0.4,
  includeScore: true,
  ignoreLocation: true,
})

// Food-related keywords for fail-soft fallback
const FOOD_KEYWORDS_RE = /\b(carne|prato|comida|refeicao|comer|almocar|jantar|porcao|defumad[ao])\b/

function findBestProductMatch(input: string): { id: string; name: string; score: number } | null {
  const results = productFuse.search(input)
  if (results.length === 0 || results[0].score === undefined) return null
  return {
    id: results[0].item.id,
    name: results[0].item.name,
    score: results[0].score,
  }
}

// ── Variant extraction ─────────────────────────────────────────────────────────

// Weight/volume variants: "1kg", "500g", "500ml", "300ml"
const WEIGHT_VARIANT_RE = /\b(\d+(?:\.\d+)?)\s*(kg|g)\b/
const VOLUME_VARIANT_RE = /\b(\d+)\s*ml\b/
const SIZE_VARIANT_MAP: Record<string, string> = {
  grande: "500ml",
  pequena: "300ml",
  pequeno: "300ml",
}

// Product-contextual variant qualifiers — checked before SIZE_VARIANT_MAP.
// Keys are product names (from PRODUCT_PATTERNS); values map qualifier words to variant strings.
const VARIANT_QUALIFIERS: Record<string, Record<string, string>> = {
  costela: { grande: "1kg", pequena: "500g", inteira: "1kg", meia: "500g" },
  limonada: { grande: "500ml", pequena: "300ml" },
}

/** Returns true when `word` appears as a whole word inside `fragment`. */
function hasWord(fragment: string, word: string): boolean {
  const tokens = fragment.split(/\W+/)
  return tokens.includes(word)
}

function extractVariant(fragment: string, productName?: string): string | undefined {
  const weightMatch = WEIGHT_VARIANT_RE.exec(fragment)
  if (weightMatch) return `${weightMatch[1]}${weightMatch[2]}`

  const volumeMatch = VOLUME_VARIANT_RE.exec(fragment)
  if (volumeMatch) return `${volumeMatch[1]}ml`

  // Product-contextual qualifiers take priority over the generic SIZE_VARIANT_MAP
  if (productName !== undefined) {
    const productQualifiers = VARIANT_QUALIFIERS[productName]
    if (productQualifiers !== undefined) {
      for (const [keyword, mapped] of Object.entries(productQualifiers)) {
        if (hasWord(fragment, keyword)) return mapped
      }
    }
  }

  for (const [keyword, mapped] of Object.entries(SIZE_VARIANT_MAP)) {
    if (hasWord(fragment, keyword)) return mapped
  }

  return undefined
}

// ── Helper exports ─────────────────────────────────────────────────────────────

/**
 * Returns the first product name found in the normalized message, or null.
 */
export function findProductMention(msg: string): string | null {
  const norm = normalize(msg)
  // Exact match first
  for (const { name, pattern } of PRODUCT_PATTERNS) {
    if (pattern.test(norm)) return name
  }
  // Fuzzy fallback
  const match = findBestProductMatch(norm)
  if (match && match.score < 0.35) return match.id
  return null
}

/**
 * Extract all products mentioned in the message with quantities and optional variants.
 * "2 costelas" -> [{ name: "costela", qty: 2 }]
 * "costela 1kg" -> [{ name: "costela", qty: 1, variant: "1kg" }]
 */
export function extractProducts(
  msg: string,
): Array<{ name: string; qty: number; variant?: string; confidence: number }> {
  const norm = normalize(msg)

  // 1. Try legacy exact regex first (zero-cost, already correct)
  const regexResults: Array<{ name: string; qty: number; variant?: string; confidence: number }> = []
  for (const { name, pattern } of PRODUCT_PATTERNS) {
    const match = pattern.exec(norm)
    if (!match) continue
    const matchIndex = match.index
    const windowStart = Math.max(0, matchIndex - 10)
    const windowEnd = Math.min(norm.length, matchIndex + match[0].length + 20)
    const window = norm.slice(windowStart, windowEnd)
    let qty = 1
    const qtyBefore = norm.slice(Math.max(0, matchIndex - 5), matchIndex).trim()
    const qtyMatch = /(\d+)\s*$/.exec(qtyBefore)
    if (qtyMatch) qty = parseInt(qtyMatch[1], 10)
    const variant = extractVariant(window, name)
    regexResults.push({ name, qty, confidence: 1.0, ...(variant !== undefined ? { variant } : {}) })
  }
  if (regexResults.length > 0) return regexResults

  // 2. Fuzzy match via Fuse.js — sliding window (3-word, 2-word, 1-word)
  const words = norm.split(/\s+/).filter(Boolean)
  for (const windowSize of [3, 2, 1]) {
    for (let i = 0; i <= words.length - windowSize; i++) {
      const phrase = words.slice(i, i + windowSize).join(" ")
      const match = findBestProductMatch(phrase)
      if (match && match.score < 0.3) {
        const qty = extractQuantityFromNorm(norm)
        const variant = extractVariant(norm, match.id)
        const confidence = Math.round((1 - match.score) * 100) / 100
        return [{ name: match.id, qty, confidence, ...(variant !== undefined ? { variant } : {}) }]
      }
    }
  }

  // 3. Full input as single query
  const fullMatch = findBestProductMatch(norm)
  if (fullMatch && fullMatch.score < 0.4) {
    const qty = extractQuantityFromNorm(norm)
    const variant = extractVariant(norm, fullMatch.id)
    const confidence = Math.round((1 - fullMatch.score) * 100) / 100
    return [{ name: fullMatch.id, qty, confidence, ...(variant !== undefined ? { variant } : {}) }]
  }

  return []
}

const WORD_NUMBERS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5,
  meia: 6, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
}

/** Extract quantity from normalized text (helper for fuzzy path) */
function extractQuantityFromNorm(norm: string): number {
  // Digit-based: "2x", "3 un"
  const digitMatch = /\b(\d+)\s*(x|un)?\b/.exec(norm)
  if (digitMatch) return parseInt(digitMatch[1], 10)
  // Word-based: "uma", "dois", etc.
  for (const [word, num] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`\\b${word}\\b`).test(norm)) return num
  }
  return 1
}

/**
 * Extract payment method from the normalized message.
 * Returns "pix", "card", or "cash", or null if not found.
 */
export function extractPayment(msg: string): "pix" | "card" | "cash" | null {
  const norm = normalize(msg)
  if (/\bpix\b/.test(norm)) return "pix"
  if (/\b(cartao|debito|credito)\b/.test(norm)) return "card"
  if (/\bdinheiro\b/.test(norm)) return "cash"
  return null
}

/**
 * Extract fulfillment method from the normalized message.
 * Returns { method, cep? } or null.
 */
export function extractFulfillment(
  msg: string,
): { method: "pickup" | "delivery"; cep?: string } | null {
  const norm = normalize(msg)

  const PICKUP_RE =
    /\b(retirada|retirar|retiro|retirei|pegar|buscar|pra\s+pegar|vou\s+buscar|pra\s+buscar|pick\s*up)\b/
  const DELIVERY_RE = /\b(entrega|entregar)\b/

  if (PICKUP_RE.test(norm)) return { method: "pickup" }

  const cep = extractCep(msg)
  if (DELIVERY_RE.test(norm) || cep !== null) {
    return { method: "delivery", ...(cep !== null ? { cep } : {}) }
  }

  return null
}

/**
 * Extract a Brazilian CEP (postal code) from the raw message.
 * Matches \d{5}-?\d{3} format.
 */
export function extractCep(msg: string): string | null {
  const match = /\b(\d{5}-?\d{3})\b/.exec(msg)
  return match ? match[1] : null
}

/**
 * Extract a coupon code from the message.
 * Matches uppercase alphanumeric codes like FIEL20, BEMVINDO15.
 */
export function extractCouponCode(msg: string): string | null {
  // Common coupon patterns: uppercase letters followed by digits, or all-caps alphanumeric 4+ chars
  const match = /\b([A-Z]{2,}[0-9]{1,}|[A-Z]{4,})\b/.exec(msg)
  return match ? match[1] : null
}

// ── Customer name extraction ───────────────────────────────────────────────────

/**
 * Extract customer name from patterns like "meu nome é X", "é pra Y", "pedido pro Z".
 * Returns the name or null.
 */
export function extractCustomerName(msg: string): string | null {
  const norm = normalize(msg)
  // "meu nome é Bruno" / "me chamo Bruno"
  const nameMatch = /(?:meu nome e|me chamo)\s+(\w+)/i.exec(norm)
  if (nameMatch) return capitalize(nameMatch[1])
  // "é pra Bruno" / "pedido pro Bruno" / "para Bruno"
  const forMatch = /(?:e pra|pedido pr[ao]|para)\s+(\w+)/i.exec(norm)
  if (forMatch) return capitalize(forMatch[1])
  // Fallback: short message with a capitalized word — "Bruno", "Certo. Bruno"
  // Only triggers when explicit patterns above fail.
  const words = msg.trim().split(/[\s.,!?]+/).filter(Boolean)
  if (words.length <= 3) {
    const capitalized = words.find((w) => /^[A-ZÀ-Ú][a-zà-ú]{1,}$/.test(w))
    if (capitalized) return capitalize(capitalized)
  }
  return null
}

export function extractEmail(msg: string): string | null {
  const match = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/.exec(msg)
  return match ? match[1]!.toLowerCase() : null
}

export function extractCpf(msg: string): string | null {
  const match = /\b(\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})\b/.exec(msg)
  if (!match) return null
  const raw = match[1]!.replace(/\D/g, "")
  if (raw.length !== 11) return null
  return raw.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")
}

export function extractFullName(msg: string): string | null {
  // Remove email and CPF from message, remaining text is the name
  const cleaned = msg
    .replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, "")
    .replace(/\b(\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})\b/g, "")
    .trim()
  if (cleaned.length < 3) return null
  // Must have at least 2 words for a full name
  const words = cleaned.split(/\s+/).filter(w => w.length > 0)
  if (words.length < 2) return null
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ")
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

// ── History context ────────────────────────────────────────────────────────────

const CHECKOUT_CONTEXT_RE =
  /\b(confirma|confirme|pagamento|pix|cartao|total|pedido|resumo|entrega|retirada|dinheiro|fechar|finalizar|mando|certo)\b/

/**
 * Returns true if recent assistant messages indicate the conversation is in a
 * checkout confirmation context.
 */
export function historyInCheckout(history: AgentMessage[]): boolean {
  const assistantMessages = history.filter((m) => m.role === "assistant")
  const recent = assistantMessages.slice(-3)
  return recent.some((m) => CHECKOUT_CONTEXT_RE.test(normalize(m.content)))
}

const UPSELL_CONTEXT_RE =
  /\b(combina|acompanhamento|bebida|farofa|mandioca|limonada|refri|quer\s+adicionar|quer\s+incluir)\b/

/**
 * Returns true if the last assistant message was an upsell suggestion.
 * Prevents "sim" after "Quer uma farofa?" from triggering CONFIRM_ORDER.
 */
export function historyHasUpsellQuestion(history: AgentMessage[]): boolean {
  const assistantMessages = history.filter((m) => m.role === "assistant")
  const last = assistantMessages[assistantMessages.length - 1]
  if (!last) return false
  return UPSELL_CONTEXT_RE.test(normalize(last.content))
}

// ── Main router ────────────────────────────────────────────────────────────────

/**
 * Route a user message to one or more XState OrderEvents.
 *
 * Fast path: if the message contains product(s) + payment + fulfillment,
 * return [ADD_ITEM..., SET_FULFILLMENT, SET_PAYMENT, CHECKOUT_START].
 *
 * Otherwise, detect the single dominant intent in priority order.
 */
export function routeMessage(
  message: string,
  history: AgentMessage[],
  currentMachineState?: string,
): OrderEvent[] {
  const norm = normalize(message)

  const products = extractProducts(message)
  const payment = extractPayment(message)
  const fulfillment = extractFulfillment(message)

  // Greeting detection — prepended to reset stale machine state (e.g., post_order → idle)
  const GREETING_RE = /\b(oi|ola|bom\s+dia|boa\s+tarde|boa\s+noite|eai|fala)\b/
  const hasGreeting = GREETING_RE.test(norm)

  // ── PIX details collection — LLM extracts via set_pix_details tool ──
  if (currentMachineState === "checkout.collecting_pix_details" || currentMachineState === "checkout.reviewing_pix_details") {
    // Affirmative in reviewing state → confirm
    if (/\b(sim|isso|pode|bora|certo|ok|beleza|confirmo)\b/.test(norm)) {
      return [{ type: "CONFIRM_ORDER", confidence: 0.9 }]
    }
    // Negation → re-enter data
    if (/\b(nao|não|trocar|outro|mudar|alterar|corrigir)\b/.test(norm)) {
      return [{ type: "UNKNOWN_INPUT", raw: message, confidence: 0.0 }]
    }
    // Everything else → UNKNOWN_INPUT so the LLM handles via tool
    return [{ type: "UNKNOWN_INPUT", raw: message, confidence: 0.0 }]
  }

  // ── Fast path ──────────────────────────────────────────────────────────────
  if (products.length > 0 && payment !== null && fulfillment !== null) {
    const events: OrderEvent[] = products.map((p) => ({
      type: "ADD_ITEM" as const,
      productName: p.name,
      quantity: p.qty,
      confidence: p.confidence,
      ...(p.variant !== undefined ? { variantHint: p.variant } : {}),
    }))

    const secondary = detectSecondaryIntent(norm)
    if (secondary) {
      events[0] = { ...events[0], secondaryIntent: secondary } as OrderEvent
    }

    events.push({
      type: "SET_FULFILLMENT",
      method: fulfillment.method,
      confidence: 1.0,
      ...(fulfillment.cep !== undefined ? { cep: fulfillment.cep } : {}),
    })

    events.push({ type: "SET_PAYMENT", method: payment, confidence: 1.0 })
    events.push({ type: "CHECKOUT_START", confidence: 1.0 })

    // Prepend GREETING to reset machine from stale states (post_order, etc.)
    if (hasGreeting) events.unshift({ type: "GREETING", confidence: 1.0 })

    return events
  }

  // ── "Tudo" (order everything on current menu) ────────────────────────────
  if (/\b(tudo|quero\s+tudo|um\s+de\s+cada)\b/.test(norm)) {
    const menuProducts = getCurrentMenuProducts()
    if (menuProducts !== null && menuProducts.length > 0) {
      const events: OrderEvent[] = menuProducts.map((p) => ({
        type: "ADD_ITEM" as const,
        productName: p.name,
        quantity: 1,
        confidence: 1.0,
        ...(p.variant !== undefined ? { variantHint: p.variant } : {}),
      }))

      // Also include any fulfillment/payment from the same message
      if (fulfillment !== null) {
        events.push({
          type: "SET_FULFILLMENT",
          method: fulfillment.method,
          confidence: 1.0,
          ...(fulfillment.cep ? { cep: fulfillment.cep } : {}),
        })
      }
      if (payment !== null) {
        events.push({ type: "SET_PAYMENT", method: payment, confidence: 1.0 })
      }
      if (fulfillment !== null && payment !== null) {
        events.push({ type: "CHECKOUT_START", confidence: 1.0 })
      }

      return events
    }
    // Closed hours — fall through to fallback
  }

  // ── Quantity correction ("uma só", "só uma", "apenas duas") ──────────────
  const QTY_CORRECTION_RE = /\b(so\s+(?:um|uma|dois|duas|\d+)|(?:um|uma|dois|duas|\d+)\s+so|apenas\s+(?:um|uma|dois|duas|\d+))\b/
  if (QTY_CORRECTION_RE.test(norm)) {
    const qty = extractQuantityFromNorm(norm)
    return [{ type: "UPDATE_QTY", productName: "__last_pending__", quantity: qty, confidence: 1.0 }]
  }

  // ── Confirm order (MUST run before product matching) ──────────────────────
  // Short affirmative messages like "sim", "pode", "ok" can fuzzy-match product
  // names in Fuse.js. Check for confirmation FIRST when machine is in checkout.
  const AFFIRMATIVE_RE = /\b(sim|isso|pode|bora|manda|vai|fecha|certo|ok|beleza|perfeito|confirmar|confirmo|fechado)\b/
  if (AFFIRMATIVE_RE.test(norm)) {
    // Explicit confirmation — always CONFIRM_ORDER
    if (/\b(confirmar|confirmo|fechado)\b/.test(norm)) {
      return [{ type: "CONFIRM_ORDER", confidence: 1.0 }]
    }
    // Machine state: authoritative checkout detection
    const machineInCheckout = currentMachineState?.startsWith("checkout")
    const machineInOrdering = currentMachineState?.startsWith("ordering")

    if (machineInCheckout && !historyHasUpsellQuestion(history)) {
      return [{ type: "CONFIRM_ORDER", confidence: 0.95 }]
    }
    if (machineInOrdering && !historyHasUpsellQuestion(history) && historyInCheckout(history)) {
      return [{ type: "CONFIRM_ORDER", confidence: 0.8 }]
    }
    // Fallback: history-based (when machine state not available)
    if (!currentMachineState && historyInCheckout(history) && !historyHasUpsellQuestion(history)) {
      return [{ type: "CONFIRM_ORDER", confidence: 0.7 }]
    }
    // Affirmative after upsell = accept upsell
    if (historyHasUpsellQuestion(history)) {
      return [{ type: "UPSELL_ACCEPT", productName: "__last_suggested__", confidence: 0.8 }]
    }
    // Short bare affirmative (1-2 words) with low-confidence product match → don't treat as product
    if (norm.split(/\s+/).length <= 2 && products.every((p) => p.confidence < 0.8)) {
      // Fall through to UNKNOWN_INPUT — let LLM handle conversationally
      return [{ type: "UNKNOWN_INPUT", raw: message, confidence: 0.0 }]
    }
  }

  // ── Products mentioned ─────────────────────────────────────────────────────
  if (products.length > 0) {
    const addEvents: OrderEvent[] = products.map((p) => ({
      type: "ADD_ITEM" as const,
      productName: p.name,
      quantity: p.qty,
      confidence: p.confidence,
      ...(p.variant !== undefined ? { variantHint: p.variant } : {}),
    }))
    const secondary = detectSecondaryIntent(norm)
    if (secondary) {
      addEvents[0] = { ...addEvents[0], secondaryIntent: secondary } as OrderEvent
    }
    // Preserve fulfillment/payment signals from the same message (don't drop them)
    if (fulfillment !== null) {
      addEvents.push({
        type: "SET_FULFILLMENT",
        method: fulfillment.method,
        confidence: 1.0,
        ...(fulfillment.cep !== undefined ? { cep: fulfillment.cep } : {}),
      })
    }
    if (payment !== null) {
      addEvents.push({ type: "SET_PAYMENT", method: payment, confidence: 1.0 })
    }
    if (fulfillment !== null && payment !== null) {
      addEvents.push({ type: "CHECKOUT_START", confidence: 1.0 })
    }
    // Prepend GREETING to reset machine from stale states
    if (hasGreeting) addEvents.unshift({ type: "GREETING", confidence: 1.0 })
    return addEvents
  }

  // ── Variant-only selection (e.g., "1kg", "500g", "300ml") ─────────────────
  const VARIANT_ONLY_RE = /^(\d+(?:\.\d+)?)\s*(kg|g|ml)$/
  if (VARIANT_ONLY_RE.test(norm.trim())) {
    return [{
      type: "ADD_ITEM" as const,
      productName: "__last_pending__",
      quantity: 1,
      variantHint: norm.trim(),
      confidence: 1.0,
    }]
  }

  // ── Fulfillment + payment (no product) ────────────────────────────────────
  if (fulfillment !== null || payment !== null) {
    const events: OrderEvent[] = []
    if (fulfillment) {
      events.push({
        type: "SET_FULFILLMENT",
        method: fulfillment.method,
        confidence: 1.0,
        ...(fulfillment.cep ? { cep: fulfillment.cep } : {}),
      })
    }
    if (payment) {
      events.push({ type: "SET_PAYMENT", method: payment, confidence: 1.0 })
    }
    if (fulfillment && payment) {
      events.push({ type: "CHECKOUT_START", confidence: 1.0 })
    }
    return events
  }

  // ── Greeting ───────────────────────────────────────────────────────────────
  if (/\b(oi|ola|bom\s+dia|boa\s+tarde|boa\s+noite|eai|fala)\b/.test(norm)) {
    return [{ type: "GREETING", confidence: 1.0 }]
  }

  // ── Frozen / merch explicit requests ──────────────────────────────────────
  if (/\b(congelado|congelados|levar\s+pra\s+casa)\b/.test(norm)) {
    return [{ type: "ASK_MENU", subtype: "frozen" as const, confidence: 1.0 }]
  }
  if (/\b(bone|camiseta|loja|mercadoria|merch)\b/.test(norm)) {
    return [{ type: "ASK_MENU", subtype: "merch" as const, confidence: 1.0 }]
  }

  // ── Food category requests ─────────────────────────────────────────────────
  if (/\b(prato|pratos|porcao|porcoes)\b/.test(norm)) {
    return [{ type: "ASK_MENU", subtype: "food" as const, confidence: 1.0 }]
  }

  // ── Menu inquiry ───────────────────────────────────────────────────────────
  if (/\b(cardapio|menu|o\s+que\s+tem|lanche|lanches|sanduiche|sanduiches|opcao|opcoes)\b/.test(norm)) {
    return [{ type: "ASK_MENU", confidence: 1.0 }]
  }

  // ── Price inquiry ──────────────────────────────────────────────────────────
  if (/\b(quanto\s+custa|preco|valor)\b/.test(norm)) {
    const productName = findProductMention(message)
    if (productName !== null) {
      return [{ type: "ASK_PRICE", productName, confidence: 1.0 }]
    }
  }

  // ── View cart ──────────────────────────────────────────────────────────────
  if (/\b(carrinho|sacola|meu\s+pedido)\b/.test(norm)) {
    return [{ type: "VIEW_CART", confidence: 1.0 }]
  }

  // ── Remove item ────────────────────────────────────────────────────────────
  if (/\b(tirar|tira)\b/.test(norm) || /\bremov(er|e)\b/.test(norm)) {
    const productName = findProductMention(message)
    if (productName !== null) {
      return [{ type: "REMOVE_ITEM", productName, confidence: 1.0 }]
    }
  }

  // ── Clear cart ─────────────────────────────────────────────────────────────
  if (/\b(limpar|zerar|esvaziar)\b/.test(norm)) {
    return [{ type: "CLEAR_CART", confidence: 1.0 }]
  }

  // ── Apply coupon ───────────────────────────────────────────────────────────
  if (/\b(cupom|codigo|fiel)\b/.test(norm)) {
    const code = extractCouponCode(message)
    if (code !== null) {
      return [{ type: "APPLY_COUPON", code, confidence: 1.0 }]
    }
  }

  // ── Order status inquiry ───────────────────────────────────────────────────
  if (/\b(status|andamento|onde\s+esta|acompanhar)\b/.test(norm)) {
    return [{ type: "ASK_ORDER_STATUS", confidence: 1.0 }]
  }

  // ── Checkout start ─────────────────────────────────────────────────────────
  // "pagar" only triggers checkout when it's the dominant intent (not "quanto custa pra pagar entrega")
  if (/\b(finalizar|finalizado|fechar|fechado|fechamos|checkout)\b/.test(norm)) {
    return [{ type: "CHECKOUT_START", confidence: 1.0 }]
  }
  if (/\bpagar\b/.test(norm) && !(/\bquanto\b/.test(norm) || /\bcusta\b/.test(norm) || /\bpreco\b/.test(norm))) {
    return [{ type: "CHECKOUT_START", confidence: 1.0 }]
  }

  // (CONFIRM_ORDER logic moved above product matching to prevent Fuse.js false positives)

  // ── Cancel (item-aware) ──────────────────────────────────────────────────
  // If a product is mentioned with cancel intent, it's per-item cancel, not full order
  if (/\b(cancelar|cancela)\b/.test(norm)) {
    const productName = findProductMention(message)
    if (productName !== null) {
      return [{ type: "CANCEL_ITEM", productName, confidence: 1.0 }]
    }
    return [{ type: "CANCEL_ORDER", confidence: 1.0 }]
  }
  if (/\b(desistir)\b/.test(norm)) {
    return [{ type: "CANCEL_ORDER", confidence: 1.0 }]
  }

  // ── Reservation ────────────────────────────────────────────────────────────
  if (/\b(reserva|mesa|agendar)\b/.test(norm)) {
    return [{ type: "RESERVE_TABLE", confidence: 1.0 }]
  }

  // ── Loyalty ────────────────────────────────────────────────────────────────
  if (/\b(selos|fidelidade|pontos|recompensa)\b/.test(norm)) {
    return [{ type: "ASK_LOYALTY", confidence: 1.0 }]
  }

  // ── Reorder (expanded patterns) ──────────────────────────────────────────
  if (/\b(repetir|ultimo\s+pedido|de\s+novo|mesmo\s+pedido|mesmo\s+de\s+sempre|de\s+sempre|o\s+mesmo)\b/.test(norm)) {
    return [{ type: "ASK_REORDER", confidence: 1.0 }]
  }

  // ── Handoff to human ───────────────────────────────────────────────────────
  if (/\b(atendente|humano|reclamacao|problema|gerente)\b/.test(norm)) {
    return [{ type: "HANDOFF_HUMAN", confidence: 1.0 }]
  }

  // ── Hours inquiry ──────────────────────────────────────────────────────────
  if (/\b(horario|funcionamento|abre|fecha)\b/.test(norm)) {
    return [{ type: "ASK_HOURS", confidence: 1.0 }]
  }

  // ── Restaurant address inquiry (not delivery) ────────────────────────────
  if (/\bendereco\b/.test(norm) && /\b(restaurante|voces|ibatexas|retirada|localizacao|onde\s+fica)\b/.test(norm)) {
    return [{ type: "UNKNOWN_INPUT", raw: message, confidence: 0.0 }]
  }

  // ── Delivery / CEP inquiry ─────────────────────────────────────────────────
  if (/\b(entrega|cep)\b/.test(norm) || (/\bendereco\b/.test(norm) && /\b(entrega|entregar|meu|cep)\b/.test(norm))) {
    const cep = extractCep(message)
    return [{ type: "ASK_DELIVERY", confidence: 1.0, ...(cep !== null ? { cep } : {}) }]
  }

  // CEP alone (no delivery keyword) also triggers ASK_DELIVERY
  const standaloneCep = extractCep(message)
  if (standaloneCep !== null) {
    return [{ type: "ASK_DELIVERY", cep: standaloneCep, confidence: 1.0 }]
  }

  // ── Objection ──────────────────────────────────────────────────────────────
  if (/\b(caro|cara|barato|mais\s+em\s+conta|mais\s+acessivel|economico)\b/.test(norm)) {
    return [{ type: "OBJECTION", subtype: "expensive", confidence: 1.0 }]
  }
  if (/\b(pensar|vou\s+ver)\b/.test(norm)) {
    return [{ type: "OBJECTION", subtype: "thinking", confidence: 1.0 }]
  }
  // "depois" only triggers objection when it's the dominant intent — not when
  // mixed with an ordering clause like "quero costela, mas depois adiciono bebida"
  if (/\b(nao\s+sei)\b/.test(norm)) {
    // "nao sei qual/quanto/como/..." is a question, not hesitation
    if (/\bnao\s+sei\s+(qual|quanto|como|que|se|onde)\b/.test(norm)) {
      return [{ type: "UNKNOWN_INPUT", raw: message, confidence: 0.0 }]
    }
    // In checkout context, it's hesitation about paying
    if (historyInCheckout(history)) {
      return [{ type: "OBJECTION", subtype: "later", confidence: 0.8 }]
    }
    // Default: treat as indecision, not objection
    return [{ type: "UNKNOWN_INPUT", raw: message, confidence: 0.0 }]
  }
  if (/\bdepois\b/.test(norm) && !findProductMention(message)) {
    return [{ type: "OBJECTION", subtype: "later", confidence: 1.0 }]
  }

  // ── Fail-soft: food-related words but no product matched → show menu ─────
  if (FOOD_KEYWORDS_RE.test(norm)) {
    return [{ type: "ASK_MENU", confidence: 0.8 }]
  }

  // ── Short affirmative without checkout context → let LLM handle ──────────
  // "sim", "ok" etc. are ambiguous without checkout history.
  // The guarded CONFIRM_ORDER path (line ~596) already handles checkout context.
  // Bare affirmatives fall through to UNKNOWN_INPUT so the LLM can respond
  // conversationally instead of silently confirming a stale order.

  // ── Fallback ───────────────────────────────────────────────────────────────
  return [{ type: "UNKNOWN_INPUT", raw: message, confidence: 0.0 }]
}
