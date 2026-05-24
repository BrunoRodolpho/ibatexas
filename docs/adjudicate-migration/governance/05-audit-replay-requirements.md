> **NOTE — load-bearing with stale rollout framing.** The `AuditRecord` v4 schema, PII redactor contract, and replay/drift policy below are still authoritative. The "before enforce flip" gating references throughout this doc point to a deleted rollout framework — the kernel is now always-on per `CLAUDE.md` rule #9 (cutover commit `f3bea43`). Read "before enforce flip" as "before production deploy" (or simply ignore the gating, since no rollout phase exists today). See `README.md` in this directory for the full classification.

---

# 05 — Audit & Replay Requirements

> Companion to: [`01-intent-taxonomy.md`](./01-intent-taxonomy.md), [`04-decision-policy.md`](./04-decision-policy.md), [`06-deferred-execution-policy.md`](./06-deferred-execution-policy.md), [`07-rollback-recovery.md`](./07-rollback-recovery.md).
> Sources: investigations [04](../investigation/04-background-jobs-nats.md), [05](../investigation/05-adjudicate-capabilities.md), [07](../investigation/07-testing-observability.md), [08](../investigation/08-security-trust-boundaries.md). Adjudicate framework: `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/audit.ts`, `audit/src/index.ts`, `audit-postgres/src/index.ts`.

## Executive summary

