// Tests for the set_pix_details tool (PIX billing-detail validation).
// Pure validation — no Redis, network, or state mutation. The handler only
// reads its input and returns a structured machine event, so no external
// dependency needs mocking beyond silencing the [extraction] console.warn.
//
// Scenarios:
// - isValidCpf  : Receita Federal checksum (real valid/invalid check digits,
//                 length + repeated-digit guards, forced-zero check branches)
// - normalizeCpf: digit-strip + 000.000.000-00 formatting / null on bad length
// - maskCpf     : middle-block redaction
// - isValidEmail: shape regex (missing @, missing dot, whitespace)
// - setPixDetails: semantic anti-misparse early-return, per-field validation,
//                 missing-field accumulation, event/message shaping, and
//                 HTML/CRLF sanitization.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  setPixDetails,
  isValidCpf,
  normalizeCpf,
  maskCpf,
  isValidEmail,
  SetPixDetailsTool,
  SetPixDetailsInputSchema,
} from "../set-pix-details.js"
import { makeCtx } from "./fixtures/medusa.js"

// Real CPFs with mathematically-correct Receita check digits.
const VALID_CPF = "529.982.247-25" // canonical valid test CPF
const VALID_CPF_RAW = "52998224725"
const VALID_CPF_2 = "111.444.777-35"
// Edge: a valid CPF whose FIRST check digit is forced to 0 (sum % 11 in {0,1}).
const VALID_CPF_FIRST_ZERO = "00000000604"
// Edge: a valid CPF whose SECOND check digit is forced to 0.
const VALID_CPF_SECOND_ZERO = "00000001830"

const CTX = makeCtx()

beforeEach(() => {
  // The handler emits a structured [extraction] warn line; silence it so the
  // test output stays clean while still exercising the logging branch.
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── isValidCpf ────────────────────────────────────────────────────────────────

describe("isValidCpf", () => {
  it.each([
    ["raw 11-digit valid", VALID_CPF_RAW],
    ["formatted valid", VALID_CPF],
    ["second known valid", VALID_CPF_2],
    ["valid with forced-zero first check digit", VALID_CPF_FIRST_ZERO],
    ["valid with forced-zero second check digit", VALID_CPF_SECOND_ZERO],
  ])("accepts a real valid CPF (%s)", (_label, cpf) => {
    expect(isValidCpf(cpf)).toBe(true)
  })

  it("rejects a CPF with the wrong first check digit", () => {
    // digits[9] tampered 2 -> 3
    expect(isValidCpf("52998224735")).toBe(false)
  })

  it("rejects a CPF with the wrong second check digit", () => {
    // digits[10] tampered 5 -> 4
    expect(isValidCpf("52998224724")).toBe(false)
  })

  it.each([
    ["too short", "529822472"],
    ["10 digits", "5299822472"],
    ["12 digits", "529982247255"],
    ["empty", ""],
  ])("rejects wrong-length input (%s)", (_label, cpf) => {
    expect(isValidCpf(cpf)).toBe(false)
  })

  it.each(["00000000000", "11111111111", "99999999999"])(
    "rejects all-same-digit sequence %s",
    (cpf) => {
      expect(isValidCpf(cpf)).toBe(false)
    },
  )

  it("strips formatting before validating (dots/hyphen are ignored)", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true)
    expect(isValidCpf("529 982 247 25")).toBe(true)
  })
})

// ── normalizeCpf ────────────────────────────────────────────────────────────────

describe("normalizeCpf", () => {
  it("formats a raw 11-digit string as 000.000.000-00", () => {
    expect(normalizeCpf(VALID_CPF_RAW)).toBe(VALID_CPF)
  })

  it("re-formats an already-formatted CPF idempotently", () => {
    expect(normalizeCpf(VALID_CPF)).toBe(VALID_CPF)
  })

  it("strips arbitrary non-digit characters before formatting", () => {
    expect(normalizeCpf("529-982-247/25")).toBe(VALID_CPF)
  })

  it.each([
    ["fewer than 11 digits", "5299822472"],
    ["more than 11 digits", "529982247255"],
    ["no digits", "abc"],
    ["empty", ""],
  ])("returns null for invalid length (%s)", (_label, raw) => {
    expect(normalizeCpf(raw)).toBeNull()
  })
})

// ── maskCpf ─────────────────────────────────────────────────────────────────────

