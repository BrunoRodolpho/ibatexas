> ⚠️ **SUPERSEDED on 2026-05-24.** Pre-cutover 10x-load audit (2026-05-23). Identifies failure modes at 2x-5x baseline; performance/scalability work remains open (per the civilization-health report's "What this report does NOT cover" — scalability under load is still open since audit-2026-05-23). For current outstanding items, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md). Content preserved unchanged below as historical record.

---

# Scalability / 10x Load Audit

**Date:** 2026-05-23
**Auditor:** SRE/Performance-engineer
**Scope:** ibatexas + adjudicate integration, baseline → 10x churrascaria-lunch-peak
**Posture statement under audit:** "ready for shadow rollout, not load-tested"

---

## Executive summary

The system, in its current shape, **will degrade at 2x baseline and fail in
multiple subsystems at 5x**, well before 10x. Five distinct failure modes
manifest before the kernel itself becomes the bottleneck:

1. **Defer-resolver SCAN amplification on every PIX webhook** — each settled
   wire event re-scans the entire `defer:pending:*` namespace and then issues
   O(N) Redis round-trips per parked envelope. At 2,000+ parked envelopes
   (achievable at 2x with normal PIX latency), one webhook = ~6,000 Redis
   operations. With Stripe webhook bursts (100/min @ 10x), this is a Redis
   denial-of-service against itself.

2. **Single Prisma connection pool, capped at 10, behind PgBouncer** — under
   sustained 10x load with mixed read+write traffic (kernel snapshots, audit
   inserts, projection updates, payment locks), the pool will be saturated
   in seconds. `$transaction` blocks in `OrderCommandService.transitionStatusFromEnvelope`
   hold connections across read+write, multiplying contention.

3. **NATS Core (no JetStream) with synchronous fan-out subscribers** — every
   `order.placed` event triggers 11 distinct downstream operations (DB
   inserts, Redis writes, multiple `publishNatsEvent` re-publishes, WhatsApp
   sends) on a SINGLE per-process subscriber callback. With no JetStream,
   any subscriber backpressure silently drops messages.

The system is **not load-tested**. Numbers below are derived from code
analysis of constants, fixed concurrency limits, fan-out factors, and
known external latencies (Postgres/Supabase pooler, NATS Core).

---

## Baseline → 10x projection table

| Subsystem | Baseline (per min) | 10x (per min) | 10x sustained (per sec) | Bottleneck before 10x? |
|---|---|---|---|---|
| LLM tool calls (→ kernel adjudicate()) | 100 | 1,000 | 16.7 | No (kernel is fast) |
| Checkout intents (→ order.placed) | 50 | 500 | 8.3 | **Yes — at fan-out** |
| Audit records (→ persistentBufferedSink) | 200 | 2,000 | 33 | **Yes — Redis spill + Postgres lag** |
| PIX charges (→ defer:pending writes) | 20 | 200 | 3.3 | **Yes — SCAN amplification** |
| Reservations | 5 | 50 | 0.83 | No |
| Stripe webhooks (burst) | 10 | 100 | 100/burst | **Yes — per-payment lock + defer SCAN** |
| NATS publishes from order.placed fan-out | 50 × 4 = 200 | 500 × 4 = 2,000 | 33 | **Yes — backpressure-prone** |
| Total inflight Redis ops (estimate) | ~3,000 | ~30,000+ | ~500+ | **Yes — SCAN dominates** |

The "10x sustained per sec" column assumes uniform load; the real workload
has lunch peaks 3-5x the average, so peak RPS is closer to 50-150 across
subsystems.

---

## Bottleneck inventory (per subsystem)

### A. Audit pipeline (with numerical projection)

**Pipeline shape** (from `packages/llm-provider/src/intent-audit-wiring.ts:30-43`):

```
emit(record)
  → redactor.redact(record)              [audit-redactor.ts — regex + walk]
  → persistentBufferedSink.emit()        [@adjudicate/audit — bounded buffer]
      → multiSink(console, nats, postgres)  [Promise.allSettled]
```

**Per-record cost breakdown** (approximate, at 10x):
- `redactor.redact()`: full deep-walk of `envelope.payload` + regex scrub of
  every string leaf + per-leaf `sha256` for HASH fields + `sha256Canonical`
  of redacted record to recompute `auditHash`. For a typical
  `set_pix_details` payload (~12 fields), that is ~12 walk steps + 4
  sha256 ops + 1 canonical hash. Estimate **0.5 ms/record** at the 95th
  percentile in Node, **3-5 ms** for payloads with large free-form text
  (handoff reasons, lastMessage). At 2,000 records/min = 33/sec, the
  redactor consumes **~17-165 ms/sec of CPU** on a single event loop —
  not yet saturating, but eating headroom.
- `persistentBufferedSink.emit()`: awaits `drainStorage()` then `drainMemory()`
  then `inner.emit(record)` (see `persistent-buffered-sink.ts:108-122`).
  When the inner sink is healthy, drains are no-ops. When the inner sink
  fails, **drainStorage() is called on every subsequent emit until the
  spill is empty** — and `drainStorage` does sequential `await
  inner.emit(head)` per item with **no batching, no parallelism**. Spill
  drain at 33 records/sec with 50 ms inner-sink latency = **1,650 ms/sec
  of emit time** — the buffered sink **cannot keep up with sustained
  10x load if the inner sink ever has a 100ms+ blip**.
- `multiSink`: `Promise.allSettled` over 2-3 sinks. With NATS at ~5ms and
  Postgres at ~10-50ms (Supabase pooler, varies under load), the slowest
  sink dominates. Postgres is the bottleneck once `IBX_AUDIT_POSTGRES_ENABLED=true`.

**Buffer capacity arithmetic** (`intent-audit-wiring.ts:93-104` default = 1000):
- Normal: 33 rec/sec × 50 ms Postgres latency = 1.65 records in flight. Buffer
  empty.
- Postgres 60-second stall: 33 × 60 = **1,980 records** — exceeds 1,000
  capacity in 30s → 980 records spill to Redis. With 30s+ stalls during
  typical Supabase auto-vacuum / pgbouncer reload, **spill is the normal
  steady-state mode at 10x**.
- Redis spill TTL: 7 days. 2,000/min × 60 × 24 × 7 = **20.16 million records
  max** if the inner sink stays down for a week. Each AuditRecord serialized
  is ~1-3 KB (envelope payload + decision_basis array). Worst case **~60 GB**
  of Redis memory. Realistic case: a 5-min Postgres outage = 10,000 × 2 KB
  = **20 MB** of spill — fine — but the **upper bound is dangerous**.

**Critical bug in persistent-buffered-sink at 10x:** the drain loop is
single-flight (`async function drainStorage`). The next `emit()` call from
the hot path **awaits the drain to complete before its own emit even
starts**. At 33 rec/sec × an 800-record backlog × 50 ms each =
**40-second emit latency** during catch-up. The hot path stays
fail-open (`intent-audit-wiring.ts:296-306` swallows the error) but the
hot-path's `await buffered.emit(redacted)` is a **30-second-plus block on
every subsequent kernel decision until the backlog clears**. This is the
single worst latency bomb in the audit pipeline.

**Postgres write rate at 10x:**
- 2,000 records/min = 33/sec sustained, peaks of 100+/sec during lunch.
- Single-row INSERTs via `$executeRawUnsafe` (no batching — see
  `postgres-audit-writer.ts`). Each INSERT is a connection-round-trip.
- At ~10-30ms per INSERT through Supabase pooler, the **per-process audit
  write throughput is bounded at ~30-100 inserts/sec/connection**. With
  one shared Prisma pool of 10 connections, theoretical ceiling is
  ~300-1,000/sec — but only if the entire pool is dedicated to audit,
  which it isn't.

**`audit-consumer` is a SECOND writer (redundant insert path)** —
`apps/api/src/subscribers/audit-consumer.ts` subscribes to
`audit.intent.decision.v1` and INSERTs again. At 10x, that doubles the
Postgres write load to 4,000/min. Dedup is via Redis SETNX + ON CONFLICT
DO NOTHING — but **`ON CONFLICT DO NOTHING` has no unique constraint to
match** (per the P0-14 note in `postgres-audit-writer.ts:21-58`). The
second write **always runs to completion** before failing the conflict
check, so the dedup is by Redis SETNX only.

**NATS publishes from audit**: 2,000/min on
`ibatexas.audit.intent.decision.v1`. NATS Core has **no backpressure
signal to the publisher** — `publishNatsEvent` is fire-and-forget at line
245 of `nats-client/src/index.ts`. The Core NATS server will drop messages
when the subscriber falls behind (slow_consumer policy). The `audit-consumer`
subscriber processes synchronously inside a `for await (msg of sub)` loop,
so **one slow Postgres write blocks the next message** — at 10x, dropped
audit messages become inevitable.

---

### B. NATS

**Connection model** (`packages/nats-client/src/index.ts`):
- **Single connection per process**, singleton (`natsConn` at line 41-42).
- All publishes share one connection — line 245 `nats.publish(subject, ...)`.
- All subscribes share one connection.
- This is fine for Core NATS in normal load but creates **head-of-line
  blocking** when the subscriber is slow.

**Critical: no JetStream.** The file's own header (line 3-4) flags this:
> NOTE: Uses Core NATS (fire-and-forget), not JetStream.
> JetStream (with persistence/durability) is deferred to Step 14.

Implications at 10x:
- Subscriber overload → server-side slow_consumer → silent message drops.
- Publisher has no flow-control signal.
- No durable replay; if a subscriber crashes mid-batch, messages between
  the last ack and crash are lost.
- **The `audit.intent.decision.v1` subject is published at 2,000/min at 10x.
  Any subscriber stutter drops audit messages — the exact failure mode the
  Redis spill was supposed to mitigate, but the spill only triggers on
  `multiSink` failures, NOT on NATS subscriber-side drops.**

**Defer-resolver fan-in (the worst NATS pattern in this system)**
(`apps/api/src/subscribers/defer-resolver.ts:650-757`):
- Subscribes to `payment.status_changed`.
- On EVERY settled status (`paid|captured|confirmed`):
  1. `scanIterator` over `rk("defer:pending:*")` with `COUNT: 100`.
  2. For each key found, `resolveDeferredSession` → `robustRedisGet`
     (up to 3 retries with backoff), `JSON.parse`, `verifyParkedEnvelopeHash`,
     `redis.get(resumedKey)`, `redis.set(resumingKey, NX)`, `redis.incr(cycleKey)`,
     `redis.expire(cycleKey)`, `adjudicate()`, `auditSink.emit()`, optional
     dispatcher, `redis.set(resumedKey, NX)`, `redis.del(rawKey)`,
     `redis.decr(defer:count:*)`, `redis.del(resumingKey)`.
  3. **9-12 Redis ops per parked envelope** plus an adjudicate() call.

Numbers:
- At 10x: 200 PIX charges/min = 200 defer-pending creates/min.
- Average TTL: O(minutes) at typical PIX confirmation latency.
- Steady-state parked count: ~200-1,000 envelopes.
- Stripe webhook burst: 100/min = ~1-2/sec sustained; bursts 10-20 in 1 sec.
- Each webhook = SCAN + 9-12 ops × parked count.
- At 500 parked, 1 webhook ≈ **5,000-6,000 Redis ops in one subscriber
  callback**, all sequential.
- At 100 webhooks/min × 500 parked ≈ **300,000+ Redis ops/min just from
  defer-resolver**.

The subscriber's own header (line 30-35) acknowledges the issue:
> A real production deployment may swap this to a session-by-orderId index
> when parked-session count grows.

That refactor has not happened. **This is the single hardest scaling
bottleneck in the system.**

**Subscriber concurrency** (`subscribeNatsEvent` at `nats-client:268-295`):
- `for await (const msg of sub)` is **strictly sequential** per subscription.
- A slow message handler holds up every following message for that subject.
- No worker pool, no per-message concurrency limit, no backpressure to the
  publisher.

**NATS subscriber inventory** (27 active subscriptions identified):
- Two distinct subscribers on `payment.status_changed`: `defer-resolver` AND
  `payment-lifecycle`. Each receives every message independently — fine for
  Core NATS, but **doubles the work per webhook**.
- One subscriber on `order.placed` does **all the heavy lifting** (11
  numbered operations in `cart-intelligence.ts:256-562`).

---

### C. Redis

**KEY count growth at 10x** (rough order of magnitude):

| Key pattern | Per day @ 10x | TTL | Steady-state count |
|---|---|---|---|
| `defer:pending:{sessionId}` | ~288,000 creates | ceil(timeout/1000)+60s, ~5-10 min typical | ~5,000-20,000 active |
| `defer:resuming:{hash}` | follows resumes | 60s | low |
| `defer:resumed:{hash}` | ~288,000/day | 7d grace | ~2,016,000 |
| `defer:cycle:{intentHash}` | ~288,000/day | 7d | ~2,016,000 |
| `defer:count:{sessionId}` | per session | unset (DECR) | unbounded |
| `recovery:fired:{...}` | per resume | 14 days | up to 4M |
| `audit:spill:queue` | one list | 7d | depends on outage |
| `lock:payment:{id}` | per payment write | 30s typical | ~hundreds |
| `wa:phone:{hash}` | per session | session TTL | ~unbounded growth in customers |
| `metrics:wa_orders:daily:{date}` | 1/day | 48h | 2 keys |
| `metrics:messages:{sessionId}` | per session | unknown | grows |
| `recoveryFiredCount` etc | various | various | various |

The **`defer:resumed:*` and `defer:cycle:*` keys grow ~4M each over a
typical 7-day window at 10x**. With 2 KB serialized cycle counter + key
metadata overhead (~100 bytes), that is ~400 MB Redis for those alone.

**SCAN performance**:
- `defer-timeout-sweeper` (`apps/api/src/jobs/defer-timeout-sweeper.ts:80,150-162`)
  SCANs `defer:pending:*` every 60s with COUNT=100 and MAX_KEYS_PER_SWEEP=1000.
- At steady state with 5,000-20,000 active parks at 10x, a single sweep
  caps at 1,000. **The remaining 4,000-19,000 keys are not swept until
  the next minute** — but `MAX_KEYS_PER_SWEEP` is also the SCAN cap, so
  some parked keys may never be visited because each minute we restart
  the cursor at the beginning. Practical effect: timeouts beyond the
  first 1,000 keys are not fired until population shrinks.
- Coupled with the defer-resolver's full-namespace SCAN per webhook
  (no MAX cap on that one), at 100 webhooks/min × 20,000 keys = **2M
  keys scanned per minute**. Redis SCAN is O(N) in total work across
  iterations; this consumes substantial Redis CPU and head-of-line-blocks
  any other Redis command that runs against the same shard.

**Lock contention**:
- `lock:payment:{paymentId}` — held during `paymentCmdSvc.transitionStatusFromEnvelope`.
  Critical section involves at least one `prisma.$transaction` (read +
  write + history insert), so ~20-100ms held duration.
- Same-customer rapid checkout retries → contention on `lock:payment:{id}`.
  At 10x with Stripe webhook bursts, multiple webhooks for the same
  payment within 50ms (Stripe retries on flaky network) hit the lock.
  `acquireLock` returns null after one attempt — no retry, no queue.
  **Stripe webhook returns 200 even when lock contention dropped the
  reconcile** (`stripe-webhook.ts:158-167`). Stripe sees success; the
  database state did not change. **This is a correctness risk, not just
  latency.**

**INCR/DECR hot keys**:
- `defer:cycle:{intentHash}` — per-intent. Not hot.
- `refund:daily-total:{staffId}:{date}` — **ONE KEY per (staff, day)**. If
  one staff member processes a refund burst, this is a single-key hot
  spot. With ~5 staff at 10x and ~100 refunds/staff/day, that is 500
  INCRs/day per key spread over hours — no contention even at 10x.
- `metrics:wa_orders:daily:{date}` — **ONE KEY per day, written from EVERY
  order.placed handler**. At 500 orders/min, that is 500 INCRs/min on
  ONE Redis key, spread across however many api processes. Redis handles
  single-key INCR at >100k/sec — fine.
- `metrics:avg_messages_to_checkout` — **single key**, `redis.set(avgKey,
  String(newAvg))` after a GET. **Read-modify-write race**: at 10x with
  500 orders/min, the read+compute+set sequence is not atomic. Final
  value loses concurrent updates. Functional but inaccurate.

**Eviction policy**: not specified in code. The Redis config
(infra dir not inspected here) determines what happens at memory pressure.
Without an explicit `maxmemory-policy` of `noeviction` AND careful
key tagging, **the audit spill queue, parked envelopes, and dedup keys
share the same eviction class as non-critical cache keys** (query cache,
embeddings cache). At memory pressure, governance-critical keys can be
evicted alongside disposable cache. This is a **governance failure mode
not catchable by the current monitoring**.

---

### D. Prisma

**Connection pool** (`.env.example:84`):
```
?connection_limit=10&pool_timeout=30&pgbouncer=true
```

- 10 connections total per process. PgBouncer transaction-mode in front.
- Per-process — multiple api processes multiply this, but the upstream
  PgBouncer is the ultimate cap (Supabase pooler typically 200 client
  connections at the standard tier).
- `pool_timeout=30` means a query waits up to 30s for a connection. **Under
  10x sustained load with bursts, the pool is the wall.**

**At 10x, query mix per minute** (rough order of magnitude):
- 2,000 audit inserts (if Postgres sink enabled, doubled by audit-consumer)
- 500 order.placed → ~5 Prisma writes per event (CustomerOrderItem batch,
  order projection upsert, payment row, status history, etc.) = 2,500
  writes/min
- 500 order projection reads + writes for status transitions (via webhook)
- LLM hot path reads (cart load, customer lookup, etc.) for each of 1,000
  tool calls/min — ~3,000-5,000 reads/min
- Per-process job traffic (defer-timeout-sweeper, abandoned-cart-checker,
  pix-expiry-checker) — ~200/min

**Total ~10,000-15,000 Prisma operations/min at 10x = 167-250/sec.** With
10 connections @ ~10ms avg query, theoretical capacity is ~1,000/sec —
plenty of headroom in steady state. **The risk is bursts and held
connections.**

**`$transaction` connection-holding**:
- `OrderCommandService.transitionStatusFromEnvelope` (line 484-502) does:
  - `snapshotProjection(orderId)` → `findUnique` (outside the transaction).
  - Then `withAdjudicate` → callback runs adjudicate() → calls executor.
  - Executor is `executeTransition` (line 319-366): full `prisma.$transaction`
    holding a connection through: `findUnique` + version check + status
    machine check + `update` + `orderStatusHistory.create`.
- Each `$transaction` holds a connection for the entire critical section.
  At ~30-80ms per transaction including network, **10 concurrent connections
  → ~125-330 transactions/sec max**.
- At 10x with bursts of 50 webhooks in 1 second (Stripe retry storm) ×
  4 reconciles needing transitions, the pool saturates in <2 seconds.
  Subsequent queries wait up to 30 seconds (`pool_timeout`); requests
  start failing with `P2024` (timed out waiting).

**Concurrent refunds for same payment**:
- `prisma.payment.update({where: {id}})` — single-row update. Postgres
  acquires a row-level lock. Concurrent updates serialize at the DB. Fine
  for correctness; bad for latency. With the `lock:payment:{id}` Redis
  lock in front, contending requests **don't even get a DB connection** —
  they return early with "skipped (lock contention)".

**Index coverage on `intent_audit`**:
- Per `migrations/001-create-intent-audit.sql`:
  - PRIMARY KEY (id, recorded_at)
  - INDEX (intent_hash, recorded_at DESC)
  - INDEX (session_id, recorded_at DESC)
  - INDEX (kind, decision_kind, recorded_at DESC)
- Per `migrations/008-add-v4-fields.sql`:
  - INDEX (policy_version, recorded_at DESC) WHERE policy_version IS NOT NULL
  - INDEX (audit_hash) WHERE audit_hash IS NOT NULL
- **`ibx kernel divergence` CLI** (`packages/cli/src/commands/kernel.ts:328-440`)
  queries with `WHERE recorded_at >= $1 AND recorded_at < $2 [AND intent_kind = $3]`.
  - `intent_kind` is NOT an indexed column. **`kind` is** (the column name
    in the schema). The CLI's `intentKind` parameter mismatches the column
    name — at minimum a code bug, at worst a full-table scan if the column
    was somehow added.
  - The window query without `intent_kind` filter falls back to scanning
    by `recorded_at`. With monthly partitions this is bounded to one
    partition. At 10x = ~60M rows/month. **Scanning 60M rows on each
    divergence-CLI run is expensive but not query-pathological** (the
    partition pruning helps).
- **No index on `decision_basis` (TEXT[])** — if any operator query filters
  by basis category at scale, GIN index is needed.

**Partitioning**: created monthly via cron / pg_partman. **No automated
partition creation in the IbateXas repo** — the migrations file is just
the schema. If the operator forgets to create the next month's partition,
**every audit insert fails with "no partition of relation found" on the
first of the next month**. This is operational debt, not a code bug, but
at 10x the impact is amplified.

---

### E. LLM hot path

**Wall-clock budget per turn** (`packages/llm-provider/src/orchestrator.ts:33-58`):
- `ttfbDeadlineMs: 800` — TTFB SLA.
- `softDeadlineMs: 2500` — start wrap-up.
- `hardDeadlineMs: 4000` — abort.

This is a TIGHT budget. The kernel adjudicate() call itself is fast
(~1-5 ms typical based on the code reading: maybe O(20) guards × <0.5 ms).
But the kernel is NOT the slow part. The slow parts:
1. LLM API call (Anthropic) — typically 800-3000 ms.
2. Cart + delivery + loyalty operations gated by 5-10 second timeouts.
3. Postgres-backed projection reads.

**`safePlan` cost per turn**: every `runOrchestrator` invocation re-runs the
planner. `safePlan` wraps the planner with `assertPlanReadOnly` and
`assertPlanSubsetOfPack` checks (per `planner-conformance.ts:115-122`).
These are O(visible-tools) per planner.plan() call. With ~25 visible tools,
the assertions are ~50-100 µs. **Not a bottleneck.**

**`AuditRedactor` cost per turn**: runs on **every adjudication** — 1+ per
turn. ~0.5-5 ms per call (see Section A). At 1,000 turns/min × ~3
adjudications/turn = 3,000 redactions/min. ~25-250 ms/sec of CPU at 10x —
**occupies 2.5-25% of one event loop**.

**Metrics sink async fan-out at 10x**:
- 2,000 records/min × 4 destinations:
  - Prometheus counter increment (in-process — fast, ~1 µs)
  - PostHog event via NATS publish (~200 µs to enqueue, fire-and-forget)
  - Sentry breadcrumb (in-process — ~10 µs)
  - Postgres insert (~10-50 ms — see A)
- Aggregate: **~6,000-8,000 fan-out ops/min**. The Postgres write dominates.
  PostHog through NATS adds another **2,000 NATS publishes/min on
  analytics.event** subject — same fire-and-forget concern as audit.

**`validateEnforceConfig` cost**: boot-only, cached. Confirmed fine (per
brief).

---

### F. Memory growth

**`kernel_intent_kind_coverage` 24h rolling window**
(`apps/api/src/plugins/kernel-metrics-sink.ts:273-298`):
- `observedIntentKinds = new Map<string, number>()`.
- Eviction: only on `publishCoverageGauges()` call (which fires inside
  `recordDecision`). If no `recordDecision` calls happen for 24h+, the
  Map keeps stale entries.
- Per-key: `string` (intent kind ~30 chars) + `number` (timestamp, 8 bytes).
  ~80-150 bytes total Map entry overhead.
- Bound: limited by `KNOWN_INTENT_KINDS.size`. The brief estimates ~64.
  Even with unknown kinds slipping in, the practical bound is hundreds.
  **Total memory: < 30 KB. Not a leak risk.**
- But: **if `event.intentKind` is ever populated from free-form payload
  data (a bug), the Map grows unbounded.** Grep confirms `event.intentKind`
  flows from the envelope kind which is checked against `KNOWN_INTENT_KINDS`.
  Safe in current code, brittle invariant.

**AuditRecord object size**:
- `envelope.payload` carries the LLM's full tool input. For `set_pix_details`,
  ~200 bytes. For `whatsapp.message.send`, could be ~2-5 KB if the body
  is long.
- `decision_basis: BasisEntry[]` — typically 1-3 entries × ~200 bytes each.
- `auditHash` — 64 bytes.
- Total per AuditRecord JSON-serialized: **~1-3 KB typical**, up to 10 KB
  in worst case.

**In-memory buffer at 10x worst case**: 1,000 records × 3 KB = 3 MB.
Bounded. Fine.

**Redis spill at 10x worst case**: see Section A — bounded by 7-day TTL,
worst case ~60 GB but only with sustained week-long outage.

**Unbounded maps anywhere else**:
- `_outboxWriter` is a single function ref. Safe.
- `_dispatcher`, `_writerOverride`, `_depsOverride` — singletons. Safe.
- `kernel_metrics-sink.ts:273` is the only map I identified that grows
  on hot path. Safe within KNOWN_INTENT_KINDS bound.
- `_outbox` events list in NATS code — `OUTBOX_EVENTS` is a `Set` of fixed
  strings. Safe.
- I did NOT identify any obvious leak in the hot path. Memory growth is
  most likely from Prisma's internal connection pool buffering under
  load, not from app code.

---

### G. Observability cardinality

**Prometheus metric cardinality** (`kernel-metrics-sink.ts:155-241`):

| Metric | Labels | Cardinality |
|---|---|---|
| `kernel_decision_total` | kind (6) × intent_kind (~64) | ~384 |
| `kernel_refusal_total` | kind (6) × intent_kind (~64) × basis_category (~10) × basis_code (~80) | ~307,200 |
| `kernel_decision_duration_seconds` | intent_kind (64) | 64 |
| `kernel_shadow_divergence_total` | class (3) × intent_kind (64) | 192 |
| `kernel_ledger_op_total` | outcome × op | small |
| `kernel_audit_sink_failure_total` | sink × reason | small |
| `kernel_defer_resume_duration_seconds` | kind | 64 |
| `kernel_intent_kind_coverage` | — | 1 |
| `kernel_distinct_intent_kinds_observed` | — | 1 |

**`kernel_refusal_total` is the cardinality risk**:
- `basis_code` is set from `event.refusal.code` (line 415). The refusal
  codes are bounded by the BASIS_CODES enum from `@adjudicate/core` — but
  Pack-specific refusal codes can extend this. If any code path constructs
  a refusal code from user input or formatted string interpolation, the
  cardinality explodes.
- Looking at the IbateXas code: refusal codes come from constants files
  (`refusal-taxonomy.ts`, Pack policy files). These are bounded.
- **Practical estimate: 6 × 64 × 10 × 80 = 307,200 distinct series in worst
  case.** That is heavy but tolerable for Prometheus if scrape interval is
  generous. **Each Prom scrape pulls all of them — at 10x with active
  REFUSE flows, this becomes a >100 KB scrape payload per scrape.**

**PostHog event properties** (`kernel-metrics-sink.ts:398-404`):
- `audit_decision_executed` and `audit_decision_refused` events include
  `intent_hash_prefix: event.intentHash.slice(0, 8)` as a property.
- `intent_hash_prefix` has 16^8 = ~4 billion possible values. PostHog
  uses event properties for filtering, not for indexing — but **PostHog
  retains every distinct value, and per-property analytics queries on
  high-cardinality fields are expensive**. If the operator builds a
  dashboard filtered by `intent_hash_prefix`, performance degrades.
- **The same `intent_hash_prefix` is in the Sentry breadcrumb data** —
  same concern.

PostHog does NOT charge per cardinality (per their pricing) but it does
affect query performance. **This is a query-time cost, not a write-time
cost — fine for the steady state, but operators should not build
hash-prefix-keyed dashboards.**

---

### H. Queue amplification

**`order.placed` fan-out** (`apps/api/src/subscribers/cart-intelligence.ts:256-562`):

The single `order.placed` subscriber callback performs:
1. `isNewEvent(...)` — Redis SETNX
2. `eventLog.append(...)` — Postgres write
3. `customerSvc.recordOrderItems(...)` — bulk INSERT to CustomerOrderItem
4. `updateCopurchaseScores(...)` — Redis ZINCRBY × N×(N-1) for N items, with
   ZREMRANGEBYRANK pruning, EXPIRE on each set. For 5 items, **20 ZINCRBY +
   5 ZREMRANGE + 5 EXPIRE = 30 Redis ops**.
5. `updateGlobalScores(...)` — similar Redis ops
6. Redis profile updates — hIncrBy, hSet, hDel ×N, hKeys, hSet, hDel
7. Conditional WhatsApp metrics (more Redis reads/writes)
8. `loyaltySvc.addStamp(...)` — Prisma write + conditional `publishNatsEvent("notification.send", ...)`
9. Conditional staff WhatsApp alert (HTTP to Twilio)
10. Conditional customer notification — `publishNatsEvent("notification.send", ...)`
11. `commandSvc.createFromEnvelope(...)` — full Prisma $transaction with adjudicate()
12. `paymentCmdSvc.createFromEnvelope(...)` — full Prisma $transaction with adjudicate()

**Per single `order.placed` event at 10x**:
- ~5-10 Prisma writes (steps 2, 3, 8, 11, 12 with internal sub-writes).
- ~30-50 Redis ops (steps 1, 4-7).
- 1-2 NATS re-publishes (steps 8, 10) — each of which triggers further
  fan-out at `notification.send` subscribers.
- 1-2 Twilio HTTP calls (steps 8, 9) — external, ~200-500ms each.

**At 500 events/min (10x)**, this subscriber processes ~8.3/sec sequentially.
Each event takes **~1-3 seconds** (Twilio is the long pole). The subscriber
falls behind at >500/min. **NATS Core drops messages when the subscriber
backlog grows beyond the server's slow-consumer threshold (~1 MB default).**

**Other high-fan-out subjects**:
- `payment.status_changed` → 2 subscribers (defer-resolver + payment-lifecycle).
  Defer-resolver's per-message cost dominates (see Section B).
- `intent.defer.timeout` → anonymize-grace-resolver subscriber. Likely a
  single fast Prisma update — low fan-out.
- `analytics.event` → PostHog ingester. The metrics sink publishes 2,000+/min
  of these at 10x. Throughput depends on the external PostHog ingester.

**Total NATS publishes from one order.placed at 10x peak**:
- 1 `order.placed` from checkout
- 1 `notification.send` for staff
- 1 `notification.send` for customer
- 1 `notification.send` for loyalty reward (10% probability)
- + 1 `analytics.event` for adjudicate decision on `order.projection.create`
- + 1 `analytics.event` for adjudicate decision on `payment.create`
- + 1 `audit.intent.decision.v1` × 2 (projection + payment)

**~8 NATS publishes per `order.placed` × 500/min = 4,000 NATS pub/min from
just this one event class**.

---

## Theoretical breaking points (RPS at which each subsystem degrades)

(These are first-pass estimates from code constants; real numbers require
load testing.)

| Subsystem | Degradation onset | Hard failure | Failure mode |
|---|---|---|---|
| Defer-resolver SCAN | ~50 webhooks/min sustained with >2,000 parked | ~200/min with >5,000 parked | Subscriber backlog grows; NATS drops; same-customer resumes lost |
| Postgres connection pool (per process) | ~150-200 ops/sec sustained | 300+ ops/sec or 30s+ burst | P2024 timeout errors; 500s on writes |
| Audit Redis spill | Postgres outage > 60s at 10x = 1,000+ buffer overflow | Postgres outage > 24h = 2-50 GB spill | Memory pressure; degrades all other Redis ops |
| persistent-buffered-sink drain | Postgres slowdown to >50ms latency at sustained 30/sec | Drain falls permanently behind | Hot-path latency spike to seconds; deadline misses |
| Prisma $transaction connection holding | Burst > 50 concurrent webhooks | Sustained 100+ tx/sec | Pool exhaustion; pool_timeout errors |
| NATS Core slow consumer (audit subject) | Sustained 33+ messages/sec with any subscriber stutter | Subscriber > 1s behind | Silent message drops; **PII-redacted audit records lost** |
| order.placed sequential fan-out | ~120 events/min sustained | 500+/min with Twilio at typical latency | Subscriber backlog; messages dropped |
| WhatsApp session lock contention | per-customer burst of 3+ messages in <2s | Sustained per-customer DDoS | Customer messages dropped (acquireAgentLock returns null) |
| Redis SCAN @ defer:pending | 5,000+ pending keys | 50,000+ keys | All SCAN-using jobs slow; same-shard ops queued |

**The headline number**: the defer-resolver pattern means the system
catastrophically degrades around **2-5x baseline** under typical Brazilian
PIX confirmation latency (15-60 seconds), not 10x.

---

## Recommended scaling redesigns (prioritized)

### P0 (must fix before any production rollout above baseline)

1. **Replace defer-resolver SCAN-on-every-webhook with a session-by-payment
   index.** Either:
   - Add `defer:payment:{paymentId} → sessionId` mapping at park time. On
     webhook, single-key GET to find the session. O(1) per webhook.
   - OR move the defer-resolver to JetStream pull-based consumer with
     filter on payment id.
   - This is THE highest-leverage fix. Single change drops Redis load
     by 1-2 orders of magnitude.

2. **Migrate NATS Core to JetStream with explicit ack and durable consumers**
   for `order.placed`, `payment.status_changed`, `audit.intent.decision.v1`.
   The current Core NATS silently drops audit records under any subscriber
   stutter — a governance-fatal failure mode. The code already flags this
   as deferred (line 3-4 of `nats-client/index.ts`).

3. **Batch and parallelize the audit Postgres writer.** Replace
   single-row `$executeRawUnsafe` with a batch INSERT every ~50 ms or
   100 records. Current per-row cost limits throughput to ~30-100/sec
   per connection. Batch of 100 reduces to ~3-10ms/batch. Tenfold
   improvement in audit write throughput.

### P1 (load-blocking for >2x)

4. **Split the `order.placed` fan-out across multiple subscribers /
   workers**. The 11-step monolithic callback in `cart-intelligence.ts:256-562`
   serializes work that has no logical dependency: notification, loyalty,
   intelligence updates, and projection creation can all run in parallel
   subscriber instances. With JetStream this becomes work-queue semantics
   with horizontal scaling.

5. **Increase Prisma `connection_limit` per process and use a separate
   "audit" connection pool** isolated from the request hot path. At 10x,
   audit alone wants 100-200 inserts/sec sustained — cohabiting with
   request-path queries via 10 connections causes contention. A dedicated
   pool of 5 connections for the audit-consumer subscriber + 15 connections
   for the request path gives clearer SLO accounting.

### P2 (operational risk)

6. **Make the `persistent-buffered-sink` drain non-blocking on the hot
   path.** Today an `emit()` call awaits `drainStorage` + `drainMemory`
   in series before its own inner emit. Replace with a background drain
   task so the hot path's `await buffered.emit(record)` returns in O(buffer-push
   time), not O(N-spilled-records × inner-emit-latency).