- Every adjudicated decision must produce an `AuditRecord` (v4 per investigation 05 — `AUDIT_RECORD_VERSION = 4`) that survives: process restart, NATS broker outage, Postgres maintenance window, and Redis cache eviction. Composition target: `persistentBufferedSink(multiSink(consoleSink, natsSink, postgresSink))` with a Redis-backed spill storage.
- **PII redaction is non-negotiable.** Investigation 08 §"P0 #1" identified that today CPF/email/phone bleed into `ibatexas.audit.intent.decision.v1` because `AuditRecord.envelope.payload` is published verbatim. The `AuditRedactor` runs **before** any sink emit, masks fields per intent-kind schema (driven by PII levels in [`01-intent-taxonomy.md`](./01-intent-taxonomy.md) §"PII categorization"), and is contract-tested before any shadow flip.
- Hot path: NATS subject `ibatexas.audit.intent.decision.v1` (current; per investigation 06 — already wired but unconsumed). Cold path: `@adjudicate/audit-postgres.createPostgresSink` with monthly partitioning (per investigation 05). Crash-safe buffer: `persistentBufferedSink` with Redis storage (per investigation 05 Tier 1 #7).
- Replay runs nightly via `ibx kernel replay --since=24h` (new CLI per investigation 07 P1 #10). Uses `replayWithIntegrity` + `classifyReplayDrift` from `@adjudicate/audit` (per investigation 05). Daily drift class must be `stable` or `improving`; any other class blocks the next-day enforce flip per [`07-rollback-recovery.md`](./07-rollback-recovery.md).
- Retention: **90 days hot** (Postgres partitioned monthly), **1 year warm** (S3 JSONL archive), **archival cold** (S3 Glacier; pruned only after legal hold lifted). Per intent kind, the retention tag drives the lifecycle policy.

## The `AuditRecord` (v4)

From `@adjudicate/core` (per investigation 05 §"core top-level"). Full schema includes:

```ts
type AuditRecord = {
  // Versioning + identity
  auditVersion: 4;
  auditHash: string;                  // canonical hash of the entire record
  recordedAt: string;                 // ISO timestamp
  kernelIdentity: { id: string; version: string };

  // Intent under adjudication
  envelope: IntentEnvelope;           // ← THE PII RISK SURFACE
  intentHash: string;                 // === envelope.intentHash

  // Decision the kernel produced
  decision: Decision;
  durationMs: number;

  // Planning context (NEW in v4)
  plan: AuditPlanSnapshot;            // { visibleReadTools, allowedIntents, planFingerprint }

  // Policy provenance
  policyVersion: string;              // semver of the bundle that adjudicated
  packId: string;                     // e.g. "@ibatexas/pack-orders@1.2.0"

  // Causal links
  supersedes?: Supersession;          // { reason, predecessorIntentHash }
  ledgerHit?: { matched: boolean; resourceVersion?: number };

  // Signing (placeholder for v0.2 — KernelIdentity.attest())
  signature?: string;
};
```

The full type is exported from `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/audit.ts` (per investigation 05 §"core top-level"). `buildAuditRecord(input)` and `verifyAuditRecord(record)` are the constructor and verifier.

## Required AuditRecord fields (ibatexas extensions)

Beyond the base v4, ibatexas requires these fields populated on every emission (validated by a contract test in CI per investigation 07 §"P0 #6"):

| Field | Source | Why |
|---|---|---|
| `envelope.actor.principal` | Boundary crossing site per [`03-trust-boundary-model.md`](./03-trust-boundary-model.md) §"Boundary inventory" | Causal trace for SOC2/LGPD review |
| `envelope.actor.taint` | `createSystemTaintPolicy` per [`03-trust-boundary-model.md`](./03-trust-boundary-model.md) §"Recommended TaintPolicy composition" | Reproducible adjudication on replay |
| `envelope.actor.sessionId` | Per actor table in [`01-intent-taxonomy.md`](./01-intent-taxonomy.md) §"Actor types" | Per-session correlation; supports per-customer audit slices |
| `envelope.payload` | **Redacted by `AuditRedactor` before emit** | PII compliance per investigation 08 §"P0 #1" |
| `decision.basis[]` | Kernel produces; basis category + code from `BASIS_CODES` per `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/basis-codes.ts` | Refusal analytics + drift detection |
| `plan` | `AuditPlanSnapshot` from `safePlan` wrapper per [`02-capability-model.md`](./02-capability-model.md) §"The `safePlan` wrapper" | Replay determinism: a planner-visible-tools change reproduces decisions exactly |
| `packId` | `installPack(pack, ...)` returned wrapped pack per investigation 05 §"installPack" | Per-pack version tracking; supports `ibx kernel divergence --pack` |
| `supersedes` | Set by kernel when confirmation-resolved, defer-resumed, rewrite-executed, or replay; per investigation 05 §"Supersession" | Multi-step causal chains per `04-decision-policy.md` §"Receipt envelope shape" |
| `ledgerHit` | `AdjudicateAndAuditDeps.ledger` from `@adjudicate/audit` Redis ledger per investigation 06 §"Intent ledger wiring" | Detect replay-suppressed duplicates |
| `kernelIdentity.id` | `createKernelIdentity("ibatexas", versionFromPackageJson)` per investigation 05 §"KernelIdentity" | Per-deploy identity; supports multi-region kernel forensics |

## PII redaction contract

The `AuditRedactor` (named here; **does not yet exist** — must be authored per investigation 08 §"P0 #1 fix recommendation") sits between `buildAuditRecord` and `sink.emit`:

```
adjudicateAndAudit → buildAuditRecord(input) → redactor(record) → sink.emit(redactedRecord)
```

### Redaction schema

Driven by intent-kind to PII-level mapping in [`01-intent-taxonomy.md`](./01-intent-taxonomy.md) §"PII categorization":

| PII level | Fields in envelope.payload | Redaction action |
|---|---|---|
| **high** | `cpf`, raw `email`, raw `phone`, `name`, `pixDetails.{name,email,cpf}`, full `address.street`, `address.complement` | Replace with `"REDACTED:{sha256(value).slice(0,8)}"` — preserves uniqueness for analytics correlation; no plaintext leaves the boundary |
| **med** | `address.street`, `address.complement` (when standalone, not under pixDetails) | Replace street/complement with `"REDACTED"`; keep `neighborhood`, `city`, `cepPrefix` (5 digits) for delivery-zone analytics |
| **low** | free-form strings (`reason`, `comment`, `body`, `specialRequests`) | Truncate to 64 chars; strip newlines; HTML/markdown-escape |
| **none** | IDs, enums, integer amounts, hashes | Pass through |

### Per-kind redactor configuration

```ts
// @ibatexas/audit/src/redactor.ts (new, per investigation 08 P0 fix)
const REDACTION_MAP: Record<string, RedactionSchema> = {
  "order.pix.details.set":   { high: ["name", "email", "cpf"] },
  "order.checkout.create":   { high: ["pixDetails.name", "pixDetails.email", "pixDetails.cpf"] },
  "order.address.change":    { med:  ["address.street", "address.complement"] },
  "customer.create":         { high: ["phone"] },
  "customer.profile.update": { high: ["name", "email"] },
  "customer.pix.details.save": { high: ["name", "email", "cpf"] },
  "customer.address.add":    { med:  ["address.street", "address.complement"] },
  "customer.anonymize":      { high: ["customerId"] },     // hash even the ID at this point
  "whatsapp.handoff.request":{ low:  ["reason"] },
  "order.review.submit":     { low:  ["comment"] },
  "whatsapp.message.send":   { low:  ["variables.*"] },    // generic template variable truncation
  // Default for any kind missing here: pass-through (none).
};
```

### Pre-emit contract test (gates Stage 1 shadow per investigation 07 P0 #6)

Required CI test: for every kind in `REDACTION_MAP`, construct an envelope with synthetic PII, run through the redactor, assert no `cpf`/`email`/`phone` regex match in the resulting JSON. Per investigation 08 §"P0 #1 fix" — verified by contract test before any shadow flip.

```ts
// __tests__/audit-redactor.contract.test.ts
const PII_REGEX = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\b[\w\.+-]+@[\w-]+\.\w+\b|\+?55\d{10,11}/;
for (const kind of Object.keys(REDACTION_MAP)) {
  it(`redacts PII from ${kind}`, () => {
    const envelope = synthesizeEnvelopeWithPII(kind);
    const record = buildAuditRecord({ envelope, decision: executeDecision(), /* ... */ });
    const redacted = redactor(record);
    expect(JSON.stringify(redacted)).not.toMatch(PII_REGEX);
  });
}
```

## Sink topology

Per investigation 06 §"Audit sink wiring" + investigation 05 Tier 1 #5-7 + investigation 07 §"NATS audit subjects":

```
adjudicateAndAudit
       ↓
AuditRedactor (new — per investigation 08 P0 #1)
       ↓
persistentBufferedSink(  ← crash-safe outer wrapper per inv 05 Tier 1 #7
  inner: multiSink(       ← strict fan-out per inv 05 §"Sinks"
    consoleSink({ prefix: "[ibx-audit]" }),           // dev visibility
    natsSink({ publisher, subject: "audit.intent.decision.v1" }),  // hot fanout
    postgresSink({ pool, partitionFn: partitionMonthOf }),         // cold durable
  ),
  storage: redisSpillStorage(redisClient, "ibx:audit:spill:"),
  capacity: 10_000,
  onOverflow: (record, reason) => { sentry.captureException(...); },
)
```

### Hot path — NATS `ibatexas.audit.intent.decision.v1`

Already wired via `intent-audit-wiring.ts` (per investigation 06 §"Audit sink wiring"). Currently has **no consumer** (per investigation 06 §"P0-5"). Migration adds:

- **Operator console live tail** via `createInMemoryAuditEventBus` (per investigation 05 §"Cross-replica coordination") for the future `apps/console` audit explorer view.
- **Real-time refusal alerts** via a Sentry breadcrumb subscriber on this subject (per investigation 06 §"Recommendations" — Sentry on `recordRefusal`).

Subject naming convention (per investigation 07 §"NATS audit subjects"):
- `ibatexas.audit.intent.decision.v1` — primary record stream (every adjudicated decision)
- `ibatexas.audit.intent.defer.v1` — DEFER park events (envelope shape: `{intentHash, signal, parkedAt, expiresAt}`)
- `ibatexas.audit.intent.resume.v1` — DEFER resume events (envelope shape: `{intentHash, resumedAt, originalDecision, newDecision}`)
- `ibatexas.audit.ledger.op.v1` — ledger check/record latency stream (envelope shape: `{intentHash, op: "check"|"record", outcome: "hit"|"miss"|"error", durationMs}`)
- `ibatexas.audit.intent.killswitch.v1` — kill switch toggle events (envelope shape: `{active, reason, actorPrincipal, timestamp}`)

Schema breaking changes get a `.v2` suffix; old subscribers stay subscribed to `.v1` until cutover.

### Cold path — Postgres via `@adjudicate/audit-postgres`

Adopt `createPostgresSink` (per investigation 05 Tier 1 #5). Monthly partitioning via `partitionMonthOf` (per investigation 05 §"audit-postgres"). Migration includes:

1. New Prisma schema additions: `intent_audit` table per `@adjudicate/audit-postgres` shape (`intent_audit_row` ↔ `AuditRecord` via `rowToRecord`/`recordToRow`).
2. Monthly partition creator: BullMQ job `audit-partition-rotator` runs daily at 02:00 UTC, creates next month's partition (`intent_audit_2026_06`, etc.) 7 days ahead.
3. Read API: `readAuditWindow(pool, {since, until, intentKind?, customerId?})` per investigation 05 §"audit-postgres" — backing the future `apps/console` audit explorer.

### Crash-safe buffer — `persistentBufferedSink`

Per investigation 05 Tier 1 #7. Spill storage backed by Redis lists:

```ts
// pseudocode for redisSpillStorage
{
  enqueue(record) { rpush("ibx:audit:spill:queue", JSON.stringify(record)); },
  drain(count) { lrange + ltrim atomically via Lua; },
  size() { llen("ibx:audit:spill:queue"); },
}
```

Capacity 10K records before lossy overflow (per `PersistentBufferedSinkOptions` per investigation 05). Onoverflow handler emits Sentry alert + `recordSinkFailure({sink: "buffered", reason: "capacity"})` per investigation 05 §"MetricsSink".

### Fail-open / fail-closed per sink (per investigation 06 §"Audit sink wiring" + master plan §"Risk register R2")

| Sink | Failure mode | Decision impact |
|---|---|---|
| Console | Failure swallowed; never blocks | none |
| NATS | Circuit-breaker per `createNatsSink({failureThreshold, onFailure})` per investigation 05 — opens after threshold; subsequent emits fail-soft until half-open probe | none (fail-open at NATS layer) |
| Postgres | Connection retried up to 3× via `multiSink` strict semantics per investigation 05 §"multiSink" — throws after retries exhausted | **Buffered**; persistent spill catches it. Decision **never** blocks per master plan §"R2 mitigation" |
| persistentBufferedSink | Capacity overflow → lossy with Sentry alert | recordSinkFailure called; decision proceeds |

**Per master plan §"Risk register R2"**: sink failure must not block decisions. The kernel's `adjudicateAndAudit` returns the Decision before the sink's emit promise settles — buffer absorbs latency. This is achieved by `persistentBufferedSink`'s in-memory queue per investigation 05.

## Replay schedule

Nightly job `audit-replay-nightly` (new BullMQ worker per investigation 07 P1 #10):

1. Read records from `intent_audit` for the last 24h via `readAuditWindow`.
2. For each record, re-run `adjudicate(record.envelope, record.state, currentPolicyBundle)`.
3. Aggregate into a `ReplayReport` via `replay(records, adjudicator)` from `@adjudicate/audit` (per investigation 05 §"Replay & integrity").
4. Hash-verify via `replayWithIntegrity` per investigation 05 — checks `auditHash` + `intentHash` for tamper detection.
5. Classify drift over time via `classifyReplayDrift(samples, thresholds)` per investigation 05.
6. Emit a `ReplayDriftReport` to Postgres `replay_drift_report` (new table) and `ibatexas.audit.replay.v1` NATS subject.

The CLI per investigation 07 P1 #10:
```
ibx kernel replay --since=24h [--intent-kind=<kind>] [--format=ci-line|operator|summary]
ibx kernel divergence --pack=@ibatexas/pack-orders --since=7d
ibx kernel status
```

`--format=ci-line` emits a single-line summary suitable for CI gate; `operator` is multi-line for human review; `summary` is for Sentry/Slack daily report.

### Drift classes (per investigation 05 — `ReplayDriftClass`)

| Class | Meaning | Action |
|---|---|---|
| `stable` | Replay decisions match recorded decisions for ≥99.9% of records | proceed with planned enforce flips |
| `improving` | Recent decisions tighter than older (more REFUSEs that match policy changes) | proceed; flag for review |
| `regressing` | Recent decisions looser than older (more EXECUTEs where policy now says REFUSE) | **block enforce flips for the affected kind**; investigate code change |
| `flapping` | Drift class oscillates day-over-day | block; unstable policy |
| `insufficient_data` | Window too small for confidence | rerun with larger window |

## Tamper detection

Per investigation 05 §"core top-level" + `assertPackConformance`:

- **Decision hashing**: every `Decision` produces a stable hash via the kernel's deterministic evaluation. Two `(envelope, state, bundle)` triples produce the same `Decision` iff the bundle is conformant. Verified by `runConformance(pack)` from `@adjudicate/conformance` (per investigation 05 Tier 3 #17).
- **`auditHash`** on every AuditRecord: canonical-JSON SHA-256 over the entire record (per `sha256Canonical` and `canonicalJson` from `@adjudicate/core`).
- **`assertPackConformance(pack)`** at boot (per investigation 06 §"Recommendations" + master plan §"Risk register R5"): throws on malformed pack, basis-vocabulary drift, default-polarity regression. Pack failure crashes startup before serving traffic (per investigation 06 §"P0-2").
- **`verifyAuditRecord(record)`** in the nightly replay path (per investigation 05): re-computes `auditHash` and compares; mismatch logged as `IntegrityFailure` per investigation 05 §"ReplayIntegrityReport".

## Retention policy

Per intent kind, driven by a `retentionTag` field stored alongside the record:

| Tag | Hot (Postgres) | Warm (S3 JSONL) | Cold (S3 Glacier) | Reason |
|---|---|---|---|---|
| `payment` | 90 days | 7 years | indefinite | Brazilian SPB regulation requires 7-year transaction logs |
| `customer-pii` | 90 days | 5 years (anonymized) | indefinite (anonymized) | LGPD Art. 16; raw PII never archived |
| `auth` | 90 days | 1 year | n/a | Audit needs only short-term |
| `order` | 90 days | 2 years | indefinite (per legal hold) | CDC + tax reconciliation |
| `reservation` | 90 days | 1 year | n/a | Operational only |
| `whatsapp` | 30 days | 6 months | n/a | High-volume; transient |
| `system` | 365 days | indefinite | indefinite | Kernel decisions kept forever for forensics |

Lifecycle policy: BullMQ job `audit-retention-rotator` runs daily; reads `intent_audit` records past hot window, exports anonymized JSONL to S3 (`s3://ibatexas-audit-warm/{retentionTag}/{date}/`), deletes from Postgres. Glacier transition handled by S3 lifecycle config.

## Supersession chains

Per investigation 05 §"Supersession" — `Supersession` record links predecessor → successor via `AuditRecord.supersedes`. Reasons:

| Reason | When set | Predecessor intentHash points to |
|---|---|---|
| `confirmation_resolved` | Receipt envelope consumes a REQUEST_CONFIRMATION | the original REQUEST_CONFIRMATION envelope |
| `defer_resumed` | DEFER signal arrives; resumed envelope produces a new decision | the original DEFER envelope |
| `rewrite_executed` | REWRITE substituted envelope executes | the original (rewritten) envelope |
| `replay` | A new decision supersedes a stored one with the same intentHash (rare; only via `ibx kernel replay --apply`) | the previous AuditRecord intentHash |

`buildSupersessionChains(records)` from `@adjudicate/audit` (per investigation 05) reconstructs full chains. The operator console exposes them via `apps/console`'s `SupersessionChain` component (per investigation 05 §"apps/console").

## Audit emit invariants

Verified by contract test per investigation 07 P0 #4:

1. **One emit per envelope.** Every `adjudicateAndAudit` call produces exactly one `AuditRecord`. No double-emit on retry. Verified by the kernel's internal once-semaphore (per investigation 05 §"adjudicateAndAudit deps").
2. **No emit on cache hit (legacy EXECUTE branch).** Investigation 01 §"P2 #7" identified that today even the legacy-EXECUTE branch fires an audit — this pollutes the stream. Migration changes `llm-responder.ts:335-354` to emit only when `result.kind === "intent"` AND `decision !== legacy-EXECUTE-passthrough`.
3. **PII never reaches a sink.** Verified by the contract test above + a daily NATS subject sampling job that runs a CPF/email/phone regex against 1% of records.
4. **`auditHash` is stable** for the same `(envelope, decision, plan, supersedes)` tuple. Verified by `runConformance(pack)` per investigation 05 §"conformance".
5. **`planFingerprint` is stable** for the same `(visibleReadTools, allowedIntents)`. Verified by `assertPlanReadOnly` per investigation 05 §"llm".

## Metrics emitted alongside audit

Per investigation 05 §"MetricsSink" + investigation 06 §"P0-4" + investigation 07 §"Metrics":

| Event | Source | Maps to ibatexas analytics |
|---|---|---|
| `recordDecision({intentKind, decisionKind, durationMs})` | inside `adjudicateAndAudit` after kernel | PostHog: `audit_decision_executed` / `audit_decision_refused` (already declared per investigation 06) |
| `recordRefusal({intentKind, basisCategory, basisCode})` | when decision is REFUSE | PostHog: `audit_decision_refused`; Sentry breadcrumb per investigation 06 §"Recommendations" |
| `recordShadowDivergence({intentKind, class: "BASIS_ONLY"|"DECISION_KIND"|"PAYLOAD_REWRITE"})` | from shadow telemetry sink | PostHog: `audit_kernel_shadow_diverged_basis` / `_kind` / `_rewrite` (already declared) |
| `recordLedgerOp({op, outcome, durationMs})` | from intent-ledger per investigation 06 §"Intent ledger wiring" | PostHog: `audit_ledger_hit` (already declared) |
| `recordSinkFailure({sink, reason})` | from `multiSink` per investigation 05 | PostHog: `audit_nats_sink_failed` (already declared); Sentry alert |
| `recordResourceLimit({resource: "defer_quota"})` | from `parkDeferredIntent` per investigation 05 §"runtime" | PostHog: new event `audit_defer_quota_exceeded` |

A real `MetricsSink` implementation (per investigation 06 §"Recommendations" step 3) lands in `apps/api/src/plugins/kernel-bootstrap.ts` and dispatches to PostHog (via existing `track()`) + Sentry (breadcrumb) + Prometheus (future `/metrics` endpoint per investigation 07 P0 #1).

## CI gates on audit/replay

Required before any enforce flip per investigation 07 §"P0 — must land before Stage 1 ENFORCE":

1. **AuditRedactor contract test** (CPF/email/phone regex against synthesized records) — gates Stage 1 shadow.
2. **`runConformance(pack)` matrix** (per investigation 05 Tier 3 #17) — gates any Pack version bump.
3. **`analyze --pack --format=sarif`** in CI (per investigation 05 Tier 3 #16) — gates any policy bundle change.
4. **Replay drift nightly** with threshold gate: drift class must be `stable` or `improving` for the affected kind before enforce flip per [`07-rollback-recovery.md`](./07-rollback-recovery.md).

## Cross-references

- PII level per intent kind: [`01-intent-taxonomy.md`](./01-intent-taxonomy.md) §"PII categorization".
- Decision shape and per-kind possible outcomes: [`04-decision-policy.md`](./04-decision-policy.md).
- DEFER park record fields (`audit.intent.defer.v1`): [`06-deferred-execution-policy.md`](./06-deferred-execution-policy.md) §"Park mechanism".
- Kill switch audit emission: [`07-rollback-recovery.md`](./07-rollback-recovery.md) §"Global kill switch".
- Framework AuditRecord schema: `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/audit.ts`.
- Replay APIs: `/Users/thaisrodolpho/projects/adjudicate/packages/audit/src/replay.ts`, `replay-integrity.ts`, `drift.ts`.
- Postgres sink: `/Users/thaisrodolpho/projects/adjudicate/packages/audit-postgres/src/index.ts`.
