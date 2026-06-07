import { describe, expect, it } from "vitest"
import {
  CARD_RE,
  CPF_RE,
  EMAIL_RE,
  HASH_PREFIX,
  PHONE_RE,
  PII_PATTERNS,
  PII_SENTINELS,
  isSentinelString,
} from "./index.js"

// g-flagged regexes are stateful under repeated .test(); use .replace (resets
// lastIndex) or a fresh non-global clone for boolean checks.
const hits = (re: RegExp, s: string): boolean =>
  new RegExp(re.source, re.flags.replace("g", "")).test(s)

describe("@ibatexas/pii — pattern coverage", () => {
  it("CPF: matches with and without separators", () => {
    expect(hits(CPF_RE, "meu cpf 123.456.789-00 ok")).toBe(true)
    expect(hits(CPF_RE, "12345678900")).toBe(true)
  })

  it("email / phone / card match their canonical shapes", () => {
    expect(hits(EMAIL_RE, "fale com a.b+x@loja.com.br")).toBe(true)
    expect(hits(PHONE_RE, "+55 11 99999-8888")).toBe(true)
    expect(hits(PHONE_RE, "(11) 99999-8888")).toBe(true)
    expect(hits(CARD_RE, "4111 1111 1111 1111")).toBe(true)
    expect(hits(CARD_RE, "4111111111111111")).toBe(true)
  })

  it("redact replaces matches with the stable sentinel (g, all occurrences)", () => {
    const out = "cpf 12345678900 e 987.654.321-00".replace(
      CPF_RE,
      PII_SENTINELS.CPF,
    )
    expect(out).toBe(`cpf ${PII_SENTINELS.CPF} e ${PII_SENTINELS.CPF}`)
  })

  it("PII_PATTERNS exposes the four ids in declared order, each with redact()", () => {
    expect(PII_PATTERNS.map((p) => p.id)).toEqual(["cpf", "email", "phone", "pan"])
    expect(PII_PATTERNS.every((p) => typeof p.redact === "function")).toBe(true)
    expect(PII_PATTERNS[0]!.redact("12345678900")).toBe(PII_SENTINELS.CPF)
  })
})

describe("@ibatexas/pii — idempotency surface", () => {
  it("isSentinelString recognises sentinels + hashed prefix, not free text", () => {
    expect(isSentinelString(PII_SENTINELS.CPF)).toBe(true)
    expect(isSentinelString(`${HASH_PREFIX}deadbeef`)).toBe(true)
    expect(isSentinelString("olá, tudo bem?")).toBe(false)
    // exact-match only: a string merely CONTAINING a sentinel is not "redacted"
    expect(isSentinelString(`${PII_SENTINELS.CPF} extra`)).toBe(false)
  })

  it("documented reality: a 16-digit order id false-matches CARD (no Luhn)", () => {
    // Not aspirational — records the known limitation so wiring stays aware:
    // the guard must scan only PII-bearing free-text fields, never numeric ids.
    expect(hits(CARD_RE, "4815162342000000")).toBe(true)
  })
})