describe("maskCpf", () => {
  it("redacts the two middle blocks, keeping prefix and suffix", () => {
    expect(maskCpf(VALID_CPF)).toBe("529.***.***-25")
  })
})

// ── isValidEmail ────────────────────────────────────────────────────────────────

describe("isValidEmail", () => {
  it.each([
    "joao@test.com",
    "a.b@c.co.uk",
    "joao+tag@example.com.br",
  ])("accepts a well-formed email (%s)", (email) => {
    expect(isValidEmail(email)).toBe(true)
  })

  it.each([
    ["missing @", "joaotest.com"],
    ["missing dot after @", "joao@testcom"],
    ["whitespace inside", "joao test@x.com"],
    ["empty local part", "@test.com"],
    ["empty string", ""],
  ])("rejects a malformed email (%s)", (_label, email) => {
    expect(isValidEmail(email)).toBe(false)
  })
})

// ── setPixDetails: semantic anti-misparse (early return) ────────────────────────

describe("setPixDetails — semantic consistency (anti-misparse)", () => {
  it("rejects when the name field contains an email", async () => {
    const result = await setPixDetails({ name: "joao@test.com" }, CTX)

    expect(result.valid).toBe(false)
    expect(result.event).toBeUndefined()
    expect(result.missing).toEqual([])
    expect(result.errors).toEqual([
      "Campo nome contém um email — informe apenas o nome completo",
    ])
    expect(result.message).toContain("Campo nome contém um email")
  })

  it("rejects when the email field is missing the @ symbol", async () => {
    const result = await setPixDetails({ email: "joaotest.com" }, CTX)

    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain("falta o símbolo @")
    expect(result.errors[0]).toContain("joaotest.com")
  })

  it("rejects when the CPF field contains an email", async () => {
    const result = await setPixDetails({ cpf: "5@9" }, CTX)

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      "Campo CPF contém um email — informe apenas o CPF",
    ])
  })

  it("rejects when the name field is an 8+ digit number (likely a misparsed CPF)", async () => {
    const result = await setPixDetails({ name: "12345678" }, CTX)

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      "Campo nome parece conter apenas números — informe o nome completo",
    ])
  })

  it("collects multiple semantic errors in one early return", async () => {
    const result = await setPixDetails(
      { name: "ana@x.com", email: "semarroba", cpf: "z@y" },
      CTX,
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(3)
    expect(result.message).toContain("Campo nome contém um email")
    expect(result.message).toContain("falta o símbolo @")
    expect(result.message).toContain("Campo CPF contém um email")
  })
})

// ── setPixDetails: per-field validation + shaping ───────────────────────────────

describe("setPixDetails — full valid input", () => {
  it("returns a complete PIX_DETAILS_COLLECTED event with normalized fields", async () => {
    const result = await setPixDetails(
      { name: "joão silva", email: "JOAO@Test.com", cpf: VALID_CPF },
      CTX,
    )

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.event).toEqual({
      type: "PIX_DETAILS_COLLECTED",
      payload: {
        name: "João Silva", // title-cased
        email: "joao@test.com", // lower-cased + sanitized
        cpf: VALID_CPF, // normalized
      },
    })
  })

  it("renders a 'Dados completos' message with the CPF masked", async () => {
    const result = await setPixDetails(
      { name: "joão silva", email: "joao@test.com", cpf: VALID_CPF },
      CTX,
    )

    expect(result.message).toBe(
      "Dados completos: João Silva, joao@test.com, CPF 529.***.***-25",
    )
    expect(result.message).not.toContain("982") // raw middle blocks redacted
  })
})

describe("setPixDetails — empty / partial input", () => {
  it("reports all three fields as missing when given nothing", async () => {
    const result = await setPixDetails({}, CTX)

    expect(result.valid).toBe(false)
    expect(result.event).toBeUndefined()
    expect(result.errors).toEqual([])
    expect(result.missing).toEqual([
      "nome completo (nome e sobrenome)",
      "email",
      "CPF (formato 000.000.000-00)",
    ])
    expect(result.message).toBe(
      "Falta: nome completo (nome e sobrenome), email, CPF (formato 000.000.000-00)",
    )
  })

  it("accepts a single valid field and lists only the remaining as missing", async () => {
    const result = await setPixDetails({ email: "joao@test.com" }, CTX)

    expect(result.valid).toBe(true)
    expect(result.event).toEqual({
      type: "PIX_DETAILS_COLLECTED",
      payload: { email: "joao@test.com" },
    })
    expect(result.errors).toEqual([])
    expect(result.missing).toEqual([
      "nome completo (nome e sobrenome)",
      "CPF (formato 000.000.000-00)",
    ])
    expect(result.message).toBe(
      "Falta: nome completo (nome e sobrenome), CPF (formato 000.000.000-00)",
    )
  })
})

