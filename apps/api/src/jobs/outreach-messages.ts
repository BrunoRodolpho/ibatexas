// Proactive outreach message builder.
// Pure function — no side effects, no Redis, no network.
// All messages are in pt-BR (CLAUDE.md rule 4).

export type OutreachMessageType =
  | "dormant_reorder"
  | "friday_habit"
  | "new_week"
  | "rainy_day"
  | "hot_day";

/**
 * Build a personalized outreach message for a dormant customer.
 *
 * Selection logic (weather takes priority over day-of-week):
 *  - weatherCondition "rain"        → "rainy_day"
 *  - weatherCondition "hot"         → "hot_day"
 *  - dayOfWeek 4 (Thu) or 5 (Fri)  → "friday_habit"
 *  - dayOfWeek 1 (Mon)              → "new_week"
 *  - otherwise                      → "dormant_reorder"
 */
export function buildOutreachMessage(
  customerName: string,
  topProductName: string,
  daysSinceLastOrder: number,
  dayOfWeek: number, // 0=Sun, 6=Sat
  weatherCondition?: "rain" | "hot" | "normal",
): { message: string; type: OutreachMessageType } {
  const name = customerName || "você";
  const product = topProductName || "seu pedido favorito";

  if (weatherCondition === "rain") {
    return {
      type: "rainy_day",
      message: `Dia perfeito pra ficar em casa com um ${product} defumado, ${name}. Quer que eu monte seu pedido? 🌧️`,
    };
  }

  if (weatherCondition === "hot") {
    return {
      type: "hot_day",
      message: `${name}, esse calor pede uma IPA gelada com uns defumados. Quer ver o cardápio de hoje? 🍺`,
    };
  }

  if (dayOfWeek === 4 || dayOfWeek === 5) {
    return {
      type: "friday_habit",
      message: `Sexta, ${name}! O de sempre — ${product}? Responda 'sim' e cuido do resto 😉`,
    };
  }

  if (dayOfWeek === 1) {
    return {
      type: "new_week",
      message: `Bom dia, ${name}! Semana nova, merece um ${product} pra começar bem. Quer pedir? 🔥`,
    };
  }

  return {
    type: "dormant_reorder",
    message: `Oi ${name}! Sentimos sua falta por aqui. Seu ${product} favorito tá te esperando — quer que eu monte o pedido? 🥩`,
  };
}
