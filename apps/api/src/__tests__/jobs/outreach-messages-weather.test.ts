// Tests for weather-based message selection in buildOutreachMessage.
// Pure function — no mocks needed.

import { describe, it, expect } from "vitest";
import { buildOutreachMessage } from "../../jobs/outreach-messages.js";

describe("buildOutreachMessage — weather priority", () => {
  // ── Weather overrides day-of-week ─────────────────────────────────────────

  it("weatherCondition='rain' → rainy_day regardless of day (Friday)", () => {
    const { type, message } = buildOutreachMessage("Maria", "Costela", 10, 5, "rain");
    expect(type).toBe("rainy_day");
    expect(message).toContain("Maria");
    expect(message).toContain("Costela");
    expect(message).toContain("chuva");
  });

  it("weatherCondition='rain' → rainy_day regardless of day (Monday)", () => {
    const { type } = buildOutreachMessage("João", "Picanha", 8, 1, "rain");
    expect(type).toBe("rainy_day");
  });

  it("weatherCondition='rain' → rainy_day regardless of day (Wednesday)", () => {
    const { type } = buildOutreachMessage("Ana", "Frango", 12, 3, "rain");
    expect(type).toBe("rainy_day");
  });

  it("weatherCondition='hot' → hot_day regardless of day (Friday)", () => {
    const { type, message } = buildOutreachMessage("Carlos", "Alcatra", 9, 5, "hot");
    expect(type).toBe("hot_day");
    expect(message).toContain("Carlos");
    expect(message).toContain("Calorzao");
  });

  it("weatherCondition='hot' → hot_day regardless of day (Monday)", () => {
    const { type } = buildOutreachMessage("Pedro", "Linguiça", 7, 1, "hot");
    expect(type).toBe("hot_day");
  });

  it("weatherCondition='hot' → hot_day regardless of day (Sunday)", () => {
    const { type } = buildOutreachMessage("Luiz", "Costela", 7, 0, "hot");
    expect(type).toBe("hot_day");
  });

  // ── Normal weather falls back to day-of-week logic ────────────────────────

  it("weatherCondition='normal' → friday_habit on Thursday", () => {
    const { type } = buildOutreachMessage("Maria", "Costela", 10, 4, "normal");
    expect(type).toBe("friday_habit");
  });

  it("weatherCondition='normal' → friday_habit on Friday", () => {
    const { type } = buildOutreachMessage("Maria", "Costela", 10, 5, "normal");
    expect(type).toBe("friday_habit");
  });

  it("weatherCondition='normal' → new_week on Monday", () => {
    const { type } = buildOutreachMessage("Maria", "Costela", 10, 1, "normal");
    expect(type).toBe("new_week");
  });

  it("weatherCondition='normal' → dormant_reorder on Wednesday", () => {
    const { type } = buildOutreachMessage("Maria", "Costela", 10, 3, "normal");
    expect(type).toBe("dormant_reorder");
  });

  // ── Undefined weather (no param) falls back to day-of-week logic ─────────

  it("no weatherCondition → friday_habit on Friday", () => {
    const { type } = buildOutreachMessage("Maria", "Costela", 10, 5);
    expect(type).toBe("friday_habit");
  });

  it("no weatherCondition → dormant_reorder on Tuesday", () => {
    const { type } = buildOutreachMessage("Maria", "Costela", 10, 2);
    expect(type).toBe("dormant_reorder");
  });

  // ── Message content ───────────────────────────────────────────────────────

  it("rainy_day message includes customer name and product", () => {
    const { message } = buildOutreachMessage("Ana", "Costela Bovina", 10, 3, "rain");
    expect(message).toContain("Ana");
    expect(message).toContain("Costela Bovina");
  });

  it("rainy_day message uses fallback product name when empty", () => {
    const { message } = buildOutreachMessage("Ana", "", 10, 3, "rain");
    expect(message).toContain("seu pedido favorito");
  });

  it("hot_day message uses fallback customer name when empty", () => {
    const { message } = buildOutreachMessage("", "Costela", 10, 3, "hot");
    expect(message).toContain("você");
  });
});
