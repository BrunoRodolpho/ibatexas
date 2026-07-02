// Unit tests for the strict pt-BR integer-centavos parser (hard rule #2:
// prices are integer centavos, never floats — no parseFloat, no float math).

import { describe, it, expect } from "vitest"
import { reaisStringToCentavos } from "../lib/money"

describe("reaisStringToCentavos", () => {
  describe("comma decimal (pt-BR)", () => {
    it('parses "50,00" as 5000', () => {
      expect(reaisStringToCentavos("50,00")).toBe(5000)
    })

    it('parses "1.234,56" (thousands-dotted) as 123456', () => {
      expect(reaisStringToCentavos("1.234,56")).toBe(123456)
    })

    it('parses "1.234.567,89" as 123456789', () => {
      expect(reaisStringToCentavos("1.234.567,89")).toBe(123456789)
    })

    it('parses a single-fraction-digit "50,5" as 5050', () => {
      expect(reaisStringToCentavos("50,5")).toBe(5050)
    })

    it('parses ">3-digit integer part without dots "12345,6" as 1234560', () => {
      expect(reaisStringToCentavos("12345,6")).toBe(1234560)
    })

    it('rejects 3 fraction digits ("1,234")', () => {
      expect(reaisStringToCentavos("1,234")).toBeNull()
    })

    it('rejects malformed thousands grouping ("12.34,56")', () => {
      expect(reaisStringToCentavos("12.34,56")).toBeNull()
    })
  })

  describe("no comma", () => {
    it('parses pure digits "50" as whole reais (5000)', () => {
      expect(reaisStringToCentavos("50")).toBe(5000)
    })

    it('parses dot decimal "50.00" as 5000', () => {
      expect(reaisStringToCentavos("50.00")).toBe(5000)
    })

    it('parses dot decimal "1.05" as 105 centavos — NOT 105 reais (the parseFloat 100x bug)', () => {
      expect(reaisStringToCentavos("1.05")).toBe(105)
    })

    it('parses single-fraction-digit "1.5" as 150', () => {
      expect(reaisStringToCentavos("1.5")).toBe(150)
    })

    it('rejects the ambiguous bare thousands form "1.000"', () => {
      expect(reaisStringToCentavos("1.000")).toBeNull()
    })

    it('rejects multi-dot "1.000.000"', () => {
      expect(reaisStringToCentavos("1.000.000")).toBeNull()
    })
  })

  describe("prefix and whitespace", () => {
    it('accepts an "R$" prefix', () => {
      expect(reaisStringToCentavos("R$ 50,00")).toBe(5000)
      expect(reaisStringToCentavos("r$50")).toBe(5000)
    })

    it("ignores interior/surrounding spaces", () => {
      expect(reaisStringToCentavos("  1.234,56  ")).toBe(123456)
    })
  })

  describe("rejections", () => {
    it("rejects blank input", () => {
      expect(reaisStringToCentavos("")).toBeNull()
      expect(reaisStringToCentavos("   ")).toBeNull()
    })

    it('rejects non-numeric input ("abc")', () => {
      expect(reaisStringToCentavos("abc")).toBeNull()
    })

    it("rejects signed amounts", () => {
      expect(reaisStringToCentavos("-50,00")).toBeNull()
      expect(reaisStringToCentavos("+50,00")).toBeNull()
    })

    it("rejects zero", () => {
      expect(reaisStringToCentavos("0")).toBeNull()
      expect(reaisStringToCentavos("0,00")).toBeNull()
    })

    it("rejects amounts that overflow safe integer centavos", () => {
      expect(reaisStringToCentavos("9".repeat(20))).toBeNull()
    })

    it("rejects mixed garbage around a number", () => {
      expect(reaisStringToCentavos("50,00x")).toBeNull()
      expect(reaisStringToCentavos("$50")).toBeNull()
    })
  })
})
