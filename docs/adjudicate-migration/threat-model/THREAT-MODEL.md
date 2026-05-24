> **NOTE — load-bearing constitutional with stale rollout framing.** The asset inventory, trust boundaries, STRIDE matrix, LGPD analysis, and residual-risks list below are still authoritative. **Exceptions:** the `IBX_KERNEL_ENFORCE` env var asset (line 33), the "enforce-mode rollout MUST NOT happen until..." gating language throughout the STRIDE matrix, and the companion-doc link to `../superseded/SHADOW-ENFORCE-ROLLOUT.md` describe a rollout framework deleted by the IBX-IGE v3.0 cutover (`f3bea43`). Per `CLAUDE.md` rule #9, the kernel is always authoritative — read enforce-flip gates as "before production deploy" production-safety guidance. See `README.md` in this directory for the full classification and the list of localized stale references.

---

# IbateXas Kernel-Gated Mutation — Threat Model

**Status:** W6-12 (final wave). First formal threat model post-adjudicate migration.
**Owner:** Security review + migration lead
**Last reviewed:** 2026-05-23
**Annual review cadence:** Every 2026-05 (calendar reminder + ticket cut).
**Companion docs:** `../audit/05-security-red-team.md`, `../audit/AUDIT-SYNTHESIS.md`, `../remediation/REMEDIATION-COMPLETE.md`, `../superseded/SHADOW-ENFORCE-ROLLOUT.md`, `../remediation/NATS-AUTH-REQUIREMENTS.md`.

---

## Scope

This threat model covers the kernel-gated mutation surface of IbateXas:

- **In scope:** the IBX-IGE v2.0 stack (LLM responder, intent dispatcher, Pack policies, command-service envelope path, audit pipeline, defer-park-resume infrastructure, admin two-step confirm, LGPD anonymize flow, Stripe webhook handler).
- **Out of scope (separate threat models):** Anthropic LLM API integration security, Stripe API integration security, the underlying Postgres + Redis + NATS infrastructure (assumed to be in their own threat models), the customer mobile app, the marketing site, the staff dashboard frontend.

---

## Assets

| Asset | Sensitivity | Storage | Notes |
|---|---|---|---|
| Customer PII (CPF, email, phone) | CRITICAL — LGPD-regulated | Postgres `Customer` table; audit `intent_audit` (redacted) | LGPD Art. 18: customer can request deletion. P0-13 fix scrubs phone + reviews + email + cpf. |
| Payment data (PIX QR, card last4) | CRITICAL — PCI-touching | Postgres `Payment` table; Stripe (full card stored there); audit (redacted) | We never store full PAN. PIX QR is a one-time token; expires in ~1h. |
| Order state | HIGH — drives fulfillment + invoicing | Postgres `Order` projection; Medusa (commerce DB) | Forced state changes = financial impact (refunds, charges). |
| Audit records | HIGH — forensic + replay | NATS `audit.intent.decision.v1` subject; Postgres `intent_audit`; Redis spill | The genealogy here proves what happened; tampering = forensic blindspot. |
| Reservation slots | MEDIUM — drives revenue | Postgres `Reservation` table | Bad cancellation = double-booking; bad creation = orphan slot. |
| Conversation history | MEDIUM — contains PII | Postgres `Conversation`; redacted in audit | The LLM sees this; if leaked, contains customer phone + utterances. |
| Twilio Verify OTP codes | HIGH — auth bearer | Twilio (we never see them); freshness markers in Redis | Replay of an OTP = full account takeover or anonymize. |
| Admin JWT cookies | CRITICAL — staff bearer | HTTP-only Set-Cookie; backed by JWT issued at OTP gate | Stolen JWT = stolen staff role (until rotated). |
| `ADMIN_API_KEY` (env) | CRITICAL — bypasses JWT | Env var | Per P1-H: this is a single-key bearer for system-actor admin paths. Compromise = unbounded refunds. |
| ~~`IBX_KERNEL_ENFORCE` env var~~ (HISTORICAL) | n/a | n/a | Updated 2026-05-24 post-cutover: the IBX-IGE v3.0 cutover (`f3bea43`) removed `IBX_KERNEL_ENFORCE`/`IBX_KERNEL_SHADOW`. The kernel is always authoritative — there is no env-gated state to tamper with at this asset boundary. |
| Pack policy code | HIGH — decides every mutation | Source code; build artifact | A malicious Pack edit changes the gate logic. Code review + CI gate (bypass-detection) defends. Post-cutover this is the **only** code path that controls the kernel's decision surface — there is no runtime override. |

