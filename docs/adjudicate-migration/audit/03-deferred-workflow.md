# Deferred Workflow Audit

> Auditor: Deferred Workflow Auditor (P0-c subsystem)
> Date: 2026-05-23
> Scope: `defer:pending:*` park lifecycle — park, sweep, resume, timeout, dedup, cycle cap.
> Files audited:
> - `apps/api/src/subscribers/defer-resolver.ts`
> - `apps/api/src/jobs/defer-timeout-sweeper.ts`
> - `apps/api/src/subscribers/anonymize-grace-resolver.ts`
> - `packages/llm-provider/src/llm-responder.ts` (park path)
> - `packages/llm-provider/src/kernel-executor.ts` (park path)
> - `apps/api/src/routes/me.ts` (anonymize park path)
> - `/Users/thaisrodolpho/projects/adjudicate/packages/runtime/src/defer-park.ts`
> - `/Users/thaisrodolpho/projects/adjudicate/packages/runtime/src/defer-resume.ts`
> - `apps/api/src/__tests__/defer-roundtrip*.test.ts`
> - `apps/api/src/subscribers/__tests__/defer-resolver.test.ts`
> - `apps/api/src/jobs/__tests__/defer-timeout-sweeper.test.ts`
> - `packages/nats-client/src/index.ts`

## Executive summary

**DEFER is NOT production-safe today.** The kernel's runtime ships a sophisticated park/resume primitive (`parkDeferredIntent`, `resumeDeferredIntent`) with per-session quota, T-005 hash verification, dedup ledger (SETNX), and a per-`intentHash` cycle cap. **Three of three** in-tree park callers (responder, kernel-executor, anonymize route) bypass this primitive and do a raw `redis.set(...)` with no NX, no quota, no hash-verification fields, no per-session counter. The resume side does verify hashes, but legacy v0.1 blobs are accepted with a warning (default `verifyHash: "warn"` mode) — and **every park in this repo writes a v0.1-shaped blob today**. The result is a system that's safe against the "tampered blob" attack (because the resume path detects mismatch when verification fields are present) but completely defenceless against:

