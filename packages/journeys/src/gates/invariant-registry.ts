// gates/invariant-registry.ts — minimal invariant-id registry (T1a-2).
//
// `verify[]` entries in a journey file name an invariant id plus
// harness-bound args. `ibx journey lint` requires every referenced id to
// resolve against THIS registry — an unknown id is a lint error
// (`unknown_invariant`), so a typo'd or not-yet-implemented invariant can
// never silently pass as "verified".
//
// This is deliberately a PLACEHOLDER registry of ids only: T1a-7 (audit
// oracle) and T1a-13 (first green journey) bind the real harness
// implementations behind these ids. The registry is append-only — removing
// or renaming an id breaks every journey that references it, so renames go
// through a deprecation entry, never an in-place edit.

/**
 * Known goal-state invariant ids, resolvable from journey `verify[]` refs.
 *
 *   order.goal-state        → order projection goal-state via the read-only
 *                             Prisma role (status + asserted fields);
 *                             tolerant of LGPD-anonymized payloads (T1a-6/13).
 *   reservation.goal-state  → reservation row goal-state via the read-only
 *                             Prisma role (T1a-13).
 *   cart.goal-state         → cart contents by product HANDLE (never raw
 *                             Medusa ids) via the public surface (T1a-13).
 *   audit.refusal-basis     → an audited REFUSE decision carries the exact
 *                             expected basis `{category, code}` — e.g. the
 *                             ledger replay-suppression refusal
 *                             `{category:"ledger", code:"replay_suppressed"}`
 *                             (T1a-7).
 */
export const KNOWN_INVARIANT_IDS: ReadonlySet<string> = new Set([
  "order.goal-state",
  "reservation.goal-state",
  "cart.goal-state",
  "audit.refusal-basis",
])