7. **Pin Redis eviction policy to `noeviction` AND tag governance-critical
   keys** (`defer:*`, `audit:spill:*`, `lock:*`) versus disposable cache
   (`query-cache:*`, `embeddings:*`) so a misconfigured `allkeys-lru` does
   not evict parked envelopes. Best done by running governance keys on a
   separate Redis instance (DB or full cluster) from cache.

8. **Stop double-writing audit records via both the in-process Postgres
   sink AND the audit-consumer NATS subscriber.** Pick one: in-process
   sink for low-latency durability, OR audit-consumer for crash-safe
   eventual durability. Doing both doubles Postgres write load with no
   added durability guarantee (the `ON CONFLICT DO NOTHING` is a no-op
   per the P0-14 note).

---

## What load-test scenarios should run before enforce rollout

### Scenario 1 (P0): "Lunch peak PIX storm"
- Hold ~500 envelopes in `defer:pending` (simulated by parking 500 dummy
  PIX intents).
- Fire 100 `payment.status_changed` events/min for 10 minutes.
- Measure: defer-resolver subscriber callback duration, Redis ops/sec,
  webhook → payment-reconciled latency, dropped resumes.
- **Pass criteria**: p99 webhook handling < 5 seconds; zero dropped
  resumes; Redis CPU utilization < 50%.
