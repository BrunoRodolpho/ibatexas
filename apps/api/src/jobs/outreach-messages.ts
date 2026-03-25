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
      message: `Dia de chuva, ${name}! Que tal pedir ${product} sem sair de casa? Responda 'sim' 🌧️`,
    };
  }

  if (weatherCondition === "hot") {
    return {
      type: "hot_day",
      message: `Calorzao hoje, ${name}! Que tal uma salada ou cerveja gelada? Responda 'sim' 🍺`,
    };
  }

  if (dayOfWeek === 4 || dayOfWeek === 5) {
    return {
      type: "friday_habit",
      message: `Sexta chegando, ${name}! Quer o de sempre? Responda 'sim' pra ${product} 😉`,
    };
  }

  if (dayOfWeek === 1) {
    return {
      type: "new_week",
      message: `Bom dia ${name}! Comecando a semana bem com ${product}? Responda 'sim' 🔥`,
    };
  }

  return {
    type: "dormant_reorder",
    message: `Oi ${name}! Faz ${daysSinceLastOrder} dias desde seu ultimo pedido. Quer que eu prepare ${product} de novo? Responda 'sim' e cuido do resto! 🥩`,
  };
}
