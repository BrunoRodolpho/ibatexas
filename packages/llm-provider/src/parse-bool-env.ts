// parseBoolEnv — strict-yet-tolerant boolean env-var parser.
//
// ── Why this helper exists (NEW-P1-ENV, deep-audit hidden bug #9 + 09 #11) ─
//
// 7+ sites in the IbateXas codebase were using `process.env.X === "true"`
// to gate behaviour (Postgres audit enabled, NATS TLS required, ledger
// enforce, etc.). Common operator inputs silently fell through to false:
//
//   "TRUE", "True"      → false (case mismatch)
//   "1"                  → false (numeric flag)
//   "yes", "on"          → false
//   " true "             → false (whitespace from .env)
//
// Production impact: setting `IBX_AUDIT_POSTGRES_ENABLED=TRUE` silently
// disabled the Postgres audit sink while ops dashboards reported a
// healthy configuration. Same hazard for `IBX_LEDGER_*`,
// `NATS_TLS_REQUIRED`, and several others.
//
// This helper centralises the parse so all sites share one truth table:
//
//   Input (case-insensitive, trimmed)   parseBoolEnv returns
//   ─────────────────────────────────   ────────────────────
//   "true", "1", "yes", "on"            true
//   "false", "0", "no", "off"           false
//   "" (empty string)                   defaultValue
//   undefined                           defaultValue
//   anything else (typo)                defaultValue
//
// Callers MUST pass their existing default — the helper does not assume
// either polarity. This preserves the behaviour for valid existing
// inputs while closing the silent-flip vulnerability for typos.
//
// Why not throw on typos?
//
// The bug spec mandates accept `true|1|yes` (any case) as true; "everything
// else as false" was the literal recommendation. We err on the side of the
// caller-supplied defaultValue for unrecognised inputs (which includes
// typos) — that's the existing pre-fix behaviour for ANY non-"true"
// string, just generalised. Aggressive throw-on-typo would be a separate
// hardening and is not scope here.

const TRUTHY = new Set(["true", "1", "yes", "on"])
const FALSY = new Set(["false", "0", "no", "off"])

/**
 * Parse a string env-var value as a boolean with the canonical truthy/falsy
 * lexicon (case-insensitive). See module header for the full truth table.
 *
 * @param value         The raw env-var value (typically `process.env.X`).
 * @param defaultValue  Returned when the value is undefined, empty, or
 *                      unrecognised. Each call site passes its own default
 *                      to avoid encoding a global polarity into the helper.
 */
export function parseBoolEnv(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue
  const v = value.trim().toLowerCase()
  if (v.length === 0) return defaultValue
  if (TRUTHY.has(v)) return true
  if (FALSY.has(v)) return false
  return defaultValue
}
