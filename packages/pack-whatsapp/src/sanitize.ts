/**
 * @ibatexas/pack-whatsapp — customer-controlled-string sanitizer.
 *
 * Per investigation 08 P1 #4:
 *   "`handoff_to_human` can flood staff WhatsApp. No per-customer rate
 *    limit; user-controlled `reason` is template-injected into a
 *    staff-bound WhatsApp message."
 *
 * The sanitizer is the input-cleanse half of that fix (the rate-limit
 * is the volume half; both apply). When the LLM proposes a
 * `whatsapp.message.send` where `senderRole = "customer"` and the
 * recipient is staff (i.e., echoing a customer-supplied string into a
 * staff-bound WhatsApp message), the REWRITE guard in `policies.ts`
 * passes the body through this function and emits the rewritten
 * envelope.
 *
 * The sanitizer is intentionally narrow:
 *
 *   - Strip newline runs (CR / LF / Unicode LINE-SEPARATOR /
 *     Unicode PARAGRAPH-SEPARATOR) - removes the "newline injection"
 *     vector that breaks the staff message template.
 *   - Strip markdown control chars (`*`, `_`, `~`, `` ` ``) - removes
 *     bold/italic/strikethrough/code spans the customer could inject
 *     to mimic system formatting.
 *   - Strip zero-width chars (U+200B..U+200F, U+FEFF) - closes the
 *     "invisible char that breaks tokenization" vector.
 *   - Collapse whitespace runs to a single space.
 *   - Truncate to `WHATSAPP_SANITIZE_MAX_LENGTH` chars (default 100).
 *
 * What it does NOT do:
 *
 *   - PII detection - there's no CPF/email/phone regex here. The
 *     LLM-side `sanitizeToolResultForLLM` covers the LLM's view of PII;
 *     this function is for the staff-bound channel where the customer's
 *     literal string is the payload. A future enhancement may add PII
 *     redaction here.
 *   - Profanity filtering - out of scope.
 *
 * # Adversarial coverage
 *
 * The unit tests (`__tests__/sanitize.test.ts`) cover:
 *
 *   - newline-only injection
 *   - markdown-only injection
 *   - zero-width-only injection
 *   - combined newline + markdown + zero-width
 *   - oversized input (200 chars in -> 100 chars out)
 *   - empty string passthrough
 *   - whitespace-only input
 *   - mixed-case markdown chars
 *   - Unicode line separators (U+2028 / U+2029)
 *   - leading/trailing whitespace
 *   - template-injection bomb (combined attack)
 *
 * # Determinism
 *
 * Pure function. Identical input always produces identical output. The
 * REWRITE guard pipes the result through `buildEnvelope` so the
 * rewritten envelope's hash is deterministic too.
 */

import { WHATSAPP_SANITIZE_MAX_LENGTH } from "./types.js"

/**
 * Newline / paragraph-separator pattern. Newlines are REPLACED with a
 * single ASCII space (not deleted) so adjacent words don't fuse — the
 * sanitizer preserves token boundaries the customer's input implied,
 * just without the line break that would break a staff-bound template.
 *
 *   - `\r` (U+000D), `\n` (U+000A)   - CR / LF.
 *   - U+2028, U+2029                 - LINE / PARAGRAPH SEPARATOR.
 *
 * Built via `new RegExp(...)` rather than a literal regex because
 * U+2028 / U+2029 terminate regex literals in the ECMAScript grammar.
 * The constructor accepts a string literal where Unicode escapes are
 * honored, so the source file stays ASCII while preserving the
 * intended codepoints in the compiled pattern.
 */
const NEWLINE_PATTERN = new RegExp("[\\r\\n\\u2028\\u2029]", "g")

/**
 * Zero-width / markdown-control characters. These are DELETED rather
 * than replaced — they carry no semantic content the customer
 * intended for the staff reader.
 *
 *   - `*`, `_`, `~`, `` ` ``    - WhatsApp markdown control chars.
 *   - U+200B..U+200F            - zero-width family.
 *   - U+FEFF                    - byte-order mark / zero-width no-break space.
 */
const DELETE_PATTERN = new RegExp("[*_~`\\u200B-\\u200F\\uFEFF]", "g")

/**
 * Whitespace-run pattern - used after stripping to collapse runs of
 * spaces (tabs / NBSP / the spaces freshly introduced by
 * `NEWLINE_PATTERN`) to a single ASCII space.
 */
const WHITESPACE_RUN_PATTERN = /\s+/g

/**
 * Sanitize a customer-controlled string before it is emitted to a
 * staff-bound WhatsApp message. Pure / deterministic.
 *
 * Order of operations:
 *   1. Replace newline / line-separator chars with single space (so
 *      adjacent words stay separated for the staff reader).
 *   2. Delete markdown-control + zero-width chars.
 *   3. Collapse remaining whitespace runs to single space.
 *   4. Trim leading/trailing whitespace.
 *   5. Truncate to `WHATSAPP_SANITIZE_MAX_LENGTH` chars.
 *
 * The truncate uses `String.prototype.slice(0, N)` which counts UTF-16
 * code units, not grapheme clusters. For the adversarial cases this
 * Pack defends against (ASCII + Latin-1 + control chars), the
 * distinction does not matter. A future enhancement may switch to
 * grapheme-cluster truncation for full-emoji-safety.
 */
export function sanitizeCustomerString(input: string): string {
  if (typeof input !== "string") return ""
  const denewlined = input.replace(NEWLINE_PATTERN, " ")
  const deleted = denewlined.replace(DELETE_PATTERN, "")
  const collapsed = deleted.replace(WHITESPACE_RUN_PATTERN, " ").trim()
  if (collapsed.length <= WHATSAPP_SANITIZE_MAX_LENGTH) return collapsed
  return collapsed.slice(0, WHATSAPP_SANITIZE_MAX_LENGTH)
}