---

## Trust boundaries

```
[Customer device]              ←→  [WhatsApp / Twilio / Stripe webhook]
        |                                       |
        v                                       v
[Customer-facing routes]                [System-actor routes / subscribers]
        |                                       |
   (auth: OTP cookie / JWT)            (auth: NATS subject filter / API key)
        v                                       v
   [Customer-intent-gateway]          [Subscriber-intent dispatch]
        |                                       |
        +--- enforce-gated by adjudicate() and Pack ---+
        |                                       |
        v                                       v
   [Command service *FromEnvelope methods]
        |
   +--- Prisma TX → Postgres (single source of truth) ---+
   |                                                       |
   +--- Audit emit → NATS subject + Redis spill + Postgres archive ---+
   |
   +--- Optional: medusaAdjudicated() → Medusa Commerce DB
```

**Trust boundary 1: untrusted → kernel.** Every request from a customer is `taint: "UNTRUSTED"`. The Pack policies enforce the SECURITY → STATE → TAINT → AUTH → BUSINESS guard order; an unauthenticated mutating envelope REFUSEs at the AUTH layer (taint_level_insufficient).

**Trust boundary 2: kernel → command service.** Only `*FromEnvelope` methods can write Prisma — verified by the bypass-detection grep gate (W6-8 extensions cover `$executeRaw` outside services).

**Trust boundary 3: NATS subject.** Every audit record passes through NATS subject `ibatexas.audit.intent.decision.v1`. Anyone with NATS connect can subscribe — TODAY this is the open infrastructure threat (P0-12).

**Trust boundary 4: build/deploy → kernel.** Updated 2026-05-24 post-cutover: the IBX-IGE v3.0 cutover (`f3bea43`) collapsed this boundary. There is no runtime env-gated kernel state any longer — `IBX_KERNEL_ENFORCE` / `IBX_KERNEL_SHADOW` no longer exist, and `setKillSwitch()` was removed. Kernel configuration is now **compile-time + boot-time only**: the installed Pack set is decided by the `kernel-bootstrap.ts` `installPack(...)` calls (source code), and the `KNOWN_INTENT_KINDS` typo gate is similarly compiled in. The remaining trust boundary for kernel behavior is therefore the **source-code → build artifact** boundary (covered by Pack policy code in §Assets and by the bypass-detection CI gate in §Tampering). A compromised CI/CD pipeline or build-artifact substitution is the analogous threat; a compromised operator cannot flip a runtime env var because none exist.

---

## STRIDE inventory

### Spoofing identity

| Vector | Mitigation | Status | Residual risk |
|---|---|---|---|
| Forged customer JWT cookie | Twilio Verify OTP at issue; HTTP-only cookie; HMAC-signed by API JWT secret | Implemented | LOW — JWT secret rotation is on the ops backlog; theft of `JWT_SECRET` env var = global cookie forgery |
| Stolen JWT replays anonymize | Fresh-OTP gate at `initiate-deletion` (P0-11). Brute-force counter 5 strikes / 30min. 30-min cancel-cooldown. | Implemented (W4) | LOW — stolen JWT is now insufficient by itself for the most destructive operation |
| Forged staff JWT (admin path) | Twilio Verify OTP at staff login; SQRRL JWT TTL = 1 day; manager role enforced at route. Same-actor gate (P0-5) prevents step-1 + step-2 by same operator | Implemented (W1) | MEDIUM — `ADMIN_API_KEY` env bypasses JWT (P1-H) — single leaked key = unbounded refunds. Tighten via `requireManagerRole` fail-closed when no JWT (TODO) |
| Forged Stripe webhook | Signature verification via `STRIPE_WEBHOOK_SECRET`; rejected at handler entrypoint | Implemented | LOW — secret rotation requires Stripe coordination |
| Forged NATS publish (resume signal, audit record, defer-timeout) | NONE today | **P0-12 DEFERRED** | **HIGH** — NATS Core has no auth on `localhost:4222`. Any process on the network can publish forged signals. Mitigation: deploy NKey/JWT auth + TLS per `remediation/NATS-AUTH-REQUIREMENTS.md`. UNTIL THEN enforce-mode rollout MUST NOT happen for kinds whose resume signal arrives via NATS (PIX, anonymize-grace, payment-status). |

