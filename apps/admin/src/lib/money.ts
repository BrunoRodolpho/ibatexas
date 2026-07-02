/**
 * Strict pt-BR money parsing — integer arithmetic only, no parseFloat
 * (CLAUDE.md hard rule #2: prices are integer centavos, never floats).
 *
 * Accepted forms (optional "R$" prefix; spaces ignored):
 *   - "1.234,56"        — thousands-dotted, exactly 2 comma decimals
 *   - "50,00" / "50,5"  — comma decimal with 1–2 fraction digits
 *   - "50"              — pure digits = whole reais
 *   - "50.00" / "1.05"  — dot decimal with 1–2 fraction digits (unambiguous:
 *                         a pt-BR thousands dot requires exactly 3 digits)
 *
 * Rejected → null:
 *   - "1.000" — ambiguous (thousands "1000" vs decimal "1,00")
 *   - zero / negative / signed amounts, and any other shape
 */
export function reaisStringToCentavos(raw: string): number | null {
  const s = raw.replace(/\s+/g, '').replace(/^R\$/i, '')
  if (!s) return null

  let intDigits: string
  let fracDigits: string

  if (s.includes(',')) {
    const m = /^(\d{1,3}(?:\.\d{3})*),(\d{2})$/.exec(s) ?? /^(\d+),(\d{1,2})$/.exec(s)
    if (!m) return null
    intDigits = m[1].replaceAll('.', '')
    fracDigits = m[2]
  } else if (/^\d+$/.test(s)) {
    intDigits = s
    fracDigits = ''
  } else {
    // A dot is only unambiguously decimal with 1–2 fraction digits; a bare
    // "1.000" (3 digits) could mean R$1.000,00 or R$1,00 — reject it.
    const m = /^(\d+)\.(\d{1,2})$/.exec(s)
    if (!m) return null
    intDigits = m[1]
    fracDigits = m[2]
  }

  const centavos =
    Number.parseInt(intDigits, 10) * 100 + Number.parseInt(fracDigits.padEnd(2, '0'), 10)
  if (!Number.isSafeInteger(centavos) || centavos <= 0) return null
  return centavos
}

/** pt-BR validation message shown when the typed amount cannot be parsed. */
export const INVALID_AMOUNT_PT_BR = 'Valor inválido — use vírgula para centavos, ex.: 50,00'
