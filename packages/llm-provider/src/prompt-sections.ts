// Composable prompt sections for the IbateXas Hybrid State-Flow architecture.
// Each exported constant is a self-contained text block that the prompt
// synthesizer assembles into a targeted, minimal system prompt per LLM call.
// All user-facing text is in pt-BR (CLAUDE.md rule).

// ── Base voice ────────────────────────────────────────────────────────────────

// ~100 tokens. Always included. Defines channel-appropriate tone and hard constraints.

const restaurantAddress = process.env.RESTAURANT_ADDRESS || process.env.NEXT_PUBLIC_ADDRESS || ""
const addressLine = restaurantAddress ? `\nENDEREÇO DO RESTAURANTE: ${restaurantAddress}` : ""

export const BASE_VOICE_WHATSAPP = `Você é o atendente do IbateXas — defumados artesanais, low & slow.
Tom: caloroso, como um amigo que entende de churrasco. Informal mas confiante. Sempre pt-BR.
Ao apresentar produtos: lidere com a experiência e o diferencial, não com o preço. Preço vem DEPOIS do valor.
VARIAÇÃO OBRIGATÓRIA: nunca repita a mesma descrição de marca duas vezes seguidas. Alterne entre: "defumado lentamente por horas", "preparado no estilo low & slow", "carne macia que desmancha", "defumação artesanal no carvalho", "horas de fogo lento com madeira nobre". Escolha a que encaixa melhor no contexto.
REGRA DE EMOJI: use no máximo 1 emoji por mensagem. Se já usou 1, NÃO use outro. Zero emojis é aceitável. Respostas curtas — cliente no celular.
Princípio "Sim, e...": confirme a intenção ANTES de pedir qualquer coisa.
NUNCA mencione "/entrar", "login", "criar conta" ou "estar logado" — cliente WhatsApp já está autenticado.
NUNCA peça CPF ou telefone. Nome é coletado durante o pedido.
Se uma busca de produto retornar vazio ou falhar, tente novamente silenciosamente. NUNCA mencione erros internos, falhas de sistema ou retentativas ao cliente. Diga apenas "Só um momento..." se precisar de tempo.
NUNCA invente telefone ou dados de contato. Se não tiver a informação, diga "entre em contato pelo nosso site ibatexas.com.br".
NUNCA redirecione o cliente para o site para fazer pedido ou pagamento. O pedido é feito AQUI no WhatsApp, do início ao fim.
RETIRADA: cliente faz o pedido aqui, recebe confirmação com número do pedido e tempo estimado, e retira no restaurante no horário indicado.
ENTREGA: cliente informa o CEP, verificamos se está na área de entrega, informamos taxa e tempo estimado.
CONGELADOS: disponíveis para retirada mesmo com restaurante fechado (horário comercial). Pedido pelo WhatsApp, retira no balcão.${addressLine}
NUNCA gere número de pedido (#IXS-...) — apenas o sistema gera. NUNCA calcule totais — o total vem do sistema. NUNCA confirme pedido sem o sistema ter passado por entrega e pagamento.
URLs diretos (sem markdown). Sem tabelas — use listas.`

export const BASE_VOICE_WEB = `Você é o atendente do IbateXas — defumados artesanais, low & slow.
Tom: caloroso, como um amigo que entende de churrasco. Informal mas confiante. Sempre pt-BR.
Ao apresentar produtos: lidere com a experiência e o diferencial, não com o preço. Preço vem DEPOIS do valor.
VARIAÇÃO OBRIGATÓRIA: nunca repita a mesma descrição de marca duas vezes seguidas. Alterne entre: "defumado lentamente por horas", "preparado no estilo low & slow", "carne macia que desmancha", "defumação artesanal no carvalho", "horas de fogo lento com madeira nobre".
Markdown completo. Links clicáveis: [texto](url).
Princípio "Sim, e...": confirme a intenção ANTES de pedir qualquer coisa.`

// ── Menu sections ─────────────────────────────────────────────────────────────

// Injected based on the current meal period. Keeps the prompt small — the LLM
// never sees menus that are not relevant to what the customer can actually order.

export const LUNCH_MENU = `[Cardápio AGORA — almoço]
Carnes: Frango Defumado(R$52), Linguiça 4un(R$38), Pulled Pork(R$48)
Sanduíches: Smash Burger(R$42), [Carro-chefe] Combo Brisket(R$68 — inclui bebida+acomp, melhor custo-benefício)
Acompanhamentos: Farofa(R$16), Mandioca Frita(R$18), Feijão Tropeiro(R$18), Coleslaw(R$14), Batata Rústica(R$16)
Sobremesas: Brownie(R$22), Pudim(R$18)
Bebidas: Refri Coca/Guaraná(R$8), Limonada 300/500ml(R$14/R$19), IPA(R$18), Suco(R$12)
Congelados: Costela 500g/1kg(R$72/R$135), Pulled Pork(R$42), Molho BBQ(R$24)
NÃO disponível agora: Costela Bovina, Brisket, Barriga de Porco (jantar 18h-23h)`