- **Expected failure mode without fix #1**: subscriber falls behind by
  minute 3; resume latency p99 > 30 seconds.

### Scenario 2 (P0): "Audit pipeline outage recovery"
- Run normal 10x traffic (~33 audit records/sec) for 5 minutes.
- Disable Postgres (simulate Supabase outage) for 5 minutes.
- Re-enable Postgres.
- Measure: how long until the spill drains; whether hot-path latency
  spikes during drain; whether any audit records are lost.
- **Pass criteria**: spill drains in < 5 minutes; hot-path p99 latency
  during drain < 2 seconds; zero records lost.
- **Expected failure mode**: hot-path latency spikes to 30+ seconds during
  drain (the `await drainStorage` problem in section A).

### Scenario 3 (P1): "Concurrent checkout burst"
- 500 simultaneous checkout requests from different sessions in 10 seconds.
- Measure: Prisma pool wait time, p99 checkout latency, NATS publish backlog
  for `order.placed` and `notification.send`, Twilio API responses.
- **Pass criteria**: p99 checkout < 4 seconds (hits the orchestrator
  deadline); zero P2024 errors; all 500 notification.send messages delivered.
- **Expected failure mode without fix #4 or #5**: ~50 Prisma timeouts in
  first 30 seconds; notification.send subscriber backs up by 10+ seconds.

### Scenario 4 (P1): "Sustained 24h coverage map"
- Run a synthetic mix of intent kinds (KNOWN + 3 fake "unknown" kinds) for
  24 hours at 10x rate.
- Measure: `kernel_intent_kind_coverage` gauge stability, Prom registry
  memory, label cardinality on `kernel_refusal_total`.
- **Pass criteria**: gauge oscillates within expected bound; Prom registry
  RSS stays < 200 MB; `kernel_refusal_total` series count < 10,000.

### Scenario 5 (P2): "Stripe webhook retry storm"
- Stripe retries deliver 5 duplicate webhooks for the same paymentId in
  500 ms (mimics flaky-network Stripe behavior).
- Measure: `lock:payment:{id}` contention, lock-skipped responses, audit
  record correctness, kernel decision count.
- **Pass criteria**: exactly one reconcile succeeds; 4 are lock-skipped
  cleanly; one set of audit records emitted; Stripe sees 200 on all 5.
- **Expected failure mode**: lock-skipped responses confuse downstream
  if Stripe interprets the lack of state change as a failure. Tests
  whether the current `return 200` strategy holds at burst.
