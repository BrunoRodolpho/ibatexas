/**
 * Validate and return a required (non-secret) environment variable.
 *
 * Sibling of `requireSecret` with different semantics: no minimum length and
 * NO test-mode generated fallback — a generated value would be a bogus model
 * id that 404s at the provider, which is exactly the silent failure this
 * helper exists to prevent. Tests must set the variable explicitly.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} env var is required`);
  }

  return value;
}