export const DINNER_MENU = `[Cardápio AGORA — jantar]
Carnes: [Carro-chefe] Costela Bovina 500g/1kg(R$89/R$165 — mínimo 10h de defumação), Brisket 400g(R$78), Barriga 300g(R$62)
Bebidas: Refri(R$8), Limonada(R$14/R$19), IPA(R$18)
Congelados: Costela 500g/1kg(R$72/R$135), Pulled Pork(R$42), Molho BBQ(R$24)
NÃO disponível agora: Smash Burger, Frango, Pulled Pork, Acompanhamentos, Sobremesas (almoço 11h-15h)`

export const CLOSED_MENU = `[FECHADO — almoço 11h-15h | jantar 18h-23h]
O restaurante está fechado no momento. Informe o horário de funcionamento.
Se o cliente PERGUNTAR sobre congelados ou quiser levar algo: Congelados(Costela R$72/R$135, Pulled Pork R$42, Molho BBQ R$24).
NÃO sugira congelados proativamente — espere o cliente pedir.`

// ── Menu selector ─────────────────────────────────────────────────────────────

/**
 * Returns the correct menu section for the current time in the restaurant's
 * timezone. All hours are read from environment variables so they can be
 * overridden without a code change.
 */
export function getCurrentMenu(schedule?: import("@ibatexas/types").RestaurantSchedule): string {
  const period = _getMealPeriodSync(schedule)
  if (period === "lunch") return LUNCH_MENU
  if (period === "dinner") return DINNER_MENU
  return CLOSED_MENU
}

function _getMealPeriodSync(schedule?: import("@ibatexas/types").RestaurantSchedule): "lunch" | "dinner" | "closed" {
  const tz = process.env.RESTAURANT_TIMEZONE || "America/Sao_Paulo"
  const now = new Date()
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(now)
  let hour = 0, minute = 0
  for (const p of parts) {
    if (p.type === "hour") hour = Number.parseInt(p.value, 10)
    if (p.type === "minute") minute = Number.parseInt(p.value, 10)
  }
  if (hour === 24) hour = 0

  if (schedule) {
    const timeMinutes = hour * 60 + minute
    const dayStr = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now)
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    const dayOfWeek = dayMap[dayStr] ?? now.getDay()
    const day = schedule.days.find((d) => d.dayOfWeek === dayOfWeek)
    if (!day || !day.isOpen) return "closed"
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

  // Fallback: env vars
  const lunchStart = Number.parseInt(process.env.RESTAURANT_LUNCH_START_HOUR || "11", 10)
  const lunchEnd = Number.parseInt(process.env.RESTAURANT_LUNCH_END_HOUR || "15", 10)
  const dinnerStart = Number.parseInt(process.env.RESTAURANT_DINNER_START_HOUR || "18", 10)
  const dinnerEnd = Number.parseInt(process.env.RESTAURANT_DINNER_END_HOUR || "23", 10)
  if (hour >= lunchStart && hour < lunchEnd) return "lunch"
  if (hour >= dinnerStart && hour < dinnerEnd) return "dinner"
  return "closed"
}

// ── Structured menu product lists ────────────────────────────────────────────

// Co-located with text menus so they stay in sync when the menu changes.
// Used by the router to expand "tudo" into individual ADD_ITEM events.
// Excludes congelados (separate take-home category).

export interface MenuProduct {
  name: string
  variant?: string  // passed as variantHint to ADD_ITEM
}

export const LUNCH_PRODUCTS: MenuProduct[] = [
  // Carnes
  { name: "frango" },
  { name: "linguica" },
  { name: "pulled pork" },
  // Sanduíches
  { name: "smash" },
  { name: "combo" },
  // Acompanhamentos
  { name: "farofa" },
  { name: "mandioca" },
  { name: "feijao" },
  { name: "coleslaw" },
  { name: "batata" },
  // Sobremesas
  { name: "brownie" },
  { name: "pudim" },
  // Bebidas
  { name: "coca" },
  { name: "guarana" },
  { name: "limonada", variant: "300ml" },
  { name: "ipa" },
  { name: "suco" },
]

export const DINNER_PRODUCTS: MenuProduct[] = [
  // Carnes
  { name: "costela", variant: "500g" },
  { name: "brisket" },
  { name: "barriga" },
  // Bebidas
  { name: "refrigerante" },
  { name: "limonada", variant: "300ml" },
  { name: "ipa" },
]

/**
 * Returns the structured product list for the current meal period.
 * Returns null during closed hours (no "tudo" support when closed).
 */
export function getCurrentMenuProducts(schedule?: import("@ibatexas/types").RestaurantSchedule): MenuProduct[] | null {
  const period = _getMealPeriodSync(schedule)
  if (period === "lunch") return LUNCH_PRODUCTS
  if (period === "dinner") return DINNER_PRODUCTS
  return null
}

// ── Backward-compatible monolithic prompt ─────────────────────────────────────

// Any consumer that still imports `SYSTEM_PROMPT` from this module gets the
// assembled combination of the WhatsApp base voice (most restrictive, safe
// default) and the currently-active menu. New code should call
// synthesizePrompt() from ./prompt-synthesizer.js instead.

export const SYSTEM_PROMPT = [BASE_VOICE_WHATSAPP, getCurrentMenu()].join("\n\n")
