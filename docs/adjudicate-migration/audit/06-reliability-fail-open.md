> ⚠️ **SUPERSEDED on 2026-05-24.** Pre-cutover fail-open inventory (2026-05-23). Drove the fail-closed audit-sink (H2) and ledger work; the audit-sink is now fail-closed via `@ibatexas/audit-sink`. For current outstanding items, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md). Content preserved unchanged below as historical record.

---

# Reliability / Fail-Open Audit

> Auditor 6 of 8 — Reliability / Fail-Open.
>
> Question: every "we proceed when X fails" decision in the governance path — is the failure
> recorded? Recoverable? Should it be fail-closed instead?
>
> All paths are absolute and rooted at `/Users/thaisrodolpho/projects/ibatexas`.

## Executive summary

Total fail-open sites inventoried: **27** across the LLM hot path, the customer-intent gateway,
the system-actor (subscriber/job) envelope path, the audit fan-out, the ledger, the metrics sink,
the DEFER park/resume cycle, and the boot sequence.

**Verdict: REGULAR. Most fail-open decisions are correctly bounded** (metrics sink, audit sink,
ledger when `IBX_LEDGER_FAIL_OPEN=true`, NATS publish). **But there are 5 fail-open paths that are
real safety issues** — three on the hot path silently downgrade the LLM-visible result to
"success" when the underlying mutation never landed, one on the boot path lets the API serve
traffic after critical config validation reports a typo, and the audit redactor's sentinel
(`__redactor_error: true`) is *not* preserved through the persistent spill list (records survive,
but the operator's ability to triage a PII-leak window is invisible to ops dashboards).

The cascade failure surface has two scenarios that result in **silent data loss** (DEFER park +
Redis loss; LLM-DEFER + worker outage > 24h) and one that **breaks LGPD compliance** (anonymize
grace timeout sweeper down → customer waits in deletion limbo).

## Fail-open inventory (table)

`file:line` → `what fails` → `default behavior` → `should it be fail-closed?` → `severity`

### Hot path (LLM responder)

| File:line | What fails | Default behavior | Should it be fail-closed? | Severity |
|---|---|---|---|---|
| `packages/llm-provider/src/llm-responder.ts:336-343` | `ledger.checkLedger()` / `recordExecution()` throws (Redis circuit open). | console.error + continue. Dedup skipped. Intent dispatched. | **No — by design**, governed by `IBX_LEDGER_FAIL_OPEN`. Fail-open is appropriate for the LLM path because the kernel's own deduplication (intentHash + nonce) is a backstop. But the fail-open decision is silent at the responder layer — the env policy only applies inside `intent-ledger.ts`. | P2 |
| `packages/llm-provider/src/llm-responder.ts:397-418` | `buildAuditRecord()` throws OR `getAuditSink().emit()` rejects. | console.error + continue. **The kernel decision still executes** — audit emit is fire-and-forget. | **No (audit emit) / Yes (build).** The `void getAuditSink().emit().catch(...)` is the correct fail-open posture per task 18+19. BUT the surrounding `try` that wraps `buildAuditRecord` swallows the build error silently — the responder proceeds to dispatch with no audit record produced. The forensic trail dies without any kernel-level signal. | P1 |
| `packages/llm-provider/src/llm-responder.ts:437-441` | `onToolIntent()` (dispatcher) throws. | DispatchResult coerced to `{kind: "failed", error}`; LLM sees refusal-style `dispatch_failed` tool_result. | **Correct. The downgrade prevents the pre-Task-02 lie ("Solicitação registrada" when nothing happened).** | P2 (correctly handled) |
| `packages/llm-provider/src/llm-responder.ts:496-513` | DEFER park to Redis fails (`redis.set` rejects). | console.error + continue. **LLM still emits "Estou aguardando confirmação"** tool_result. | **YES, FAIL-CLOSED.** This is the bug: the responder tells the LLM the operation is parked, but no envelope was stored. When the wire signal arrives, no parked key exists for the resolver to find. The customer is silently lost — same pre-Task-03 bug, different variant. Recommend: on park failure, surface a refusal-style tool_result ("Não consegui processar agora; tente novamente") and return. | **P0** |
| `packages/llm-provider/src/llm-responder.ts:714-723` | LLM stream startup fails (Anthropic SDK throws synchronously). | Post-checkout: emit deterministic confirmation fallback. Otherwise: yield generic error. | **Correct.** Post-checkout customers MUST see *something* — a checkout that completed deterministically can't leave the customer in conversational limbo because the LLM is down. | P2 (correct) |
| `packages/llm-provider/src/llm-responder.ts:740-750` | Stream rejects mid-flight (network drop, model 5xx). | Same as above: post-checkout fallback, generic error otherwise. | **Correct.** Same rationale. | P2 (correct) |
| `packages/llm-provider/src/llm-responder.ts:639-650` | Session-token tracker (`incrBy`) fails. | swallow. Daily budget broken. | **No.** Budget enforcement is best-effort by design; a leak is non-catastrophic. | P2 |
| `packages/llm-provider/src/llm-responder.ts:799-810` | REWRITE audit emit fails. | console.error + continue. Stream proceeds. | No — audit-emit is fire-and-forget. | P2 |
| `packages/llm-provider/src/llm-responder.ts:832-834` | REFUSE audit emit fails. | swallow (no log). | **YES (partial).** The refusal text DOES reach the user, but the audit record vanishes silently with no `.catch()` logging. Compliance audit cannot reconstruct that a REFUSE fired here. | P1 |

### Audit pipeline

| File:line | What fails | Default behavior | Should it be fail-closed? | Severity |
|---|---|---|---|---|
| `packages/llm-provider/src/intent-audit-wiring.ts:282-294` | Buffered sink rethrows after inner emit failed. | console.warn + swallow. **Documented fail-open at IbateXas boundary.** | **No — by design.** Task 19 contract: audit emit must never block adjudicate(). Persistent spill + audit-consumer NATS replay are the recovery. | P2 (correct) |
| `packages/llm-provider/src/intent-audit-wiring.ts:226-235` | Postgres sink direct insert fails. | onError → console.warn, buffered sink spills to Redis. | **No — by design.** Spill drains on next successful emit. | P2 (correct) |
| `packages/llm-provider/src/intent-audit-wiring.ts:140-158` | `getRedisClient()` unreachable for spill storage. | **In-memory spill fallback.** | **YES (partial).** Comment notes "spill still works within the process lifetime, it just doesn't survive a restart". In practice, a process restart during an inner-sink outage means the records in the in-memory spill list are lost forever. Recommend: gauge `audit_spill_storage_kind{kind="in_memory"}` so ops can see when the audit pipeline is silently lossy. | P1 |
| `packages/llm-provider/src/audit-redactor.ts:339-355` | Redactor throws (cycle in payload, exotic types). | Replace payload with `{ __redactor_error: true }` stub; record continues downstream. | **No — by design.** Invariant #4: never block on a redactor bug. | P2 (correct) |
| `packages/llm-provider/src/audit-redactor.ts:339-355` | **`__redactor_error` sentinel preservation through downstream sinks.** | The sentinel IS preserved in the JSON serialisation through `multiSink → console/NATS/Postgres`. The Redis spill (`redis-spill-storage.ts:94`) stores `JSON.stringify(record)`, so the sentinel survives spill + restart drain. **Postgres** writes `envelope_jsonb` verbatim via `$executeRawUnsafe` (`postgres-audit-writer.ts:107`), so the column shows `{"__redactor_error": true}` when triaging. | **No fail-closed needed.** The sentinel is end-to-end visible. Open the dashboard for "envelope_jsonb @> '{\"__redactor_error\": true}'" and ops see redactor-failure incidents. | P2 (verified working) |
| `packages/llm-provider/src/redis-spill-storage.ts:95-106` | EXPIRE call after RPUSH fails. | warn + swallow. Backlog may be evicted before 7d. | No — the data is already in Redis. | P2 |
| `packages/llm-provider/src/redis-spill-storage.ts:120-128` | LPOP during drain fails (Redis dropped). | warn + return (zero records yielded). | No — backlog stays in Redis for next attempt. | P2 |

### Customer / system gateways

| File:line | What fails | Default behavior | Should it be fail-closed? | Severity |
|---|---|---|---|---|
| `apps/api/src/routes/__shared__/customer-intent-gateway.ts:197-202` | Shadow-mode `adjudicate()` throws inside the try/catch. | swallow ("Pack threw — skip telemetry, fall through to legacy EXECUTE"). | **PARTIAL CONCERN.** Shadow mode is designed to never break the legacy path, so this is correct for the rollout phase. BUT once `IBX_KERNEL_ENFORCE` ships a kind to enforce, the same code path goes through line 192-193 (`if (ALWAYS_ENFORCE...||isEnforced)`) and `adjudicate()` throws will propagate to the route. Verify route-level error handlers translate kernel `throw` to a generic 500, not a SUCCESS body. | P1 |
| `apps/api/src/routes/__shared__/customer-intent-gateway.ts:218-229` | Audit emit fails on customer-intent path. | warn + swallow. | No — fire-and-forget by design. | P2 |
| `apps/api/src/subscribers/payment-lifecycle.ts:67-71` | Dedup `isNewEvent()` check fails. | swallow ("dedup failure is non-fatal"). | **YES (partial).** Without dedup, redelivered NATS messages re-fire the kernel-gated transition. EXECUTE is idempotent at the order-projection level (`InvalidTransitionError` on second attempt) but `pushToDlq` is NOT — a duplicate REFUSE produces a duplicate DLQ entry. Recommend: at minimum log `eventName=payment.status_changed` so the on-call sees redundant dedup misses. | P2 |
| `apps/api/src/subscribers/payment-lifecycle.ts:162-167` and `:242-246` | `transitionStatusFromEnvelope()` throws (concurrency, invalid transition). | warn + swallow. **No DLQ push.** | **YES, FAIL-CLOSED.** Documented as gap in investigation 04 §"Quick wins" #10. Today's behavior: the auto-confirm/auto-cancel event evaporates and no operator surface shows the failure. Add `pushToDlq("payment.status_changed", payload, err, log)` on this catch. | **P1** |

### DEFER / resume / sweep

| File:line | What fails | Default behavior | Should it be fail-closed? | Severity |
|---|---|---|---|---|
| `apps/api/src/subscribers/defer-resolver.ts:236-239` | Redis `get` of parked envelope fails. | `.catch(() => null)` → `kind: "no_park"` returned. | **YES (partial).** A transient Redis error produces an indistinguishable result from "no park exists" — the resolver skips the session, the parked key remains, the wire signal won't be re-delivered (Core NATS, not JetStream), and the customer's PIX confirmation is silently dropped. Recommend: distinguish IOError from null and DLQ the IOError case so the next sweep retries. | **P1** |
| `apps/api/src/subscribers/defer-resolver.ts:467-475` | Redis unreachable at sweep start. | error log + return (no sweep). | **YES (partial).** Same loss vector as above but at the sweep level. Add a metric/Sentry breadcrumb so an outage of >5min visibly triggers. | P1 |
| `apps/api/src/subscribers/defer-resolver.ts:482-500` | SCAN over `defer:pending:*` fails mid-sweep. | error log + abort sweep. | No — next sweep retries. | P2 |
| `apps/api/src/subscribers/defer-resolver.ts:349-364` | `adjudicate()` throws on resume re-execution. | log + DLQ + return `resume_failed`. | **Correct.** | P2 (correct) |
| `apps/api/src/subscribers/audit-consumer.ts:135-141` | Dedup check fails. | warn + proceed (ON CONFLICT is layer 2). | No — by design. | P2 (correct) |
| `apps/api/src/subscribers/audit-consumer.ts:155-163` | Postgres INSERT fails. | DLQ push. | **Correct fail-closed pattern.** | P2 (correct) |
| `apps/api/src/jobs/defer-timeout-sweeper.ts:96-105` | Redis unreachable. | error log + skip sweep. | **Correct, but unmonitored.** If Redis is down for >24h, anonymize-grace customers wait indefinitely for the deletion to complete. Need an alert on "consecutive sweeps with Redis error". | P1 |
| `apps/api/src/jobs/defer-timeout-sweeper.ts:195-203` | NATS publish fails. | error log + leave key for retry. | **Correct.** Next sweep retries. | P2 (correct) |
| `apps/api/src/jobs/defer-timeout-sweeper.ts:207-211` | DEL key after publish fails. | swallow ("Best-effort. Even if DEL fails, the Redis TTL will eventually garbage-collect"). | Acceptable — TTL is +60s grace beyond the signal timeout, so the next sweep re-publishes. **Idempotency on the subscriber side (anonymize-grace-resolver) is the safety net.** | P2 (correct, depends on subscriber idempotency) |

### Boot path

| File:line | What fails | Default behavior | Should it be fail-closed? | Severity |
|---|---|---|---|---|
| `apps/api/src/plugins/kernel-bootstrap.ts:142-156` | `installPack()` throws `PackConformanceError`. | `server.log.fatal` then **rethrow**. `index.ts:127` catches and `process.exit(1)`. | **Correct fail-closed pattern.** Boot fails before `listen()`. | P2 (correct) |
| `apps/api/src/plugins/kernel-bootstrap.ts:168-178` | `validateEnforceConfig()` reports a typo. | **WARN ONLY — server proceeds to `listen()`**. | **YES, FAIL-CLOSED in production.** Today, a typo in `IBX_KERNEL_ENFORCE=order.cart.adddd` is logged at warn level and the API boots — but the intent kind is never enforced because the comparator returns false. The operator gets a silent "kernel rollout looks healthy" while the policy gate isn't running. Recommend: in `APP_ENV=production`, treat any unknown-intent-kind warning as fatal (throw). Keep warn-only in dev/staging. | **P0** |
| `apps/api/src/plugins/kernel-bootstrap.ts:90-91` | `setMetricsSink()` call — does NOT throw, no boot guard. | n/a | n/a | — |
| `apps/api/src/index.ts:86-91` | `setOutboxWriter(redis)` setup fails. | warn + outbox disabled. | **YES (partial).** Without the outbox, 8 critical events (order.placed, payment.status_changed, etc.) can be silently lost on NATS broker restart per investigation 04. Recommend: in production, treat outbox setup failure as fatal. | P1 |
| `apps/api/src/index.ts:74-79` | `scheduleSvc.seedFromEnv()` fails. | warn + continue. | No — operator runs `ibx db migrate:domain` manually. | P2 |

### Metrics sink

| File:line | What fails | Default behavior | Should it be fail-closed? | Severity |
|---|---|---|---|---|
| `apps/api/src/plugins/kernel-metrics-sink.ts:197-214` | `trackAnalytics()` (PostHog via NATS) throws or rejects. | swallow with log.warn. | **Correct.** Metric publish must not block adjudicate(). | P2 (correct) |
| `apps/api/src/plugins/kernel-metrics-sink.ts:216-230` | Sentry breadcrumb throws. | swallow with log.warn. | Correct. | P2 (correct) |
| `apps/api/src/plugins/kernel-metrics-sink.ts:232-241` | `prom-client.inc()` throws. | swallow with log.warn. | Correct. | P2 (correct) |
| Chain failure: **all three sinks down simultaneously.** | Each catches independently; the `MetricsSink` methods complete normally. **Kernel decision proceeds with zero observability.** | **YES (partial).** This is the correct posture (decision MUST NOT block) but the operator loses every signal. Recommend: emit a single in-process counter `metrics_sink_total_failures` that survives all three sub-sink failures, exposed via `/healthz` so the load balancer can route around a sink-blind replica. | P1 |

## Cascade failure scenarios

### Scenario A — BullMQ worker outage → anonymize grace expires silently
**Trigger:** `defer-timeout-sweeper` worker crashes and BullMQ doesn't restart it.
**Impact:**
1. `defer:pending:anonymize:{customerId}` keys expire at TTL (24h + 60s).
2. Redis garbage-collects the key silently.
3. No `intent.defer.timeout` event fires.
4. `anonymize-grace-resolver` subscriber never runs `anonymizeCustomer`.
5. **LGPD obligation breached:** customer requested deletion, kernel said "I'll wait 24h", deletion never runs.

**Detection:** Currently NONE. No monitor on the sweeper's last successful run.
**Severity:** **P0 — Regulatory.**
**Recommendation:** Heartbeat metric on `sweepDeferTimeouts` last invocation; PagerDuty if stale > 5min.

### Scenario B — Redis outage during DEFER park
**Trigger:** Redis unavailable when `llm-responder.ts:496-513` tries to `set defer:pending`.
**Impact:**
1. console.error logs the failure.
2. LLM is told "Estou aguardando confirmação..."
3. Customer's PIX confirms 5 minutes later.
4. NATS event fires. Defer-resolver sweeps `defer:pending:*` — no keys.
5. Customer's order remains pending forever; LLM has moved on; staff don't know.

**Severity:** **P0 — Silent data loss.**
**Recommendation:** see top inventory entry — make this fail-closed (surface refusal to LLM).

### Scenario C — NATS broker outage during in-flight DEFER
**Trigger:** Customer parks PIX intent. NATS broker crashes. Stripe sends `payment.status_changed` webhook. API receives the HTTP request, calls `publishNatsEvent("payment.status_changed", ...)`. Core NATS (not JetStream) fire-and-forget: if no subscriber connected at publish time, message is gone.
**Impact:** Outbox-retry compensates for `payment.status_changed` (it's in `OUTBOX_EVENTS` per `packages/nats-client/src/index.ts:77`). On NATS recovery within 60s, the retry re-publishes and defer-resolver picks it up.
**Severity:** **P2 — Recoverable**, provided outbox setup succeeded at boot (see boot path P1 above).

### Scenario D — Postgres outage + Redis spill storage simultaneous outage
**Trigger:** Both Postgres (audit-postgres) and the Redis spill storage are unreachable.
**Impact:**
1. Postgres sink: `onError` log, buffered sink spills.
2. Spill storage: Redis unreachable → `loadSpillStorage()` already fell back to in-memory at boot if Redis was down then. If Redis went down later, `createRedisSpillStorage` calls fail on `rPush`.
3. `persistentBufferedSink.bufferOrSpill` tries to evict to storage (fails), calls `onOverflow` (logs), pushes new record to memQueue.
4. Backlog grows until process restart.
5. **Process restart → in-memory queue lost → audit gap.**

**Detection:** `console.warn("audit buffer overflow")` only — no metric.
**Severity:** **P1 — Audit gap.** The NATS subscriber side (audit-consumer) only catches records that successfully published to NATS, which depends on the NATS sink in the inner multi-sink succeeding. If NATS is up while Postgres is down, the audit-consumer drains correctly. If NATS is also down: silent loss.
**Recommendation:** A filesystem-backed spill implementation (referenced in `persistent-buffered-sink.ts` doc comment as "adopter responsibility") would close this gap.

### Scenario E — Audit redactor sentinel preservation
**Tested through code reading:**
1. `audit-redactor.ts:339-355` replaces payload with `{ __redactor_error: true }` on throw.
2. The redacted record passes to `persistentBufferedSink.emit` (intent-audit-wiring.ts:284).
3. `multiSink(console, nats, [postgres])` fan-out — each receives the same `record` object.
4. Console sink: `[ibx-audit] { ... envelope: { payload: { __redactor_error: true } } ... }` — visible.
5. NATS sink: `publishNatsEvent` serialises via `JSON.stringify(payload)` — sentinel survives.
6. Postgres sink: `postgres-audit-writer.ts:107` → `row.envelope_jsonb` is the redacted record's envelope. The driver serialises the JSON column verbatim.
7. Redis spill: `redis-spill-storage.ts:94` does `JSON.stringify(record)` — sentinel survives. LPOP + parse on drain restores the sentinel.

**Verdict: VERIFIED preserved end-to-end.** Operator triage path: query `intent_audit` where `envelope_jsonb @> '{"__redactor_error": true}'` to find PII-redaction failures.

### Scenario F — Kill switch trip during boot
Not yet wired (the kernel ships a `KillSwitch` concept in `@adjudicate/core`, but IbateXas hasn't installed a kill switch sink). N/A for this audit.

## Backpressure analysis

### Audit buffer at capacity 1000

`packages/llm-provider/src/intent-audit-wiring.ts:89-100` — buffer capacity is 1000 records, overridable via `IBX_AUDIT_BUFFER_CAPACITY`.

Flow at capacity 1001:
1. `persistentBufferedSink.emit` calls inner.emit (multi-sink).
2. If inner succeeds → drained from memQueue.
3. If inner fails → `bufferOrSpill(record, memQueue, opts, "failure")` is called.
4. `bufferOrSpill` checks `memQueue.length < opts.capacity` (1000). If equal, evicts oldest into storage via `storage.append`.
5. `onOverflow` callback fires (currently: `console.warn("audit buffer overflow — record spilled to durable storage")`).
6. Storage append failure path (`persistent-buffered-sink.ts:139-144`) catches silently; subsequent records still push into memQueue. **The spill is best-effort.**

**Max spill size (Redis):**
- Redis list `audit:spill:queue` has no explicit cap. The 7-day EXPIRE TTL is the upper bound on time-in-queue.
- Redis memory pressure depends on cluster sizing. At 30 RPS sustained outage, one day = ~2.6M records. At ~1KB/record (typical AuditRecord JSON with redacted payload), that's ~2.6 GB of Redis memory.
- **No alarm exists on `audit:spill:queue` length.** Recommend: gauge `audit_spill_queue_size` exposed via Prometheus and alarm at > 10K.

### NATS publish backpressure

`packages/nats-client/src/index.ts:138` — `nats.publish(subject, encoded)` is synchronous and non-awaiting in the underlying nats.js library (Core NATS, no ack). The `publishNatsEvent` function does `await getNatsConnection()` then a sync `publish()`. Audit emit fires this from within `void getAuditSink().emit().catch(...)` so the responder never awaits the NATS publish path.

**Backpressure exists in two places:**
1. NATS client connection buffer (default 8MB in node nats.js) — fills if publish rate exceeds drain rate. Library returns synchronously, so backpressure manifests as silent message loss on overflow (Core NATS, no flow control).
2. Outbox writes (for the 8 critical events) — `lpush` is awaited and can block on Redis backpressure. The publisher path is `await _outboxWriter.lPush` before `nats.publish`, so a slow Redis blocks the entire publisher chain.

**Verdict:** under heavy load, audit records can be silently dropped at the NATS broker boundary even when the inner-sink layer reports success. The persistent buffered sink does NOT protect against this — only inner-emit *rejection* spills, and Core NATS publish doesn't reject. Recommend: migrate audit subject to JetStream so the publish becomes ack'd and backpressure surfaces.

## Boot-time failure handling

### Postgres unreachable + `IBX_AUDIT_POSTGRES_ENABLED=true`

`intent-audit-wiring.ts:215-239` — when the flag is true, `createPostgresAuditWriter` is constructed with `prisma`. The construction itself doesn't connect (Prisma lazy-connects on first query). Boot completes successfully.

First adjudicate() → first audit emit → first Postgres INSERT → Prisma attempts connection → fails → `onError(err)` → buffered sink spills. **Boot does not fail-fast.**

The audit-consumer (`apps/api/src/subscribers/audit-consumer.ts:65-73`) also doesn't pre-flight Postgres connectivity. It subscribes successfully and fails on the first record.

**Verdict:** Both the in-process Postgres sink and the redundancy consumer are designed to fail-open on Postgres outage. This is correct for the audit pipeline contract — audit failures must never block decisions. But there is no boot-time pre-flight that says "Postgres reachable, audit will land". Recommend: `bootstrapKernel` could probe a `SELECT 1` against the audit DB and log a single `kernel.bootstrap.audit_postgres_pre_flight` event so the absence of audit rows in dev/staging is diagnosable.

### NATS unreachable

`packages/nats-client/src/index.ts:32-33` — `connect({reconnect: true, maxReconnectAttempts: -1})`. Infinite retries. The first `subscribeNatsEvent` call awaits `getNatsConnection()` which blocks until connection succeeds.

Boot flow (`apps/api/src/index.ts`):
1. `await bootstrapKernel(server)` — does not touch NATS.
2. `await server.listen()` — does not touch NATS.
3. `await startCartIntelligenceSubscribers(...)` — first NATS-touching call. **This blocks forever if NATS is unreachable.**

**Verdict:** The API process hangs at "registering subscribers" indefinitely. Health checks pointing at `/healthz` would see the listener up but subscribers not registered. Recommend: a connect timeout on `getNatsConnection` so boot fails-fast rather than hanging.

### Redis unreachable

Most paths use Redis. `getRedisClient()` (`packages/tools/src/redis/client.ts:13-39`) throws `Error("REDIS_URL env var required")` if the env var isn't set, otherwise awaits `client.connect()`. No timeout.

Boot flow:
- `setOutboxWriter(redis)` at `apps/api/src/index.ts:87` — awaited. **Blocks forever if Redis is down.**
- BullMQ workers — Redis-backed; `createQueue` lazy-connects on first command.

**Verdict:** Boot hangs at outbox writer setup. Same recommendation as NATS — connect timeout + fail-fast.

## Recovery procedures (existing or missing)

### Existing
1. **Outbox retry (60s)** — replays 8 critical NATS events from Redis list. Distributed lock prevents concurrent retries.
2. **DLQ replay CLI** — `ibx dlq replay <event>` re-publishes from Redis lists. Manual operator action.
3. **Audit-postgres redundancy** — NATS-subscribed audit-consumer catches what the in-process Postgres sink missed.
4. **DEFER timeout sweeper** — publishes `intent.defer.timeout` for expired parks; consumed by `anonymize-grace-resolver`.

### Missing — required
1. **DEFER park failure replay:** when `redis.set` fails at park time (`llm-responder.ts:496-513`), there's no fallback. Recommend: a second-line park to an in-memory queue with a Redis health probe that drains when Redis recovers, OR refuse the intent.
2. **DLQ enumeration for `audit.intent.decision.v1` and `intent.defer.resume`:** `packages/cli/src/commands/dlq.ts:12-18` defines `DLQ_EVENTS = ["order.status_changed", "order.placed", "notification.send", "support.handoff_requested", "conversation.message.appended"]` — only 5 entries. The `audit-consumer` and `defer-resolver` push to `dlq:audit.intent.decision.v1` and `dlq:intent.defer.resume` respectively; **these are invisible to `ibx dlq list`**. The investigation 04 bug was never fixed — Task 19's audit-consumer worsened it. Add both subjects to the constant.
3. **`payment-lifecycle` DLQ:** the catch on `transitionStatusFromEnvelope` throw doesn't DLQ. The original NATS payload disappears.
4. **Audit pipeline read-only recovery:** there's no documented procedure for rebuilding parked state from the audit log when Redis loses parks. Comment in `defer-resolver.ts` notes "Read-only audit can rebuild parked state? (Probably not without audit-postgres being live.)" — confirmed: without `IBX_AUDIT_POSTGRES_ENABLED=true`, the audit subject is fire-and-forget through NATS (Core NATS, no persistence), so a Redis loss is unrecoverable.

### Missing — nice-to-have
5. **Graceful shutdown drain:** `apps/api/src/index.ts:59-66` — `shutdown()` order is: stop workers → drain NATS → close server → close Redis → disconnect Prisma. This does NOT explicitly drain in-flight kernel decisions or audit emits. A kernel decision in flight when SIGTERM arrives may have its audit emit interrupted (Redis closes before the buffered sink finishes draining). The Postgres audit-consumer then needs to absorb the redundancy. Acceptable, but undocumented.
6. **In-flight DEFER parks at shutdown:** the parked envelope is already in Redis at SIGTERM, so it survives the shutdown. Resumes work after the next process restart provided NATS redelivers (subject to outbox/JetStream caveats).

## Logging consistency (task 07 audit reference)

Confirmed: `llm-responder.ts` uses `console.warn` / `console.error` at every failure site (lines 231, 249, 260, 274, 311, 339, 408, 414, 447, 508, 715, 717, 741, 743, 762, 800, 806, 832). These bypass the pino structured logger and lose `reqId` correlation, exactly as task 07 reported.

`intent-audit-wiring.ts:94, 232, 260, 269, 290` — same pattern.

`audit-redactor.ts:285, 288, 343-347` — accepts `warn` injection but defaults to `console.warn`.

`intent-ledger.ts:122, 150` — `console.warn`.

`kernel-bootstrap.ts:144, 153, 169, 172` — correctly uses `server.log` (the bound pino instance).

**Verdict:** Inconsistent. All `@ibatexas/llm-provider` package paths use console; all `apps/api` paths use the bound pino logger. The intent-dispatcher accepts a logger but the responder doesn't thread it through. Closing this is a single-PR refactor.

## Findings ranked

### P0 — Production-critical
1. **`llm-responder.ts:496-513` DEFER park failure is silently lossy.** Customer is told "wait for confirmation"; no envelope stored. **Make fail-closed:** on park failure, surface a refusal tool_result.
2. **`kernel-bootstrap.ts:168-178` enforce-config typo warns and proceeds.** A typo in `IBX_KERNEL_ENFORCE` silently disables a kind that the operator thinks is enforced. **Make fail-fast in production** (`APP_ENV === "production"` → throw on unknown intent kind).
3. **Scenario A — anonymize grace silently breaks LGPD compliance if sweeper outage > 24h.** No heartbeat metric exists today.

### P1 — Important
4. **`payment-lifecycle.ts:162-167, 242-246` swallows transition failures with no DLQ.** Forged or replayed `payment.status_changed` events that hit `InvalidTransitionError` evaporate.
5. **`defer-resolver.ts:236-239` Redis IOError indistinguishable from "no park exists".** Transient Redis failures silently drop PIX confirmations.
6. **`intent-audit-wiring.ts:140-158` Redis-down at boot → in-memory spill fallback.** Lossy on restart; no visibility to ops.
7. **`llm-responder.ts:832-834` REFUSE audit emit has no `.catch()` logging.** Refusals fire correctly to the user but the audit gap is silent.
8. **DLQ CLI omits `audit.intent.decision.v1` and `intent.defer.resume`.** `ibx dlq list` returns empty when those subjects have entries.
9. **`apps/api/src/index.ts:86-91` outbox setup failure warned, not fatal.** Without the outbox, 8 critical events are silently lossy on broker restart.
10. **NATS Core mode (fire-and-forget) for `audit.intent.decision.v1`** — backpressure on the broker side silently drops audit records even when inner emit succeeds. Migrate to JetStream.
11. **No connect-timeout on `getNatsConnection` or `getRedisClient`** — boot hangs indefinitely on those services. Should fail-fast.
12. **Customer-intent-gateway shadow-mode swallow at line 197-202.** Acceptable today; verify enforce-mode propagation when the rollout flips.
13. **Logging inconsistency** — every failure in `@ibatexas/llm-provider` logs through `console.*`, dropping `reqId` correlation. Single-PR refactor.

### P2 — Hygiene / correct fail-open
14. Ledger fail-open path (when `IBX_LEDGER_FAIL_OPEN=true`) is correctly bounded and well-instrumented.
15. Metrics sink chain failure-open is correct; recommend health surface so a metrics-blind replica is routable around.
16. Audit redactor sentinel preserved end-to-end — verified.
17. DEFER timeout sweeper publish/delete behaviour — correct retry semantics.
18. Audit-consumer DLQ pattern — correct fail-closed.
19. Stream-startup and stream-mid-flight failures with deterministic post-checkout fallback — correct.

## Summary metric

| Severity | Count | Notes |
|---|---|---|
| Fail-open sites total | 27 | Across hot path, subscribers, jobs, gateway, audit pipeline |
| Correctly fail-open | 16 | Audit sink chain, metrics, ledger (governed by env), stream fallbacks, dispatcher refusal downgrade |
| Should be fail-closed | 5 | DEFER park, enforce-config validation, payment-lifecycle DLQ, defer-resolver IOError, outbox setup |
| Partial / monitoring gap | 6 | In-memory spill fallback, DLQ CLI enumeration, sweeper heartbeat, REFUSE audit log, NATS Core mode, shadow-throw swallow |
| Verified working | 1 | Redactor sentinel through downstream sinks |
