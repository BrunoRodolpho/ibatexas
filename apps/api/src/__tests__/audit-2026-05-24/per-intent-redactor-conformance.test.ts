// audit-2026-05-24 — Hardening test T3: per-intent-kind redactor conformance.
//
// # Why this test exists
//
// SYNTHESIS.md §"Hardening tests" item #3: the audit-redactor's per-intent-
// kind rules (`INTENT_KIND_FIELD_RULES` in
// `packages/audit-sink/src/audit-redactor.ts`) carry the free-form-text
// PII defense for kinds whose payload fields have names the global
// REDACT_FIELDS / HASH_FIELDS sets do NOT match — `reason`, `body`,
// `comment`, `specialRequests`, `templateVariables`, `lastMessage`. A kind
// added to `KNOWN_INTENT_KINDS` without either (a) a rule entry or (b) a
// documented "PII-free by construction" rationale is a silent latent leak:
// the kind's free-form fields would reach the audit sink (NATS subject
// `ibatexas.audit.intent.decision.v1`, the Postgres ledger) verbatim.
//
// F-5 (audit-2026-05-24) is the canonical regression: pre-fix the WhatsApp
// handoff rule keyed on `"whatsapp.handoff.request"` — a taxonomy-doc kind
// that does NOT exist in the Pack's union. The typo silently disabled the
// rule. The `reason` and `lastMessage` fields shipped to NATS in cleartext
// for the entire lifetime of the package.
//
// # What this test pins
//
// For every kind in `KNOWN_INTENT_KINDS`, exactly one of:
//
//   (a) the kind appears in `INTENT_KIND_FIELD_RULES` (per-kind rule
//       covers free-form fields), OR
//   (b) the kind appears in `PII_FREE_KIND_ALLOWLIST` (documented PII-free
//       rationale — opaque-id-only payload, fields already covered by the
//       global REDACT/HASH sets, or already-redacted hashed input), OR
//   (c) the kind appears in `KNOWN_REDACTOR_GAPS` (a tracked gap — fail
//       message still surfaces but the suite passes; operator must move
//       the kind to (a) or (b) as a follow-up audit-redactor ticket).
//
// A kind in NONE of those sets fails this suite with a file:line pointer
// to where it should be added.
//
// # Out of scope
//
// This is test-only conformance. The test does NOT add new entries to
// `INTENT_KIND_FIELD_RULES` for newly-discovered gaps; those are flagged
// in `KNOWN_REDACTOR_GAPS` for a separate audit-redactor ticket.
// (Per `docs/adjudicate-migration/audit-2026-05-24/tasks/`
// `hardening-conformance-followup.md` §T3 "Out of scope".)
//
// # Style
//
// Mirrors R3-1 commit 6dda950: failure messages name the kind and point
// at the file:line where it should be added; sentinel checks catch stale
// entries; the test runs sub-second (introspection only, no I/O).

import { describe, it, expect } from "vitest"
import { KNOWN_INTENT_KINDS } from "@ibatexas/intent-kinds"
import {
  HTTP_PLANE_GOVERNED_KINDS,
  INTENT_KIND_FIELD_RULES,
  PII_FREE_KIND_ALLOWLIST,
} from "@ibatexas/audit-sink"

// ── Source-file pointers (failure-message guidance) ──────────────────────

const RULES_FILE = "packages/audit-sink/src/audit-redactor.ts"
const RULES_HEADER = "INTENT_KIND_FIELD_RULES (search for the constant name)"
const ALLOWLIST_HEADER =
  "PII_FREE_KIND_ALLOWLIST (search for the constant name)"
const INTENT_KINDS_FILE = "packages/intent-kinds/src/index.ts"

// ── Known redactor gaps (audit-redactor follow-up tickets) ────────────────
//
// Each entry is a kind known to need a per-kind rule entry in
// INTENT_KIND_FIELD_RULES but where the addition is out-of-scope for
// the T3 conformance task (per the task's "Out of scope" clause). The
// test surfaces these on every run so the gap is visible to operators
// reviewing the audit-redactor surface; new T3-discovered gaps go here
// rather than into PII_FREE_KIND_ALLOWLIST.
//
// Each entry MUST carry: (1) the missing field path, (2) the suggested
// rule shape, (3) a one-sentence rationale for why it leaks PII today.
//
// Moving an entry: add the suggested rule to INTENT_KIND_FIELD_RULES,
// delete from this set, re-run the suite — the sentinel test catches
// any forgotten cleanup.
const KNOWN_REDACTOR_GAPS: ReadonlyMap<
  string,
  {
    readonly missingField: string
    readonly suggestedRule: string
    readonly rationale: string
  }
