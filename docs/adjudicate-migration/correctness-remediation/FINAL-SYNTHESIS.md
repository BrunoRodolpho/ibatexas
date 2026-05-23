# Correctness Remediation — Final Synthesis

**Date:** 2026-05-23 (post-Wave 6 verification)
**Branch:** `feat/correctness-w1-reproduction` — 30 commits since deep-audit synthesis
**Verifiers:** 5 parallel (Red-Team, Operational Drill, Integration E2E, Governance Coverage, TS Cleanup) producing ~3,500 lines of independent findings + 17 red-team exploit-demonstration tests

---

## TL;DR

The remediation **substantially closed the 14 deep-audit P0s** with real evidence (failing-test → passing-test cycles, real Docker Redis, real Lua scripts). The atomic primitives are correct under stress (refund cap N=200 burst, OTP N=50 concurrent, DEFER park collision N=2). The audit pipeline, redactor, and boot sequence are wired correctly.

**BUT** Wave 6 verifiers discovered:
- **2 new exploitable bypasses** that the previous remediation missed (whitespace customerId, template-literal scan evasion)
- **6 new P0 bypass categories** the previous audit didn't enumerate (reservations, admin scheduler, customer onboarding, orderNote, Stripe SDK direct, fetchAdmin)
- **`verifyParkedEnvelopeHash` silently INERT** in production — adopter writes `e.actor.principal`, framework reads `e.actorPrincipal`. Tamper-at-rest detection disabled.
- **Operational tooling shipped but ghost-references remain** — kernel_audit_spill_bytes mismatch, MANAGER vs OWNER role drift, CLI bypasses two-person rule

**Recommendation:**
- 🟡 **CONDITIONAL GO** for Tier 1 shadow rollout after 4 fixes (~1-2 days)
- 🔴 **NO-GO** for Tier 3+4 enforce (refunds/LGPD/force-cancel) until 6 new P0 categories close + operational gaps resolved (~3-4 weeks)

---

## Wave-by-wave ledger

### Wave 1 — Reproduction-and-fix (19 P0/P1 closures, 4 clusters)

**21 commits with before/after evidence files in `docs/adjudicate-migration/correctness-remediation/evidence/`.**

| Cluster | Fixes | Approach |
|---|---|---|
| A — DEFER + audit | P0-7-TRUE (NX wrapper), P0-15+X5 (prototype pollution), X6 (NaN refund), P1-D (robust Redis get) | Adopter-side wrapper around framework primitives; 1000-iteration adversarial fuzz |
| B — Mutation bypasses | X8 (empty customerId), X2 (default-REFUSE), X4+R1-DELETE (9 bare-arg sites + delete @deprecated methods), X9 (multi-line bypass-detection) | Type-system enforcement; 13 PRE-EXISTING bypasses surfaced by the new detector → allow-listed → migrated in Wave 3 follow-up |
| C — Concurrency | X1 (boot race, Option B injection), X3 (NATS fail-CLOSED), P1-I (refund cap atomic Lua), X-OTP (atomic INCR+threshold) | Real Docker Redis for concurrency proofs (N=5, N=10 bursts) |
| D — Edge cases | P0-9 (enforce-config empty-trim), P0-5 (staffId null edge), X7 ($transaction timeout + batched scrub), CPF regex, parseBoolEnv helper | 7 known-unsafe `=== "true"` env checks migrated to canonical truthy lexicon |

### Wave 3 — Operational reality (4 agents + Medusa migration)

| Agent | Delivered |
|---|---|
| CLI + admin endpoint | Real `ibx kernel kill-switch enable/disable/status`, `POST /api/admin/kernel/kill-switch` with two-person rule, real `ibx kernel replay --since=24h`, `--intent-kind` SQL fix |
| Missing metrics | 11 ghost metrics now real (`kernel_audit_lag_seconds`, `kernel_replay_drift_total`, `kernel_kill_switch_state`, `kernel_pack_install_total`, `kernel_defer_pending_gauge`, `kernel_defer_quota_exceeded_total`, `kernel_defer_timeout_total`, `kernel_audit_redactor_failures_total`, `kernel_audit_sink_buffer_size`, `kernel_audit_sink_spill_size`, `kernel_intent_kind_unknown_total`) + 4 doc/code name drifts resolved + `KernelMetricsRecorder` API |
| Infrastructure configs | 4 Grafana dashboard JSONs (Grafana 10.x), 14 Prometheus alert rules in YAML, 42 validation tests, PromQL drift fix (`divergence` → `class`) |
| Cross-cluster recon-1 | force-routes-governance 7 tests → real Docker Redis via testcontainers; new reusable `redis-testcontainer.ts` harness |
| Cross-cluster recon-2 | lgpd-anonymize-lifecycle 2 tests + stale-order-checker 6 tests rescued via real Redis + real parseBoolEnv via `vi.importActual` |
| Medusa migration (P0-X9 follow-up) | 13 sites → `medusaAdjudicated()`; `DEFERRED_MEDUSA_MIGRATIONS` empty; 2 new `medusa.*` intent kinds added |

