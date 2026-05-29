// Tests for set_pix_details validation helpers + agent path (P2-DATA-CNPJ)
// Pure functions; no network/Redis/mocks needed.
//
// Focus:
// - isValidCnpj: checksum-validated (valid accepted, bad rejected, all-same rejected)
// - isValidTaxId: unified CPF(11)/CNPJ(14) gate; rejects other lengths
// - normalizeTaxId / maskTaxId: format + PII-mask both document types
// - setPixDetails agent path: now ACCEPTS a valid CNPJ (previously rejected all
//   14-digit values as "CPF inválido"), still accepts CPF, rejects garbage.

import { describe, it, expect } from "vitest"
import {
  isValidCpf,
  isValidCnpj,
  isValidTaxId,
  normalizeTaxId,
  normalizeCnpj,
  maskTaxId,
  setPixDetails,
} from "../set-pix-details.js"
import { makeCtx } from "./fixtures/medusa.js"

// Well-known checksum-valid values.
const VALID_CPF = "529.982.247-25"
const VALID_CNPJ = "11.222.333/0001-81"
const VALID_CNPJ_REAL = "06.990.590/0001-23" // Google Brasil — real, valid

describe("isValidCnpj", () => {
  it("accepts a checksum-valid CNPJ (formatted and bare)", () => {
    expect(isValidCnpj(VALID_CNPJ)).toBe(true)
    expect(isValidCnpj("11222333000181")).toBe(true)
    expect(isValidCnpj(VALID_CNPJ_REAL)).toBe(true)
  })

  it("rejects a CNPJ with a bad checksum", () => {
    expect(isValidCnpj("11.222.333/0001-99")).toBe(false)
    expect(isValidCnpj("11.222.333/0001-80")).toBe(false)
  })

  it("rejects all-same-digit CNPJs", () => {
    expect(isValidCnpj("11.111.111/1111-11")).toBe(false)
    expect(isValidCnpj("00000000000000")).toBe(false)
  })

  it("rejects non-14-digit input", () => {
    expect(isValidCnpj("1122233300018")).toBe(false) // 13
    expect(isValidCnpj("112223330001811")).toBe(false) // 15
    expect(isValidCnpj(VALID_CPF)).toBe(false) // CPF length
  })
})

describe("isValidTaxId (unified CPF or CNPJ)", () => {
  it("accepts a valid CPF (11 digits)", () => {
    expect(isValidTaxId(VALID_CPF)).toBe(true)
    expect(isValidTaxId("52998224725")).toBe(true)
  })

  it("accepts a valid CNPJ (14 digits)", () => {
    expect(isValidTaxId(VALID_CNPJ)).toBe(true)
  })

  it("rejects an invalid CPF and an invalid CNPJ", () => {
    expect(isValidTaxId("123.456.789-00")).toBe(false)
    expect(isValidTaxId("11.222.333/0001-99")).toBe(false)
  })

  it("rejects values that are neither 11 nor 14 digits", () => {
    expect(isValidTaxId("12345")).toBe(false)
    expect(isValidTaxId("123456789012")).toBe(false) // 12
  })

  it("agrees with the standalone CPF validator for CPF-length input", () => {
    expect(isValidTaxId(VALID_CPF)).toBe(isValidCpf(VALID_CPF))
  })
})

describe("normalizeTaxId / maskTaxId", () => {
  it("normalizes a bare CNPJ to the canonical format", () => {
    expect(normalizeTaxId("11222333000181")).toBe("11.222.333/0001-81")
    expect(normalizeCnpj("11222333000181")).toBe("11.222.333/0001-81")
  })

  it("normalizes a bare CPF to the canonical format", () => {
    expect(normalizeTaxId("52998224725")).toBe("529.982.247-25")
  })

  it("returns null for input that is neither CPF nor CNPJ length", () => {
    expect(normalizeTaxId("123")).toBeNull()
  })

  it("PII-masks a CNPJ body while keeping the prefix and check digits", () => {
    const masked = maskTaxId(VALID_CNPJ)
    expect(masked).toContain("11.")
    expect(masked).toContain("-81")
    expect(masked).toContain("***")
    // The middle registration body must not appear in clear text.
    expect(masked).not.toContain("222.333")
  })

  it("PII-masks a CPF", () => {
    const masked = maskTaxId(VALID_CPF)
    expect(masked).toContain("***")
    expect(masked).toContain("-25")
  })
})

describe("setPixDetails agent path (P2-DATA-CNPJ)", () => {
  const CTX = makeCtx()

  it("accepts a valid CNPJ (previously rejected all 14-digit values)", async () => {
    const result = await setPixDetails({ cpf: VALID_CNPJ }, CTX)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.event?.payload.cpf).toBe("11.222.333/0001-81")
  })

  it("accepts a bare (unpunctuated) valid CNPJ and normalizes it", async () => {
    const result = await setPixDetails({ cpf: "11222333000181" }, CTX)
    expect(result.valid).toBe(true)
    expect(result.event?.payload.cpf).toBe("11.222.333/0001-81")
  })

  it("still accepts a valid CPF", async () => {
    const result = await setPixDetails({ cpf: VALID_CPF }, CTX)
    expect(result.valid).toBe(true)
    expect(result.event?.payload.cpf).toBe("529.982.247-25")
  })

  it("rejects a CNPJ with a bad checksum", async () => {
    const result = await setPixDetails({ cpf: "11.222.333/0001-99" }, CTX)
    expect(result.valid).toBe(false)
    expect(result.errors.join(" ")).toContain("CPF/CNPJ inválido")
  })

  it("rejects a CPF with a bad checksum", async () => {
    const result = await setPixDetails({ cpf: "123.456.789-00" }, CTX)
    expect(result.valid).toBe(false)
    expect(result.errors.join(" ")).toContain("CPF/CNPJ inválido")
  })

  it("accepts a full set of valid PIX details with a CNPJ", async () => {
    const result = await setPixDetails(
      { name: "Restaurante Parceiro LTDA", email: "fin@parceiro.com", cpf: VALID_CNPJ },
      CTX,
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.missing).toHaveLength(0)
    expect(result.event?.type).toBe("PIX_DETAILS_COLLECTED")
  })
})
