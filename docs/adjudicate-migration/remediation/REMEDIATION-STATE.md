# Remediation State — Audit Closure

**Started:** 2026-05-23 (post-audit)
**Audit source:** [`audit/AUDIT-SYNTHESIS.md`](../audit/AUDIT-SYNTHESIS.md)
**Branch:** `feat/consume-adjudicate-from-platform-repo`

## Wave plan

| Wave | Theme | Est | Status |
|---|---|---|---|
| W1 | Fail-safety + enforcement | ~2d | ⏳ |
| W2 | DEFER + replay correctness | ~3-4d | ⏳ |
| W3 | Money-path governance | ~3-4d | ⏳ |
| W4 | Security + LGPD | ~3-5d | ⏳ |
| W5 | Enforcement readiness (pack-payments + taxonomy) | ~3-5d | ⏳ |
| W6 | Testing + observability + docs | ~2-3d | ⏳ |

## P0 ledger (15 findings)

| ID | Title | Wave | Status |
|---|---|---|---|
| P0-1 | Refund magnitude bypasses kernel | W3 | ⏳ |
| P0-2 | payment/retry + regenerate-pix bypass chain | W3 | ⏳ |
| P0-3 | amend-order pipeline unadjudicated | W3 | ⏳ |
| P0-4 | Admin reservation cancel uses raw $transaction | W1 | ⏳ |
| P0-5 | Two-person rule unenforced (same staffId) | W1 | ⏳ |
| P0-6 | installPack fail-fast not wired | W1 | ⏳ |
| P0-7 | DEFER park silent-data-loss (raw redis.set) | W2 | ⏳ |
| P0-8 | Resume dedup fires before dispatch | W2 | ⏳ |
| P0-9 | Enforce-config typo silently disables enforcement | W1 | ⏳ |
| P0-10 | Audit redactor leaks customerId via actor.sessionId | W4 | ⏳ |
| P0-11 | Stolen JWT → account destruction (no fresh OTP at initiate) | W4 | ⏳ |
| P0-12 | NATS zero auth | W4 | ⏳ (likely DEFERRED — infra dep) |
| P0-13 | anonymizeCustomer doesn't clear phone/reviews | W4 | ⏳ |
| P0-14 | Postgres sink ON CONFLICT broken | W1 | ⏳ |
| P0-15 | AuditRedactor breaks audit hash verification | W2 | ⏳ |

## P1 ledger (12 findings)

| ID | Title | Wave |
|---|---|---|
| P1-A | Intent-kind drift / no pack-payments | W5 |
| P1-C | payment-lifecycle subscriber swallows failures | W1 |
| P1-D | defer-resolver Redis IOError silently dropped | W2 |
| P1-E | Sweeper downtime silently loses envelopes | W2 |
| P1-F | slot.released is dead code | W2 |
| P1-G | pack-whatsapp has no auth-phase guards | W4 |
| P1-H | Admin API-key bypasses two-person rule | W4 |
| P1-I | Refund threshold bypass via drip | W3 |
| P1-J | no-show-checker uses deprecated transition | W1 |
| P1-K | bypass-detection regex is line-based — gate is performative | W6 |
| P1-L | ALLOWED_MEDUSA_DIRECT carve-out wrong | W3 |

## P2 ledger (3 findings)

- P2-A: DLQ CLI hardcodes 5 events
- P2-B: NATS Core silent drops (JetStream migration)
- P2-C: console.warn loses reqId correlation

## Verification gates

After each wave: typecheck + targeted tests + summary in this file.

## Tags planned

- `audit-w1-complete`
- `audit-w2-complete`
- `audit-w3-complete`
- `audit-w4-complete`
- `audit-w5-complete`
- `audit-w6-complete`