### Tampering with data

| Vector | Mitigation | Status | Residual risk |
|---|---|---|---|
| Direct Prisma write to kernel-owned tables (bypass envelope path) | Bypass-detection grep gate (`bypass-detection.test.ts`). 4 base scenarios + W6-8 extensions for `$executeRaw`, redis.del(lock), Twilio direct, console.log(envelope) | Implemented (W3 + W6-8) | LOW — gate is grep-based, not AST. Multi-line obfuscation could slip; reviewers must verify on PR |
| Audit record tampering after emit | `auditHash` (sha256 over canonical record) at v4. `verifyAuditRecord` detects post-write mutation | Implemented (upstream `@adjudicate/core`) | LOW — verifier only runs on replay; in-place row edits to `intent_audit` would be detected on next replay |
| Audit redactor breaks `auditHash` (P0-15) | Recompute auditHash after redaction (or use companion `redactedAuditHash`) | **Status TBD** — verify in remediation report | If unfixed: every redacted record reads as `tampered` on replay — replay is broken |
| Command-service `prisma.payment.update` for refundedAmountCentavos out-of-band | P0-1 fix routes refund through `issueRefundFromEnvelope` (pack-payments). Bypass-detection forbids `prisma.payment.update` outside services | Implemented (W3) | LOW |
| Forged `intent.defer.timeout` causes LGPD-anonymize to fire early | TODAY: nothing prevents this — NATS unauthenticated (see Spoofing) | **P0-12 DEFERRED** | **HIGH** — any local process can publish a fake timeout for any sessionId, triggering grace resolver. Mitigated by anonymize-grace-resolver's idempotent receipt-check (no receipt = no anonymize) but the receipt-check is per-customerId, not nonce-bound |

### Repudiation

| Vector | Mitigation | Status | Residual risk |
|---|---|---|---|
| Customer denies they authorized a deletion | Audit `intent_audit` row captures envelope.actor.sessionId (hashed), nonce, timestamp, OTP token hint, IP. Twilio Verify records OTP attempt | Implemented (W4 redactor) | LOW |
| Staff denies they issued a refund | Audit row carries `actor.sessionId = admin:<staffId>`, signed via `auditHash`. Two-person rule (P0-5) means TWO staff IDs are bound to the audit record | Implemented (W1) | LOW |
| Tampering with `intent_audit` row | `auditHash` detects mutation; row-level audit-log (Postgres internal) can detect DDL | Partial | MEDIUM — direct DBA access can rewrite + recompute hash; needs DBA access audit |
| Replay-of-audit-record by a malicious party | The replay harness re-derives `auditHash`; mismatched = `tampered`. Replay path itself is read-only | Implemented (upstream `@adjudicate/core`) | LOW |

### Information disclosure

| Vector | Mitigation | Status | Residual risk |
|---|---|---|---|
| PII (CPF, email, phone) leaks to NATS subscribers | Audit redactor hashes/redacts before sink fan-out. `actor.sessionId = customerId` was leaking (P0-10); fixed via hash-at-build-time or redactor treats as HASH field | Implemented (W4 P0-10) | LOW |
| PII leaks via stdout/console.log | Bypass-detection W6-8 extension warns on `console.log(envelope|payload|cpf|email|phone)`. Found 4 matches in seed-data scripts (acceptable) | Implemented (W6-8 warn-only) | LOW — production code paths use structured logger after W6-10; seed scripts run in dev only |
| PII in audit row payload (CPF in `set_pix_details`) | Redactor masks at emit time. Postgres `intent_audit.envelope_jsonb` shows `[REDACTED]` not raw | Implemented | LOW |
| PII visible to NATS subscribers without auth | Without NATS auth (P0-12), any localhost subscriber reads audit records. Redactor mitigates raw PII but `intentKind` + timing alone enables traffic-analysis attacks | **P0-12 DEFERRED** | **HIGH** — must close before enforce-mode for customer-touching kinds |
| LGPD anonymize doesn't fully scrub | Per P0-13: phone hashed, reviews scrubbed, email + CPF nulled, address fields cleared | Implemented (W4) | LOW |
| Sentry breadcrumbs include payload | Sentry sink integration in kernel-metrics; payload is intentionally NOT included in breadcrumbs (basis + kind only) | Implemented | LOW |
| Stripe webhook PII echo on anonymized customer | Customer was anonymized; later webhook for the same `customer.email` arrives | Untested per audit gap | MEDIUM — if the webhook handler echoes back the email field in a 200 body, that's a re-export. Verify in stripe-webhook-route.test.ts (audit/08 §"Edge case gaps" line 138) |

