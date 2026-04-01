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
  const errors: string[] = []

  // ── Semantic consistency checks (anti-misparse) ───────────────────────────
  if (input.name?.includes("@")) {
    errors.push("Campo nome contém um email — informe apenas o nome completo")
  }
  if (input.email && !input.email.includes("@")) {
    errors.push(`Email inválido — falta o símbolo @: "${input.email}"`)
  }
  if (input.cpf?.includes("@")) {
    errors.push("Campo CPF contém um email — informe apenas o CPF")
  }
  if (input.name && /^\d+$/.test(input.name.replace(/\D/g, "")) && input.name.replace(/\D/g, "").length >= 8) {
    errors.push("Campo nome parece conter apenas números — informe o nome completo")
  }

  // If semantic errors were found, return early
  if (errors.length > 0) {
    const durationMs = Date.now() - startMs
    console.info(
      "[extraction] tool=%s valid=%s fields=%s errors=%s latency=%dms",
      "set_pix_details",
      false,
      [],
      errors,
      durationMs,
    )
    return { valid: false, errors, missing: [], message: errors.join(". ") }
  }

  // ── Field validation ──────────────────────────────────────────────────────

  // Email
  let email: string | undefined
  if (input.email) {
    const sanitized = sanitize(input.email).toLowerCase()
    if (isValidEmail(sanitized)) {
      email = sanitized
    } else {
      errors.push(`Email inválido: "${input.email}"`)
    }
  }

  // CPF
  let cpf: string | undefined
  if (input.cpf) {
    const sanitized = sanitize(input.cpf)
    const normalized = normalizeCpf(sanitized)
    if (normalized && isValidCpf(sanitized)) {
      cpf = normalized
    } else {
      errors.push(`CPF inválido: "${input.cpf}". Formato esperado: 000.000.000-00 (11 dígitos)`)
    }
  }

  // Name — must have at least 2 words
  let name: string | undefined
  if (input.name) {
    const sanitized = sanitize(input.name)
    const words = sanitized.split(/\s+/).filter((w) => w.length > 0)
    if (words.length >= 2) {
      name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ")
    } else {
      errors.push(`Nome incompleto: "${input.name}". Preciso do nome e sobrenome.`)
    }
  }

  // ── Build missing list ────────────────────────────────────────────────────
  const missing: string[] = []
  if (!name && !errors.some((e) => e.includes("nome"))) missing.push("nome completo (nome e sobrenome)")
  if (!email && !errors.some((e) => e.includes("Email") || e.includes("email"))) missing.push("email")
  if (!cpf && !errors.some((e) => e.includes("CPF"))) missing.push("CPF (formato 000.000.000-00)")

  // ── Build result ──────────────────────────────────────────────────────────
  const hasAnyValid = !!(name || email || cpf)
  const allPresent = hasAnyValid && errors.length === 0 && missing.length === 0

  const validFields = Object.keys({
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(cpf ? { cpf } : {}),
  })

  const durationMs = Date.now() - startMs
  console.info(
    "[extraction] tool=%s valid=%s fields=%s errors=%s latency=%dms",
    "set_pix_details",
    hasAnyValid,
    validFields,
    errors,
    durationMs,
  )

  let message: string
  if (allPresent) {
    message = `Dados completos: ${name}, ${email}, CPF ${maskCpf(cpf!)}`
  } else if (errors.length > 0) {
    message = `${errors.join(". ")}${missing.length > 0 ? `. Ainda falta: ${missing.join(", ")}` : ""}`
  } else {
    message = `Falta: ${missing.join(", ")}`
  }

  return {
    valid: hasAnyValid,
    event: hasAnyValid
      ? {
          type: "PIX_DETAILS_COLLECTED",
          payload: {
            ...(name && { name }),
            ...(email && { email }),
            ...(cpf && { cpf }),
          },
        }
      : undefined,
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