### Wave 6 — Adversarial verification (5 verifiers)

| Verifier | Method | Verdict |
|---|---|---|
| Red-Team | Wrote 17 exploit-demonstration tests against committed code without reading agent reports | **17/21 fixes hold; 2 exploitable; 2 suspicious-but-unverified** |
| Operational Drill | Walked 10 incident drills as 3am on-call against real Docker Redis | **1 pass / 8 partial / 1 fail** — Tier 1 OK, Tier 3+4 NOT ready |
| Integration E2E | Spun up 7 real-infrastructure harnesses, 94 assertions total | **7/7 paths verified, 94/94 assertions PASS** — but 1 load-bearing security gap discovered |
| Governance Coverage | Built exhaustive mutation-surface map across HTTP/Prisma/Medusa/Stripe/Twilio/NATS/BullMQ/LLM | **~65% adjudicated; 6 new P0 bypass categories** |
| TS Cleanup | Fixed 3 TS-strict errors | Clean across `@ibatexas/api`, `@ibatexas/tools`, `@ibatexas/domain`, `@ibatexas/llm-provider` |

---

## NEW findings from Wave 6 verifiers

### P0-NEW-W6-1 — `verifyParkedEnvelopeHash` is silently inert (Integration E2E)

The framework's `verifyParkedEnvelopeHash` reads `e.actorPrincipal` at the top level of the parked envelope. `buildEnvelope` writes `e.actor.principal` (nested). **Every park blob hits the `missing_fields` back-compat branch.** Framework unit tests presumably hoist the field; production reality differs. **Tamper-at-rest detection at resume is effectively disabled.**

**Same class as the W2 P0-7 framework hole.** Adopter assumption diverged from framework reality.

**Fix:** Either (a) framework PR to read from `e.actor.principal`, or (b) ibatexas adapter hoists `actorPrincipal` before storing the blob.

### P0-NEW-W6-2 — Whitespace customerId bypass (Red-Team)

Empty-string guard checks `=== ""` but does NOT trim. `markOtpFresh("   ")` resolves and writes Redis key `ibatexas:anonymize:otp:   `. All whitespace-only customerIds share state.

**Fix:** Add `.trim().length === 0` to empty-string guards at `anonymize-otp-gate.ts:87` and `auth.ts:64,95,127`. One-line change per site.

### P0-NEW-W6-3 — Template-literal bypass of medusa scanner (Red-Team)

The bypass-detection regex character class `['"]` excludes backticks. `method: \`POST\`` evades all 4 `FORBIDDEN_MEDUSA_MULTILINE` patterns.