### Denial of service

| Vector | Mitigation | Status | Residual risk |
|---|---|---|---|
| Customer floods `send-otp` → Twilio cost burst | Rate-limited at `@fastify/rate-limit`; brute-force counter per-customer | Implemented | LOW |
| Customer floods `initiate-deletion` → DEFER park exhaustion | `parkDeferredIntent` quota counter; 30-min cancel-cooldown blocks re-init | Implemented (W4 + P0-7) | LOW |
| Adversary publishes 10^6 forged `intent.defer.timeout` to NATS | TODAY: anonymize-grace-resolver iterates every event → no rate limit | **P0-12 DEFERRED** | MEDIUM — once NATS auth lands, drop publishers without auth at the broker |
| Audit sink chain failure (Postgres + NATS down) → in-memory buffer overflow | Buffered sink + Redis spill + 7-day TTL. Per audit §"Scenario D" — process restart loses in-memory queue | Implemented (with caveat — see audit §F1) | LOW (with monitoring) — emit gauge `audit_spill_storage_kind` exposed via /healthz |
| Sentry/PostHog metrics blackout → on-call blind | Metrics sink chain failures emit `metrics_sink_total_failures` counter via `/healthz` | Partial | LOW — health surface exposes blindness; LB routes around |
| Pack policy infinite loop / runaway recursion | `executeKernel` 5-second timeout; pack-runtime-resilience test (TODO) | Partial | LOW |
| BullMQ worker outage → anonymize grace timeout never fires (LGPD breach!) | Heartbeat metric on `sweepDeferTimeouts`; PagerDuty alert at >5min stale | **PARTIAL** — heartbeat added but PagerDuty wiring TBD | **MEDIUM — LGPD risk** — a 24h+ sweeper outage means a customer's deletion request never completes. Per audit Scenario A |

### Elevation of privilege

| Vector | Mitigation | Status | Residual risk |
|---|---|---|---|
| Customer-actor envelope routes to admin path | Pack policy AUTH guard rejects `taint=UNTRUSTED` for admin kinds. `*FromEnvelope` methods refuse SYSTEM/TRUSTED via taint check | Implemented | LOW |
| LLM proposes a mutating tool that's not in the planner | `CapabilityPlanner.visibleReadTools` is the gate. Mutating tools NEVER reach the LLM's prompt. Tested via `agent-intent-dispatch.test.ts` | Implemented | LOW |
| Pack drift: a Pack accepts an envelope kind it shouldn't | `installPack` PackConformanceError fail-fast at boot (P0-6, W6-4). Conformance tests cross-check Pack's `intentSurface` against `knownKinds` | Implemented | LOW |
| Same-actor two-step bypass (one staff issues both step-1 and step-2 of force-cancel/refund) | P0-5 fix: `consumeWithSameActorCheck` refuses if step-1 and step-2 staffId match | Implemented (W1) | LOW |
| Admin API-key bypasses two-person rule | `requireManagerRole` fails open when no JWT (P1-H). A leaked single key = unbounded refunds | **P1-H DEFERRED** | MEDIUM — close by tightening `requireManagerRole` or define an API-key-role registry |
| `executeToolDirect` re-introduction (would let any caller dispatch a mutating tool without adjudicate()) | Bypass-detection scenario 3: grep gate fails if the symbol reappears | Implemented (Task 06) | LOW |
| Pack policy code injection via untrusted Pack | Packs are first-party, source-controlled. The kernel doesn't load Packs from network at runtime | Implemented (architecture) | LOW |

---

## Attack vectors discovered in audit (with W4-applied mitigations)

The audit identified 7 P0 security findings; W4 closed 5, 2 remain partial/deferred:

