import { randomBytes } from "node:crypto";

/**
 * Validate and return an environment variable used as a secret.
 * - In production/dev: throws if missing or too short.
 * - In test: generates a random secret if missing.
 */
export function requireSecret(name: string, minLength = 32): string {
  const value = process.env[name];

  if (process.env.NODE_ENV === "test" && !value) {
    return randomBytes(32).toString("base64");
  }

  if (!value) {
    throw new Error(`${name} env var is required`);
  }

  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters`);
  }

  return value;
}
