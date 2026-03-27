/** PII key names to strip (both en and pt-BR). */
const PII_KEYS = new Set([
  "email", "phone", "cpf", "name", "address",
  "nome", "telefone", "endereco", "celular", "rg",
]);

/** Patterns that likely contain PII values. */
const PII_PATTERNS = [
  /\S+@\S+\.\S+/,                                  // email
  /(\+55)?\s?\(?\d{2}\)?\s?\d{4,5}[-\s]?\d{4}/,   // BR phone
  /\d{3}\.?\d{3}\.?\d{3}[-.]?\d{2}/,               // CPF
];

const MAX_VALUE_LENGTH = 500;

/**
 * Strip PII keys and redact values matching PII patterns.
 * Returns a new object — does not mutate input.
 */
export function sanitizeProperties(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    if (PII_KEYS.has(key.toLowerCase())) continue;

    if (typeof value === "string") {
      const redacted = PII_PATTERNS.some((p) => p.test(value));
      result[key] = redacted
        ? "[REDACTED]"
        : value.length > MAX_VALUE_LENGTH
          ? value.slice(0, MAX_VALUE_LENGTH)
          : value;
    } else {
      result[key] = value;
    }
  }

  return result;
}