| ID | Finding | W4 mitigation | Status |
|---|---|---|---|
| P0-10 | `actor.sessionId = customerId` plaintext leaks to NATS / Postgres audit | Redactor hashes the field at emit; contract test updated to detect this PII path | CLOSED |
| P0-11 | Stolen JWT alone authorises destructive anonymize | Fresh-OTP gate at initiate; brute-force counter 5 strikes / 30min; 30-min cancel-cooldown | CLOSED |
| P0-13 | `anonymizeCustomer` doesn't scrub phone + reviews | Extended to nullify phone, anonymize reviews, scrub email + cpf + address | CLOSED |
| P0-12 | NATS has zero authentication | Requirements doc filed (`remediation/NATS-AUTH-REQUIREMENTS.md`). Operator action: deploy NKey/JWT auth + TLS | **DEFERRED — operator action** |
| P1-H | Admin API-key bypasses two-person rule | Mitigation TBD | **DEFERRED — partial** |
| P1-I | Refund drip cap (sub-R$200 refunds skip two-step) | Per-staff-day aggregate cap (R$2000/day default) | CLOSED |
| P1-K | bypass-detection regex line-based — gate is performative | W6-8 extends to 8 scenarios; the multi-line `ALLOWED_MEDUSA_DIRECT` audit lands | PARTIAL — multi-line regex is still line-based for some forbidden patterns; AST-based gate is a follow-up |

---

## Residual risks (the "we know but can't close today" list)

Closing these is the operator's responsibility, not the codebase's:

1. **NATS Core mode lacks auth + TLS (P0-12).** Customer-touching enforce-mode flips MUST WAIT until this is closed. See `remediation/NATS-AUTH-REQUIREMENTS.md` for the infra change.
2. **Admin `ADMIN_API_KEY` bypasses two-person rule (P1-H).** A single key leak = unbounded refunds. Mitigation requires either (a) tightening `requireManagerRole` to fail-closed without JWT, or (b) building an API-key-role registry with per-key separation-of-duty enforcement.
3. **BullMQ sweeper recovery on outage (P1-E).** A worker down >24h means parked LGPD-anonymize envelopes expire silently and the deletion never completes. Heartbeat metric is in place; PagerDuty alert routing is the gap.
4. **Postgres audit-postgres `ON CONFLICT` constraint (P0-14) — verify constraint exists in the `intent_audit` table BEFORE enabling `IBX_AUDIT_POSTGRES_ENABLED=true` in prod.** Otherwise the first audit write crashes with `42P10`.
5. **Audit redactor breaks `auditHash` (P0-15) verification.** Replay reports `tampered` for every redacted record. The fix is either recompute the hash after redaction OR add a `redactedAuditHash` companion field. Coordinate with `@adjudicate/core` audit shape.
6. **Pack runtime errors crash the route handler.** No `kernel-runtime-resilience.test.ts` exists; a bug in any Pack's `policy()` function takes down the route. Mitigation: a runtime try/catch in `executeKernel` that downgrades to refusal+sentry-log.
7. **Audit gap on simultaneous Postgres + Redis-spill outage (Scenario D).** A filesystem-backed spill (the `persistent-buffered-sink.ts` doc comment notes "adopter responsibility") would close this. Not implemented.
8. **`@ibatexas/llm-provider` package-level intent-ledger fail-open (`IBX_LEDGER_FAIL_OPEN=true`).** Acceptable when configured, but the default is opaque. Operator should explicitly set the value in prod via runbook 04.

---

## Threat model review process

- **Annual review:** every year in May (next: 2026-05). Migration lead + on-call lead read this doc end-to-end. Open a ticket for every item that changed (asset added, mitigation upgraded, new threat surfaced).
- **Triggered review:** any of the following triggers an immediate review and update:
  - A P0 audit finding lands
  - A new Pack is added (changes asset surface)
  - Auth flow changes (OTP, JWT, API key)
  - NATS / Postgres / Redis architecture changes
  - A security incident (post-mortem must update this doc)
- **Updates require:** migration lead + security review signoff in the change PR. The doc is version-controlled via the same review path as code.

---

## Audit references

- `docs/adjudicate-migration/audit/05-security-red-team.md` — auditor 5 of 8; ~280 lines on customer + admin auth paths
- `docs/adjudicate-migration/audit/06-reliability-fail-open.md` — reliability + fail-open inventory; ~290 lines
- `docs/adjudicate-migration/audit/AUDIT-SYNTHESIS.md` — master findings, recommended fix waves
- `docs/adjudicate-migration/remediation/REMEDIATION-COMPLETE.md` — per-wave outcomes
- `docs/adjudicate-migration/remediation/NATS-AUTH-REQUIREMENTS.md` — operator infrastructure work
