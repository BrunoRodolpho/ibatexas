// Validation layer for LLM output.
//
// Two-phase language commit: text is buffered when tools are available,
// then validated against forbidden patterns before being committed (streamed).
// When no tools are available, text streams live with zero TTFB penalty.

// ── Forbidden patterns per state ──────────────────────────────────────────────

// Phrases the LLM must NEVER emit before a tool result confirms the action.
// These are checked via regex against buffered text.
const POST_ORDER_FORBIDDEN: RegExp[] = [
  /pedido\s+cancelado/i,
  /cancelamento\s+confirmado/i,
  /pedido\s+alterado/i,
  /alteração\s+confirmada/i,
  /pedido\s+registrado/i,
  /pedido\s+confirmado/i,
  /pedido\s+finalizado/i,
  /pedido\s+encaminhado/i,
  /pedido\s+enviado/i,
]

const ORDERING_FORBIDDEN: RegExp[] = [
  /pedido\s+registrado/i,
  /pedido\s+confirmado/i,
  /pedido\s+finalizado/i,
  /pedido\s+encaminhado/i,
  /confirma[çc][ãa]o\s+em\s+instantes/i,
]

// Phrases that imply processing/confirmation BEFORE the checkout tool ran
const CHECKOUT_FORBIDDEN: RegExp[] = [
  /vou\s+encaminhar/i,
  /sistema\s+processa/i,
  /processando/i,
  /estou\s+finalizando/i,
  /estou\s+processando/i,
  /pedido\s+registrado/i,
  /pedido\s+confirmado/i,
  /pedido\s+finalizado/i,
  /pedido\s+encaminhado/i,
  /pedido\s+enviado/i,
  /j[aá]\s+est[aá]\s+sendo\s+preparado/i,
  /j[aá]\s+encaminhei/i,
]

// States where tools are available and text must be buffered
const BUFFERED_STATES = new Set([
  "post_order",
  "reorder",
])

// States where text must be checked against forbidden patterns (even without buffering)
const _CHECKED_STATES = new Set([
  "ordering.awaiting_next",
  "ordering.item_unavailable",
  "ordering.validating_item",
  "checkout.confirming",
  "checkout.selecting_slots",
  "checkout.checking_auth",
])

/**
 * Determine if text should be buffered (not streamed live) for this state.
 * Buffer when the state has tools that can modify order state.
 */
export function shouldBufferText(stateValue: string, hasTools: boolean): boolean {
  if (!hasTools) return false
  for (const prefix of BUFFERED_STATES) {
    if (stateValue === prefix || stateValue.startsWith(prefix + ".")) return true
  }
  return false
}

/**
 * Check if text contains forbidden patterns for the current state.
 * Returns the first violation found, or null if text is clean.
 */
export function checkForbiddenPhrases(
  text: string,
  stateValue: string,
): { pattern: string; match: string } | null {
  for (const re of getPatternsForState(stateValue)) {
    const match = text.match(re)
    if (match) {
      return { pattern: re.source, match: match[0] }
    }
  }

  return null
}

/**
 * Validate buffered text before committing to the consumer.
 * Returns cleaned text (with violations removed) and a list of violations.
 */
export function validateBufferedText(
  text: string,
  stateValue: string,
): { cleanText: string; violations: Array<{ pattern: string; match: string }> } {
  const violations: Array<{ pattern: string; match: string }> = []
  let cleanText = text

  for (const re of getPatternsForState(stateValue)) {
    const match = cleanText.match(re)
    if (match) {
      violations.push({ pattern: re.source, match: match[0] })
      // Remove the violation from text
      cleanText = cleanText.replace(re, "").replace(/\s{2,}/g, " ").trim()
    }
  }

  return { cleanText, violations }
}

// ── Internal ──────────────────────────────────────────────────────────────────

function getPatternsForState(stateValue: string): RegExp[] {
  if (stateValue === "post_order" || stateValue.startsWith("post_order.")) {
    return POST_ORDER_FORBIDDEN
  }
  if (stateValue.startsWith("checkout.")) {
    return CHECKOUT_FORBIDDEN
  }
  if (stateValue.startsWith("ordering.")) {
    return ORDERING_FORBIDDEN
  }
  return []
}