1. **Parked-envelope clobber** — a second DEFER for the same `sessionId` silently overwrites the first; the first envelope is *lost* before its resume signal could fire.
2. **No park-time quota** — a single misbehaving session can park unbounded envelopes (the runtime's `DEFAULT_DEFER_QUOTA_PER_SESSION=16` is never enforced because `parkDeferredIntent` is never called).
3. **Per-message NATS auth absent** — `payment.status_changed` arrives on a plain NATS subject; any process that reaches the NATS port can forge a resume signal and trigger re-execution of *every* parked envelope in the system. The only gate is per-session — once an attacker resolves the `sessionId`, they own the resume.
4. **No CLI for stuck-intent drain** — `defer:pending:*` keys are sweep-and-publish on TTL expiry, but there's no operator-facing tool to inspect, replay, or DLQ a stuck park.

The audit-trail / dispatch path is well-defended: hash verification catches tamper-at-rest, SETNX dedup catches webhook replays, the cycle cap (default 3) prevents resume oscillation. The vulnerabilities are at the **park boundary** (no quota, no atomic write, no overwrite-detection) and the **NATS trust boundary** (no signing, no subject ACLs).

---

## Park mechanism review

### Three independent parkers — none uses the runtime primitive

| Caller | File:line | Uses `parkDeferredIntent`? | Writes verification fields? | NX guard? | Counter INCR? |
|---|---|---|---|---|---|
| LLM responder (PIX-pending) | `packages/llm-provider/src/llm-responder.ts:498` | No | No | No | No |
| Kernel-executor (PIX-pending, server-side) | `packages/llm-provider/src/kernel-executor.ts:270` | No | No | No | No |
| `/api/me/data/delete` (anonymize 24h grace) | `apps/api/src/routes/me.ts:313` | No | No | No | No |

All three call shape is identical:

```ts
await redis.set(
  rk(`defer:pending:${sessionId}`),
  JSON.stringify({ envelope, signal, parkedAt }),
  { EX: ttlSeconds },
)
```

No `NX: true`. No per-session quota INCR. The `envelope` JSON does **not** carry the flattened `actorPrincipal` / `version` / `nonce` / `taint` fields the runtime's `verifyParkedEnvelopeHash` needs (the resume side falls back to `verified: null, reason: "missing_fields"` and proceeds with `"warn"` mode — a silent skip).

### Key shape (consistent across callers)

- Key: `${APP_ENV}:defer:pending:${sessionId}` (via `rk()`)
- TTL: `Math.ceil(signal.timeoutMs / 1000) + 60` (responder/kernel-executor) or `24h + 60s` (anonymize)
- Value: `JSON.stringify({ envelope, signal, parkedAt })`
- Write semantics: **unconditional SET** (last-write-wins)

### Race window: resume signal arrives BEFORE park commits

The responder path is:
1. Kernel returns `DEFER`.
2. Responder calls `redis.set(...)`.
3. Returns 202/deferred reply to the user.

The Stripe webhook → `payment.status_changed` publish can fire concurrently with step 2 — there is **no happens-before relationship** between "envelope parked" and "wire signal published". If the PIX provider confirms within the 200-500ms LLM responder latency, the resume subscriber's SCAN can complete before the park's SET commits. The parked envelope then sits orphaned until TTL expiry, at which point the timeout sweeper fires `intent.defer.timeout` with the *expired* event — never resumed.

This is mitigated for the PIX flow only because the customer must observably see the PIX QR code and pay, which takes minimum ~5s of wall-clock. The window is small but real, and the system has no detection mechanism — silent loss of intent.

### Collision: multiple DEFERs for the same sessionId

Because the responder writes with no NX, a second `pix.charge.create` (or any other PIX-pending intent) on the same sessionId silently overwrites the first parked envelope. Found by reading `kernel-executor.ts:270` — there is literally a `redis.set(...)` with no collision check. The first envelope's `intentHash` is now lost; the resume signal will fire `resumeDeferredIntent` against the *second* envelope's intentHash; the first is leaked to the dedup-ledger TTL (14 days) with no audit trail of the dropped intent.

Severity: **high** — a customer who places two orders in quick succession could lose the first one entirely. The cycle counter is per-intentHash so it doesn't help here.

---

## Resume signal inventory

### Signals defined in the codebase

| Signal | Kind | Constant | Defined in |
|---|---|---|---|
| `payment.confirmed` | PIX | `PIX_CONFIRMATION_SIGNAL` | `/Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/types.ts:118` |
| `customer.anonymize.confirmed_after_grace` | LGPD 24h grace | `CUSTOMER_ANONYMIZE_GRACE_SIGNAL` | `packages/pack-customer-onboarding/src/signals.ts:29` |
| `slot.released` | Reservation slot | `RESERVATION_SLOT_RELEASED_SIGNAL` | `packages/pack-reservations/src/types.ts:263` |

### Wire events that resume the parked envelopes

| Wire event | Resumes which signal | Publishers (8 sites) |
|---|---|---|
| `payment.status_changed` (newStatus in {paid,captured,confirmed}) | `payment.confirmed` | `stripe-webhook.ts:217`, `admin/payments.ts:175/259/745`, `admin/order-actions.ts:637`, `stale-order-checker.ts:190`, `packages/tools/src/cart/{amend-order,cancel-order,regenerate-pix}.ts` |
| `intent.defer.timeout` | `customer.anonymize.confirmed_after_grace` | `defer-timeout-sweeper.ts:194` (only) |
| (none) | `slot.released` | **No publisher found** — the `pack-reservations` signal is dead in IbateXas |

### Subscribers (only 2 actively consume DEFER resume events)

| Subscriber | Subscribes to | What it does |
|---|---|---|
| `defer-resolver.ts:458` | `payment.status_changed` | Filters wire status ∈ {paid,captured,confirmed}, SCANs `defer:pending:*`, re-adjudicates the parked envelope |
| `anonymize-grace-resolver.ts:147` | `intent.defer.timeout` | Filters signal == `CUSTOMER_ANONYMIZE_GRACE_SIGNAL`, runs `anonymizeCustomer(customerId)` if pending receipt still exists |

### Idempotency analysis

- **`payment.status_changed` → defer-resolver**: dedup via `defer:resumed:${sha256(intentHash + ":" + signal)}` written by `resumeDeferredIntentImpl` with `SET NX EX=14d`. **Atomic.** Verified at `packages/runtime/src/defer-resume.ts:260`.
- **`payment.status_changed` → payment-lifecycle (auto-confirm)**: dedup via `nats:processed:payment-lifecycle:${paymentId}:${newStatus}` with `SET NX EX=7d`. **Atomic.** Verified at `subscribers/dedup.ts:17`.
- **`intent.defer.timeout` → anonymize-grace-resolver**: dedup via the pending-deletion *receipt* in Redis (`anonymize:pending:${customerId}`). Receipt is deleted *after* `anonymizeCustomer` returns. If the call throws, the receipt stays for retry. **No dedup ledger key** — relies entirely on the receipt's presence as the gate. Race-prone: a concurrent timeout event + manual retry could double-execute (see "Race condition scenarios" #3).

---

## Race condition scenarios

> Severity scale: P0 (data loss / customer-facing breakage), P1 (silent inconsistency), P2 (recoverable / observability gap).

### R1. Parked-envelope clobber on same sessionId — **P0**

Two `pix.charge.create` (or other DEFER-producing intents) on the same `sessionId` within the 15-minute PIX timeout: second park overwrites first.

- **Detection**: none. No metric, no warning, no audit record.
- **Recovery**: none. First envelope is lost to dedup-ledger TTL.
- **Why it's broken**: `kernel-executor.ts:270` and `llm-responder.ts:498` both use raw `redis.set(...)` without NX, bypassing `parkDeferredIntent` which enforces the per-session quota.

### R2. Park-write loses race with resume-signal arrival — **P1**

`payment.confirmed` fires before the parked envelope's SET hits Redis (sub-second window between kernel returning DEFER and `redis.set` resolving).

- **Detection**: orphan resume — defer-resolver SCAN finds nothing, logs "no parked envelopes — nothing to resume".
- **Recovery**: the timeout sweeper will fire `intent.defer.timeout` at TTL expiry; for the PIX flow, no consumer of that timeout reacts (only the anonymize grace resolver subscribes, and it filters on `signal != CUSTOMER_ANONYMIZE_GRACE_SIGNAL`). The customer's intent is silently lost; the LLM responder told them "Estou aguardando confirmação. Te aviso assim que tudo estiver certo." — and never does.
- **Mitigating factor**: realistic PIX QR scan latency is multi-second; the race window is sub-second. Probability is low but nonzero.

### R3. Anonymize timeout fires twice (no atomic dedup) — **P1**

The defer-timeout-sweeper runs every 60s. On a sweep boundary, the published `intent.defer.timeout` event could be delivered twice (NATS Core has no exactly-once guarantee; retries are possible on disconnect). The anonymize-grace-resolver has no dedup key — it relies on `readPendingDeletion(customerId)` being non-null AND `anonymizeCustomer` being idempotent.

- **Worst case**: two parallel invocations of `anonymizeCustomer(customerId)` race. Per the comment at `anonymize-grace-resolver.ts:34-36`, this is "idempotent at the Prisma level (UPDATE-with-no-rows is a no-op)" — which is true for the customer row, but `anonymizeCustomer` (in `@ibatexas/domain`) likely does more: cascade orders, NATS audit, etc. None of that audited here.
- **Recommendation**: add a SETNX-based dedup at the anonymize-grace-resolver boundary using `nats:processed:anonymize-grace:${customerId}` — single-line fix.

### R4. Timeout sweeper AND resume signal fire concurrently — **P1, mitigated**

Scenario: PIX TTL = 15m + 60s grace. At T=14m59s the sweeper SCAN picks up the key. At T=15m00s the wire `payment.status_changed` arrives. Both publish their respective NATS events. The defer-resolver receives `payment.status_changed`, does a SCAN, but the timeout sweeper has already `DEL`'d the key — SCAN returns empty. The customer never gets the resume side-effect.

- **Detection**: orphan resume (as in R2).
- **Defence**: defer-timeout-sweeper.ts:155 — `if (ttl > IMMINENT_TTL_SECONDS) continue;` — so the sweeper only acts at TTL ≤ 60s. But "at TTL ≤ 60s" is exactly when a late wire signal arrives in race-prone scenarios.
- **Sweeper ordering**: the sweeper publishes the `intent.defer.timeout` BEFORE deleting the parked key, but the delete is best-effort and immediate. The defer-resolver SCAN happens AFTER NATS delivery latency — typically already after the DEL.
- **Mitigating factor**: at-most-one execution is preserved (dedup ledger). The harm is "customer never gets the resume side-effect" rather than "double-execute".

### R5. Restart mid-resume: dedup wrote, dispatch never ran — **P0**

The resume flow at `defer-resolver.ts:305-451`:
1. Verify hash.
2. Call `resumeDeferredIntent` (Lua-equivalent: INCR cycle, SETNX dedup, DEL parked key, DECR session counter).
3. Build resume order-state.
4. Call `adjudicate(envelope, state, bundle)`.
5. Emit audit record.
6. Call `_dispatcher(...)` for EXECUTE.

If the process crashes between steps 2 and 6, on restart:
- `defer:pending:${sessionId}` is DELETED (step 2.4 above).
- `defer:resumed:${hash}` ledger key is SET (step 2.2 above).
- The envelope was never executed.
- The cycle counter was incremented.

On the next `payment.status_changed` delivery (NATS retry, or a duplicate wire event), the SCAN finds nothing; even if the responder re-parks, `defer:resumed:${hash}` blocks the resume as "duplicate". **The intent is permanently lost.**

- **Severity**: P0 — silent loss of a confirmed PIX payment's downstream effect (order confirmation, customer notification).
- **Why it's broken**: the kernel's dedup is "at-most-once" — there's no idempotency token tied to the *dispatcher's completion*. The contract is essentially "if we got past `resumeDeferredIntent`, the dispatcher will run" — true when the process doesn't crash, false otherwise.
- **Recommendation**: write a per-sessionId "resume_pending" marker to Redis at the start of step 3, clear at step 6 completion. On restart, sweep these markers and resume from step 3.

### R6. NATS-forged resume signal — **P0 (security)**

`packages/nats-client/src/index.ts` has zero authentication, zero message signing, zero subject ACLs. Any process that can reach the NATS port (typically `nats://localhost:4222` in docker-compose) can publish a forged `payment.status_changed` with `newStatus: "paid"` and trigger the defer-resolver to execute every parked envelope in the system.

- **Trust boundary**: NATS port is bound to localhost in dev; production deployment via docker-compose.prod.yml — need to verify firewall posture.
- **Attack**: SSRF-via-misconfigured-service, container escape, or any subscriber that *receives* an attacker-controlled body which is then re-published as `payment.status_changed`. The Stripe webhook is signature-verified, but the *internal* re-publishers (`admin/payments.ts:175`, `admin/order-actions.ts:637`, `stale-order-checker.ts:190`) trust their callers — admin auth covers them, but any future re-publisher that doesn't is a vector.
- **Defence-in-depth**: per-message HMAC signing (TODO not implemented), per-subject NATS ACLs (TODO not implemented), or JetStream + auth (also TODO — confirmed by `packages/nats-client/src/index.ts:5` comment: `"Full JetStream migration needed for production reliability"`).

### R7. Replay attack with reconstructed timestamp — **P2**

The dedup ledger key is `sha256(intentHash + ":" + signal)` — it does NOT incorporate the wire-event's timestamp or paymentId. So a second delivery of the same `payment.status_changed` with a different `timestamp` field is still suppressed by the ledger (good). An attacker who *changes* the `paymentId` to one that *doesn't exist yet* in IbateXas (e.g., a future Stripe ID) would not even reach the defer-resolver because the resolver doesn't validate `paymentId` exists — but it doesn't need to: the resolver re-builds state from `event.newStatus` and the parked envelope's payload, ignoring `event.paymentId` for the matching step. So a forged event with valid `newStatus` would execute the parked envelope regardless of `paymentId` validity.

This compounds with R6 — the attacker gets full control over the resume timing of every parked envelope.

---

## Timeout sweeper assessment

### Cadence and recovery

- **Repeatable interval**: 60s via `queue.upsertJobScheduler` (BullMQ).
- **TTL grace**: parked envelopes are written with `TTL = signal.timeoutMs/1000 + 60s`. Sweeper threshold = 60s. So any park whose signal `timeoutMs` deadline has passed is caught within at most one 60s sweep.
- **Backfill on extended downtime**: BullMQ `upsertJobScheduler` does NOT replay missed runs. If the worker is down for 1 hour, the parked keys whose TTL falls within that window have already been GC'd by Redis. The `intent.defer.timeout` event was never published. The anonymize-grace-resolver (the only consumer) never fires.
- **Recovery for extended downtime**: **none**. The parked envelopes are lost. There is no "drain" CLI, no orphan-recovery sweep at startup, no audit record for the missed timeouts.

### Implementation correctness

- **SCAN cursor**: `redis.scanIterator({ MATCH, COUNT: 100 })` — non-blocking, good. Bound by `MAX_KEYS_PER_SWEEP=1000` to cap one run, with a follow-up sweep picking up the rest.
- **TTL probe**: `redis.ttl(key)` per key — N+1 round-trips. For O(1000) parks per sweep that's 1000 RTTs, easily 100-500ms. Not pipelined.
- **Per-key error containment**: try/catch around each key — one bad blob doesn't kill the batch. Good.
- **publishNatsEvent failure handling**: `defer-timeout-sweeper.ts:200` — if publish fails, the key is NOT deleted, so the next sweep retries. Good.

### Payload sufficiency

The published `intent.defer.timeout` carries:

```ts
{
  eventType: "intent.defer.timeout",
  sessionId, intentHash, signal, parkedAt, timestamp,
}
```

This is enough for the anonymize-grace-resolver (which needs `sessionId == customerId` and `signal` filter). It is **NOT enough** for a hypothetical PIX-pending timeout consumer to re-build the customer-facing message — no orderId, no displayId. If task 03's followup plan is to fan out a "PIX expired" customer notification, the payload needs `paymentId`/`orderId` from the parked envelope's payload. Current implementation does NOT include them.

---

## Stuck-intent recovery path

### No CLI command exists

Search for `ibx defer`, `ibx adjudicate defer-list`, etc.: **no command**. The CLI has `ibx dlq` (DLQ inspection/replay) and `ibx kernel` (kernel config), but neither lists parked envelopes or replays them.

Operator actions today require direct Redis access:

```bash
# List all parked envelopes for current env
redis-cli --scan --pattern "${APP_ENV}:defer:pending:*"

# Inspect a specific park
redis-cli get "${APP_ENV}:defer:pending:${sessionId}"

# Force-resume by directly publishing the wire event (DANGEROUS — bypasses kernel)
nats pub "ibatexas.payment.status_changed" '{"orderId":"...","paymentId":"...","newStatus":"paid",...}'
```

### Recovery gaps

- **No drain mechanism**: a park whose resume signal is permanently unreachable (e.g., PIX provider deleted the charge, customer never paid) will eventually TTL out. The customer is never notified that their intent expired. The LLM responder's reply was "Te aviso assim que tudo estiver certo" — a lie if it never gets the wire event.
- **No replay mechanism**: a park whose resume DID fire but the dispatcher crashed (R5) has no operator-visible recovery. The dedup ledger blocks any retry.
- **No audit visibility**: parked envelopes have no audit emission at park-time. The only record is the responder's `console.error` if Redis fails — and that goes to stderr, not the audit stream.

### Recommended operator runbook (out of scope for this audit but obvious gaps)

- `ibx defer list [--signal <name>] [--older-than <duration>]` — read `defer:pending:*` and pretty-print.
- `ibx defer expire <sessionId>` — manually publish `intent.defer.timeout` for one park (for orphan recovery).
- `ibx defer drain --signal <name> --reason "..."` — bulk-DLQ all parks matching a filter, with audit emission.

---

## Adversarial scenarios

### A1. Customer triggers parallel anonymize DEFERs

The anonymize route at `apps/api/src/routes/me.ts` does OTP verification + receipt check before parking. The receipt acts as a per-customer mutex: if a receipt exists, the route returns early (route comment at line 285: "we returned early on existing receipt"). However:

- **Receipt write order**: the route reads pending-deletion, checks empty, then runs through the gateway, then writes the parked envelope, then writes the receipt. There is a brief window between "check no receipt" and "write receipt" where a concurrent request can also check empty and proceed. Both would write parked envelopes — but the second SET overwrites the first (no NX), so only the second park survives.
- **OTP single-use**: the OTP marker is consumed AFTER the park. So the second concurrent request *would* also need a fresh OTP — which the route consumes by re-issuing. The OTP is a per-customer Redis SETNX, so the second request fails OTP verification first. **Mitigated.**
- **Result**: realistic concurrent anonymize attempts are caught by the OTP gate, not by the park-time check. Defence-in-depth would be a SETNX on `defer:pending:${customerId}` itself, which is currently absent.

### A2. Forged `payment.confirmed` resumes someone else's envelope

See R6. The defer-resolver SCANs *all* `defer:pending:*` on every wire event and tries to resume each one with `signal: PIX_CONFIRMATION_SIGNAL`. The kernel re-adjudicates against the wire event's status — which for a forged event is whatever the attacker chose. The attacker doesn't even need to know specific sessionIds; one forged `payment.status_changed{newStatus: "paid"}` triggers resume sweep across the entire keyspace.

**The only thing protecting production is NATS network isolation.** No application-layer authentication.

### A3. Hash-verification bypass via missing fields

`resumeDeferredIntent` calls `verifyParkedEnvelopeHash(parked)`:

```ts
if (typeof e.version !== "number" || typeof e.nonce !== "string" || ...) {
  return { verified: null, reason: "missing_fields" }
}
```

If any required field is missing, verification returns `null` (legacy blob), and the default `verifyMode: "warn"` PROCEEDS without verification. An attacker who can write to Redis (R6 + Redis exposure) can craft a parked envelope blob *without* the verification fields, and the resume path will accept whatever payload they specified.

Mitigation: set `verifyHash: "strict"` in the `resumeDeferredIntentImpl` call at `defer-resolver.ts:305-311` — but **none of the in-tree parkers populate the v0.5 verification fields**, so flipping to strict would break the entire DEFER path. The chicken-and-egg: parkers must be migrated to `parkDeferredIntent` (which fills the fields) before strict mode can ship.

### A4. Replay with different paymentId

See R7. The dedup ledger keys on `intentHash + signal`, not the wire event's identifying fields. Attacker delivers `payment.status_changed{paymentId: "different", newStatus: "paid"}` — the resolver looks up parked envelopes by SCAN, finds them, re-adjudicates against the wire event's status (paid), and dispatches. The dedup ledger blocks subsequent replays with the same intentHash+signal — but only AFTER the first execution. An attacker can pre-empt the legitimate Stripe webhook by sending the forged event first.

---

## Test coverage gaps

### What's tested

- **defer-roundtrip.test.ts**: happy path (park → wire event → dispatch), tampered envelope detection, duplicate-delivery dedup, orphan-webhook (no park) no-op, TTL preservation.
- **defer-resolver.test.ts**: 7 scenarios — happy path, duplicate delivery, tamper detection, cycle cap, non-settled status skip, no-park-found, REFUSE on resume.
- **defer-timeout-sweeper.test.ts**: 6 scenarios — expired key swept, no-op when nothing expired, mixed batch, malformed blob still publishes, publish-failure leaves key.

### What's NOT tested

1. **Parked-envelope clobber on same sessionId**: no test asserts that a second DEFER preserves the first, OR that it's explicitly rejected with `quota_exceeded`. (Because the responder bypasses `parkDeferredIntent`, the test would just confirm the bug.)
2. **Park-write loses race with resume signal**: no time-ordering test. Would need a controlled scheduler (vitest fake timers + manual flush) to exercise this.
3. **Restart mid-resume**: no test crashes between dedup write and dispatcher call. The R5 scenario is undetected.
4. **Forged NATS payment.status_changed**: no test exercises the security path — an attacker-controlled wire payload triggering resume. The unit tests all use happy-path Stripe-shaped payloads.
5. **Worker downtime + missed TTLs**: no test asserts behaviour when the sweeper is down for >60s. (BullMQ behaviour is non-replay; the test stub mocks BullMQ so this can't be exercised at the unit level.)
6. **Hash-verification missing-fields fail-closed**: no test asserts that flipping `verifyHash: "strict"` blocks a legacy blob. The roundtrip tests deliberately populate `actorPrincipal` to *pass* verification, masking the legacy-blob fragility.
7. **Concurrent same-signal resume sweeps**: no test for two NATS deliveries arriving within microseconds of each other; the SETNX dedup *should* hold, but the in-memory Redis stub may not exercise the real race.
8. **TTL = 0 / very-short signal timeouts**: no boundary test. A signal with `timeoutMs: 0` would compute `ttlSeconds = 60`, meaning the sweeper picks it up on the first sweep — possibly before the responder can re-park if there's a race.
9. **DLQ recovery semantics**: tampered envelopes are DLQ'd, but no test asserts the DLQ-replay path actually restores the park. (`pushToDlq` is mocked in all tests.)
10. **CLI / operator recovery**: zero test coverage — because no CLI exists.

---

## Findings ranked

| # | Severity | Finding | Location |
|---|---|---|---|
| 1 | **P0** | Park writes use raw `redis.set` with no NX, no quota counter, no verification fields — bypassing `parkDeferredIntent` entirely. Three sites: responder, kernel-executor, anonymize route. | `kernel-executor.ts:270`, `llm-responder.ts:498`, `routes/me.ts:313` |
| 2 | **P0** | Second DEFER for same sessionId silently overwrites first parked envelope. No detection, no audit, intent is lost. | Same as #1 |
| 3 | **P0** | NATS has zero authentication / message signing. Forged `payment.status_changed` triggers resume sweep across the entire keyspace. | `packages/nats-client/src/index.ts` |
| 4 | **P0** | Restart between dedup-ledger SETNX and dispatcher call permanently loses the intent (dedup says "resumed", but execution never happened). | `defer-resolver.ts:305-451` |
| 5 | **P1** | Anonymize-grace-resolver has no SETNX dedup — relies on receipt presence + `anonymizeCustomer` idempotency. Double-execute possible on NATS redelivery. | `anonymize-grace-resolver.ts:84-134` |
| 6 | **P1** | Park-write loses race with same-millisecond resume-signal arrival. Orphan resume returns "no parked envelopes" silently. | Park sites + `defer-resolver.ts:502-507` |
| 7 | **P1** | Sweeper worker downtime >60s loses parked envelopes whose TTL expires during the outage. No backfill, no audit, no recovery. | `defer-timeout-sweeper.ts:268` (BullMQ `upsertJobScheduler`) |
| 8 | **P1** | `verifyHash: "warn"` (default) accepts legacy blobs without the v0.5 fields. Every in-tree parker writes legacy blobs. Strict mode is unreachable. | `defer-resume.ts:203, 219-232` |
| 9 | **P1** | `intent.defer.timeout` payload missing `orderId`/`paymentId`/customer-routing fields needed for non-anonymize timeout consumers. | `defer-timeout-sweeper.ts:185-192` |
| 10 | **P1** | No CLI command for `ibx defer list/expire/drain/replay`. Operators must use raw redis-cli for any stuck-intent inspection. | `packages/cli/src/commands/` (absence) |
| 11 | **P2** | Sweeper does N+1 TTL probes (no MULTI pipelining). At MAX_KEYS_PER_SWEEP=1000 that's measurable latency. | `defer-timeout-sweeper.ts:150` |
| 12 | **P2** | `slot.released` signal is exported from `pack-reservations` but has no publisher in the codebase — reservation DEFERs would never resume. (May be planned for future; flag for ADR review.) | `packages/pack-reservations/src/types.ts:263` |
| 13 | **P2** | Test coverage for race conditions (R2, R4, R5) and adversarial paths (A2, A3, A4) is absent. Roundtrip tests deliberately populate verification fields, masking the legacy-blob fragility. | `apps/api/src/__tests__/defer-roundtrip*.test.ts` |
| 14 | **P2** | Dedup ledger key derives from `intentHash + signal` only — does not bind to wire event paymentId or timestamp. Replay-with-forged-event bypass possible (compounds with #3). | `defer-resume.ts:25-27` |
| 15 | **P2** | No audit emission at park-time. Only resume-time emits an audit record. Forensics on "why did this intent get parked" require log scraping. | `kernel-executor.ts:263-288` (no `auditSink.emit` call) |

---

## Verdict

**DEFER is not production-safe today.** The runtime's safety primitives (`parkDeferredIntent`, hash verification in strict mode, per-session quota, cycle cap) are well-designed. **None of them are wired up at the IbateXas park sites.** The resume side defends against tamper-at-rest and webhook replay, but the park side is essentially "redis.set last-write-wins" with no defence against the most likely production failure modes (concurrent DEFERs from the same session, restart mid-resume, forged NATS signals).

**Recommended next steps (priority order)**:

1. **Migrate all three park sites to `parkDeferredIntent`** — fills verification fields, enforces quota, sets counter. Then flip `verifyHash` to `"strict"` in defer-resolver.
2. **Add NX guard on park writes** as defence-in-depth even if `parkDeferredIntent` quota is in place. Surface a `quota_exceeded` REFUSE with pt-BR copy so the customer learns their second concurrent intent was rejected.
3. **Wire NATS auth** (JetStream + per-subscriber credentials, or HMAC message signing) before the M2 rollout exits shadow mode for any DEFER-emitting intent.
4. **Add a "resume in-flight" marker** to close the restart-mid-resume window. The marker writes BEFORE the dedup ledger and clears AFTER the dispatcher confirms.
5. **Build `ibx defer` CLI** covering list / expire / drain / replay. Without it, operators have no inspection / recovery path other than raw redis-cli.
6. **Add adversarial test coverage** (R5 crash, A2 forged NATS, A3 missing fields).
