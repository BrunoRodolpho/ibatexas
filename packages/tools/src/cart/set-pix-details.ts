// set_pix_details tool
// Validates PIX billing details (name, email, CPF) and returns a structured machine event.
// Does NOT write to Redis or mutate state — validation only.

import { z } from "zod"
import type { AgentContext } from "@ibatexas/types"

export const SetPixDetailsInputSchema = z.object({
  name: z.string().optional().describe("Nome completo do cliente (nome e sobrenome)"),
  email: z.string().optional().describe("Email do cliente"),
  cpf: z.string().optional().describe("CPF do cliente (qualquer formato)"),
})

export type SetPixDetailsInput = z.infer<typeof SetPixDetailsInputSchema>

// ── Sanitization ──────────────────────────────────────────────────────────────

function sanitize(s: string): string {
  // Strip HTML tags and non-printable / non-safe characters
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s@.\-_]/gu, "")
    .trim()
}

// ── CPF validation (Receita Federal checksum algorithm) ───────────────────────

export function isValidCpf(cpf: string): boolean {
  const digits = cpf.replace(/\D/g, "")
  if (digits.length !== 11) return false
  if (/^(\d)\1+$/.test(digits)) return false // all same digit (e.g. 111.111.111-11)
  let sum = 0
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (10 - i)
  let check = 11 - (sum % 11)
  if (check >= 10) check = 0
  if (check !== Number(digits[9])) return false
  sum = 0
  for (let i = 0; i < 10; i++) sum += Number(digits[i]) * (11 - i)
  check = 11 - (sum % 11)
  if (check >= 10) check = 0
  return check === Number(digits[10])
}

export function normalizeCpf(raw: string): string | null {
  const digits = raw.replace(/\D/g, "")
  if (digits.length !== 11) return null
  return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4")
}

export function maskCpf(cpf: string): string {
  return cpf.replace(/(\d{3})\.\d{3}\.\d{3}(-\d{2})/, "$1.***.***$2")
}

// ── Email validation ──────────────────────────────────────────────────────────

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

// ── Field-validation helpers ──────────────────────────────────────────────────

type FieldResult<K extends string> = { [P in K]?: string } & { error?: string }

/** Semantic consistency checks (anti-misparse). Returns the collected errors. */
function checkSemanticConsistency(input: SetPixDetailsInput): string[] {
  const errors: string[] = []
  if (input.name?.includes("@")) {
    errors.push("Campo nome contém um email — informe apenas o nome completo")
  }
  if (input.email && !input.email.includes("@")) {
    errors.push(`Email inválido — falta o símbolo @: "${input.email}"`)
  }
  if (input.cpf?.includes("@")) {
    errors.push("Campo CPF contém um email — informe apenas o CPF")
  }
  const nameDigits = input.name ? input.name.replace(/\D/g, "") : ""
  if (input.name && /^\d+$/.test(nameDigits) && nameDigits.length >= 8) {
    errors.push("Campo nome parece conter apenas números — informe o nome completo")
  }
  return errors
}

function validateEmailField(raw: string): FieldResult<"email"> {
  const sanitized = sanitize(raw).toLowerCase()
  if (isValidEmail(sanitized)) return { email: sanitized }
  return { error: `Email inválido: "${raw}"` }
}

function validateCpfField(raw: string): FieldResult<"cpf"> {
  const sanitized = sanitize(raw)
  const normalized = normalizeCpf(sanitized)
  if (normalized && isValidCpf(sanitized)) return { cpf: normalized }
  return { error: `CPF inválido: "${raw}". Formato esperado: 000.000.000-00 (11 dígitos)` }
}

