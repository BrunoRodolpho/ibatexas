> **NOTE — load-bearing constitutional.** The DEFER semantics + park/resume protocol + TTL + idempotency rules below are still authoritative. The "two bugs in today's implementation" callouts in the executive summary (resolver not started, resume doesn't re-execute) were closed in W1-W4 of correctness-remediation and the cutover; treat those paragraphs as historical context. See `README.md` in this directory for the full classification.

---

# 06 — Deferred Execution Policy

> Companion to: [`01-intent-taxonomy.md`](./01-intent-taxonomy.md), [`04-decision-policy.md`](./04-decision-policy.md), [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md).
> Sources: investigations [01](../investigation/01-llm-tool-execution.md), [04](../investigation/04-background-jobs-nats.md), [05](../investigation/05-adjudicate-capabilities.md). Adjudicate framework: `/Users/thaisrodolpho/projects/adjudicate/packages/runtime/src/defer-park.ts`, `defer-resume.ts`, `pack-payments-pix/src/policies.ts`, `pack-identity-kyc/src/*`.

## Executive summary

- **DEFER is the kernel's "await a wire signal"** decision. The envelope is parked in Redis at `rk("defer:pending:{sessionId}")` (per current `llm-responder.ts:384-406` and investigation 04 §"Park mechanism"); a NATS subscriber on the matching wire subject drains and re-executes via `resumeDeferredIntent` from `@adjudicate/runtime` (per investigation 05 §"runtime").
- Today, **only `order.confirm` (PIX-pending) defers**, only via `createPixPendingDeferGuard` (per investigation 01 §"Refusal/validation status" + investigation 04 §"Resume signals"). The framework supports more — `pack-identity-kyc` ships `KYC_DOCUMENTS_UPLOADED_SIGNAL` and `KYC_VENDOR_COMPLETED_SIGNAL` per investigation 05 §"pack-identity-kyc". ibatexas adds resume signals for handoff and KYC per the table below.
- **Two critical bugs in today's implementation** (per investigation 04 §"Deferred intent system" + master plan §"WS1"):
  1. `startDeferResolverSubscriber` is **never invoked** in `apps/api/src/index.ts` — the resume path is dead at runtime.
  2. `resumeDeferredIntent` (when wired) only flips the dedup ledger and deletes the parked key. **It does NOT re-execute the parked envelope.** Per master plan §"WS1" the fix is to re-execute through `adjudicate()` on resume.
- **TTL = `signal.timeoutMs + 60s grace`** (per investigation 04 §"Park mechanism"). On TTL expiry the resume never fires; today the customer is left in conversational limbo. This doc defines a timeout policy: a sweeper subscriber on Redis keyspace notifications publishes `intent.defer.timeout` events that drive customer-facing follow-ups.
- **Idempotency**: a resumed envelope must produce the **same decision hash** as the original park to be considered a "successful resume" — otherwise it's a replay-induced drift, audit-flagged via `classifyReplayDrift`. The `defer:resumed:{deferResumeHash}` SET-NX key (TTL = `DEFER_PENDING_TTL_GRACE_SECONDS = 14 days` per investigation 05 §"runtime") ensures at-most-once resume per `(intentHash, signal)` pair.

## DEFER vs REFUSE — when to use which

This is the most-asked question per intent design. The framework's stance (per investigation 05 §"pack-payments-pix" + the PIX state machine):

| Situation | Decision | Rationale |
|---|---|---|
| PIX is pending; expected to confirm soon | **DEFER** on `payment.confirmed` | The action will likely become valid; waiting is the user-friendly path |
| Customer has insufficient funds (Stripe declined) | **REFUSE** with code `payment_failed` | No signal will ever change this; deferring would mislead the user |
| Stripe is down; webhook hasn't arrived | **DEFER** on `payment.confirmed` (same as PIX-pending) | Transient external dependency; recover on signal |
| Customer not authenticated | **REFUSE** with code `identity_missing` | No async resolution possible from kernel layer |
| Cart already empty | **REFUSE** with code `state/terminal_state` | State terminal; nothing to wait for |
| KYC documents uploaded but vendor processing | **DEFER** on `kyc.vendor.completed` | Vendor responds async; valid wait state |
| KYC vendor returned score < threshold | **REFUSE** with code `kyc_score_below_threshold` | Terminal; no signal will reverse |
| Handoff requested; staff response pending | **DEFER** on `staff.handoff.received` (new) | Human-in-the-loop async wait |
| Anonymize requested without OTP | **REQUEST_CONFIRMATION** (not DEFER) | Requires user-initiated receipt, not a wire signal |
| Ledger circuit open + `IBX_LEDGER_FAIL_OPEN=false` | **REFUSE** with code `ledger_unavailable` | Operator action, not wire signal |

**Rule of thumb**: DEFER iff (a) an external wire signal will plausibly arrive within TTL, and (b) the decision is **expected to flip to EXECUTE** on signal arrival.

## Park mechanism

Per `llm-responder.ts:384-406` (per investigation 04 §"Park mechanism"). The current implementation is correct except for the resolver-not-wired and resume-doesn't-execute bugs.

### Redis key shape

```
rk("defer:pending:{sessionId}")  →  JSON.stringify(ParkedEnvelope)

where ParkedEnvelope = {
  envelope: IntentEnvelope,
  signal: string,        // e.g. "payment.confirmed"
  parkedAt: string,      // ISO timestamp
}
```

Per investigation 05 §"runtime" — `ParkedEnvelope` type from `@adjudicate/runtime`.

### TTL policy

```
TTL = Math.ceil(decision.timeoutMs / 1000) + 60   // seconds
```

Per `llm-responder.ts:391` (existing). The +60s grace accounts for clock skew between Redis and NATS subscribers and the time needed for `resumeDeferredIntent` to consume + acknowledge.

### Park quota

Per investigation 05 §"runtime" — `DEFAULT_DEFER_QUOTA_PER_SESSION = 16`. `parkDeferredIntent` enforces the per-session cap via Redis INCR + EXPIRE. On quota exceeded, returns `{parked: false, reason: "quota_exceeded", observed, limit}` and triggers `recordResourceLimit({resource: "defer_quota"})` per investigation 05 §"MetricsSink".

ibatexas can override the quota per session class via `parkDeferredIntent` args — e.g. customer sessions get 4, system actors get 32. Driven by env: `IBX_DEFER_QUOTA_CUSTOMER=4`, `IBX_DEFER_QUOTA_SYSTEM=32` (new env vars per investigation 06 §"Conspicuously absent" list — defer-quota override).

## Resume signal contract

A resume signal is a **wire-level NATS subject** that, when consumed, triggers a sweep of `defer:pending:*` keys with matching `signal` field.

### Subject pattern

```
ibatexas.{domain}.{event}    →  e.g. "ibatexas.payment.status_changed"
```

The subscriber maps the wire subject to a logical signal name:

```ts
// apps/api/src/subscribers/defer-resolver.ts (existing but unwired, per inv 04)
const SIGNAL_MAP: Record<string, (msg: any) => string | null> = {
  "payment.status_changed": (msg) =>
    SETTLED_WIRE_STATUSES.has(msg.newStatus) ? "payment.confirmed" : null,
  "kyc.vendor.completed": (msg) => "kyc.vendor.completed",
  "kyc.documents.uploaded": (msg) => "kyc.documents.uploaded",
  "support.handoff.received": (msg) => "staff.handoff.received",
};
```

### Signal envelope shape

The framework's `resumeDeferredIntent` (per investigation 05 §"runtime") consumes:

```ts
type ResumeArgs = {
  parkKey: string;                  // rk("defer:pending:{sessionId}")
  signal: string;                   // must match parked envelope's signal
  redis: DeferRedis;
  hashVerify: "strict" | "warn" | "off";  // verifyParkedEnvelopeHash policy
  cycleCap?: number;                // DEFAULT_MAX_RESUME_CYCLES = 3
}
```

Returns:
```ts
{ resumed: true, intentHash, parked: ParkedEnvelope } | { resumed: false, reason }
```

The `parked.envelope` is the original; **the migration MUST re-execute it** via:

```ts
// Migration fix per master plan §"WS1"
const result = await resumeDeferredIntent({...});
if (result.resumed) {
  // CRITICAL: re-adjudicate the original envelope on resume
  const decision = await adjudicateAndAudit(
    result.parked.envelope,
    fetchCurrentState(result.parked.envelope),     // state may have advanced
    orderPolicyBundle,
    { sink, ledger, plan, /* ... */, supersedes: { reason: "defer_resumed", predecessorIntentHash: result.intentHash } },
  );
  if (decision.kind === "EXECUTE") {
    await dispatchToExecutor(result.parked.envelope);
  } else if (decision.kind === "DEFER") {
    // re-park; respect cycleCap (3) per inv 05 §"runtime"
  } else if (decision.kind === "REFUSE") {
    // notify customer the wait timed out / state moved on
    await sendCustomerNotification(result.parked.envelope, decision);
  }
}
```

This is the **load-bearing invariant** per investigation 05 §"adjudicate/anthropic" — "DEFER persists full envelope fields so resume can re-derive intentHash". Today's `resumeDeferredIntent` only does the ledger+key cleanup; the re-execute step is **missing** in the call site (investigation 04 §"Even if it were wired" — "the resumed envelope is lost").

## Allowed resume signals

| Signal name | Source NATS subject | Triggered by | When emitted | Cycle cap |
|---|---|---|---|---|
| `payment.confirmed` | `payment.status_changed` (filter: `newStatus ∈ SETTLED_WIRE_STATUSES`) | Stripe webhook `payment_intent.succeeded` → `payment-lifecycle` subscriber | PIX confirmed, card captured | 3 (DEFAULT_MAX_RESUME_CYCLES per inv 05) |
| `payment.refund.confirmed` | `payment.status_changed` (filter: `newStatus === REFUNDED`) | Stripe webhook `charge.refunded` | Refund settled | 3 |
| `kyc.vendor.completed` | `kyc.vendor.completed` (new; future) | Future KYC integration when adopting `@adjudicate/pack-identity-kyc` | Vendor returns verification result | 3 |
| `kyc.documents.uploaded` | `kyc.documents.uploaded` (new; future) | Future document upload completion | Customer finishes upload step | 3 |
| `staff.handoff.received` | `support.handoff.received` (new) | Staff acknowledges handoff in admin UI (new endpoint) | Staff member opens the conversation | 3 |
| `cart.recovery.signal` | `cart.recovery.received` (new; speculative) | Future cart-recovery workflow | Customer responds to recovery nudge | 2 |
| `pix.qr.regenerated` | `payment.status_changed` (filter: `event === "pix_regenerated"`) | Customer regenerates PIX after expiry; deferred checkout can resume against new charge | Per `regenerate_pix` LLM tool / route | 1 (single attempt) |

Per investigation 04 §"Resume signals" — today only `payment.confirmed` is used. The other signals are reserved kinds; their subscribers are added incrementally as the corresponding flows are adjudicated.

## Timeout policy

Today (per investigation 04 §"Timeout / cleanup behavior"):
- Redis key expires silently.
- No sweeper.
- No customer notification.
- Customer left in conversational limbo with "Estou aguardando confirmação..." message that never resolves.

Migration adds:

### Sweeper subscriber

New subscriber `apps/api/src/subscribers/defer-timeout-sweeper.ts` listens to Redis keyspace expiration notifications:

```
__keyevent@0__:expired   →   filter keys matching rk("defer:pending:*")
                          →   read the (now-expired) ParkedEnvelope from a separate
                              "tombstone" key written at park time
                          →   emit ibatexas.intent.defer.timeout NATS event
                          →   publish a customer-facing notification
```

Redis keyspace notifications must be enabled (`CONFIG SET notify-keyspace-events Ex`) — added to the bootstrap config.

### Tombstone pattern

At park time, in addition to `rk("defer:pending:{sessionId}")`, write:

```
rk("defer:tombstone:{intentHash}")  →  JSON.stringify(ParkedEnvelope)
TTL = signal.timeoutMs/1000 + 86400   // 24h grace beyond the park TTL
```

When the park key expires, the tombstone survives, letting the sweeper read the original envelope shape and notify the customer with context.

### Timeout outcomes per intent kind

| Intent kind | On timeout | Customer notification (pt-BR) | Audit |
|---|---|---|---|
| `order.checkout.create` (PIX pending) | Customer messaged; offer regenerate-PIX | `"O PIX expirou. Quer que eu gere um novo QR Code?"` | `intent.defer.timeout` event; `AuditRecord.decision = REFUSE` with code `pix_expired` |
| `payment.charge.confirm` (Stripe outage) | Re-queue at the BullMQ outbox-retry job | `"Estamos com instabilidade no pagamento. Vou checar de novo em breve."` | timeout event; supersedes original DEFER |
| KYC kinds (future) | ESCALATE to staff (manual review) | `"Sua verificação está demorando mais do que o esperado. Nossa equipe vai te ajudar."` | ESCALATE audit with reason `kyc_timeout` |
| `whatsapp.handoff.request` (no staff response) | Re-publish to backup staff channel | `"Vou tentar avisar nossa equipe novamente."` | re-handoff envelope; supersedes original |

## Re-execution semantics

Per master plan §"WS1" "fix `resumeDeferredIntent` to re-execute":

```
resume signal arrives
   ↓
defer-resolver subscriber drains matching defer:pending:* keys
   ↓
for each parked envelope:
   1. verifyParkedEnvelopeHash(parked) → must pass (hashVerify=strict per inv 05)
   2. ledger SET-NX defer:resumed:{deferResumeHash} (idempotency)
      → if hit: skip (already resumed)
   3. adjudicateAndAudit(parked.envelope, currentState, bundle, {
        supersedes: { reason: "defer_resumed", predecessorIntentHash: result.intentHash }
      })
   4. switch decision.kind:
        EXECUTE      → dispatchToExecutor(parked.envelope)
        REWRITE      → dispatchToExecutor(decision.rewritten)
        REFUSE       → notify customer; record terminal audit
        DEFER again  → re-park (subject to cycleCap = 3 per inv 05)
        ESCALATE     → publish handoff envelope
        REQUEST_CONF → unexpected at resume time; record as drift; refuse
   5. DEL defer:pending:{sessionId}
   6. DEL defer:tombstone:{intentHash}
```

### Idempotency: same decision hash invariant

A resumed envelope **must** produce the same `decision.kind` as the original park's "would-have-EXECUTEd if signal arrived" intent — otherwise the resume is **drift**. Verified by:

1. **`verifyParkedEnvelopeHash(parked)`** per investigation 05 §"runtime" — re-derives `intentHash` from the parked envelope fields; mismatch = `T-005` violation.
2. **`deferResumeHash(intentHash, signal)`** SET-NX per investigation 05 — prevents duplicate resume per `(intentHash, signal)` pair.
3. **Decision-class invariant**: a parked `order.checkout.create` should resume to EXECUTE on `payment.confirmed`. If it resumes to REFUSE (state advanced; cart cleared), audit-record both the original DEFER and the resumed REFUSE with `supersedes` linking; the replay job (per [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) §"Replay schedule") flags this as a legitimate state-progression drift, not a code-change drift.

### Cycle cap

Per investigation 05 §"runtime" — `DEFAULT_MAX_RESUME_CYCLES = 3`. After 3 DEFER → resume → DEFER oscillations on the same intentHash, the resume returns `{resumed: false, reason: "cycle_cap_exceeded"}` and the envelope is **terminally REFUSEd** with code `defer_cycle_exhausted`. This bounds pathological PSP flapping.

## Audit subjects for DEFER

Per [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) §"Subject naming convention":

| Subject | Payload | Purpose |
|---|---|---|
| `ibatexas.audit.intent.decision.v1` | Standard `AuditRecord` with `decision.kind = "DEFER"` | The DEFER decision audit; same stream as all decisions |
| `ibatexas.audit.intent.defer.v1` | `{intentHash, signal, parkedAt, expiresAt, sessionId}` | Specific park event for fast operator dashboards (count active parks) |
| `ibatexas.audit.intent.resume.v1` | `{intentHash, resumedAt, originalDecisionHash, newDecisionHash, success: bool}` | Per-resume telemetry; powers DEFER round-trip latency p99 |
| `ibatexas.intent.defer.timeout` | `{intentHash, parkedAt, expiredAt, signal}` | Timeout events; consumed by customer-notification publisher |

## Metrics

Per investigation 07 §"Alerting gaps":

| Metric | Source | Alert threshold |
|---|---|---|
| `kernel_defer_park_total{kind}` | `parkDeferredIntent` per inv 05 | none (volume metric) |
| `kernel_defer_resume_duration_seconds{kind}` p99 | `resumeDeferredIntent` end-to-end | > 5s for `order.checkout.create` (paged S2 per inv 07) |
| `kernel_defer_timeout_total{kind}` | sweeper subscriber | > 0 in 1 min sustained (paged S1 per inv 07) |
| `kernel_defer_cycle_cap_exceeded_total{kind}` | resume path when cycle = 3 | > 0 in 5 min (paged S1) |
| `kernel_defer_quota_exceeded_total{sessionType}` | `parkDeferredIntent` quota path | > 0 per session in 1h (paged S2) |
| `kernel_defer_park_active{kind}` (gauge) | Redis SCAN of `defer:pending:*` periodically | > 100 sustained (paged S2 — backlog) |

## Wiring checklist (per master plan §"WS1")

Per investigation 04 §"Gaps and recommendations Architectural":

| Step | Effort | Cited |
|---|---|---|
| 1. Wire `startDeferResolverSubscriber` in `apps/api/src/index.ts` | <1 day; investigation 04 §"P0 #5" | "highest-priority bug" |
| 2. Fix `resumeDeferredIntent` call site to re-execute the parked envelope through `adjudicateAndAudit` | 1-2 days | investigation 04 §"Even if it were wired"; master plan §"WS1" |
| 3. Add tombstone pattern + sweeper for timeouts | 2-3 days | this doc §"Sweeper subscriber" |
| 4. Enable Redis keyspace notifications in bootstrap | 30 min | this doc §"Sweeper subscriber" |
| 5. Add resume-signal subscribers for the future kinds (KYC, handoff) | 2 days per signal | this doc §"Allowed resume signals" |
| 6. Add `audit.intent.defer.v1` / `audit.intent.resume.v1` subjects (separate from primary record stream) | 1 day | [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) §"Subject naming convention" |
| 7. Integration test for DEFER round-trip per investigation 07 P0 #3 | 2 days | investigation 07 §"P0 — must land before Stage 1 ENFORCE" |

## Cross-references

- DEFER as a decision outcome: [`04-decision-policy.md`](./04-decision-policy.md) §"The six decision outcomes".
- DEFER intent kinds (which kinds can produce DEFER): [`04-decision-policy.md`](./04-decision-policy.md) §"Decision-kind selection per intent".
- Audit emissions for DEFER park/resume: [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) §"Subject naming convention".
- Recovery from stuck DEFER: [`07-rollback-recovery.md`](./07-rollback-recovery.md) §"Recovery from a stuck DEFER".
- Framework park/resume APIs: `/Users/thaisrodolpho/projects/adjudicate/packages/runtime/src/{defer-park,defer-resume,resume-hash-verify}.ts`.
- PIX-pending guard factory: `/Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/policies.ts` (`createPixPendingDeferGuard`).
- KYC pack DEFER kinds (future ibatexas adoption): `/Users/thaisrodolpho/projects/adjudicate/packages/pack-identity-kyc/src/types.ts`.
