// Tests for outreach-messages.ts — pure function, no mocks needed.

import { describe, it, expect } from "vitest";
import { buildOutreachMessage } from "../jobs/outreach-messages.js";

describe("buildOutreachMessage", () => {
  // ── Message type selection by day of week ────────────────────────────────

  it("returns friday_habit on Thursday (dayOfWeek=4)", () => {
    const { type, message } = buildOutreachMessage("Maria", "Costela", 10, 4);
    expect(type).toBe("friday_habit");
    expect(message).toContain("Maria");
    expect(message).toContain("Costela");
  });

  it("returns friday_habit on Friday (dayOfWeek=5)", () => {
    const { type, message } = buildOutreachMessage("João", "Picanha", 8, 5);
    expect(type).toBe("friday_habit");
    expect(message).toContain("João");
    expect(message).toContain("Picanha");
  });

  it("returns new_week on Monday (dayOfWeek=1)", () => {
    const { type, message } = buildOutreachMessage("Ana", "Frango", 12, 1);
    expect(type).toBe("new_week");
    expect(message).toContain("Ana");
    expect(message).toContain("Frango");
  });

  it("returns dormant_reorder on Wednesday (dayOfWeek=3)", () => {
    const { type, message } = buildOutreachMessage("Carlos", "Alcatra", 9, 3);
    expect(type).toBe("dormant_reorder");
    expect(message).toContain("Carlos");
    expect(message).toContain("Alcatra");
  });

  it("returns dormant_reorder on Sunday (dayOfWeek=0)", () => {
    const { type } = buildOutreachMessage("Pedro", "Linguiça", 7, 0);
    expect(type).toBe("dormant_reorder");
  });

  it("returns dormant_reorder on Saturday (dayOfWeek=6)", () => {
    const { type } = buildOutreachMessage("Luiz", "Costela", 7, 6);
    expect(type).toBe("dormant_reorder");
  });

  it("returns dormant_reorder on Tuesday (dayOfWeek=2)", () => {
    const { type } = buildOutreachMessage("Luiz", "Costela", 7, 2);
    expect(type).toBe("dormant_reorder");
  });

  // ── Message content ──────────────────────────────────────────────────────

  it("dormant_reorder includes product name in message", () => {
    const { message } = buildOutreachMessage("Ana", "Picanha", 14, 3);
    expect(message).toContain("Picanha");
  });

  it("message includes customer name", () => {
    const { message } = buildOutreachMessage("Fernanda", "Costela", 8, 3);
    expect(message).toContain("Fernanda");
  });

  it("message includes product name", () => {
    const { message } = buildOutreachMessage("Fernanda", "Costela Bovina", 8, 3);
    expect(message).toContain("Costela Bovina");
  });

  // ── Fallback when no product name ────────────────────────────────────────

  it("uses fallback product name when topProductName is empty", () => {
    const { message } = buildOutreachMessage("Ana", "", 8, 3);
    expect(message).toContain("seu pedido favorito");
  });

  it("uses fallback customer name when customerName is empty", () => {
    const { message } = buildOutreachMessage("", "Picanha", 8, 3);
    expect(message).toContain("você");
  });
});