describe("setPixDetails — per-field rejection", () => {
  it("rejects an email that passes the @ check but fails the shape regex", async () => {
    const result = await setPixDetails({ email: "joao@invalid" }, CTX)

    expect(result.valid).toBe(false) // no field became valid
    expect(result.event).toBeUndefined()
    expect(result.errors).toEqual([`Email inválido: "joao@invalid"`])
    // the email error suppresses 'email' from the missing list, but name + cpf remain
    expect(result.missing).toEqual([
      "nome completo (nome e sobrenome)",
      "CPF (formato 000.000.000-00)",
    ])
    expect(result.message).toContain("Email inválido")
    expect(result.message).toContain("Ainda falta:")
  })

  it("rejects a CPF with a bad check digit", async () => {
    const result = await setPixDetails({ cpf: "529.982.247-24" }, CTX)

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      `CPF inválido: "529.982.247-24". Formato esperado: 000.000.000-00 (11 dígitos)`,
    ])
    // CPF error suppresses 'CPF' from missing; name + email still requested
    expect(result.missing).toEqual([
      "nome completo (nome e sobrenome)",
      "email",
    ])
  })

  it("rejects a single-word name as incomplete", async () => {
    const result = await setPixDetails({ name: "joão" }, CTX)

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      `Nome incompleto: "joão". Preciso do nome e sobrenome.`,
    ])
  })

  it("accumulates valid + invalid fields together (cpf valid, email bad)", async () => {
    const result = await setPixDetails(
      { email: "joao@invalid", cpf: VALID_CPF },
      CTX,
    )

    // cpf became valid → overall valid:true and event carries only cpf
    expect(result.valid).toBe(true)
    expect(result.event).toEqual({
      type: "PIX_DETAILS_COLLECTED",
      payload: { cpf: VALID_CPF },
    })
    expect(result.errors).toEqual([`Email inválido: "joao@invalid"`])
  })
})

// ── setPixDetails: sanitization (HTML / CRLF injection) ──────────────────────────

describe("setPixDetails — sanitization", () => {
  it("strips HTML tags from the name before title-casing", async () => {
    const result = await setPixDetails(
      { name: "<b>joão</b> <i>silva</i>" },
      CTX,
    )

    expect(result.valid).toBe(true)
    expect(result.event?.payload.name).toBe("João Silva")
    expect(result.event?.payload.name).not.toContain("<")
  })

  it("rejects an email carrying a CRLF header-injection payload", async () => {
    const result = await setPixDetails(
      { email: "joao@test.com\r\nBcc: evil@x.com" },
      CTX,
    )

    expect(result.valid).toBe(false)
    expect(result.event).toBeUndefined()
    expect(result.errors[0]).toContain("Email inválido")
  })

  it("strips control characters from a CPF and still validates the digits", async () => {
    const result = await setPixDetails({ cpf: "529.982.247-25\x00<x>" }, CTX)

    expect(result.valid).toBe(true)
    expect(result.event?.payload.cpf).toBe(VALID_CPF)
  })
})

// ── Tool definition + schema ────────────────────────────────────────────────────

describe("SetPixDetailsTool / schema", () => {
  it("exposes the LLM-facing tool id and object schema", () => {
    expect(SetPixDetailsTool.name).toBe("set_pix_details")
    expect(SetPixDetailsTool.inputSchema.type).toBe("object")
    expect(Object.keys(SetPixDetailsTool.inputSchema.properties)).toEqual([
      "name",
      "email",
      "cpf",
    ])
  })

  it("accepts a partial input (all fields optional)", () => {
    expect(SetPixDetailsInputSchema.parse({})).toEqual({})
    expect(SetPixDetailsInputSchema.parse({ name: "Ana" })).toEqual({
      name: "Ana",
    })
  })

  it("rejects a non-string field", () => {
    expect(() => SetPixDetailsInputSchema.parse({ cpf: 123 })).toThrow()
  })
})
