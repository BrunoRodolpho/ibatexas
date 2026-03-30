// Prompt synthesizer for the IbateXas Hybrid State-Flow architecture.
//
// Maps an XState machine state value + OrderContext → a tiny, targeted
// SynthesizedPrompt that is given to the LLM for that single turn.
//
// Design principle: the LLM only sees instructions relevant to the current
// state. Smaller prompts = fewer hallucinations, lower latency, lower cost.

import type { RestaurantSchedule } from "@ibatexas/types"
import type { OrderContext, SynthesizedPrompt } from "./machine/types.js"
import { getCurrentMealPeriod } from "./machine/types.js"
import {
  BASE_VOICE_WHATSAPP,
  BASE_VOICE_WEB,
  getCurrentMenu,
} from "./prompt-sections.js"
import { getTimeStr, getFrozenPickupMessage } from "@ibatexas/tools"

// ── Token limits ──────────────────────────────────────────────────────────────

const DEFAULT_WHATSAPP_TOKENS = 512
const MAX_TOKENS_WEB = 1024

// States that need more tokens (order summaries, confirmations, zone lists)
const WHATSAPP_TOKEN_LIMITS: Record<string, number> = {
  "post_order": 768,
  "ordering.awaiting_next": 768,
  "ordering.item_added": 640,
  "checkout.confirming": 768,
  "checkout.order_placed": 768,
  "reorder": 300,
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Converts an integer in centavos to a Brazilian Real string.
 * Example: 8900 → "R$89,00"
 */
export function centavosToReais(centavos: number): string {
  const reais = centavos / 100
  return `R$${reais.toFixed(2).replace(".", ",")}`
}

/**
 * Formats the cart items into a human-readable list with individual prices
 * and a running total line at the end.
 */
export function formatCartSummary(
  items: OrderContext["items"],
  totalInCentavos: number,
): string {
  if (items.length === 0) return "Carrinho vazio."

  const lines = items.map(
    (item) =>
      `• ${item.quantity}x ${item.name} — ${centavosToReais(item.priceInCentavos * item.quantity)}`,
  )
  lines.push(`Total: ${centavosToReais(totalInCentavos)}`)
  return lines.join("\n")
}

/**
 * Returns a sentence listing the slots the customer still needs to fill
 * (fulfillment method and/or payment method). Returns an empty string when
 * all slots are already set.
 */
export function formatMissingSlots(ctx: OrderContext): string {
  const missing: string[] = []
  if (ctx.fulfillment === null) missing.push("forma de entrega (entrega ou retirada)")
  if (ctx.paymentMethod === null) missing.push("forma de pagamento (PIX, cartão ou dinheiro)")
  if (missing.length === 0) return ""
  return `Falta confirmar: ${missing.join(" e ")}.`
}

// ── State → tools map ─────────────────────────────────────────────────────────

// Keys are exact state values or glob-style prefixes ending in ".*".
// Lookup happens in declaration order; first match wins.

const STATE_TOOLS: Array<[pattern: string, tools: string[]]> = [
  ["idle", ["get_customer_profile", "search_products"]],
  ["first_contact", ["get_customer_profile", "search_products"]],
  ["browsing", ["search_products", "get_product_details", "check_inventory", "get_nutritional_info", "estimate_delivery"]],
  ["ordering.", ["search_products", "get_also_added", "get_ordered_together"]],
  ["checkout.", []],
  ["post_order", ["get_loyalty_balance", "submit_review", "check_order_status", "cancel_order", "amend_order", "regenerate_pix", "search_products"]],
  ["reservation", ["check_table_availability", "create_reservation", "modify_reservation", "cancel_reservation", "get_my_reservations", "join_waitlist"]],
  ["support", ["handoff_to_human"]],
  ["loyalty_check", ["get_loyalty_balance"]],
  ["reorder", ["get_order_history", "search_products", "get_or_create_cart", "add_to_cart"]],
  ["objection", ["schedule_follow_up"]],
  ["fallback", ["search_products", "get_customer_profile", "estimate_delivery"]],
]

function resolveTools(stateValue: string, ctx?: OrderContext): string[] {
  for (const [pattern, tools] of STATE_TOOLS) {
    if (pattern.endsWith(".")) {
      // prefix match — e.g. "ordering." matches "ordering.item_added"
      if (stateValue.startsWith(pattern) || stateValue === pattern.slice(0, -1)) {
        // When closed + item_unavailable: remove search tools to prevent LLM
        // from bypassing the machine's frozen-only search filter.
        if (stateValue === "ordering.item_unavailable" && ctx?.mealPeriod === "closed") {
          return tools.filter((t) => t !== "search_products")
        }
        return tools
      }
    } else {
      if (stateValue === pattern) return tools
    }
  }
  // Unknown state — return an empty tool list (safe default)
  return []
}

// ── Order confirmation formatter ──────────────────────────────────────────────

/**
 * Build a structured order confirmation prompt with:
 * - Order ID
 * - Per-item prep times
 * - PIX/card/cash payment details
 * - Estimated pickup/delivery time with closing-time guard
 * - Loyalty stamps
 * - Post-order actions (status, cancel, amend)
 */
function formatOrderConfirmation(ctx: OrderContext): string {
  const stamps = ctx.loyaltyStamps ?? 0
  const phone = process.env.RESTAURANT_PHONE || null
  const contactInfo = phone ? `Telefone: ${phone}` : "Site: ibatexas.com.br"
  const fulfillmentLabel = ctx.fulfillment === "pickup"
    ? "Retirada no restaurante"
    : `Entrega${ctx.deliveryCep ? ` — CEP ${ctx.deliveryCep}` : ""}`

  // Extract structured fields from checkoutResult
  const cr = ctx.checkoutResult as Record<string, unknown> | null
  const orderId = ctx.orderId ?? (cr?.orderId as string | undefined) ?? null
  const pixQrCodeUrl = cr?.pixQrCodeUrl as string | undefined
  const pixQrCodeText = cr?.pixQrCodeText as string | undefined

  // Per-item prep time breakdown
  const itemLines = ctx.items.map((item) => {
    const prep = item.preparationTimeMinutes
    const prepLabel = prep && prep > 0 ? ` (~${prep}min preparo)` : " (pronto)"
    return `• ${item.quantity}x ${item.name} — ${centavosToReais(item.priceInCentavos * item.quantity)}${prepLabel}`
  })

  // Overall ETA = max(all item prep times) + fulfillment buffer
  const maxPrepMinutes = Math.max(0, ...ctx.items.map((i) => i.preparationTimeMinutes ?? 0))
  const bufferMinutes = ctx.fulfillment === "delivery" ? (ctx.deliveryEtaMinutes ?? 40) : 5
  const totalEstimateMinutes = maxPrepMinutes + bufferMinutes

  // Closing time guard — uses Intl for correct timezone
  const tz = process.env.RESTAURANT_TIMEZONE || "America/Sao_Paulo"
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date())
  let currentHour = 0, currentMinute = 0
  for (const p of parts) {
    if (p.type === "hour") currentHour = Number.parseInt(p.value, 10)
    if (p.type === "minute") currentMinute = Number.parseInt(p.value, 10)
  }
  if (currentHour === 24) currentHour = 0

  // Determine closing hour from schedule or env vars
  let closingHour: number
  if (_currentSchedule) {
    const dayStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date())
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    const dow = dayMap[dayStr] ?? new Date().getDay()
    const day = _currentSchedule.days.find((d) => d.dayOfWeek === dow)
    if (ctx.mealPeriod === "lunch" && day?.lunchEnd) {
      closingHour = Number.parseInt(day.lunchEnd.split(":")[0]!, 10)
    } else if (day?.dinnerEnd) {
      closingHour = Number.parseInt(day.dinnerEnd.split(":")[0]!, 10)
    } else {
      closingHour = 23
    }
  } else {
    closingHour = ctx.mealPeriod === "lunch"
      ? Number.parseInt(process.env.RESTAURANT_LUNCH_END_HOUR || "15", 10)
      : Number.parseInt(process.env.RESTAURANT_DINNER_END_HOUR || "23", 10)
  }

  const pickupMinuteOfDay = currentHour * 60 + currentMinute + totalEstimateMinutes
  const closingMinuteOfDay = closingHour * 60
  const closingWarning = pickupMinuteOfDay > closingMinuteOfDay
    ? `\nATENÇÃO: horário de preparo pode ultrapassar o fechamento (${closingHour}h). Informe o cliente.`
    : ""

  let prompt = ctx.customerName
    ? `Pedido de ${ctx.customerName} confirmado!\n`
    : "Boa escolha! Pedido confirmado!\n"
  if (orderId) prompt += `Número do pedido: #${orderId}\n`
  prompt += `\nItens:\n${itemLines.join("\n")}\n`
  prompt += `Total: ${centavosToReais(ctx.totalInCentavos)}\n`

  // Payment details
  if (ctx.paymentMethod === "pix") {
    if (pixQrCodeText) {
      prompt += `\nPIX copia-e-cola:\n${pixQrCodeText}\n`
      prompt += "OBRIGATÓRIO: inclua o código PIX copia-e-cola COMPLETO na mensagem — o cliente precisa dele para pagar. Copie exatamente como está acima.\n"
    }
    if (pixQrCodeUrl) prompt += `QR Code: ${pixQrCodeUrl}\n`
    if (!pixQrCodeText && !pixQrCodeUrl) prompt += "\nERRO: código PIX não foi gerado. Informe ao cliente que houve um problema técnico e peça para tentar novamente. NUNCA diga que o PIX será enviado depois — ele deve aparecer AGORA ou o pedido falhou.\n"
    prompt += "Pagamento confirmado automaticamente.\n"
  } else if (ctx.paymentMethod === "card") {
    prompt += "\nPagamento via cartão confirmado.\n"
  } else {
    prompt += `\nPagamento em dinheiro na ${fulfillmentLabel.toLowerCase()}.\n`
  }

  // Fulfillment + ETA (frozen after-hours → next-day pickup instead of meaningless ETA)
  prompt += `\n${fulfillmentLabel}.\n`
  const isFrozenAfterHours = ctx.mealPeriod === "closed" && _currentSchedule
  if (isFrozenAfterHours) {
    prompt += getFrozenPickupMessage(_currentSchedule!, tz) + "\n"
  } else {
    prompt += `Tempo estimado: ~${totalEstimateMinutes} minutos.\n`
    prompt += closingWarning
  }

  // Contact info first, loyalty as cherry-on-top bonus
  prompt += `\n${contactInfo}\n`
  prompt += `Ah, e mais um selo — ${stamps}/10.\n`

  // LLM instructions
  if (ctx.paymentMethod === "pix") {
    prompt += "\nNUNCA diga 'Bom apetite' — o pagamento PIX ainda não foi confirmado. Diga que o pedido será confirmado automaticamente assim que o PIX for pago."
  }
  prompt += "\nApresente TODAS essas informações ao cliente de forma organizada."
  prompt += "\n\nAções disponíveis — use as FERRAMENTAS, não responda \"acesse o site\":\n- Status: use check_order_status (mostra tempo RESTANTE real)\n- Cancelar: use cancel_order (verifica prazo automaticamente — se passou do prazo, diga \"já começamos a preparar seu pedido, não é possível cancelar\")\n- Adicionar item: use search_products + amend_order\n- Fidelidade: use get_loyalty_balance\n- Trocar pagamento: use amend_order com action \"change_payment\" e paymentMethod (\"pix\", \"card\", \"cash\")\n- Novo PIX: use regenerate_pix (gera novo QR quando o anterior expirou)\nSempre mostre o resumo completo do pedido após qualquer alteração."
  if (orderId) {
    prompt += `\nSe o cliente disser "novo pix", "mandar pix de novo", ou pedir novo código: use regenerate_pix com o orderId "${orderId}".`
  }

  return prompt
}

