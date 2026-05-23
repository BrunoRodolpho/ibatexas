# Overnight Run — Live Status

**Started:** 2026-05-22 (user signed off for the night, full autonomous authority)
**Branch:** `feat/consume-adjudicate-from-platform-repo`
**Last update:** at start

## Legend
- ✅ Complete (merged + tests passing)
- 🟡 In progress
- ⛔ Blocked (see `open-blockers.md`)
- ⏸ Deferred (predecessor blocked)
- ⏳ Pending

## M0 + T08 (already complete this session)

| ID | Task | Status |
|---|---|---|
| 01 | Kernel bootstrap plugin | ✅ |
| 02 | Wire onToolIntent | ✅ |
| 03 | Defer-resolver + sweeper | ✅ |
| 04 | set_pix_details classification | ✅ |
| 05 | MetricsSink | ✅ |
| 08 | pack-orders | ✅ |

## Follow-ups (do first — F4 unblocks the rest)

| ID | Item | Status |
|---|---|---|
| F4 | Envelope nonce migration (5 ts errors + 2 test failures) | ✅ |
| F2 | `kernel.intent_dispatched` basis code | ⏸ DEFERRED (adjudicate repo dirty — see D6) |
| F3 | `KNOWN_INTENT_KINDS` stub | ⏳ |
| F1 | `setResumeIntentDispatcher` adapter | ⏳ |
| F5 | `add_order_note` orphan cleanup | ⏳ |
| F6 | Legacy-EXECUTE audit-record pollution cleanup | ⏳ |

## M1 — LLM tool path completion

| ID | Task | Status |
|---|---|---|
| 06 | Wrap kernel-direct mutations; remove `executeToolDirect` | ✅ |
| 07 | Adopt `orderCapabilityPlanner` + `safePlan` | 🟡 |

## M2 — Pack architecture (4 packs)

| ID | Task | Status |
|---|---|---|
| 09 | pack-reservations | ⏳ |
| 10 | pack-whatsapp | ⏳ |
| 11 | locales-pt-BR adoption | ⏳ |
| 21 | pack-customer-onboarding | ⏳ |

## M3 — Mutation-entrypoint governance (long pole)

| ID | Task | Status |
|---|---|---|
| 15 | Command-service chokepoints (LINCHPIN) | ⏳ |
| 12 | Stripe webhook governance | ⏳ |
| 13 | Admin force-* routes | ⏳ |
| 14 | Customer mutation routes + LGPD | ⏳ |
| 16 | NATS subscribers + jobs (needs 15) | ⏳ |
| 17 | medusaAdjudicated wrapper (needs 15) | ⏳ |

## M4 — Audit & observability

| ID | Task | Status |
|---|---|---|
| 18 | AuditRedactor (PII redaction) | ⏳ |
| 19 | audit-postgres + persistentBufferedSink + NATS consumer | ⏳ |

## M5/M6 — Testing & CLIs

| ID | Task | Status |
|---|---|---|
| 20 | Test coverage baseline + ibx kernel CLIs + bypass-gate | ⏳ |

## Tags planned
- `m0-complete` — already done (will tag at start of run)
- `m1-complete`
- `m2-complete`
- `m3-complete`
- `m4-complete`
- `m6-complete`