**Fix:** Widen `['"]` to ``['"`]`` in 4 FORBIDDEN_MEDUSA_MULTILINE patterns. One-line change.

### P0-NEW-W6-4 through P0-NEW-W6-9 — Governance coverage gaps

1. **Reservation tool layer**: 5 sites (`create-reservation`, `modify-reservation`, `cancel-reservation` ×2, `join-waitlist`) call bare methods despite `*FromEnvelope` siblings existing on the service
2. **Admin scheduler/tables/delivery-zone**: 6 sites — services lack `*FromEnvelope` ENTIRELY
3. **Customer onboarding via auth + WhatsApp**: `auth.ts:390` + `whatsapp/session.ts:135` call `upsertFromPhone`/`upsertFromWhatsApp` while `customer.createFromEnvelope` exists
4. **`prisma.orderNote.create` in 4 production routes**: matches `FORBIDDEN_PRISMA` pattern but lives in dirs the bypass-detection gate doesn't scan
5. **Stripe SDK direct calls**: 6 sites in `packages/tools/src/cart/` — no adjudication anywhere
6. **Medusa `fetchAdmin` POST/DELETE** in `order.service.ts:115-178,227`: order-cancel and order-edit primitives bypass `medusaAdjudicated`

### P1/P2-NEW-W6 (operational + edge)

- **`kernel_audit_spill_bytes` ghost metric** in dashboard + alert + validation-test allowlist (sink emits `kernel_audit_sink_spill_size`). Validation-test passes anyway because its allowlist is also wrong → false negative.
- **CLI `ibx kernel kill-switch enable` bypasses the two-person rule** (writes Redis directly; only the admin HTTP endpoint enforces).
- **Role mismatch**: kill-switch strategy doc says Global = OWNER; route is `requireManagerRole`.
- **`pnpm migrate` is a phantom command** referenced by the replay CLI's off-state message.
- **No `ibx kernel defer resume` CLI** — operator must SCAN Redis + manually publish NATS.
- **NX-wrapper quota slot leak** on mid-park throw (placeholder deleted, counter not DECR'd).
- **Runbook key references are literally wrong**: docs say `ibatexas:foo`, code uses `<APP_ENV>:foo` via `rk()`.

---

## Production-readiness verdict

### 🟡 Conditional GO for Tier 1 shadow rollout

**Pre-merge gates (1-2 days):**

1. **P0-NEW-W6-2 (whitespace customerId)** — add `.trim().length === 0` to 4 guards
2. **P0-NEW-W6-3 (template-literal scan evasion)** — widen regex char class to include backticks
3. **P0-NEW-W6-1 (`verifyParkedEnvelopeHash` inert)** — hoist `actorPrincipal` in the adapter OR write framework PR
4. **`kernel_audit_spill_bytes` mismatch** — pick canonical name, fix sink/dashboard/alert/validation-test consistently

After those 4 land, Tier 1 intents (`reservation.create`, `order.note.add`, `customer.preferences.update`, `whatsapp.message.send` system) are shadow-safe.

### 🔴 NO-GO for Tier 3+4 enforce

**Required before flipping any financial or LGPD intent to enforce:**

5. Close 6 new P0 bypass categories (reservation tool layer, admin scheduler, customer onboarding upserts, orderNote, Stripe SDK in tools/, fetchAdmin in order.service). **Estimated ~2 weeks.**
6. Stuck-DEFER recovery procedure documented (CLI tool OR redis-cli + NATS recipe). ~1 day.
7. Audit-postgres SQL migrations applied + flipped enabled (operator action). ~3-5 days.
8. NATS auth deployment (operator action). ~3-5 days.
9. Reconcile CLI two-person rule (either harden CLI to require admin endpoint, or soften runbook). ~1 day.
10. Reconcile MANAGER vs OWNER role for kill-switch. ~30 min.

### Aggregate timeline

| Milestone | Effort | Wall-clock (1-2 engineers) |
|---|---|---|
| Tier 1 shadow ready (4 P0s) | ~1-2 days | This week |
| Tier 2 shadow ready (+ ghost-fixes) | +3-5 days | Next week |
| Tier 3 shadow ready (+ 6 bypass categories) | +2 weeks | Weeks 3-4 |
| Tier 4 shadow ready (+ LGPD bypass closure + DEFER recovery CLI) | +3-5 days | Week 5 |
| ENFORCE Tier 1 ready (+ NATS auth + Postgres migrations) | + operator action | Week 5-6 |
| ENFORCE Tier 4 ready (LGPD anonymize, refund > R$1k) | +1 week stability soak | Week 7-8 |

**Roughly: 5-8 weeks from now to enforce-ready for the highest-risk intents.** The W1-W6 remediation closed the deep-audit's findings substantially — the remaining work is closing the NEW bypass categories Wave 6 surfaced.

---

## What worked exceptionally well

1. **Anti-theater rule (RULE 2)**: every fix has a before+after evidence file. The Red-Team verifier was able to read those files to understand what each fix actually claimed, then write adversarial tests that probe past the claim.
2. **Real-infrastructure rule (RULE 3)**: testcontainers + Docker Redis exposed bugs that mocks would have hidden (refund cap atomicity, OTP brute-force race, DEFER NX collision).
3. **Cross-audit rule (RULE 4)**: Red-Team finding the 2 new exploits + Governance finding the 6 new bypass categories validates the no-self-cert principle. Verifiers found what implementation agents couldn't.
4. **Single shared branch with disjoint file scopes**: enabled 6+ parallel agents without merge conflicts in most cases. The branch-reset incidents (recovered via cherry-pick) are the cost; the throughput is the benefit.

## What didn't work

1. **`git add -A` in sub-agents**: Medusa migration's `git add -A` swept up the CLI agent's untracked work into commit `90bebad`. Mixed-concerns commit, hard to review.
2. **Some integration tests still use too much mocking**: Wave 6 Integration E2E flagged that even after W1-W3, some "integration" tests mock more than they exercise.
3. **Audit recursion**: each verification pass finds more. Wave 6 found 8 new findings the deep-audit didn't anticipate. **Audits are not done; they're sampled.**

## Cumulative work since deep-audit synthesis

- **30 commits** on `feat/correctness-w1-reproduction`
- **~7,000 lines** of net code change
- **19 P0/P1 closures** with paired failing-test → passing-test evidence
- **13 deferred Medusa bypasses** migrated
- **14 cross-cluster broken tests** rescued via real Redis testcontainers
- **11 ghost metrics** now real
- **4 Grafana dashboards + 14 alert YAMLs** committed
- **3 operational CLI commands** real (kill-switch enable/disable/status, replay, divergence with `--intent-kind`)
- **1 new admin HTTP endpoint** (kill-switch with two-person rule)
- **42 dashboard/alert validation tests**
- **17 red-team exploit-demonstration tests**
- **~3,500 lines of Wave 6 verification findings**
- **2 latent bombs defused** (Postgres ON CONFLICT, AuditRedactor hash recomputation)
- **2 latent bombs RE-discovered** (verifyParkedEnvelopeHash inert, refund drip cap TOCTOU was already weak per Wave 6 verifier)
- **6 NEW P0 bypass categories** identified for next remediation wave