// ── Module-scoped schedule for current synthesize pass ───────────────────────

// Set by synthesizePrompt() before evaluating templates. This avoids threading
// schedule through every template function signature.
let _currentSchedule: RestaurantSchedule | undefined

// ── State → prompt template map ───────────────────────────────────────────────

// Each entry is a function that receives the full OrderContext and returns the
// state-specific instruction block. These are combined with the base voice in
// synthesizePrompt().

type PromptTemplate = (ctx: OrderContext) => string

const STATE_PROMPTS: Record<string, PromptTemplate> = {
  idle: (ctx) => {
    if (ctx.lastAction === "cancelled") {
      return "Pedido cancelado e carrinho esvaziado. Confirme ao cliente que o pedido foi cancelado. Pergunte se deseja mais algo."
    }
    if (ctx.mealPeriod === "closed") {
      return "Cliente iniciando conversa. Restaurante fechado neste horário. Cumprimente de forma amigável e informe: almoço das 11h às 15h, jantar das 18h às 23h. Se perguntar, congelados disponíveis para encomenda e retirada. NUNCA aceite pedidos de comida fresca para outro horário — o sistema NÃO suporta agendamento. Diga que pode ajudar no próximo horário aberto."
    }
    if (!ctx.isNewCustomer) {
      const nameGreeting = ctx.customerName ? ` Nome do cliente: ${ctx.customerName}.` : ""
      return `Cliente RECORRENTE.${nameGreeting} Cumprimente pelo nome se disponível. 'E aí, vai querer o de sempre?' Pergunte como pode ajudar. NÃO re-ofereça promoção de boas-vindas.`
    }
    return "Cliente iniciando conversa. Cumprimente e pergunte como pode ajudar."
  },

  first_contact: (ctx) => {
    const period = ctx.mealPeriod === "lunch" ? "almoço"
      : ctx.mealPeriod === "dinner" ? "jantar" : null
    const timeCtx = period ? ` Estamos no ${period}.` : ""
    return `Cliente NOVO (nunca pediu).${timeCtx} Cumprimente com entusiasmo e pergunte o que está com vontade de comer. NÃO mencione crédito, descontos ou promoções — capture a intenção primeiro.`
  },

  browsing: (ctx) => {
    const period = ctx.mealPeriod === "lunch" ? "ALMOÇO (11h-15h)"
      : ctx.mealPeriod === "dinner" ? "JANTAR (18h-23h)"
      : "FECHADO"
    const menu = getCurrentMenu(_currentSchedule)
    if (ctx.mealPeriod === "closed") {
      return `Período ATUAL: ${period}.\n${menu}\nSe o cliente quiser ver congelados, apresente as opções. Caso contrário, informe os horários de funcionamento.`
    }
    return `Período ATUAL: ${period}.\n${menu}\nIMPORTANTE: APENAS itens listados acima estão disponíveis AGORA. Não sugira itens de outros períodos.\nAo apresentar itens, lidere com experiência, não preço. Ex: "Nossa costela leva mais de 10h de defumação" antes de "R$89".\nSe o cliente parecer indeciso (respostas vagas, "não sei", silêncio): ofereça atalho — "Se quiser, te indico os mais pedidos — facilita bastante"\nAjude o cliente a escolher.`
  },

  "ordering.validating_item": (ctx) => {
    const product = ctx.pendingProduct ?? "um produto"
    let base: string
    if (ctx.mealPeriod === "closed") {
      base = `Cliente quer ${product}. Restaurante FECHADO — somente CONGELADOS disponíveis (Costela R$72/R$135, Pulled Pork R$42, Molho BBQ R$24). Se "${product}" não for um congelado, informe que não está disponível agora e apresente os congelados. NUNCA aceite encomenda de comida fresca para outro horário — o sistema NÃO suporta agendamento de pratos frescos.`
    } else {
      base = `Cliente quer ${product}. Apresente opções/variantes disponíveis.`
    }
    if (ctx.lastSearchResult !== null) {
      return `${base}\nResultado da busca: ${JSON.stringify(ctx.lastSearchResult)}`
    }
    return base
  },

  "ordering.item_unavailable": (ctx) => {
    const product = ctx.pendingProduct ?? "este produto"
    const reason = ctx.lastError ?? "não disponível no momento"
    const altList =
      ctx.alternatives.length > 0
        ? ctx.alternatives.join(", ")
        : "nenhuma alternativa encontrada"
    const menu = getCurrentMenu(_currentSchedule)

    let prompt: string
    if (ctx.mealPeriod === "closed") {
      prompt = `Cliente pediu ${product} mas o restaurante está FECHADO agora. Comida fresca só no almoço (11h-15h) ou jantar (18h-23h). Somente CONGELADOS disponíveis para encomenda e retirada.\n${menu}\nNUNCA aceite encomenda de comida fresca (${product}) para outro horário — o sistema NÃO suporta agendamento de pratos frescos. NUNCA diga "posso encomendar pra amanhã" para itens que não são congelados.\nSe o cliente quiser, apresente os congelados. Caso contrário, informe os horários e diga que pode ajudar com ${product} no próximo período aberto.`
    } else {
      prompt = `Cliente pediu ${product} mas NÃO disponível agora. ${reason}. Alternativas: ${altList}.\n${menu}\nExplique a janela e sugira. Varie a forma de recomendar — não repita 'carro-chefe', 'especialidade', ou 'mais pedido' em turnos consecutivos.`
    }

    const filledSlots: string[] = []
    if (ctx.fulfillment !== null) filledSlots.push(`entrega: ${ctx.fulfillment}`)
    if (ctx.paymentMethod !== null) filledSlots.push(`pagamento: ${ctx.paymentMethod}`)
    if (filledSlots.length > 0) {
      prompt += ` Cliente já informou ${filledSlots.join(" e ")} — guarde esses dados.`
    }

    // Hard anti-hallucination guard: cart is empty, no order exists
    if (ctx.items.length === 0) {
      prompt += `\nATENÇÃO: o carrinho está VAZIO — nenhum item foi adicionado com sucesso. NUNCA diga "pedido registrado", "pedido encaminhado", "confirmação em instantes" ou qualquer variação. O pedido NÃO existe ainda.`
    }

    return prompt
  },

  "ordering.item_added": (ctx) => {
    // If lastSearchResult has multiple variants and cart didn't change, present options
    if (ctx.lastSearchResult && Array.isArray(ctx.lastSearchResult) && (ctx.lastSearchResult as unknown[]).length > 1 && ctx.pendingProduct) {
      const variants = ctx.lastSearchResult as Array<{ name: string; priceInCentavos: number }>
      const variantList = variants.map((v) => `${v.name} — ${centavosToReais(v.priceInCentavos)}`).join("\n")
      let variantPrompt = `Cliente quer ${ctx.pendingProduct}. Variantes disponíveis:\n${variantList}\n`
      // Confidence-aware variant suggestion
      if (!ctx.isNewCustomer) {
        variantPrompt += "Cliente já pediu antes — assuma a variante do pedido anterior com confiança. Ex: 'Costela 500g igual da última vez — mando?'"
      } else {
        variantPrompt += "Cliente novo — sugira a variante mais popular com tom médio. Ex: 'Vou com a 500g (a mais pedida), ok?'"
      }
      return variantPrompt
    }
    let prompt = `${formatCartSummary(ctx.items, ctx.totalInCentavos)}`
    // PRIMARY credit reveal: after first item, new customer
    if (ctx.isNewCustomer && ctx.items.length === 1) {
      prompt += `\nCliente NOVO acabou de adicionar o primeiro item. Diga: "Ah, e como é seu primeiro pedido, você tem R$15 de desconto de boas-vindas pra usar agora! Dá pra incluir um acompanhamento ou bebida praticamente por conta disso — quer que eu sugira?"`
    }
    // Surface any upsell hints if the machine has populated alternatives
    if (ctx.alternatives.length > 0) {
      prompt += `\nSugestões como complemento: ${ctx.alternatives.join(", ")}. Frame: "Combina demais com..." ou "Quem pede X geralmente leva..."`
    }
    // Inline upsell: suggest complementary item when conditions are met
    if (!ctx.isCombo && ctx.upsellRound < 2 && ctx.hasMainDish && (!ctx.hasSide || !ctx.hasDrink)) {
      const meatNames = ctx.items
        .filter((i) => i.category === "meat" || i.category === "sandwich")
        .map((i) => i.name)
        .join(", ")
      const suggestions: string[] = []
      if (!ctx.hasSide) suggestions.push("Farofa(R$16)", "Mandioca Frita(R$18)")
      if (!ctx.hasDrink) suggestions.push("Refri(R$8)", "Limonada(R$14)")
      if (ctx.mealPeriod === "lunch" && ctx.totalInCentavos > 8000) suggestions.push("Brownie(R$22)")
      if (suggestions.length > 0) {
        prompt += `\nSugira UM acompanhamento complementar na mesma mensagem — "Combina demais com..." ou "Quem pede ${meatNames || "isso"} geralmente leva...": ${suggestions.join(", ")}. Máximo 1 sugestão. Se recusar, siga em frente.`
      }
    }
    // Tone modifiers from secondary intent
    if (ctx.secondaryIntent?.subtype === "price_sensitive") {
      prompt += "\nCliente mencionou preço — inclua uma alternativa mais em conta na resposta."
    }
    if (ctx.secondaryIntent?.type === "CONDITIONAL") {
      prompt += "\nCliente está em dúvida — apresente com opção de correção fácil."
    }
    return prompt
  },

  "ordering.awaiting_next": (ctx) => {
    const summary = formatCartSummary(ctx.items, ctx.totalInCentavos)
    const creditLine = ctx.isNewCustomer && !ctx.couponApplied ? "Lembre o cliente: R$15 de desconto de boas-vindas será aplicado ao finalizar. NÃO subtraia do total mostrado — o sistema aplica automaticamente no checkout." : ""

    // Upsell: suggest complementary item when main dish + no side/drink
    let upsellLine = ""
    if (!ctx.isCombo && ctx.upsellRound < 2 && ctx.hasMainDish && (!ctx.hasSide || !ctx.hasDrink)) {
      const meatNames = ctx.items
        .filter((i) => i.category === "meat" || i.category === "sandwich")
        .map((i) => i.name)
        .join(", ")
      const suggestions: string[] = []
      if (!ctx.hasSide) suggestions.push("Farofa(R$16)", "Mandioca Frita(R$18)")
      if (!ctx.hasDrink) suggestions.push("Refri(R$8)", "Limonada(R$14)")
      if (ctx.mealPeriod === "lunch" && ctx.totalInCentavos > 8000) suggestions.push("Brownie(R$22)")
      if (suggestions.length > 0) {
        upsellLine = `Sugira UM complemento na mesma mensagem — "Combina demais com..." ou "Quem pede ${meatNames || "isso"} geralmente leva...": ${suggestions.join(", ")}. Máximo 1 sugestão. Se recusar, siga em frente.`
      }
    }

    // CONVERSION OPTIMIZATION: if only fulfillment + payment missing, ask both in one shot
    if (ctx.fulfillment === null && ctx.paymentMethod === null && ctx.items.length > 0) {
      return [
        summary,
        creditLine,
        upsellLine,
        "Pergunte entrega/retirada E forma de pagamento NA MESMA mensagem. Ex: 'Entrega ou retirada? E como quer pagar — PIX, cartão ou dinheiro?' Isso reduz etapas pro cliente.",
      ].filter(Boolean).join("\n")
    }

    const missing = formatMissingSlots(ctx)
    if (missing) {
      return [summary, creditLine, upsellLine, `OBRIGATÓRIO antes de fechar: ${missing} Pergunte sobre o que falta PRIMEIRO. Só depois pergunte se quer adicionar mais algo.`].filter(Boolean).join("\n")
    }
    const instruction = "Sempre MOSTRE o resumo do carrinho ao cliente. Pergunte de forma natural: 'Quer mais alguma coisa ou fechamos?'"
    return [summary, creditLine, upsellLine, instruction].filter(Boolean).join("\n")
  },

  "checkout.awaiting_login": (ctx) => {
    const summary = formatCartSummary(ctx.items, ctx.totalInCentavos)
    return `[BLOQUEIO: LOGIN OBRIGATÓRIO] Cliente quer pagar mas NÃO está logado.\n${summary}\nReconheça o pedido com entusiasmo. DEPOIS explique que para PIX/cartão precisa estar identificado. Link: ibatexas.com.br/entrar`
  },

  "checkout.selecting_slots": (ctx) => {
    const summary = formatCartSummary(ctx.items, ctx.totalInCentavos)
    const missing: string[] = []
    if (!ctx.customerName) missing.push("nome pra quem é o pedido")
    if (!ctx.fulfillment) missing.push("entrega ou retirada")
    if (!ctx.paymentMethod) missing.push("forma de pagamento (PIX, cartão ou dinheiro)")
    return `${summary}\nPergunte: ${missing.join(" e ")} — tudo na MESMA mensagem, de forma natural.
Exemplo: "Entrega ou retirada? E como quer pagar — PIX, cartão ou dinheiro?"
Se o cliente já informou um dos dois, pergunte só o que falta.`
  },

  "checkout.offer_pickup": (ctx) => {
    const summary = formatCartSummary(ctx.items, ctx.totalInCentavos)
    const addr = process.env.RESTAURANT_ADDRESS || process.env.NEXT_PUBLIC_ADDRESS || ""
    const addrLine = addr ? ` Endereço para retirada: ${addr}.` : ""
    return `${summary}\nEndereço fora da área de entrega. Informe e sugira retirada.${addrLine}`
  },

  "checkout.confirming": (ctx) => {
    const summary = formatCartSummary(ctx.items, ctx.totalInCentavos)
    const fulfillmentLabel =
      ctx.fulfillment === "pickup" ? "Retirada no restaurante" : `Entrega${ctx.deliveryCep ? ` — CEP ${ctx.deliveryCep}` : ""}`
    const paymentLabel =
      ctx.paymentMethod === "pix"
        ? "PIX"
        : ctx.paymentMethod === "card"
          ? "Cartão"
          : "Dinheiro"
    const feeLine =
      ctx.fulfillment === "delivery" && ctx.deliveryFeeInCentavos !== null
        ? `\nTaxa de entrega: ${centavosToReais(ctx.deliveryFeeInCentavos)}`
        : ""
    const tipLine = ctx.tipInCentavos > 0 ? `\nGorjeta: ${centavosToReais(ctx.tipInCentavos)}` : ""

    // Checkout failed on previous attempt — surface the error
    if (ctx.lastError) {
      return `ERRO ao processar o pedido: ${ctx.lastError}\nInforme que houve um problema técnico e pergunte se quer tentar novamente.\n${summary}${feeLine}${tipLine}\nEntrega: ${fulfillmentLabel}\nPagamento: ${paymentLabel}`
    }

    return `${summary}${feeLine}${tipLine}\nEntrega: ${fulfillmentLabel}\nPagamento: ${paymentLabel}\nSe o cliente acabou de voltar (cumprimentou ou parece estar retomando), diga algo como "Oi de novo! Seu pedido tá aqui:" antes do resumo.\nOBRIGATÓRIO: SEMPRE inclua o total na mensagem para o cliente confirmar o valor antes de prosseguir.\nPergunte: 'Confirma o pedido?'\nNUNCA gere número de pedido, código PIX ou confirmação nesta etapa. O pedido AINDA NÃO foi enviado ao sistema.`
  },

  "checkout.order_placed": (ctx) => {
    // Transient state — usually transitions to post_order via LOYALTY_LOADED immediately.
    // This prompt is rendered if the LLM is called before loyalty fetch completes.
    const cr = ctx.checkoutResult as Record<string, unknown> | null
    const hasPixData = !!(cr?.pixQrCodeText || cr?.pixQrCodeUrl)
    if (!ctx.orderId && !cr?.orderId && !hasPixData) {
      return "ERRO INTERNO: dados do pedido não disponíveis. Informe ao cliente que houve um problema técnico e peça para tentar novamente."
    }
    return formatOrderConfirmation(ctx)
  },

  post_order: (ctx) => {
    // Guard: no order data means checkout never completed
    const cr = ctx.checkoutResult as Record<string, unknown> | null
    if (!ctx.orderId && !cr?.orderId) {
      return "Nenhum pedido foi finalizado ainda. Pergunte se o cliente deseja continuar."
    }

    // Pending product amendment (customer asked to add item post-order)
    if (ctx.pendingProduct) {
      const orderRef = ctx.orderId ? `#${ctx.orderId}` : ""
      const summary = formatCartSummary(ctx.items, ctx.totalInCentavos)
      const fulfillmentLabel = ctx.fulfillment === "pickup"
        ? "Retirada no restaurante"
        : `Entrega${ctx.deliveryCep ? ` — CEP ${ctx.deliveryCep}` : ""}`
      return `Pedido ${orderRef} confirmado.\n${summary}\n${fulfillmentLabel}\n\nCliente quer adicionar "${ctx.pendingProduct}". Use search_products para encontrar, depois amend_order com action "add" e o orderId "${ctx.orderId}". NÃO inicie pedido novo.`
    }

    // Full confirmation with explicit tool instructions (formatOrderConfirmation
    // now includes tool usage directives — works for both first display and subsequent turns)
    return formatOrderConfirmation(ctx)
  },

  reservation: () =>
    "Fluxo de reserva. Pergunte data, horário e nº de pessoas.",

  support: () =>
    "Conectando com atendente. Informe que alguém vai entrar em contato.",

  loyalty_check: (ctx) => {
    const stamps = ctx.loyaltyStamps ?? 0
    const base = `Cliente tem ${stamps}/10 selos.`
    if (stamps >= 10) {
      return `${base} Parabéns! Código FIEL20!`
    }
    return base
  },

  reorder: () =>
    `Cliente quer repetir um pedido anterior.
1. Use get_order_history para ver os últimos pedidos.
2. Apresente o pedido mais recente como sugestão: "Costela 500g + Farofa, entrega no 14815-000, PIX — igual da última vez?"
3. Se o cliente confirmar, recrie o carrinho com os mesmos itens usando get_or_create_cart + add_to_cart.
4. Se o cliente quiser mudar algo, ajude normalmente.
Preencha fulfillment e payment do perfil do cliente se disponíveis.`,

  objection: (ctx) => {
    switch (ctx.lastObjectionSubtype) {
      case "expensive":
        return "Cliente achou caro. Reframe valor, NÃO preço: destaque a defumação artesanal e o diferencial. Sugira porções menores ('500g serve 2 pessoas — menos de R$45 por pessoa') ou combos ('Combo Brisket já vem completo — R$68'). NÃO ofereça desconto. NÃO diga 'Sem pressa!'."
      case "thinking":
        return "Cliente vai pensar. 'Tranquilo! Carrinho salvo 24h — qualquer dúvida é só mandar.' NÃO use 'Sem pressa!' (clichê). NÃO empurre nada. Confirme que o carrinho está salvo e deixe a porta aberta."
      case "later":
        return "Cliente quer deixar pra depois. Confirme que o carrinho está salvo e que pode retomar a qualquer momento. Não pressione."
      default:
        return "Cliente expressou uma objeção. Ouça e responda de forma empática. Não pressione — ofereça alternativa ou deixe a porta aberta."
    }
  },

  fallback: (ctx) => {
    const period = ctx.mealPeriod === "lunch" ? "ALMOÇO (11h-15h)"
      : ctx.mealPeriod === "dinner" ? "JANTAR (18h-23h)"
      : "FECHADO"
    const menu = getCurrentMenu(_currentSchedule)
    const constraint = "NUNCA gere número de pedido, total, confirmação de pedido, ou forma de entrega/pagamento. O fluxo de pedido é controlado pelo sistema — você NÃO pode confirmar pedidos."
    if (ctx.mealPeriod === "closed") {
      return `${constraint}\nNão entendi a intenção. Pergunte de forma amigável como pode ajudar.\nPeríodo ATUAL: ${period}.\n${menu}\nNÃO sugira congelados a menos que o cliente peça.`
    }
    return `${constraint}\nNão entendi a intenção. Pergunte de forma amigável como pode ajudar.\nPeríodo ATUAL: ${period}.\n${menu}`
  },
}