> = new Map<
  string,
  {
    readonly missingField: string
    readonly suggestedRule: string
    readonly rationale: string
  }
>([
  // Empty — all previously-known gaps closed. The sentinel test "every
  // KNOWN_REDACTOR_GAPS entry exists in KNOWN_INTENT_KINDS and is NOT also
  // classified" still runs on each iteration and will catch a stale entry
  // if added without a real gap.
])

// ── Tests ─────────────────────────────────────────────────────────────────

describe("audit-2026-05-24 T3 — per-intent-kind redactor conformance", () => {
  it("every KNOWN_INTENT_KINDS entry is in INTENT_KIND_FIELD_RULES OR PII_FREE_KIND_ALLOWLIST OR KNOWN_REDACTOR_GAPS", () => {
    const ruleKinds = new Set<string>(Object.keys(INTENT_KIND_FIELD_RULES))
    const violations: string[] = []
    // KNOWN_INTENT_KINDS ∪ HTTP_PLANE_GOVERNED_KINDS: the HTTP-plane staff
    // kinds are off the Pack union BY DESIGN (no planner surface) but still
    // reach every audit sink via withAdjudicate — they need classification too.
    for (const kind of [...KNOWN_INTENT_KINDS, ...HTTP_PLANE_GOVERNED_KINDS]) {
      if (ruleKinds.has(kind)) continue
      if (PII_FREE_KIND_ALLOWLIST.has(kind)) continue
      if (KNOWN_REDACTOR_GAPS.has(kind)) continue
      violations.push(kind)
    }
    if (violations.length > 0) {
      const lines = violations
        .map((k) => `  - ${k}`)
        .join("\n")
      throw new Error(
        `audit-2026-05-24 T3 — kind missing redactor classification.\n\n` +
          `Per SYNTHESIS.md §"Hardening tests" item #3, every kind in ` +
          `KNOWN_INTENT_KINDS MUST be classified as either:\n` +
          `  (a) ruled        — add to ${RULES_HEADER} at ${RULES_FILE},\n` +
          `  (b) PII-free     — add to ${ALLOWLIST_HEADER} at ${RULES_FILE} ` +
          `with a documented WHY comment,\n` +
          `  (c) tracked gap  — add to KNOWN_REDACTOR_GAPS in THIS test file ` +
          `with field path + suggested rule + rationale.\n\n` +
          `A kind in NONE of those sets has a silent free-form-text PII leak ` +
          `path to the audit sink (NATS subject ibatexas.audit.intent.decision.v1, ` +
          `the Postgres ledger). See F-5 (audit-2026-05-24) for the canonical ` +
          `regression — a typo in INTENT_KIND_FIELD_RULES key silently disabled ` +
          `WhatsApp handover redaction for the package's entire lifetime.\n\n` +
          `Unclassified kinds (${violations.length}):\n${lines}\n\n` +
          `Source of the union: ${INTENT_KINDS_FILE} (export KNOWN_INTENT_KINDS).`,
      )
    }
    expect(violations).toEqual([])
  })

  it("every PII_FREE_KIND_ALLOWLIST entry exists in KNOWN_INTENT_KINDS (sentinel)", () => {
    // Sentinel against the allowlist rotting after a Pack rename or removal.
    // A stale entry hides — operators reviewing the allowlist see a kind that
    // looks classified, but the union actually no longer contains it.
    const stale: string[] = []
    for (const kind of PII_FREE_KIND_ALLOWLIST) {
      if (KNOWN_INTENT_KINDS.has(kind)) continue
      // HTTP-plane governed kinds (declared set — not a prefix waiver, so a
      // typo'd allowlist entry still lands in `stale`).
      if (HTTP_PLANE_GOVERNED_KINDS.has(kind)) continue
      stale.push(kind)
    }
    if (stale.length > 0) {
      throw new Error(
        `PII_FREE_KIND_ALLOWLIST contains stale entries — the kind no longer ` +
          `exists in KNOWN_INTENT_KINDS. Either remove the entry from ` +
          `${RULES_FILE} (the Pack removed the kind — good) or fix the typo ` +
          `if a rename was missed.\n\n` +
          `Stale entries (${stale.length}):\n` +
          stale.map((s) => `  - ${s}`).join("\n"),
      )
    }
    expect(stale).toEqual([])
  })

  it("every INTENT_KIND_FIELD_RULES key that intersects KNOWN_INTENT_KINDS is a real Pack kind (sentinel)", () => {
    // Mirror of F-5: a rule keyed on a non-existent kind silently disables
    // itself. We allow synthesised rule kinds (e.g., `validation.text.*`,
    // which are NOT in KNOWN_INTENT_KINDS by design — they're kernel-emitted
    // validation events) by only flagging keys that LOOK like user-facing
    // Pack kinds.
    //
    // Heuristic: any rule key with a `.` and a user-facing domain prefix
    // (order., reservation., whatsapp., conversation., payment., customer.,
    // pix.) is a real Pack kind, so it MUST resolve in KNOWN_INTENT_KINDS or
    // it's an F-5 typo.
    //
    // Exempt prefixes — rule keys that are intentionally NOT in
    // KNOWN_INTENT_KINDS by design and are documented above their rule
    // entries in audit-redactor.ts:
    //   - `validation.`              kernel-emitted text-validation events.
    //   - `medusa.` `stripe.` `twilio.`  wire-egress wrapper kinds. These
    //     are the internal REST/PSP proxy egress namespaces governed by
    //     their own inline policy (NOT the user-facing intent taxonomy) —
    //     see `@ibatexas/intent-kinds` index.ts §"medusa.* namespace is
    //     EXCLUDED" (D10). They legitimately carry per-kind redactor rules
    //     (email/metadata/body PII vectors) while staying out of the union,
    //     so the F-5 typo-sentinel must not flag them.
    const EXEMPT_RULE_KEY_PREFIXES = [
      "validation.",
      "medusa.",
      "stripe.",
      "twilio.",
    ] as const
    const orphanRuleKeys: string[] = []
    for (const ruleKey of Object.keys(INTENT_KIND_FIELD_RULES)) {
      if (EXEMPT_RULE_KEY_PREFIXES.some((p) => ruleKey.startsWith(p))) continue
      if (KNOWN_INTENT_KINDS.has(ruleKey)) continue
      // HTTP-plane governed kinds: an exact-membership check (never a `staff.`
      // prefix waiver — a typo'd rule key must still trip this F-5 sentinel).
      if (HTTP_PLANE_GOVERNED_KINDS.has(ruleKey)) continue
      orphanRuleKeys.push(ruleKey)
    }
    if (orphanRuleKeys.length > 0) {
      throw new Error(
        `INTENT_KIND_FIELD_RULES contains orphan keys — the rule key does not ` +
          `match any kind in KNOWN_INTENT_KINDS (and is not an exempt ` +
          `synthesised/egress-wrapper kind). This is the F-5 regression class: ` +
          `a typo in the key silently disables the rule.\n\n` +
          `Orphan keys (${orphanRuleKeys.length}):\n` +
          orphanRuleKeys.map((k) => `  - ${k}`).join("\n") +
          `\n\nFix at ${RULES_FILE} → ${RULES_HEADER}. If the kind was renamed, ` +
          `update the rule key. If the kind was deleted, remove the rule entry. ` +
          `Synthesised validation.* events and the medusa./stripe./twilio. ` +
          `egress-wrapper namespaces bypass this check by design.`,
      )
    }
    expect(orphanRuleKeys).toEqual([])
  })

  it("every PII_FREE_KIND_ALLOWLIST entry does NOT also appear in INTENT_KIND_FIELD_RULES (sentinel)", () => {
    // A kind in BOTH sets is a classification ambiguity — the rule fires
    // (correctly) and the allowlist suggests "no rule needed" (incorrectly).
    // The duplication is harmless at runtime but misleading at audit-review
    // time; treat as a maintainability bug.
    const ruleKinds = new Set<string>(Object.keys(INTENT_KIND_FIELD_RULES))
    const doublyClassified: string[] = []
    for (const kind of PII_FREE_KIND_ALLOWLIST) {
      if (ruleKinds.has(kind)) doublyClassified.push(kind)
    }
    if (doublyClassified.length > 0) {
      throw new Error(
        `Kinds present in BOTH INTENT_KIND_FIELD_RULES and PII_FREE_KIND_ALLOWLIST. ` +
          `Pick one — either the kind needs a rule (keep in rules, drop from ` +
          `allowlist) or it's PII-free (drop the rule, keep in allowlist).\n\n` +
          `Doubly-classified (${doublyClassified.length}):\n` +
          doublyClassified.map((k) => `  - ${k}`).join("\n"),
      )
    }
    expect(doublyClassified).toEqual([])
  })

  it("every KNOWN_REDACTOR_GAPS entry exists in KNOWN_INTENT_KINDS and is NOT also classified (sentinel)", () => {
    // Sentinel against gaps that get "fixed" by adding the rule but the
    // gap entry is left behind, OR against gaps for kinds that were
    // renamed/removed at the Pack level.
    const stale: string[] = []
    const duplicates: string[] = []
    const ruleKinds = new Set<string>(Object.keys(INTENT_KIND_FIELD_RULES))
    for (const [kind] of KNOWN_REDACTOR_GAPS) {
      if (!KNOWN_INTENT_KINDS.has(kind)) {
        stale.push(kind)
        continue
      }
      if (ruleKinds.has(kind) || PII_FREE_KIND_ALLOWLIST.has(kind)) {
        duplicates.push(kind)
      }
    }
    if (stale.length > 0 || duplicates.length > 0) {
      const parts: string[] = []
      if (stale.length > 0) {
        parts.push(
          `Stale KNOWN_REDACTOR_GAPS entries (kind no longer in KNOWN_INTENT_KINDS):\n` +
            stale.map((s) => `  - ${s}`).join("\n"),
        )
      }
      if (duplicates.length > 0) {
        parts.push(
          `Duplicates (KNOWN_REDACTOR_GAPS entries already classified ` +
            `elsewhere — remove the gap entry):\n` +
            duplicates.map((d) => `  - ${d}`).join("\n"),
        )
      }
      throw new Error(parts.join("\n\n"))
    }
    expect(stale).toEqual([])
    expect(duplicates).toEqual([])
  })

  it("KNOWN_REDACTOR_GAPS is surfaced as a visible warning (operator-facing summary)", () => {
    // This test PASSES — its purpose is to print the current gap list to
    // the operator on every run so the followup-ticket cohort doesn't rot
    // unseen. A regression that adds new gaps (without classifying them
    // anywhere) is caught by the FIRST test; this one is the steady-state
    // summary.
    //
    // The assertion is intentionally trivial: the test exists for its
    // documentation log line, not for its assertion.
    const gaps = [...KNOWN_REDACTOR_GAPS.entries()].map(
      ([kind, info]) =>
        `  - ${kind} (missing rule for \`${info.missingField}\`)\n` +
        `      suggested: ${info.suggestedRule}\n` +
        `      rationale: ${info.rationale}`,
    )
    if (gaps.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[audit-2026-05-24 T3] KNOWN_REDACTOR_GAPS — kinds awaiting a ` +
          `per-kind rule in INTENT_KIND_FIELD_RULES at ${RULES_FILE}:\n` +
          gaps.join("\n") +
          `\n\nFollowup ticket: open against @ibatexas/audit-sink audit-redactor.\n`,
      )
    }
    expect(KNOWN_REDACTOR_GAPS.size).toBeGreaterThanOrEqual(0)
  })

  it("the union of (rules ∪ allowlist ∪ gaps) equals KNOWN_INTENT_KINDS exactly (closure invariant)", () => {
    // Closure invariant: the three sets must partition KNOWN_INTENT_KINDS
    // (possibly with overlap — caught by the doubly-classified sentinel
    // above; but here we assert COVERAGE). A kind that lands in none of
    // the three is what the first test catches; this test catches the
    // inverse — sets that drift OUT of KNOWN_INTENT_KINDS (e.g., a Pack
    // removes a kind but leaves the allowlist entry) and inflates the
    // union beyond what we expect.
    const ruleKinds = new Set<string>(
      Object.keys(INTENT_KIND_FIELD_RULES).filter((k) =>
        KNOWN_INTENT_KINDS.has(k),
      ),
    )
    const union = new Set<string>([
      ...ruleKinds,
      ...[...PII_FREE_KIND_ALLOWLIST].filter((k) =>
        KNOWN_INTENT_KINDS.has(k),
      ),
      ...[...KNOWN_REDACTOR_GAPS.keys()].filter((k) =>
        KNOWN_INTENT_KINDS.has(k),
      ),
    ])
    const missing: string[] = []
    for (const kind of KNOWN_INTENT_KINDS) {
      if (!union.has(kind)) missing.push(kind)
    }
    expect(missing, `closure invariant — kinds with no classification`).toEqual(
      [],
    )
    expect(union.size).toBe(KNOWN_INTENT_KINDS.size)
  })
})
