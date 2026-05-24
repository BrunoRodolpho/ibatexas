# Hardening conformance — followup suites

**Status:** 🟡 PARTIAL — T2 + T4 blocked on H2 / H3; T3 + T6 ready now.
**Closes:** the SYNTHESIS.md §"Hardening tests" recommended-additions list, items #2-#4 + #6 (items #1, #5, #7 landed in R3-1).

---

## Already landed (R3-1, commit `6dda950`)

- **T1** NX-park static-import conformance — `apps/api/src/__tests__/bypass-detection/nx-park-conformance.test.ts`
- **T5** DEFER+resume integrity — `apps/api/src/__tests__/audit-2026-05-24/defer-resume-integrity.test.ts`
- **T7** Idempotency-key conformance + 14-entry allowlist — `apps/api/src/__tests__/audit-2026-05-24/idempotency-key-conformance.test.ts`

## Still pending

### T2 — AuditSink wrapper-call conformance (blocked on H2)

**Status:** 🚧 do not start before H2 lands.
**Purpose:** assert every wrapper call site supplies `auditSink`.
**Approach (if H2 Option A):** static-grep walker that finds every `medusaAdjudicated`, `medusaStoreAdjudicated`, `stripeAdjudicated`, `twilioAdjudicated` call and asserts either `auditSink:` in the same meta object literal OR the site is in a documented allowlist (mirroring T7).
**Approach (if H2 Option B):** unit test asserting `__getDefaultAuditSink()` is non-undefined at app boot.
**Approach (if H2 Option C):** static-grep walker asserting every wrapper-return value is followed by an `auditSink.emit(...)` call.
**Effort:** ~1-2h after H2.
**Bundle with H2 sub-agent.**

### T3 — Per-intent-kind redactor conformance (ready)

**Purpose:** for each kind in `KNOWN_INTENT_KINDS`, assert either a per-kind rule exists in `INTENT_KIND_FIELD_RULES` OR the payload is provably PII-free (an allowlist with documented rationale per kind).
**File:** `packages/llm-provider/src/audit-redactor.ts` + new test at `apps/api/src/__tests__/audit-2026-05-24/per-intent-redactor-conformance.test.ts`.
**Approach:** import `KNOWN_INTENT_KINDS` (or its equivalent — confirm location via `grep -rn "INTENT_KIND_FIELD_RULES" packages/`); iterate; for each kind, assert membership in either `INTENT_KIND_FIELD_RULES` keys or a `PII_FREE_KIND_ALLOWLIST` array (new; documented per-kind reason).
**Effort:** ~2-3h.

### T4 — LGPD scrub conformance (blocked on H3)

**Status:** 🚧 do not start before H3 lands.
**Purpose:** snapshot every table reachable from `customerId`; assert post-anonymize zero rows match the pre-anonymize PII fixtures.
**Bundle with H3 sub-agent.**

### T6 — Sweeper-resolver race regression test (ready)

**Purpose:** schedule both the sweeper and the resume-dispatcher within 50ms; assert at most one mutation fires.
**File:** new test at `apps/api/src/__tests__/audit-2026-05-24/sweeper-resolver-race.test.ts`.
**Approach:** real Redis testcontainer; spin up sweeper + resolver against the same parked envelope; race them within 50ms via `setTimeout`; assert: (a) exactly one `defer:resuming:` SETNX succeeds, (b) exactly one mutation executes, (c) the loser logs a `cancel_won_race`-equivalent reason and exits cleanly without emitting a duplicate audit.
**Effort:** ~1-2h.

---

## Parallelization plan

| Sub-agent | Items | Blocked by | Est. time |
|---|---|---|---|
| **Conformance-A** | T3 + T6 | none — ready now | 3-5h |
| **Conformance-B** | T2 | H2 lands | 1-2h |
| **Conformance-C** | T4 | H3 lands | bundled with H3 (~2-3h additional) |

## Ready-to-spawn sub-agent prompts

### Conformance-A (T3 + T6)

> You are the T3 + T6 hardening conformance agent. Per `docs/adjudicate-migration/audit-2026-05-24/tasks/hardening-conformance-followup.md` §T3 + §T6. Two new test files, no production code changes. T3: per-intent-kind redactor conformance — iterate `KNOWN_INTENT_KINDS`; require a `INTENT_KIND_FIELD_RULES` entry OR documented `PII_FREE_KIND_ALLOWLIST` membership. T6: sweeper-resolver race regression — real Redis testcontainer (use the existing testcontainer harness pattern from R2-2 anonymize race test); race within 50ms; assert single-mutation invariant. Match the R3-1 style: each suite fails clearly with file:line pointers and operator guidance. Commit: `test(api,llm-provider,audit-2026-05-24-T3+T6): per-intent-redactor + sweeper-resolver-race conformance suites`. Repo conventions per CLAUDE.md. Run only the new tests + the wrapper unit tests for any types you import. **If you discover a kind without a redactor rule AND no plausible PII-free rationale, flag it as a finding rather than silently allowlisting.**

### Conformance-B (T2) — defer

Spawn only after H2 lands. Specific prompt depends on H2 option chosen; defer prompt-writing until then.

### Conformance-C (T4) — bundle with H3

T4 is part of the H3 sub-agent's acceptance criteria (per the H3 task file). Do not spawn separately.

## Risk classification

- **Blast radius:** zero (test-only; no production code change)
- **Reversibility:** trivial (delete the file)
- **Replay impact:** none direct; protects future regression of replay-relevant invariants