// ── Momentum modifier ─────────────────────────────────────────────────────────

/**
 * Appends momentum-aware tone modifiers to the state block.
 * - high: push next step, suggest checkout
 * - cooling: reduce pressure, suggest alternatives
 * - lost: re-anchor with strong suggestion or save cart
 */
function applyMomentumModifier(stateBlock: string, momentum: OrderContext["momentum"]): string {
  switch (momentum) {
    case "cooling":
      return stateBlock + "\n[TOM: Cliente hesitante — reduza pressão. Sem urgência. Ofereça alternativa leve: 'Sem pressa — se quiser ir no mais simples, o combo resolve bem.']"
    case "lost":
      return stateBlock + "\n[TOM: Cliente perdeu interesse — re-ancore. Sugira fechar com o que tem ou salvar carrinho: 'Posso guardar seu carrinho pra depois — só mandar mensagem que retomamos.']"
    default:
      return stateBlock
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Assembles a minimal, state-targeted system prompt for a single LLM turn.
 *
 * @param stateValue - The current XState machine state value (e.g. "ordering.item_added")
 * @param context    - The full OrderContext snapshot from the machine
 * @param channel    - Delivery channel, controls base voice and maxTokens
 * @returns          A SynthesizedPrompt ready to pass directly to the LLM call
 */
export function synthesizePrompt(
  stateValue: string,
  context: OrderContext,
  channel: "whatsapp" | "web",
  schedule?: RestaurantSchedule,
): SynthesizedPrompt {
  // Make schedule available to template functions via module scope
  _currentSchedule = schedule

  // 0. Sync mealPeriod — context snapshot may be stale from Redis
  const freshContext: OrderContext = { ...context, mealPeriod: getCurrentMealPeriod(schedule) }

  // 0b. Current time so the LLM can answer "que horas são?" and reason about hours
  const tz = process.env.RESTAURANT_TIMEZONE || "America/Sao_Paulo"
  const timeStr = getTimeStr(tz)

  // 1. Channel-appropriate base voice
  const baseVoice = channel === "whatsapp" ? BASE_VOICE_WHATSAPP : BASE_VOICE_WEB

  // 2. State-specific instruction block
  const templateFn = STATE_PROMPTS[stateValue]
  const rawStateBlock = templateFn !== undefined ? templateFn(freshContext) : STATE_PROMPTS["fallback"](freshContext)
  const stateBlock = applyMomentumModifier(rawStateBlock, freshContext.momentum)

  // 3. Assemble and return
  return {
    systemPrompt: `${baseVoice}\n\nHORA ATUAL: ${timeStr}\n\n${stateBlock}`,
    availableTools: resolveTools(stateValue, freshContext),
    maxTokens: channel === "whatsapp"
      ? (WHATSAPP_TOKEN_LIMITS[stateValue] ?? DEFAULT_WHATSAPP_TOKENS)
      : MAX_TOKENS_WEB,
  }
}
