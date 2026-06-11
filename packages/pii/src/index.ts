/**
 * @ibatexas/pii — canonical Brazilian-PII pattern taxonomy.
 *
 * SINGLE SOURCE OF TRUTH for PII detection/redaction, shared by:
 *   - the DECISION-layer guard (`createDataClassificationGuard` from
 *     `@adjudicate/primitives`) — consumes {@link PII_PATTERNS} as its
 *     `patterns`, REWRITE-to-sentinel before the executor runs; and
 *   - the AUDIT-layer redactor (`@ibatexas/audit-sink`) — consumes the raw
 *     regexes + {@link PII_SENTINELS} + {@link isSentinelString} for
 *     value-scrubbing on the persisted `AuditRecord`.
 *
 * Keeping both off one taxonomy removes the drift hazard the adversarial audit
 * flagged (guard and redactor masking different things).
 *
 * LEAF PACKAGE — ZERO `@adjudicate/*` and `@ibatexas/*` runtime deps. That lets
 * the portable `@adjudicate`-only Packs, the `@ibatexas/audit-sink` leaf, and
 * `@ibatexas/domain` all depend on it without a cycle. {@link PiiPattern} is
 * structurally identical to `@adjudicate/primitives`' `DataClassificationPattern`,
 * so `PII_PATTERNS` is accepted directly as that guard's `patterns` with no
 * import of the kernel type.
 *
 * Patterns are tuned tighter than analytics sanitizers — anchored CPF, +55
 * phone, 13–19 digit card — to avoid false-positives on order ids / prices.
 * They carry the `g` flag for the redactor's `String.replace`; the guard rebuilds
 * each regex from `.source` (stripping `g`) so the shared object is never used
 * with stateful `.test()`.
 */

/**
 * One PII detection rule. Structurally compatible with
 * `@adjudicate/primitives`' `DataClassificationPattern`.
 */
export interface PiiPattern {
  /** Stable id for audit detail + dedup, e.g. "cpf", "email", "pan". */
  readonly id: string;
  /** Regex matched against stringified leaf field values. */
  readonly pattern: RegExp;
  /**
   * Redaction replacement applied per match on a REWRITE. Receives the matched
   * substring; returns the masked string. Returns a stable sentinel here so
   * guard- and redactor-produced output are byte-identical (idempotent).
   */
  readonly redact: (match: string) => string;
}

/** Stable redaction sentinels. Output of both the guard and the redactor. */
export const PII_SENTINELS = {
  FIELD: "[REDACTED]",
  CPF: "[REDACTED:CPF]",
  EMAIL: "[REDACTED:EMAIL]",
  PHONE: "[REDACTED:PHONE]",
  CARD: "[REDACTED:CARD]",
  TRUNCATED: "[REDACTED:TRUNCATED]",
} as const

/** Prefix the redactor uses for salted-hash outputs (`hashed:<8hex>`). */
export const HASH_PREFIX = "hashed:"

// ── Raw value-scanning regexes (g-flagged) ─────────────────────────────────────
// Ported verbatim from the audit-redactor's tuned set so migrating it to this
// module is behavior-preserving. Do NOT loosen without updating the redactor's
// idempotency/hash-stability tests.

// CPF: canonical 11-digit shape with optional separators. The lookahead only
// blocks another digit (so "12345678900-foo" still fires — deep-audit bug #7);
// the lookbehind blocks mid-sequence matches in a longer number.
export const CPF_RE = /(?<![\d.-])(\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?!\d)/g
export const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g
// Brazilian phone shapes: +55 / 55 / (11) / 11999999999 / 1199999999 / DDI-13.
export const PHONE_RE =
  /(?<!\d)(?:\+?55)?\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}(?!\d)/g
// Visa/MC/Amex-family 13–19 digit run, embedded separators allowed.
export const CARD_RE = /(?<!\d)(?:\d[\s-]?){13,19}(?!\d)/g

/**
 * The canonical PII pattern set, in declared order (matters for deterministic
 * `detectedPatterns` / `redactedFields` ordering in the guard's replay basis).
 * Pass directly as `createDataClassificationGuard({ patterns: PII_PATTERNS, … })`.
 */
export const PII_PATTERNS: ReadonlyArray<PiiPattern> = [
  { id: "cpf", pattern: CPF_RE, redact: () => PII_SENTINELS.CPF },
  { id: "email", pattern: EMAIL_RE, redact: () => PII_SENTINELS.EMAIL },
  { id: "phone", pattern: PHONE_RE, redact: () => PII_SENTINELS.PHONE },
  { id: "pan", pattern: CARD_RE, redact: () => PII_SENTINELS.CARD },
]

const SENTINEL_SET: ReadonlySet<string> = new Set([
  PII_SENTINELS.FIELD,
  PII_SENTINELS.CPF,
  PII_SENTINELS.EMAIL,
  PII_SENTINELS.PHONE,
  PII_SENTINELS.CARD,
  PII_SENTINELS.TRUNCATED,
])

/**
 * True when `s` is already redactor output — an exact sentinel match or a
 * `hashed:` prefix. Anchored (exact) so a free-form string that merely contains
 * a sentinel is not treated as already-redacted. Used for redactor idempotency.
 */
export function isSentinelString(s: string): boolean {
  return SENTINEL_SET.has(s) || s.startsWith(HASH_PREFIX)
}
