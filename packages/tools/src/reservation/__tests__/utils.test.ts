// Unit tests for reservation/utils.ts — pure function tests (no DB)

import { describe, it, expect } from "vitest"
import { buildDateTime, formatDateBR, locationLabel } from "../utils.js"

// ── buildDateTime ─────────────────────────────────────────────────────────────

describe("buildDateTime", () => {
  it("combines date and startTime into ISO format", () => {
    const result = buildDateTime(new Date("2025-12-20"), "19:30")
    expect(result).toBe("2025-12-20T19:30:00")
  })

  it("handles midnight correctly", () => {
    const result = buildDateTime(new Date("2025-12-20"), "00:00")
    expect(result).toBe("2025-12-20T00:00:00")
  })
})

// ── formatDateBR ──────────────────────────────────────────────────────────────

describe("formatDateBR", () => {
  it("returns a pt-BR formatted date string", () => {
    // Use noon UTC to avoid timezone date shift (São Paulo is UTC-3)
    const result = formatDateBR(new Date("2025-12-20T12:00:00Z"))
    // Should contain Portuguese day/month words
    expect(result).toMatch(/dezembro/i)
    expect(result).toMatch(/2025/)
  })

  it("includes weekday", () => {
    // Use noon UTC to avoid timezone date shift (São Paulo is UTC-3)
    const result = formatDateBR(new Date("2025-12-20T12:00:00Z")) // Saturday in São Paulo
    expect(result).toMatch(/sábado/i)
  })

  // ── FE-D11: a @db.Date (UTC midnight) must NOT roll back a day ──────────────
  it("formats a UTC-midnight @db.Date as its OWN calendar day (no TZ rollback)", () => {
    // reservation.timeSlot.date is a @db.Date returned as UTC midnight. Before the
    // fix, formatting it in America/Sao_Paulo (UTC-3) rolled 2026-07-16 back to the
    // 15th — the confirmation-copy off-by-one. It must name the 16th, matching
    // buildDateTime's UTC date extraction.
    const result = formatDateBR(new Date("2026-07-16")) // UTC midnight — the @db.Date shape
    expect(result).toMatch(/16 de julho de 2026/)
    expect(result).not.toMatch(/15 de julho/)
  })

  it("the label's day agrees with buildDateTime's date part (FE-D11 consistency)", () => {
    const date = new Date("2026-07-16")
    const dateTime = buildDateTime(date, "19:30") // "2026-07-16T19:30:00"
    const dayFromDateTime = dateTime.split("T")[0]!.split("-")[2]! // "16"
    expect(formatDateBR(date)).toContain(`${dayFromDateTime} de julho`)
  })
})

// ── locationLabel ─────────────────────────────────────────────────────────────

describe("locationLabel", () => {
  it("returns 'salão interno' for 'indoor'", () => {
    expect(locationLabel("indoor")).toBe("salão interno")
  })

  it("returns 'área externa' for 'outdoor'", () => {
    expect(locationLabel("outdoor")).toBe("área externa")
  })

  it("returns 'balcão do bar' for 'bar'", () => {
    expect(locationLabel("bar")).toBe("balcão do bar")
  })

  it("returns 'terraço' for 'terrace'", () => {
    expect(locationLabel("terrace")).toBe("terraço")
  })

  it("returns 'salão' for null", () => {
    expect(locationLabel(null)).toBe("salão")
  })

  it("returns the raw value for unknown locations", () => {
    expect(locationLabel("balcony")).toBe("balcony")
  })
})
