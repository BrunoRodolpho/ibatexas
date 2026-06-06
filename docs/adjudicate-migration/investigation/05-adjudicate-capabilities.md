> ⚠️ **SUPERSEDED on 2026-05-24.** Phase-1 pre-cutover capability inventory of `@adjudicate/*` v1.0-rc (2026-05-22). The platform repo has since published `1.0.0` / `0.1.1` family versions and the lighthouse `@adjudicate/pack-payments-pix` has been adopted (see ADR #13). For current adopted surface, see `CLAUDE.md` rule #9 and the per-package version pins in the root `package.json`. Content preserved unchanged below as historical record.

---

# 05 — Adjudicate Capabilities Inventory

> Investigator 5 of 8 — full capability surface of `@adjudicate/*` v1.0-rc.
> Source: `/Users/thaisrodolpho/projects/adjudicate/packages/**` + `apps/**` + `bench/**`.

## Executive summary

**Adjudicate ships 19 packages.** The 6 ibatexas already imports cover the
adjudication hot path; **13 packages and ~130 named exports are unused** by
ibatexas today. The biggest under-utilised surface areas are: the
**adapter-core LLM loop**, the **operator console + admin-sdk + tRPC schemas**,
the **conformance / analyze / migrate** authoring toolchain, **observability**
(OTLP), **audit-postgres** (durable governance), and the **CLI** (`simulate`,
`replay`, `analyze`, `pack init`, `pack lint`, …).

| Package | USED by ibatexas | Notable exports | Count |
|---|---|---|---|
| `@adjudicate/core` | **USED** (top-level) | envelope, decision, refusal, taint, audit, hash, ledger, sink, pack, explain, replay-classify | 25+ |
| `@adjudicate/core/kernel` | **USED** | adjudicate, adjudicateAndAudit, adjudicateWithDeadline, adjudicateAndLearn, policy bundle types, combinators, metadata, GuardFireStats, RuntimeContext, rate-limit, enforce-config, shadow, outcomes, metrics, identity | 60+ |
| `@adjudicate/core/llm` | **USED** | CapabilityPlanner, ToolClassification, PromptRenderer, safePlan/assertPlan* | 12 |
| `@adjudicate/runtime` | **USED** | deadlinePromise, DEADLINE_HIT, parkDeferredIntent, resumeDeferredIntent, verifyParkedEnvelopeHash | 10 |
| `@adjudicate/audit` | **USED** (subset) | sinks (Console/NATS/multi/persistent), Redis ledger, replay, integrity, drift, supersession, kill-switch timeline, event bus, distributed-kill-switch, operational-snapshot | 50+ |
| `@adjudicate/pack-payments-pix` | **USED** | createPixPendingDeferGuard, paymentsPixPack, refuse* helpers | 15 |
| `@adjudicate/anthropic` | **UNUSED** | createAdjudicatedAgent + Anthropic bridge/renderer | 12 |
| `@adjudicate/openai` | **UNUSED** | createAdjudicatedAgent (OpenAI variant) | 12 |
| `@adjudicate/adapter-core` | **UNUSED** | The provider-neutral loop everything funnels through | 25 |
| `@adjudicate/primitives` | **UNUSED** | createThresholdGuard, createStateDeferGuard, createRewriteGuard, createConfirmGuard, createEscalateGuard, createIdempotencyGuard, createSystemTaintPolicy | 7 |
| `@adjudicate/pack-identity-kyc` | **UNUSED** | IdentityKycPack | 8 |
| `@adjudicate/pack-deployments-approval` | **UNUSED** | deploymentsApprovalPack | 8 |
| `@adjudicate/cli` | **UNUSED** | simulate, replay, analyze, pack init/lint/verify, repl, visualize, scenarios generate, export, doctor, dev, reap | 11 commands |
| `@adjudicate/admin-sdk` | **UNUSED** | tRPC schemas + handlers (audit query, emergency, outcome, guard-stats, replay) | 30+ |
| `@adjudicate/audit-postgres` | **UNUSED** | createPostgresSink, postgres audit store, governance log, guard-stats store, outcomes store | 15 |
| `@adjudicate/conformance` | **UNUSED** | runConformance, pack manifest + trust, default checks | 8 |
| `@adjudicate/analyze` | **UNUSED** | Tier-1 / Tier-2 static analyzers (basis-code-consistency, default-polarity, missing-metadata, rewrite-scope, signal-consistency, taint-policy) | 8 |
| `@adjudicate/observability` | **UNUSED** | OTLP metrics/learning/audit-span sinks + InMemoryExporter | 10 |
| `@adjudicate/migrate` | **UNUSED** | codemod runner (nameGuard → withMetadata) | 4 |
| `@adjudicate/locales-pt-BR` | **UNUSED** | `portugueseRefusalMessages` (literally pt-BR refusal dictionary — and we are Brazilian!) | 1 |
| `apps/console` (operator UI) | **UNUSED** | Audit Explorer, decision-detail, lineage, governance, control, dashboard | full Next.js app |
| `apps/web` | **UNUSED** | marketing only; not relevant to integration | n/a |
| `bench/` | **UNUSED** | kernel + audit microbenchmarks, scale harnesses (audit event bus, kill switch) | 5 |

USED ratio: roughly 30% of named exports across all packages, concentrated on the kernel hot path.

---

## @adjudicate/core

### Top-level (`@adjudicate/core`)

| Capability | Signature / Type | Purpose | Status |
|---|---|---|---|
| `INTENT_ENVELOPE_VERSION` | `2 as const` | Current envelope version | USED |
| `IntentEnvelope<K, P>` | `{version, kind, payload, createdAt, nonce, actor, taint, intentHash}` | The canonical mutation proposal | USED |
| `IntentActor` | `{principal: "llm" \| "user" \| "system", sessionId}` | Actor identity on an envelope | USED |
| `buildEnvelope(input)` | `(BuildEnvelopeInput) → IntentEnvelope` | Construct envelope; computes intentHash from `(version, kind, payload, nonce, actor, taint)` (not `createdAt`) | USED |
| `isIntentEnvelope(value)` | `(unknown) → boolean` | Type guard | UNUSED |
| `hasUnknownEnvelopeVersion(value)` | `(unknown) → boolean` | Pre-kernel version-shape check | UNUSED |
| `Decision` | 6-variant union (EXECUTE/REFUSE/ESCALATE/REQUEST_CONFIRMATION/DEFER/REWRITE) | Result of adjudicate() | USED |
| `DecisionKind` | string literal union | Discriminator | USED |
| `decisionExecute(basis)` | `(basis[]) → Decision` | Build EXECUTE | USED |
| `decisionRefuse(refusal, basis)` | `(Refusal, basis[]) → Decision` | Build REFUSE | USED |
| `decisionEscalate(to, reason, basis)` | `("human"\|"supervisor", string, basis[]) → Decision` | Build ESCALATE | UNUSED |
| `decisionRequestConfirmation(prompt, basis)` | `(string, basis[]) → Decision` | Build REQUEST_CONFIRMATION | UNUSED |
| `decisionDefer(signal, timeoutMs, basis)` | `(string, number, basis[]) → Decision` | Build DEFER | USED |
| `decisionRewrite(rewritten, reason, basis)` | `(IntentEnvelope, string, basis[]) → Decision` | Build REWRITE | UNUSED |
| `BASIS_CODES` | nested const object | Vocabulary-controlled basis codes per category | USED |
| `BasisCategory` | string union (`state\|auth\|taint\|ledger\|schema\|business\|validation\|kill\|deadline\|confirmation\|kernel`) | | USED |
| `DecisionBasis<C>` | `{category, code, detail?}` | One reason entry on Decision | USED |
| `basis(category, code, detail?)` | typed builder | Compile-time vocab enforcement | USED |
| `isKnownBasisCode(basis)` | `(DecisionBasis) → boolean` | Runtime vocab guard | UNUSED |
| `Refusal` / `RefusalKind` | `{kind, code, userFacing, detail?}` | Stratified refusal | USED |
| `refuse(kind, code, userFacing, detail?)` | typed builder | Refusal constructor | USED |
| `RefusalMessages` | `{fallback, byCode: Record<string,string>}` | Localization dictionary | UNUSED |
| `englishRefusalMessages` | `RefusalMessages` | Default English strings | UNUSED |
| `resolveRefusalMessage(code, messages?)` | lookup | | UNUSED |
| `localizeDecision(decision, messages)` | substitute REFUSE.userFacing | Presentation-time localization | UNUSED |
| `Taint` / `TaintPolicy` | `"SYSTEM"\|"TRUSTED"\|"UNTRUSTED"` lattice | Provenance type | USED |
| `taintRank(t)` / `mergeTaint(a,b)` / `meetAll(taints)` | lattice helpers | | USED (partial) |
| `canPropose(taint, kind, policy)` | gate | The taint gate primitive | USED |
| `TaintedValue<T>` / `tainted(v, t)` / `isTaintedValue(v)` / `collectFieldTaints` / `canProposeFieldLevel` | field-level taint (v1.1) | Mixed-provenance payload support | UNUSED |
| `AuditRecord` (v4) | full schema with auditHash, supersedes, plan, policyVersion, kernelVersion, kernelIdentity, signature | Durable governance entry | USED |
| `AUDIT_RECORD_VERSION` | `4 as const` | Current version | USED |
| `Supersession` / `SupersessionReason` | `confirmation_resolved \| defer_resumed \| rewrite_executed \| replay` | Chain predecessor link | UNUSED |
| `AuditPlanSnapshot` | `{visibleReadTools, allowedIntents, planFingerprint}` | Planner snapshot at decision time | UNUSED |
| `buildAuditRecord(input)` | `(BuildAuditInput) → AuditRecord` | Constructs record + computes auditHash + planFingerprint | USED |
| `verifyAuditRecord(record)` | `→ {verified: true \| false \| null, …}` | Tamper-evidence check | UNUSED |
| `replayEnvelopeFromAudit(record)` | rebuild envelope from audit row | Replay-safe rehydration | UNUSED |
| `sha256Canonical(value)` / `canonicalJson(value)` | RFC-8785-style canonical hash | Used for intentHash + auditHash + planFingerprint | USED (partial) |
| `Ledger` / `LedgerHit` / `LedgerRecordInput` / `LedgerRecordOutcome` | contract | Execution ledger interface | USED |
| `AuditSink` | `{emit(record): Promise<void>}` | Durable sink contract | USED |
| `noopAuditSink()` | factory | No-op sink (signature-requiring slot) | UNUSED |
| `PackV0<K, P, S, C>` | `{id, version, contract: "v0", intents, policy, planner, basisCodes, handlers?, signals?, rehydrateState?}` | Pack contract | UNUSED |
| `PackHandler<P, S>` | `(payload, state) => Promise<unknown>` | Side-effect handler | UNUSED |
| `installPack(pack, options?)` | `→ {pack: wrapped, installedDefaults[]}` | Boot-time conformance + console-sink default + withBasisAudit wrapping | UNUSED |
| `PackConformanceError` / `assertPackConformance(pack, opts?)` | structural conformance | Throws on malformed pack | UNUSED |
| `withBasisAudit(pack)` | wraps every guard | Records basis-code drift, REWRITE taint regression, DEFER signal drift, basis-vocabulary drift | UNUSED |
| `KERNEL_REFUSAL_CODES` | `Set<string>` of kernel refusal codes | | UNUSED |
| `explainRecord(record, registry)` | `→ DecisionExplanation` | Operator-facing rendering | UNUSED |
| `DEFAULT_EXPLANATION_REGISTRY` / `ExplanationRegistry` / `mergeExplanationRegistries` | template-driven explanation | English defaults + composability | UNUSED |
| `classify(intentHash, expected, actual)` | replay classifier | Returns `ReplayMismatch \| null` | UNUSED |
| `ReplayMismatch` / `ReplayMismatchKind` / `ReplayBasisDelta` | mismatch shape | | UNUSED |

### kernel (`@adjudicate/core/kernel`)

| Capability | Signature | Purpose | Status |
|---|---|---|---|
| `adjudicate(envelope, state, policy)` | `→ Decision` | The pure deterministic kernel. Evaluation order: kill → schema → state → **taint** → auth → business → default | USED |
| `adjudicateWithTrace(envelope, state, policy)` | `→ {decision, trace}` | Same Decision plus per-step AdjudicationTrace | UNUSED |
| `AdjudicationTraceEntry` / `AdjudicationTracePhase` / `AdjudicationTraceResult` | trace types | | UNUSED |
| `nameGuard(name, guard)` | identity-preserving wrapper attaching metadata.name | Surfaces in trace + LearningEvent.guardId | UNUSED |
| `adjudicateAndAudit(envelope, state, policy, deps)` | `→ Promise<{decision, record, ledgerHit}>` | Production entry: ledger consult + EXECUTE-race claim + metrics + learning + audit-emit + rate-limit rollback + confirmation receipt + tenant context | USED |
| `AdjudicateAndAuditDeps` | `{sink, ledger?, clock?, resolveResourceVersion?, plan?, context?, rateLimitRollback?, confirmationReceipt?, supersedes?}` | | USED (partial) |
| `AdjudicateAndAuditClock` / `AdjudicateAndAuditResult` | injection points | | USED |
| `adjudicateWithDeadline(envelope, state, policy, {deadlineMs})` | `→ Promise<Decision>` | Races kernel against wall-clock; SECURITY refusal on miss | UNUSED |
| `adjudicateAndLearn(envelope, state, policy, options?)` | `→ Decision` (sync) | Emits LearningEvent only, no audit/ledger | UNUSED |
| `Guard<K, P, S>` | `(envelope, state) => Decision \| null` | Guard type | USED |
| `PolicyBundle<K, P, S>` | `{stateGuards, authGuards, taint, business, default}` | The plug for `adjudicate()` | USED |
| `allOf(...guards)` / `firstMatch` / `constant(decision)` | combinators | | UNUSED |
| `GuardMetadata` / `GuardDescription` (`threshold\|state_defer\|system_taint\|rewrite\|opaque`) | ADR-105 metadata vocab | | UNUSED |
| `withMetadata(guard, meta)` / `readGuardMetadata(guard)` / `GuardMetadataSymbol` | metadata attachment | Per-field write-once; identity-preserving | UNUSED |
| `describePolicyBundle(bundle)` | `→ PolicyBundleDescriptor` | JSON-serialisable introspection | UNUSED |
| `GuardDescriptor` / `PolicyBundleDescriptor` / `PolicyPhase` / `PolicyPhaseDescriptor` | descriptor types | | UNUSED |
| `GuardFireStats` (class implementing LearningSink) | in-memory accumulator with optional `GuardFireStatsStore` | Bucketizes `(guardName, guardPhase, decisionKind, day, packId)` | UNUSED |
| `GuardFireBucket` / `GuardFireStatsQuery` / `GuardFireStatsOptions` / `GuardFireStatsStore` / `GuardPhase` | | | UNUSED |
| `LearningEvent` / `LearningSink` | `{recordOutcome(event)}` | Telemetry contract | USED |
| `setLearningSink` / `hasLearningSink` / `_resetLearningSink` | singleton ops | | USED (partial) |
| `recordOutcome(event)` | helper | Module-level emit | USED |
| `createConsoleLearningSink()` | factory | Reference sink | UNUSED |
| `flattenBasis(basis)` | `→ string[]` of `"category:code"` | Used for LearningEvent.basisCodes | USED |
| `matchedGuardIdFromTrace(trace)` / `matchedGuardPhaseFromTrace(trace)` | extract matched guard identity | | UNUSED |
| `MetricsSink` | `{recordLedgerOp, recordDecision, recordRefusal, recordSinkFailure, recordShadowDivergence, recordResourceLimit?}` | Metrics contract | USED |
| `recordLedgerOp` / `recordDecision` / `recordRefusal` / `recordSinkFailure` / `recordResourceLimit` | helpers | | USED (partial) |
| `setMetricsSink` / `hasMetricsSink` / `_resetMetricsSink` / `createConsoleMetricsSink()` | wiring | | USED (partial) |
| `LedgerOpEvent` / `DecisionEvent` / `RefusalEvent` / `SinkFailureEvent` / `ShadowDivergenceEvent` / `ResourceLimitEvent` | event shapes | | USED (partial) |
| `OutcomeSink` / `ObservedOutcome` (`succeeded\|failed\|withdrawn`) / `RetrospectiveOutcome` | retrospective outcome substrate | "Did the action actually succeed?" | UNUSED |
| `InMemoryOutcomeSink` (class) | accumulator | | UNUSED |
| `setOutcomeSink` / `hasOutcomeSink` / `recordRetrospectiveOutcome` / `_resetOutcomeSink` | wiring | | UNUSED |
| `KernelIdentity` / `createKernelIdentity(id, version)` | SA6 §3.5 seam | `{id, version, attest()}` placeholder for v0.2 signing | UNUSED |
| `RuntimeContext` (per-tenant container) | `{id, killSwitch, metrics, learning, shadowTelemetry, enforceConfig, kernelIdentity?, outcomeSink?}` | Per-tenant slots; back-compat to module-level singletons | UNUSED |
| `createRuntimeContext(options?)` / `getDefaultRuntimeContext()` / `_resetDefaultRuntimeContext()` | wiring | | UNUSED |
| `CreateRuntimeContextOptions` (`id, metrics, learning, shadowTelemetry, envSeed, killSwitchEnvVar, shadowEnvVar, enforceEnvVar`) | | | UNUSED |
| `KillSwitchControl` / `KillSwitchState` / `MetricsSinkSlot` / `LearningSinkSlot` / `ShadowTelemetrySinkSlot` | slot types | | UNUSED |
| `setKillSwitch(active, reason)` / `isKilled(env?)` / `getKillSwitchState(env?)` / `_resetKillSwitch` | global kill switch (module-level) | | UNUSED |
| `validateEnforceConfig(knownIntents, env?, warn?)` | `→ {unknownShadow[], unknownEnforce[]}` | T7 typo guard for `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE`. Console-warns and emits `enforce_config_typo` sink failure on unknown tokens. Wildcard `*` honored. **Signature exactly: `(ReadonlySet<string>, NodeJS.ProcessEnv?, (msg: string) => void)`** | UNUSED |
| `isShadowed(intentKind, env?)` / `isEnforced(intentKind, env?)` / `_resetEnforceConfig()` | per-intent enforce toggles | | UNUSED |
| `EnforceConfigValidation` | `{unknownShadow, unknownEnforce}` | | UNUSED |
| `adjudicateWithShadow({envelope, state, policy, legacy})` | `→ ShadowResult` | Runs adjudicate alongside a legacy boolean path; classifies divergence | UNUSED |
| `classifyDivergence(legacy, adj)` | `→ DivergenceClass` (`NONE\|BASIS_ONLY\|DECISION_KIND\|PAYLOAD_REWRITE`) | | UNUSED |
| `ShadowTelemetrySink` / `setShadowTelemetrySink` / `_resetShadowTelemetrySink` / `legacyDecisionAsKernelDecision` | | | UNUSED |
| `RateLimitStore` / `checkRateLimit(args)` / `createRateLimitGuard(options)` / `createInMemoryRateLimitStore()` | rate-limit primitives | INCR + window + rollback hook; T5 fix for poisoned-counter attack | UNUSED |
| `CheckRateLimitArgs` / `RateLimitGuardOptions` / `RateLimitResult` | | | UNUSED |

### llm (`@adjudicate/core/llm`)

| Capability | Signature | Purpose | Status |
|---|---|---|---|
| `Plan` | `{visibleReadTools[], allowedIntents[]}` | Output of CapabilityPlanner | USED |
| `CapabilityPlanner<S, C>` | `{plan(state, context): Plan}` | Security-sensitive layer | USED |
| `staticPlanner(plan)` | factory | Test-time / hand-written plan | UNUSED |
| `PromptRenderer<S, C>` / `RenderedPrompt` / `SupervisorModifiers` / `ToolSchema` | prompt-rendering types | | USED (partial) |
| `ToolClassification<R, M>` | `{READ_ONLY: Set, MUTATING: Set}` | Type-level READ vs MUTATING partition | USED |
| `isReadOnly(c, name)` / `isMutating(c, name)` / `filterReadOnly(c, tools)` | runtime helpers | | USED (partial) |
| `PlanConformanceError` / `assertPlanReadOnly(plan, classification)` / `assertPlanSubsetOfPack(plan, pack)` / `safePlan(planner, classification, pack?)` | runtime guard against mutating-tool leak + allowed-intent leak | "LLM cannot see mutations" enforced | UNUSED |

---

## @adjudicate/runtime

| Capability | Signature | Purpose | Status |
|---|---|---|---|
| `DEADLINE_HIT` | `unique symbol` | Sentinel for `Promise.race` against deadline | USED |
| `deadlinePromise(signal)` | `(AbortSignal) → Promise<typeof DEADLINE_HIT>` | Race-friendly deadline | USED |
| `parkDeferredIntent(args)` | `→ {parked: true, count} \| {parked: false, reason: "quota_exceeded", observed, limit}` | Park-side of DEFER with per-session quota (INCR + EXPIRE + DECR rollback or Lua `evalIncrCheck`); calls `recordResourceLimit` on quota exceed | USED |
| `DEFAULT_DEFER_QUOTA_PER_SESSION` | `16` | | USED |
| `deferParkKey(sessionId)` / `deferCounterKey(sessionId)` | key builders | | USED |
| `decrementDeferCounter(redis, rk, sessionId)` | counter helper | | USED |
| `ParkRedis` / `ParkLogger` / `ParkDeferredIntentArgs` / `ParkDeferredIntentResult` / `CounterRedis` | types | | USED |
| `resumeDeferredIntent(args)` | `→ {resumed: true, intentHash, parked} \| {resumed: false, reason, ...}` | Idempotent resume via deferResumeHash + SET NX; hash-verify policy `strict\|warn\|off`; cycle-cap; per-session counter DECR | USED |
| `DEFAULT_MAX_RESUME_CYCLES` | `3` | Bounds DEFER → resume → re-DEFER oscillation | USED |
| `DEFER_PENDING_TTL_GRACE_SECONDS` | `14 * 24 * 60 * 60` | | USED |
| `deferResumeHash(intentHash, signal)` | `→ sha256(intentHash + ":" + signal)` | Idempotency key | USED |
| `verifyParkedEnvelopeHash(parked)` | `→ ParkVerificationResult` | T-005 re-derive intentHash and check byte-equality | USED |
| `DeferRedis` / `DeferLogger` / `DeferResumeResult` / `ParkedEnvelope` / `ParkVerificationResult` / `ResumeDeferredIntentArgs` | types | | USED |

---

## @adjudicate/audit

### Sinks

| Capability | Signature | Purpose | Status |
|---|---|---|---|
| `AuditSink` | re-export from core | | USED |
| `AuditSinkError` (class) | aggregated failure with `failures[]` | | UNUSED |
| `multiSink(...sinks)` | strict fan-out (T3 default — throws if any inner failed; all are still awaited) | governance-grade | USED |
| `multiSinkStrict(...sinks)` | alias for `multiSink` | | UNUSED |
| `multiSinkLossy(...sinks)` | lossy fan-out (record failure via `recordSinkFailure`, don't throw) | for non-critical paths | USED |
| `bufferedSink({inner, capacity, onOverflow?})` | in-memory bounded replay queue with FIFO drain on next emit; lossy on overflow | for tests + lightweight | UNUSED |
| `persistentBufferedSink({inner, storage, capacity, onOverflow, onSpill?})` | spills to durable storage on overflow / failure; survives restart | **governance-grade** | UNUSED |
| `createInMemorySpillStorage()` / `PersistentSpillStorage` / `PersistentBufferedSpillReason` (`capacity\|failure\|drain-failure`) / `PersistentBufferedSinkOptions` | | | UNUSED |
| `createConsoleSink({prefix?, log?})` | dev sink emitting one-line structured JSON per record | | USED |
| `ConsoleSinkOptions` | | | USED |
| `createNatsSink({publisher, subject?, failureThreshold?, onFailure?})` | publishes per record; circuit-breaker (closed → open → half-open) with T3 close on success | streaming governance | USED |
| `NatsPublisher` / `NatsSinkOptions` / `NatsSinkError` | | | USED |

### Ledger

| Capability | Signature | Purpose | Status |
|---|---|---|---|
| `createRedisLedger({client, keyFor, ttlSeconds?})` | SET NX + EX + GET semantics; default TTL 14d | Production ledger | USED |
| `createMemoryLedger()` | reference in-process ledger | Tests + quickstart | USED |
| `RedisLedgerClient` / `CreateRedisLedgerOptions` | | | USED |

### Replay & integrity

| Capability | Signature | Purpose | Status |
|---|---|---|---|
| `replay(records, adjudicator)` | `→ ReplayReport {total, matched, mismatches}` | Re-runs adjudication, classifies divergences | UNUSED |
| `Adjudicator` / `ReplayReport` | | | UNUSED |
| `replayWithIntegrity(records, adjudicator)` | `→ ReplayIntegrityReport {total, matched, mismatches, integrityFailures, preV4Records}` | Replay + tamper-detect (auditHash + intentHash) | UNUSED |
| `isReplayIntegrityClean(report)` / `IntegrityFailure` / `ReplayIntegrityReport` | | | UNUSED |
| `explainReplayReport(report, opts?)` | `→ string` | Operator-readable narration; formats `summary\|operator\|ci-line` | UNUSED |
| `classifyReplayDrift(samples, thresholds?)` | turns sequence of ReplayReports into closed-vocab class (`stable\|improving\|regressing\|flapping\|insufficient_data`) | trend over time | UNUSED |
| `DEFAULT_DRIFT_THRESHOLDS` / `ReplayDriftClass` / `ReplayDriftReport` / `ReplayDriftSample` / `ReplayDriftThresholds` / `ReplayDriftPoint` | | | UNUSED |
| `buildSupersessionChains(records)` / `explainSupersessionChainReport(report)` | walks `supersedes` links to reconstruct chains | "what happened to this intent over time" | UNUSED |
| `SupersessionChain` / `SupersessionChainNode` / `SupersessionChainReport` | | | UNUSED |
| `analyzeKillSwitchTimeline(events, options?)` | summarises kill-switch transitions; `KillSwitchStabilityClass` = `stable\|single_incident\|recurring_incidents\|storm` | | UNUSED |
| `KillSwitchEvent` / `KillSwitchEventKind` / `KillSwitchEventSource` / `KillSwitchTimelineReport` / `KillSwitchTimelineOptions` / `KILL_SWITCH_EVENT_SOURCES` | | | UNUSED |
| `classify` (re-exported from core) | | | UNUSED |

### Cross-replica coordination

| Capability | Signature | Purpose | Status |
|---|---|---|---|
| `startDistributedKillSwitch({redis, key, pollMs?, context?, logger?})` | `→ {stop, trip, clear}` | Polls Redis on `pollMs` cadence; applies remote kill state to RuntimeContext | UNUSED |
| `DistributedKillSwitchHandle` / `DistributedKillSwitchOptions` | | | UNUSED |
| `startDistributedKillSwitchPubSub(opts)` | adds Redis pub/sub on top of poll (sub-100 ms propagation when subscribed) | | UNUSED |
| `DistributedKillSwitchPubSubHandle` / `DistributedKillSwitchPubSubOptions` / `RedisPubSubClient` | | | UNUSED |
| `createInMemoryAuditEventBus()` / `createRedisAuditEventBus(opts)` | real-time fan-out separate from durable sink; lossy by design | for operator console | UNUSED |
| `bridgeAuditSinkToBus(sink, bus, opts?)` | wires durable-then-bus emission | | UNUSED |
| `AuditEventBus` / `AuditEventHandler` / `BridgeAuditSinkToBusOptions` / `BridgeBusFailure` / `RedisAuditEventBusOptions` | | | UNUSED |
| `isLedgerEnabled(env?)` / `isLedgerEnforced(env?)` | feature flag for `IBX_LEDGER_ENABLED` / `IBX_LEDGER_ENFORCE` | | UNUSED |
| `createRedisEmergencyStateStore(opts)` | SDK-shape EmergencyStateStore on the same Redis key the kill-switch poller reads | | UNUSED |
| `CreateRedisEmergencyStateStoreOptions` / `EmergencyHistoryLog` | | | UNUSED |

### Operational snapshots (post-v1)

| Capability | Signature | Purpose | Status |
|---|---|---|---|
| `buildOperationalSnapshot(input)` / `buildIncidentBundle(input)` / `buildOperatorHandoff(input)` | pure, deterministic, JSON-stable bundles | Triage / handoff / forensics | UNUSED |
| `verifyOperationalSnapshot` / `verifyIncidentBundle` / `verifyOperatorHandoff` | hash-verifiers | | UNUSED |
| `OPERATIONAL_SNAPSHOT_SCHEMA_VERSION` (= 1) and the full type family (`OperationalSnapshot`, `IncidentBundle`, `OperatorHandoff`, `DeploymentIdentity`, `KillSwitchSnapshot`, `LedgerStatsSummary`, `ReplaySnapshot`, `SinkHealthStatus`, `SinkHealthSummary`, `DeploymentMode`, …) | | | UNUSED |

---

## @adjudicate/anthropic

| Capability | Signature | Purpose | Status |
|---|---|---|---|
| `createAdjudicatedAgent(options)` | `→ AdjudicatedAgent<K, P, S, C>` | Thin shim — builds an Anthropic `ProviderBridge<MessageParam[]>` and hands it to `adapter-core`'s loop. Wires pack, renderer, deferStore (ParkRedis + DeferRedis), confirmationStore, auditSink, ledger, runtimeContext, executor, rk, deriveNonce, log, verifyParkedHash. | UNUSED |
| `createAnthropicBridge(opts)` | factory for advanced adopters | | UNUSED |
| `createAnthropicPromptRenderer(opts?)` / `DEFAULT_ADJUDICATED_SYSTEM_PROMPT` | Anthropic-tuned system prompt + tool-name translation | | UNUSED |
| Re-exports: `AdjudicatedAgent`, `AdjudicatedAgentOptions`, `AdjudicatedAgentSendInput`, `AdapterContext`, `AdopterExecutor`, `AgentEvent`, `AgentLogger`, `AgentOutcome`, `AgentTurnResult`, `AnthropicHistory`, `ConfirmAgentArgs`, `ConfirmationStore`, `PendingConfirmation`, `ResumeAgentArgs`, `Taint`, `ToolResultBlock`, `buildEnvelopeFromToolUse`, `classifyIncomingToolUse`, `intentKindToApiName`, `createInMemoryConfirmationStore`, `createInMemoryDeferStore`, `createMemoryLedger`, `translateDecision`, `AdapterError`, `AdapterErrorCode` | from adapter-core | | UNUSED |

The `AdjudicatedAgent`'s `send(input)` / `confirm(args)` / `resume(args)` cycle preserves these invariants (per adapter-core docs): every envelope crosses `adjudicateAndAudit()`, first non-continue Decision wins per assistant turn, REWRITE executes the rewritten envelope (never the original), DEFER persists full envelope fields so resume can re-derive intentHash. Tool-use classification gates LLM-proposed tools against the Plan; out-of-plan tool names get a deterministic `tool_result` refusal without crossing the kernel.

## @adjudicate/openai

| Capability | Signature | Purpose | Status |
|---|---|---|---|
| `createAdjudicatedAgent(options)` | same shim against OpenAI Chat Completions | | UNUSED |
| `createOpenAIBridge(opts)` / `OpenAIBridgeOptions` | | | UNUSED |
| `createOpenAIPromptRenderer(opts?)` / `DEFAULT_OPENAI_ADJUDICATED_SYSTEM_PROMPT` / `OpenAIPromptRendererOptions` | OpenAI-tuned prompt + dotted → underscored tool-name translation | | UNUSED |
| Re-exports identical to `@adjudicate/anthropic` (sans Anthropic-specific types) | | | UNUSED |

## @adjudicate/adapter-core (the engine under both Anthropic + OpenAI)

| Capability | Signature | Purpose | Status |
|---|---|---|---|
| `createAdjudicatedAgent(options)` | the loop everything funnels through | Tool-use loop + bridge orchestration + defer/confirm + audit + ledger + REWRITE + hash-verify | UNUSED |
| `AdjudicatedAgentOptions` / `AdjudicatedAgent` / `AdopterExecutor` / `AgentEvent` / `AgentLogger` / `AgentOutcome` / `AgentTurnResult` / `AssistantTurn` / `ConfirmArgs` / `ProviderBridge` / `ProviderRequest` / `ResumeArgs` / `SendInput` / `ToolResultBlock` / `ToolUseRequest` | full type surface | | UNUSED |
| `buildEnvelopeFromToolUse(args)` / `BuildEnvelopeFromToolUseArgs` | LLM tool-use → IntentEnvelope | | UNUSED |
| `classifyIncomingToolUse(...)` / `ToolUseClassification` | gates LLM tools against the Plan | | UNUSED |
| `intentKindToApiName(kind)` | dotted → underscored normalization | | UNUSED |
| `makeOutOfPlanToolResult(...)` / `translateDecision(decision, ctx)` / `DecisionTranslation` / `DecisionTranslationContext` / `LoopAction` | per-decision translator | | UNUSED |
| `createInMemoryConfirmationStore()` / `createInMemoryDeferStore()` / `createRedisConfirmationStore(opts)` | persistence shims | | UNUSED |
| `ConfirmationStore` / `DeferRedis` / `ParkRedis` / `PendingConfirmation` / `ConfirmationRedisClient` / `CreateRedisConfirmationStoreOptions` | | | UNUSED |
| `noopTraceSink()` / `createInMemoryTraceSink()` / `TraceSink` / `AdapterTraceEvent` / `AdapterTracePhase` / `AdapterPauseReason` | adapter-level tracing | | UNUSED |
| `AdapterError` (class) / `AdapterErrorCode` (enum) | typed error taxonomy | | UNUSED |
| `createMemoryLedger` (re-export from audit) | | | UNUSED |

---

## @adjudicate/primitives

| Capability | Signature | Purpose | Status |
|---|---|---|---|
| `createThresholdGuard({matches, extract, threshold, comparator?, onCross})` | `Guard<K,P,S>` | "match → extract numeric → compare → onCross Decision". Comparator `>=\|<=\|>\|<`. Attaches `{kind: "threshold", threshold, comparator}` metadata. | UNUSED |
| `ThresholdComparator` / `ThresholdGuardOptions` | | | UNUSED |
| `createStateDeferGuard({matches, signal, timeoutMs, basis})` | DEFER on a wire signal when an intent kind matches | `{kind: "state_defer", signal, timeoutMs}` metadata | UNUSED |
| `StateDeferGuardOptions` | | | UNUSED |
| `createRewriteGuard({matches, extract, cap, mutateField, reason, basis?})` | REWRITE-clamp one numeric payload field to a cap | `{kind: "rewrite", mutatesPayloadFields: [field]}` metadata. Static cap or `(state, env) => number`. | UNUSED |
| `RewriteGuardOptions` | | | UNUSED |
| `createConfirmGuard({matches, extract, threshold, comparator?, prompt, basis?})` | REQUEST_CONFIRMATION when threshold crossed; thin alias over `createThresholdGuard` | | UNUSED |
| `createEscalateGuard({matches, extract, threshold, comparator?, to, reason, basis?})` | ESCALATE on threshold; thin alias | | UNUSED |
| `createIdempotencyGuard({matches, extractKey, hasBeenSeen, onReplay})` | Domain-level idempotency (not framework intentHash dedup) | | UNUSED |
| `createSystemTaintPolicy({systemOnlyKinds, userMinimum?, systemMinimum?})` | `→ TaintPolicy` | Allowlist of TRUSTED-required kinds, UNTRUSTED default for the rest | UNUSED |
| `SystemTaintPolicyOptions` | | | UNUSED |

---

## Policy packs

### pack-payments-pix (USED)

| Capability | Purpose | Status |
|---|---|---|
| `paymentsPixPack` (`PackV0<PixIntentKind, ...>`) | Lighthouse Pack covering all 6 Decision outcomes | UNUSED (we use the factory pattern instead) |
| `PixIntentKind` (`pix.charge.{create\|confirm\|refund}`) | wire contract | UNUSED |
| `PIX_CONFIRMATION_SIGNAL` (`= "payment.confirmed"`) — matches our NATS subject | DEFER signal name | USED (de facto) |
| `PIX_CONFIRMED_STATUSES` / `PIX_DEFAULT_DEFER_TIMEOUT_MS` (15 min) / `PIX_DEFAULT_EXPIRY_SECONDS` (1 h) | constants | USED (partial) |
| `pixTaintPolicy` | `createSystemTaintPolicy({systemOnlyKinds: ["pix.charge.confirm"]})` | UNUSED |
| `createPixPendingDeferGuard({readPaymentMethod, readPaymentStatus, matchesIntent?, pixMethodLabel?, confirmedStatuses?, signal?, timeoutMs?})` | Factory for the "DEFER when PIX is pending" pattern — composes against your own intent kind | **USED** by ibatexas's `order-policy-bundle.ts` |
| `PixPendingDeferGuardOptions` | | USED |
| `pixPolicyBundle` | full PolicyBundle (state + business guards) | UNUSED |
| `pixCapabilityPlanner` / `PIX_TOOLS` | tool partition | UNUSED |
| `ESCALATE_REFUND_THRESHOLD_CENTAVOS` (= 100 000) / `CONFIRM_REFUND_THRESHOLD_CENTAVOS` (= 50 000) | thresholds | UNUSED |
| `inMemoryPixHandlers` | side-effect handlers | UNUSED |
| `rehydratePixState(raw)` | Map rehydration for scenario JSON | UNUSED |
| Refusal helpers: `refuseChargeAlreadyRefunded`, `refuseChargeExpired`, `refuseChargeFailed`, `refuseChargeNotConfirmed`, `refuseChargeNotFound`, `refuseConfirmRequiresWebhook`, `refuseInvalidAmount`, `refuseInvalidStateForConfirm`, `refuseRateLimitExceeded` | | UNUSED |

### pack-identity-kyc (UNUSED)

| Capability | Purpose |
|---|---|
| `IdentityKycPack` | 3-intent state machine demonstrating async DEFER + ESCALATE outcomes |
| `IdentityKycIntentKind` (`kyc.start\|kyc.document.upload\|kyc.vendor.callback`) | wire contract |
| Lifecycle: INIT → kyc.start → DEFER on `kyc.documents.uploaded`; DOCS_REQUIRED → kyc.document.upload → DEFER on `kyc.vendor.completed`; VENDOR_PENDING → kyc.vendor.callback (TRUSTED) → EXECUTE \| ESCALATE (AML flag) \| REFUSE (score < 50) |
| `KYC_DOCUMENTS_UPLOADED_SIGNAL` / `KYC_VENDOR_COMPLETED_SIGNAL` | DEFER signals |
| `KYC_REFUSE_THRESHOLD` (50) / `KYC_EXECUTE_THRESHOLD` (90) / `KYC_DOCUMENT_UPLOAD_TIMEOUT_MS` (24 h) / `KYC_VENDOR_TIMEOUT_MS` (30 min) | thresholds |
| Domain types: `Document`, `DocumentStatus`, `DocumentType`, `AmlStatus`, `KycSessionStatus`, `VendorVerificationResult`, `KycSession`, `IdentityKycState`, `IdentityKycPayload` (discriminated union), `KycStartPayload`, `KycDocumentUploadPayload`, `KycVendorCallbackPayload` |
| `rehydrateKycState(raw)` | Map rehydration |

### pack-deployments-approval (UNUSED)

| Capability | Purpose |
|---|---|
| `deploymentsApprovalPack` | Lights up ESCALATE (prod deploy without approval), REQUEST_CONFIRMATION (rollback), REWRITE (clamp ramp%) |
| `DeploymentIntentKind` (`deployment.approval.{request\|resolve}\|deployment.rollback.execute`) | |
| `MAX_PRODUCTION_RAMP_PERCENT` (= 25) / `HIGH_RAMP_THRESHOLD` (= 50) / `DEPLOYMENT_DEFAULT_DEFER_TIMEOUT_MS` (5 min) / `DEPLOYMENT_CI_GREEN_SIGNAL` (= "ci.green") | constants |
| `approvalKey(service, env, sha)` | state key builder |
| `deploymentTaintPolicy` | `createSystemTaintPolicy({systemOnlyKinds: ["deployment.approval.resolve"]})` |
| `deploymentPolicyBundle` / `deploymentCapabilityPlanner` / `DEPLOYMENT_TOOLS` | |
| `rehydrateDeploymentState(raw)` | |

No fourth pack present at v1.0-rc (only PIX, KYC, Deployments).

---

## @adjudicate/cli (UNUSED entirely)

Binary: `adjudicate`. Commands (all unused by ibatexas today):

| Command | Purpose |
|---|---|
| `pack init <name> [--target] [--template basic\|...]` | Scaffold a new Pack with the canonical layout from a template (`pack-init.ts` / `TEMPLATE_NAMES`) |
| `pack lint [path]` | Validate a Pack against kernel conformance (`runPackLint`) |
| `pack verify [path] [--expect <hex>] [--public-key] [--signature] [--policy none\|best_effort\|require_fingerprint\|require_signature]` | Pack trust posture: fingerprint + optional signature + manifest |
| `simulate --pack --scenario\|--scenarios\|--intent+--state [--format text\|json]` | Run envelopes against a Pack's policy (single or diff). Diff mode compares against expected.kind, exits 2 on mismatch. |
| `replay --pack --records <jsonl> [--format]` | Re-adjudicate stored AuditRecords; reports divergence |
| `analyze --pack [--format text\|json\|sarif] [--strict]` | Tier-1 static analyzers (basis-code-consistency, default-polarity, missing-metadata, rewrite-scope, signal-consistency, taint-policy) |
| `repl --pack` | Interactive intent → decision shell |
| `visualize --pack [--output]` | Render PolicyBundle as standalone HTML SVG |
| `scenarios generate --pack --output [--count] [--seed]` | Generate JSON fixtures from intents (seeded LCG) |
| `export --source [--format json\|csv\|parquet] [--output] [--since] [--until]` | Export audit JSONL/JSON to other formats |
| `reap [--url] [--dry-run] [--format]` | Scan Redis for stale `defer:pending:*` keys; report TTL status |
| `dev [--stop] [--logs]` | Spin up local Docker Compose harness (Redis + Postgres) |
| `doctor` | Verify local environment for adjudicate development |

The CLI's programmatic surface (`@adjudicate/cli` package exports) is identical to the bin entry, plus `loadScenario`, `loadIntentAndState`, `loadPackFromModule`, `renderTemplate`, `detectWorkspace`, `listScenarios`, `runDiff`, `renderDiffText`, `renderDiffJson`, `computeExitCode`, `renderSimulation` for adopters wiring scripts.

---

## Console & web apps

### apps/console (Next.js operator console — UNUSED)

Pages: `/` (Audit Explorer with live-tail overlay), `/dashboard`, `/governance`, `/control`, `/decisions/[intentHash]`, `/decisions/[intentHash]/lineage`.

Component groups:
- **decision/** — `AdapterTracePanel`, `AuditMetadata`, `BasisFlatSet`, `DecisionBadge`, `DecisionTrace`, `DecisionTraceHeader`, `IntentEnvelopeView`, `IntentHashChip`, `LineageGraph`, `PlanSnapshotPanel`, `PolicyResolutionList`, `RefusalCard`, `Section`, `SupersessionChain`, `WhyDecisionPanel`, `WhyNotPanel`.
- **dashboard/** — `AccuracyPanel`, `DriftPanel`, `OutcomeChart`, `RangePicker`, `SLOPanel`, `TopRefusals`.
- **governance/** — `GuardFireBars`, `PolicyBundleView`.
- **control/** — `EmergencyDialog`, `EmergencyHistoryList`, `EmergencyStatusBadge`, `KillSwitchPanel` (operator-driven kill-switch UI).
- **replay/** — `ReplayButton`, `ReplayDialog`, `ReplayDiffView` (operator-driven replay against a Pack).
- **shell/** — `TopBar`, `Sidebar`, `LiveTailContext`, `LiveTailToggle`, `FailureBanners`, `ConsoleShell`.

Hooks: `useAuditQuery`, `useLiveTail`, `useDecisionByHash`, `useDecisionAccuracy`, `useDLQStatus`, `useEmergencyHistory`, `useEmergencyState`, `useGuardFireStats`, `useLineage`, `useOutcomeDistribution`, `usePolicyDescriptor`, `useUpdateEmergencyState`, `useUrlFilters`.

Backend deps: `@adjudicate/admin-sdk`, `@adjudicate/audit`, `@adjudicate/audit-postgres`, `@adjudicate/core`, plus all three packs. tRPC client + tanstack query.

### apps/web (Marketing — UNUSED)

Marketing homepage + interactive playground. Sections cover Architecture, Comparisons, Introspection, Blog. Hosts Remotion-generated hero / explainer videos. Not relevant to integration.

---

## bench/ (UNUSED)

Microbenchmarks via vitest-bench:
- `kernel.bench.ts` — `adjudicate`, `adjudicateWithTrace` against PIX EXECUTE / REWRITE / REFUSE / DEFER scenarios.
- `audit.bench.ts` — `adjudicateAndAudit` with in-memory ledger + noop sink.

Scale harnesses (CLI driven via `tsx src/scale/run.ts`):
- `runAuditEventBusScale` — soak the audit event bus.
- `runKillSwitchScale` — propagation timing across replicas (with fake Redis pub/sub).
- `createFakePubSub`, `createFakeRedis`, `createRng` — deterministic test transports.

---

## Other packages (UNUSED)

| Package | Highlights |
|---|---|
| `@adjudicate/conformance` | `runConformance(pack)` — reframes the kernel's invariant suite (taint protection, replay safety, intent-hash determinism, basis-vocabulary purity, guard ordering, default polarity) as one-shot deterministic check. `DEFAULT_CHECKS`. `crossCheckPackVsManifest`, `validatePackManifest`. Pack health + trust primitives. |
| `@adjudicate/analyze` | Static analyzers — Tier 1: `basisCodeConsistencyAnalyzer`, `defaultPolarityAnalyzer`, `missingMetadataAnalyzer`, `rewriteScopeAnalyzer`, `signalConsistencyAnalyzer`, `taintPolicyAnalyzer`; Tier 2 (AST): `rewriteScopeAstAnalyzer`, `loadSourceFiles`. `analyzePolicy`, `renderJson\|Sarif\|Text`. |
| `@adjudicate/admin-sdk` | tRPC + Zod schemas for everything (envelope, decision, basis, refusal, audit, supersession, plan, emergency, governance event, outcome bucket, distribution, guard-fire, policy descriptor, replay). Handlers: `createAuditQueryHandler`, `createEmergencyHandler`, `createOutcomeDistributionHandler`, `createGuardFireStatsHandler`. Stores: `createInMemoryAuditStore`, `createInMemoryEmergencyStateStore`. `extractActor`. `ReplayError` / `ReplayInvoker`. Powers the operator console. |
| `@adjudicate/audit-postgres` | `createPostgresSink` — durable AuditRecord write w/ monthly partitioning. `partitionMonthOf`, `recordToRow`, `IntentAuditRow`. `readAuditWindow`, `rowToRecord`. `legacyV1ToV2` for pre-T8 v1 audit records. SDK-shape readers: `createPostgresAuditStore`, `encodeCursor`/`decodeCursor`, `buildWhereClauses`. `governanceEventToRow`/`rowToGovernanceEvent`. Outcomes store + guard-stats store. |
| `@adjudicate/observability` | OTLP exporter interface. `createOtlpMetricsSink`/`createOtlpLearningSink`/`createOtlpAuditSpanExporter` adapting the kernel's three sink contracts. `InMemoryExporter` for tests. Stable `adjudicate.*` semantic-conventions (`semconv.ts`). `ecosystem-telemetry`. |
| `@adjudicate/migrate` | Codemod runner (ts-morph-driven). v1.0-rc ships `nameGuardToWithMetadata`. Idempotent; skips ambiguous cases. |
| `@adjudicate/locales-pt-BR` | `portugueseRefusalMessages: RefusalMessages` — Brazilian Portuguese translations for kernel-emitted refusal codes. **Use with `localizeDecision(decision, portugueseRefusalMessages)` from core at presentation time. We are Brazilian; this is a one-line adoption away.** |

---

## Capabilities ibatexas should adopt (prioritised)

### Tier 0 — Immediate, low effort, high payoff

1. **`@adjudicate/locales-pt-BR.portugueseRefusalMessages`** + **`localizeDecision`** — one-line change at the presentation boundary so all kernel-emitted refusals are localized. We're a pt-BR product. (CLAUDE.md hard rule #4.)
2. **`validateEnforceConfig(knownIntents, env)`** — catches typos in `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` env vars at boot. Silent miss is the exact "intent silently left on legacy path" failure mode we're rolling out against.
3. **`assertPackConformance` + `withBasisAudit` + `installPack`** — once we adopt a Pack (even our own), wrap it with these three calls. Runtime drift recording for free.
4. **`buildSupersessionChains` + `explainSupersessionChainReport`** — once we record supersedes (DEFER resumes, REWRITE executes, confirmation resolutions), we get "what happened to this intent over time" without writing the join ourselves.

### Tier 1 — Strong fit for current ibatexas pain

5. **`@adjudicate/audit-postgres.createPostgresSink`** — Postgres is already in our stack. This drops governance into a durable substrate aligned with `multiSink(consoleSink, natsSink, postgresSink)`. Supports replay reading via `readAuditWindow`.
6. **`@adjudicate/audit-postgres.legacyV1ToV2`** — for our pre-T8 audit rows. Synthesises a nonce from v1 `createdAt` so historical replay reproduces the same intentHash.
7. **`persistentBufferedSink`** — `bufferedSink` is lossy on overflow. `persistentBufferedSink` spills to durable storage and survives process restart. Governance-grade.
8. **`replayWithIntegrity` + `explainReplayReport`** — replay + tamper-detect in one pass. Operator-readable narration (`summary\|operator\|ci-line` formats). CI gate candidate.
9. **`classifyReplayDrift`** — trend over time (`stable\|improving\|regressing\|flapping`); fits a daily/weekly drift dashboard.
10. **`createDistributedKillSwitch` + `createDistributedKillSwitchPubSub`** — once we go multi-replica, the in-process kill switch only revokes authority on one box. Two-second polling fallback + sub-100 ms pub/sub.

### Tier 2 — When we adopt the LLM agent loop

11. **`@adjudicate/anthropic.createAdjudicatedAgent`** — replaces our hand-rolled loop. Carries the load-bearing invariants (REWRITE executes rewritten envelope, DEFER persists full envelope fields for hash-verify resume, every envelope crosses `adjudicateAndAudit()`).
12. **`@adjudicate/adapter-core.AdopterExecutor`** + the `AgentEvent` stream — gives us structured `tool_use_proposed`, `decision`, `tool_result`, `assistant_message`, `error` events for our chat surface and admin console.
13. **`safePlan(planner, classification, pack)`** — runtime guard against mutating-tool leak + allowed-intent leak. Belongs at every planner registration.

### Tier 3 — Authoring + tooling

14. **`@adjudicate/cli simulate --scenarios <dir>`** — adds a CI gate that runs every scenario fixture against the live policy and fails on `expected.kind` mismatch. We can add our own scenario corpus alongside.
15. **`@adjudicate/cli replay --records <jsonl>`** — local triage tool against any production audit window we've exported.
16. **`@adjudicate/cli analyze --pack`** — Tier-1 static analysis caught at build time (default polarity, missing metadata, REWRITE-scope, signal consistency, basis-code consistency). Pair with `--format sarif` for CI.
17. **`@adjudicate/conformance.runConformance(pack)`** — property-style proofs the kernel's invariant suite holds against our Pack.
18. **`@adjudicate/observability.createOtlpMetricsSink/Learning/AuditSpan`** — once we move to OTLP (our planned Tempo/Mimir integration), one place to wire all three signals.
19. **`@adjudicate/migrate runNameGuardToWithMetadata`** — codemod runner pattern we can extend for future deprecations.

### Tier 4 — Console
20. **Embed or fork `apps/console`** — Audit Explorer / decision-detail / lineage / governance / control panels deliver immediate operator UX without us building the equivalents. Built on the same `@adjudicate/admin-sdk` schemas; could mount under `apps/console/src/app` of our monorepo or run side-by-side.

### Packs ibatexas should write (first-party)

The framework is explicit that Packs are the unit of composability; the existing three (PIX, KYC, Deployments) are lighthouse demos for the Decision algebra. ibatexas should ship its own first-party Packs:

- **`@ibatexas/pack-reservations`** — appointment / booking lifecycle. Intents: `reservation.create`, `reservation.confirm`, `reservation.cancel`, `reservation.reschedule`, `reservation.no_show`. DEFER on `payment.confirmed` and `slot.released`; REQUEST_CONFIRMATION for destructive cancels within N hours of the slot; ESCALATE no-shows over a configurable rate.
- **`@ibatexas/pack-orders`** — checkout / order lifecycle, the closest analog to PIX in our world. Composes `createPixPendingDeferGuard` we already use. Adds `createConfirmGuard` / `createEscalateGuard` thresholds for large-ticket orders, REWRITE clamp for quantities exceeding stock.
- **`@ibatexas/pack-whatsapp`** — channel-level intents. `whatsapp.message.send`, `whatsapp.template.send`, `whatsapp.session.handover`. Threading + 24-hour-window business rules naturally fit the kernel's state guards.
- **`@ibatexas/pack-customer-onboarding`** — direct counterpart to `pack-identity-kyc`. Strong fit if we need KYC compliance for new merchants.

Each first-party Pack should follow the `pack-payments-pix` layout:
`types.ts` (intents, payloads, state, taint), `policies.ts` (PolicyBundle composed from `@adjudicate/primitives` factories), `capabilities.ts` (CapabilityPlanner + `ToolClassification`), `handlers.ts` (optional side-effect handlers), `refusals.ts` (typed refusal helpers), `index.ts` (`PackV0` satisfies + rehydrator).

### Pack fits for existing use cases

- **`pack-identity-kyc`** — strong fit if/when we need merchant identity verification (Brazilian fintech / payments side of ibatexas). Its async DEFER-then-callback shape models exactly our "we sent the documents; the vendor will respond async" flow.
- **`pack-deployments-approval`** — generic confirmation pattern. Even if we don't ship literal deploys through it, the (REQUEST_CONFIRMATION → confirmation receipt → EXECUTE substituted by kernel) flow is reusable for any destructive operator action we surface (canceling a paid reservation, bulk-deleting customer data, refunding above a threshold).

---

## Migration sequencing recommendation

Phase 1 (immediate, kernel-only):
- `validateEnforceConfig` at boot.
- `localizeDecision` + `portugueseRefusalMessages` at presentation.
- `withBasisAudit` wrapping our current Pack-like policy bundles.

Phase 2 (durable governance):
- Adopt `createPostgresSink` in `multiSink(console, nats, postgres)`.
- Wire `persistentBufferedSink` around the outer sink.
- Bring up `apps/console` (or fork into our admin app) reading from Postgres.

Phase 3 (authoring discipline):
- `runConformance` + `analyze` in CI on every policy bundle.
- Write `@ibatexas/pack-orders` as the first first-party Pack; migrate `order-policy-bundle.ts` into it.
- Adopt `safePlan` everywhere.

Phase 4 (adapter loop):
- Replace our LLM loop with `@adjudicate/anthropic.createAdjudicatedAgent` once we are confident in the adapter-core invariants.
