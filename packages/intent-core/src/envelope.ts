/**
 * IntentEnvelope — the canonical mutation proposal.
 *
 * Every state-mutating action in an IBX-IGE system crosses the kernel as an
 * IntentEnvelope. The LLM proposes; the kernel disposes. The envelope carries
 * identity, provenance, version, and a replay key — it is the single load-bearing
 * contract that audit records reference, the kernel decides on, and the ledger
 * deduplicates by.
 */

import { sha256Canonical } from "./hash.js";
import type { Taint } from "./taint.js";

export const INTENT_ENVELOPE_VERSION = 1 as const;
export type IntentEnvelopeVersion = typeof INTENT_ENVELOPE_VERSION;

export interface IntentActor {
  readonly principal: "llm" | "user" | "system";
  readonly sessionId: string;
}

export interface IntentEnvelope<K extends string = string, P = unknown> {
  readonly version: IntentEnvelopeVersion;
  readonly kind: K;
  readonly payload: P;
  readonly createdAt: string; // ISO-8601
  readonly actor: IntentActor;
  readonly taint: Taint;
  /** sha256 of canonical(envelope minus intentHash). Computed once at construction. */
  readonly intentHash: string;
}

export interface BuildEnvelopeInput<K extends string, P> {
  readonly kind: K;
  readonly payload: P;
  readonly actor: IntentActor;
  readonly taint: Taint;
  /** Override for deterministic tests; defaults to new Date().toISOString(). */
  readonly createdAt?: string;
}

/**
 * Construct a fully-formed IntentEnvelope with a computed intentHash.
 * Hash is derived from everything except the hash itself, so reconstructing
 * an envelope from its fields produces the same hash.
 */
export function buildEnvelope<K extends string, P>(
  input: BuildEnvelopeInput<K, P>,
): IntentEnvelope<K, P> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const hashInput = {
    version: INTENT_ENVELOPE_VERSION,
    kind: input.kind,
    payload: input.payload,
    createdAt,
    actor: input.actor,
    taint: input.taint,
  };
  const intentHash = sha256Canonical(hashInput);
  return {
    version: INTENT_ENVELOPE_VERSION,
    kind: input.kind,
    payload: input.payload,
    createdAt,
    actor: input.actor,
    taint: input.taint,
    intentHash,
  };
}

/**
 * Narrow an unknown value to an IntentEnvelope of the given kind.
 * Consumed by the schema-version invariant test and by adjudicate() before
 * it inspects payload fields.
 */
export function isIntentEnvelope(value: unknown): value is IntentEnvelope {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<IntentEnvelope>;
  return (
    v.version === INTENT_ENVELOPE_VERSION &&
    typeof v.kind === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.intentHash === "string" &&
    v.actor !== undefined &&
    typeof v.actor.principal === "string" &&
    typeof v.actor.sessionId === "string" &&
    (v.taint === "SYSTEM" || v.taint === "TRUSTED" || v.taint === "UNTRUSTED")
  );
}

/**
 * Returns true iff the value has a recognizable envelope shape but an
 * unsupported version field. Used by the kernel to emit a SECURITY refusal
 * with code "schema_version_unsupported" rather than crashing.
 */
export function hasUnknownEnvelopeVersion(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const v = value as { version?: unknown };
  return (
    v.version !== undefined &&
    v.version !== INTENT_ENVELOPE_VERSION &&
    typeof v.version === "number"
  );
}
