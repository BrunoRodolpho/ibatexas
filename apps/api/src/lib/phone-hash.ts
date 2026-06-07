// Centralized phone-number pseudonymization.
//
// A phone number is PII (LGPD) and the WhatsApp identity. When we need a
// log-safe pseudonym or a Redis key derived from a phone, we hash it with a
// keyed HMAC under a server-side pepper rather than a bare SHA-256:
//   - keyed: an attacker who knows the algorithm still cannot brute-force the
//     ~10^11 phone keyspace without the pepper, so the output is not reversible
//     PII (unlike a plain hash, which is trivially rainbow-tabled).
//   - full-length: we do NOT truncate. The old 48-bit truncation collided in
//     the rate-limit/dedup keyspace (~50% collision at ~16.8M phones), letting
//     one user's failures bleed into another's limits.
//
// This is the single source of truth — every site that needs a phone hash must
// call hashPhone() here. Changing the pepper rotates all derived Redis keys.

import { createHmac } from "node:crypto";
import { requireSecret } from "../utils/require-secret.js";

/**
 * Keyed, full-length one-way hash of a phone number — safe to log and to use
 * as a Redis key component.
 *
 * Requires `PHONE_HASH_PEPPER` (server-side secret). In production/dev a missing
 * or too-short value throws at first use; in test a random pepper is generated.
 */
export function hashPhone(phone: string): string {
  return createHmac("sha256", requireSecret("PHONE_HASH_PEPPER"))
    .update(phone)
    .digest("hex");
}