/** Name — must have at least 2 words. */
function validateNameField(raw: string): FieldResult<"name"> {
  const sanitized = sanitize(raw)
  const words = sanitized.split(/\s+/).filter((w) => w.length > 0)
  if (words.length >= 2) {
    return { name: words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ") }
  }
  return { error: `Nome incompleto: "${raw}". Preciso do nome e sobrenome.` }
}

function buildMissing(
  name: string | undefined,
  email: string | undefined,
  cpf: string | undefined,
  errors: string[],
): string[] {
  const missing: string[] = []
  if (!name && !errors.some((e) => e.includes("nome"))) missing.push("nome completo (nome e sobrenome)")
  if (!email && !errors.some((e) => e.includes("Email") || e.includes("email"))) missing.push("email")
  if (!cpf && !errors.some((e) => e.includes("CPF"))) missing.push("CPF (formato 000.000.000-00)")
  return missing
}

function collectValidFields(
  name: string | undefined,
  email: string | undefined,
  cpf: string | undefined,
): string[] {
  return Object.keys({
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(cpf ? { cpf } : {}),
  })
}

type PixDetailsEvent = { type: string; payload: { name?: string; email?: string; cpf?: string } }

function buildEvent(
  hasAnyValid: boolean,
  name: string | undefined,
  email: string | undefined,
  cpf: string | undefined,
): PixDetailsEvent | undefined {
  if (!hasAnyValid) return undefined
  return {
    type: "PIX_DETAILS_COLLECTED",
    payload: {
      ...(name && { name }),
      ...(email && { email }),
      ...(cpf && { cpf }),
    },
  }
}

function buildResultMessage(
  allPresent: boolean,
  name: string | undefined,
  email: string | undefined,
  cpf: string | undefined,
  errors: string[],
  missing: string[],
): string {
  if (allPresent) {
    return `Dados completos: ${name}, ${email}, CPF ${maskCpf(cpf!)}`
  }
  if (errors.length > 0) {
    const stillMissing = missing.length > 0 ? `. Ainda falta: ${missing.join(", ")}` : ""
    return `${errors.join(". ")}${stillMissing}`
  }
  return `Falta: ${missing.join(", ")}`
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function setPixDetails(
  input: SetPixDetailsInput,
  _ctx: AgentContext,
): Promise<{
  valid: boolean
  event?: { type: string; payload: { name?: string; email?: string; cpf?: string } }
  errors: string[]
  missing: string[]
  message: string
}> {
  const startMs = Date.now()

  // ── Semantic consistency checks (anti-misparse) ───────────────────────────
  const semanticErrors = checkSemanticConsistency(input)

  // If semantic errors were found, return early
  if (semanticErrors.length > 0) {
    const durationMs = Date.now() - startMs
    console.warn(
      "[extraction] tool=%s valid=%s fields=%s errors=%s latency=%dms",
      "set_pix_details",
      false,
      [],
      semanticErrors,
      durationMs,
    )
    return { valid: false, errors: semanticErrors, missing: [], message: semanticErrors.join(". ") }
  }

  // ── Field validation ──────────────────────────────────────────────────────
  const errors: string[] = []

  const emailResult: FieldResult<"email"> = input.email ? validateEmailField(input.email) : {}
  if (emailResult.error) errors.push(emailResult.error)
  const email = emailResult.email

  const cpfResult: FieldResult<"cpf"> = input.cpf ? validateCpfField(input.cpf) : {}
  if (cpfResult.error) errors.push(cpfResult.error)
  const cpf = cpfResult.cpf

  const nameResult: FieldResult<"name"> = input.name ? validateNameField(input.name) : {}
  if (nameResult.error) errors.push(nameResult.error)
  const name = nameResult.name

  // ── Build missing list ────────────────────────────────────────────────────
  const missing = buildMissing(name, email, cpf, errors)

  // ── Build result ──────────────────────────────────────────────────────────
  const hasAnyValid = !!(name || email || cpf)
  const allPresent = hasAnyValid && errors.length === 0 && missing.length === 0

  const validFields = collectValidFields(name, email, cpf)

  const durationMs = Date.now() - startMs
  console.warn(
    "[extraction] tool=%s valid=%s fields=%s errors=%s latency=%dms",
    "set_pix_details",
    hasAnyValid,
    validFields,
    errors,
    durationMs,
  )

  const message = buildResultMessage(allPresent, name, email, cpf, errors, missing)

  return {
    valid: hasAnyValid,
    event: buildEvent(hasAnyValid, name, email, cpf),
    errors,
    missing,
    message,
  }
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const SetPixDetailsTool = {
  name: "set_pix_details",
  description:
    "Valida e registra dados do cliente para PIX: nome completo, email e CPF. Pode chamar várias vezes com dados parciais — os dados são acumulados. Retorna quais campos ainda faltam.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Nome completo (nome e sobrenome)" },
      email: { type: "string", description: "Email do cliente" },
      cpf: { type: "string", description: "CPF (aceita 000.000.000-00 ou 00000000000)" },
    },
  },
} as const
