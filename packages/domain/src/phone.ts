/**
 * Canonicalize a phone number to E.164 (P2-DATA-PHONENORM).
 *
 * Strips a `whatsapp:` prefix and common formatting (spaces, dashes, parens,
 * dots), then validates the E.164 shape. Used at every customer entry point
 * before the `@unique` phone lookup so the SAME number never splits into two
 * customer rows because one caller passed `whatsapp:+55…` or `+55 11 …` while
 * another passed the bare `+55…`.
 *
 * IMPORTANT — merge safety. This does NOT touch digits. In particular it does
 * NOT add or remove the Brazilian mobile 9th digit: `+5511999999999` (with the
 * 9) and `+551199999999` (without) stay DISTINCT. Canonicalizing the 9th digit
 * could MERGE two different customers — worse than the current split — so it is
 * deliberately out of scope. Formatting-only normalization is merge-safe: the
 * same digits always mean the same person.
 *
 * Idempotent on an already-canonical `+<digits>` string, so existing callers
 * that already validate E.164 (auth `PhoneSchema`, whatsapp `normalizePhone`)
 * receive the identical value back — semantics-preserving.
 */
export function toE164BR(input: string): string {
  const stripped = input.replace(/^whatsapp:/, "").replace(/[\s\-().]/g, "")
  if (!/^\+[1-9]\d{7,14}$/.test(stripped)) {
    throw new Error(`Invalid phone format: ${input}`)
  }
  return stripped
}
