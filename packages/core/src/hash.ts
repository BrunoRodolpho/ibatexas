/**
 * Canonical hashing for IntentEnvelopes.
 *
 * sha256 over a canonical JSON serialization — key order is deterministic so
 * the same envelope produces the same intentHash regardless of construction
 * order. This is the replay key consumed by the Execution Ledger.
 *
 * Uses node:crypto (no external dep). Works in any Node 22+ environment.
 */

import { createHash } from "node:crypto";

/**
 * Recursively canonicalize a value: objects get their keys sorted, arrays stay
 * ordered, primitives pass through. null and undefined are normalized — undefined
 * fields are omitted so `{a: undefined}` and `{}` hash identically.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = canonicalize(v);
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Compute sha256 hex over the canonical JSON of the input. */
export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
