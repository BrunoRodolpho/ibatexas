> ⚠️ **SUPERSEDED on 2026-05-24 — DOWNGRADED from load-bearing.** The three-concentric-rollback-layers model below (per-intent env-var rollback, per-process kill switch, cluster-wide distributed kill switch via Redis pub/sub) describes machinery that was **deleted** by the IBX-IGE v3.0 always-on cutover (`f3bea43`). Per `CLAUDE.md` rule #9: "the kernel is always authoritative — no env-var gating, no shadow mode, no kill switch." For current operator surface (which is intentionally smaller — fail-closed audit + ledger; no rollback levers besides redeploy), see [`docs/ops/runbooks/kernel-operations.md`](../../ops/runbooks/kernel-operations.md). Content preserved unchanged below as historical record of the rollback model that existed before the cutover.

---

# 07 — Rollback & Recovery

> Companion to: [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md), [`06-deferred-execution-policy.md`](./06-deferred-execution-policy.md).
> Sources: investigations [04](../investigation/04-background-jobs-nats.md), [05](../investigation/05-adjudicate-capabilities.md), [06](../investigation/06-runtime-config-governance.md), [07](../investigation/07-testing-observability.md). Adjudicate framework: `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/kernel/enforce-config.ts`, `audit/src/kill-switch-distributed.ts`, `audit/src/kill-switch-timeline.ts`.

## Executive summary

- **Every enforce flip is reversible without code change.** The rollback model has three concentric layers: per-intent (move kind from `IBX_KERNEL_ENFORCE` to `IBX_KERNEL_SHADOW`), per-process (in-process `setKillSwitch(true, ...)`), and cluster-wide (`startDistributedKillSwitchPubSub` per investigation 05 §"Cross-replica coordination"). Each has an SLA per the matrix below.
- **The global `IBX_KILL_SWITCH` is wired in the framework but unreachable from ibatexas** (per investigation 06 §"Kill switches" — "Never called from any ibatexas source file"). Migration adds an admin endpoint `POST /api/admin/kernel/kill` calling `setKillSwitch(true, reason)` (per investigation 06 §"Recommendations" optional step 6). The endpoint emits an audit record + Sentry breadcrumb + NATS `ibatexas.audit.intent.killswitch.v1` event for cross-replica propagation.
- **Shadow mode is the permanent fallback.** Any kind that previously enforced can be moved back to shadow without code change by mutating `IBX_KERNEL_ENFORCE` and restarting (~60s for `ibx svc restart api` per investigation 06). Per investigation 05 §"adjudicateWithShadow" — shadow keeps legacy as authoritative while logging divergence, which preserves customer flows during regression.
- **Per-sink fail-mode is explicit** (per investigation 05 §"Sinks" + master plan §"R2"): console = fail-soft swallow, NATS = fail-soft circuit-breaker, Postgres = fail-buffer-spill, persistentBufferedSink = lossy-with-alert on overflow. **No sink failure blocks a decision.** Per master plan §"Risk register R2 mitigation".
- **"Stop the world" SLA is <60 seconds.** Per master plan §"Success criteria — failsafe" + investigation 06 §"Recommendations". Admin endpoint mutates the in-memory `KillSwitchControl`; distributed kill switch propagates via Redis pub/sub (<100ms per investigation 05 §"startDistributedKillSwitchPubSub"); process restart applies env-var rollback in <60s.

## Three concentric rollback layers

| Layer | Mechanism | Scope | Activation latency | Authorization | Audit event |
|---|---|---|---|---|---|
| **Per-intent** | Remove kind from `IBX_KERNEL_ENFORCE`; optionally keep in `IBX_KERNEL_SHADOW` | One intent kind | ~60s (env var refresh + `ibx svc restart api`) | Admin (env var deploy) | `system.kernel.enforce.add` reverse audit |
| **Per-process global** | `setKillSwitch(true, reason)` from `@adjudicate/core/kernel` | One Node.js process | Immediate (<1s) | Admin via `POST /api/admin/kernel/kill` (new endpoint per investigation 06 §"P0-7") | `system.kernel.kill_switch.toggle` audit; `ibatexas.audit.intent.killswitch.v1` |
| **Cluster-wide** | `startDistributedKillSwitchPubSub({redis, key, pollMs})` per investigation 05 | All API replicas | <100ms via Redis pub/sub; 2s poll fallback | Admin endpoint on any replica; Redis pub/sub propagates | Same as per-process |

Layered usage:
- **Routine enforce regression** → per-intent (move back to shadow).
- **Live incident** → per-process kill (immediate on the affected box) then cluster-wide via distributed pub/sub.
- **Catastrophic / unknown blast radius** → cluster-wide kill, then triage.

## Per-intent kill switch model

Today's framework supports per-intent enforce via `IBX_KERNEL_ENFORCE=comma,separated,kinds` (per investigation 06 §"Env var surface"). To roll back a kind:

```bash
# Before:
IBX_KERNEL_ENFORCE="order.cart.ensure,order.item.add,order.checkout.create"
IBX_KERNEL_SHADOW="*"

# Rollback for order.checkout.create:
IBX_KERNEL_ENFORCE="order.cart.ensure,order.item.add"
IBX_KERNEL_SHADOW="*"
ibx svc restart api   # ~60s; investigations 06, runbook 01-90:91
```

`order.checkout.create` falls back to legacy-EXECUTE per `llm-responder.ts:329-332`. Shadow mode keeps recording the divergence so the team can investigate.

`validateEnforceConfig(KNOWN_INTENT_KINDS, env)` (per investigation 06 §"P0-3") at boot ensures the env-var change doesn't silently typo (`order.chekout.create` would warn but **not** crash).

### Per-intent kill switch (block-mode)

Per investigation 06 §"Missing from the codebase" — there's no `IBX_KERNEL_BLOCK` env var today. The closest analog is omitting from `IBX_KERNEL_ENFORCE`, which puts the kind on the legacy path (which today is "always EXECUTE"). For ibatexas, **the migration's default-deny PolicyBundle plus default REFUSE on unknown kinds** (per [`04-decision-policy.md`](./04-decision-policy.md) §"Default REFUSE on unmatched") gives us a path: temporarily register a "refuse-everything" bundle slot per kind.

**Implementation**: a new env var `IBX_KERNEL_BLOCK=kind1,kind2` parsed alongside `IBX_KERNEL_ENFORCE`. When a kind is in `IBX_KERNEL_BLOCK`, the kernel substitutes a synthetic REFUSE decision before any guard runs:

```ts
// kernel-bootstrap addition (new env semantics; pure ibatexas, no framework change)
const blockedKinds = parseSet(env.IBX_KERNEL_BLOCK);
if (blockedKinds.has(envelope.kind)) {
  return decisionRefuse(
    refuse("system", "intent_blocked", "Essa ação está temporariamente indisponível."),
    [basis("kernel", "default_deny" as const)]
  );
}
```

This is **not** a new framework primitive (per master plan §"Style requirements"). It's an env-var pre-filter at our boundary. Setting `IBX_KERNEL_BLOCK="payment.refund.issue"` and restarting blocks all refund attempts with a clean user message — useful during incident isolation.

## Global kill switch (`IBX_KILL_SWITCH`)

Per investigation 06 §"Kill switches" — the framework wires this but ibatexas never reaches it. Migration adopts.

### When to flip

| Trigger | Authorization | Procedure |
|---|---|---|
| **Catastrophic policy bug** (a kind enforce-flipped that broke customer flows for >5% volume) | Admin via API | `POST /api/admin/kernel/kill` with `{active: true, reason}` |
| **Pack release regression** (newly installed pack produces drift > threshold) | Admin via API | Same; also un-register the new pack version |
| **Suspected forgery** (audit chain integrity check fails) | Admin or auto-trip from `replayWithIntegrity` failure rate > 0.1% per inv 07 §"Alerting gaps" | Same |
| **Audit sink hard failure** (Postgres unreachable AND persistent buffer at capacity) | Auto-trip from `recordSinkFailure` consecutive count > 50 | `setKillSwitch(true, "audit_unavailable")` from a watchdog |
| **Operator scheduled maintenance** | Admin via API | Same; with planned-maintenance reason |

### Who can flip

Admin (OWNER role OR `x-admin-key` header). The kill toggle is itself adjudicated as a `system.kernel.kill_switch.toggle` envelope (per [`01-intent-taxonomy.md`](./01-intent-taxonomy.md) §"system") — when the kill switch is **inactive**, the toggle envelope flows through the kernel, kernel says REQUEST_CONFIRMATION (per [`04-decision-policy.md`](./04-decision-policy.md) §"Confirmation policy table"), admin redeems receipt, kernel emits EXECUTE → `setKillSwitch(true, reason)` runs.

When the kill switch is **active**, every envelope (including the toggle to deactivate it) refuses with code `kill_switch_active`. The only way out is **operator-side**:
1. Restart the process to clear the in-memory state (`IBX_KILL_SWITCH` env var must be unset).
2. Or use the distributed pub/sub `clear` command if implemented (per investigation 05 §"createDistributedKillSwitchPubSub" — returns `{stop, trip, clear}` handle).

### Distributed propagation

Per investigation 05 §"Cross-replica coordination": `startDistributedKillSwitchPubSub({redis, key, pollMs?, context?, logger?})` returns `{stop, trip, clear}`.

```ts
// apps/api/src/plugins/kernel-bootstrap.ts (new)
import { startDistributedKillSwitchPubSub } from "@adjudicate/audit";

const killHandle = startDistributedKillSwitchPubSub({
  redis: redisPubSubClient,
  key: rk("kernel:killswitch"),
  pollMs: 2000,
  context: getDefaultRuntimeContext(),  // per inv 05 §"RuntimeContext"
});

// Wire to graceful shutdown:
process.on("SIGTERM", () => killHandle.stop());
```

The Redis key shape is `<APP_ENV>:kernel:killswitch` — the `<APP_ENV>` prefix (e.g. `production`, `staging`, `development`) is added by `rk()` from `@ibatexas/tools` (see `packages/tools/src/redis/key.ts`). The operator-facing literal substitutes the live `APP_ENV` value, e.g. `production:kernel:killswitch`. This is what `EmergencyStateStore` reads/writes (per investigation 05 §"createRedisEmergencyStateStore"). The admin endpoint mutates the key via:

```ts
// POST /api/admin/kernel/kill
import { createRedisEmergencyStateStore } from "@adjudicate/audit";

const store = createRedisEmergencyStateStore({ redis, key: rk("kernel:killswitch") });
await store.write({ active: true, reason: req.body.reason, actorId: req.user.id });
killHandle.trip(req.body.reason);   // immediate local; pub/sub fans to other replicas
```

Sub-100ms propagation per investigation 05 + 2s poll fallback covers the pub/sub-disconnected case. Distributed timeline events are recorded via `analyzeKillSwitchTimeline` (per investigation 05 §"Cross-replica coordination") — produces a stability class (`stable | single_incident | recurring_incidents | storm`) for trend monitoring.

## Shadow mode as permanent fallback

Per investigation 05 §"adjudicateWithShadow" — `adjudicateWithShadow({envelope, state, policy, legacy})` returns a `ShadowResult` where the legacy decision wins authoritatively while the kernel decision is logged for divergence analysis.

```ts
// llm-responder.ts (existing structure per inv 01)
if (isEnforced(intentKind, env)) {
  decision = adjudicate(envelope, state, bundle);   // kernel authoritative
} else if (isShadowed(intentKind, env)) {
  const shadow = adjudicateWithShadow({ envelope, state, policy: bundle, legacy: legacyResult });
  decision = shadow.authoritative;                  // legacy authoritative; kernel logged
} else {
  decision = legacyDecisionAsKernelDecision({ kind: "EXECUTE" });  // pure-legacy, the current state
}
```

**Permanent fallback contract**: any kind that ever enforced can be returned to shadow without code change. Move the kind name from `IBX_KERNEL_ENFORCE` to `IBX_KERNEL_SHADOW` and restart. The shadow telemetry sink (per investigation 05 §"ShadowTelemetrySink") logs the would-have-been-kernel-decision; legacy continues serving customers. Divergence dashboards (per master plan §"Workstreams WS6") drive the decision on when to re-enforce.

### Shadow on top of shadow

Per investigation 05 §"adjudicateWithShadow" — there's no need to disable shadow when rolling back enforce. The kernel can stay in `IBX_KERNEL_SHADOW=*` permanently in production. Cost: one extra adjudicate call per envelope plus telemetry emit. Per investigation 05 bench data, this is sub-millisecond on the kernel hot path.

## Audit sink failure modes

Per investigation 05 §"Sinks" + master plan §"Risk register R2":

| Sink | Failure type | Action | Decision impact |
|---|---|---|---|
| `consoleSink` | I/O error | Swallow; log to Sentry as breadcrumb | none |
| `natsSink` | NATS broker down | `failureThreshold=5` opens circuit; T3 half-open probe after 30s per inv 05 §"createNatsSink" | none (fail-soft) |
| `natsSink` | publish times out | Counted as failure toward threshold | none |
| `postgresSink` | Connection error | Throw → caught by outer `multiSink` strict mode → wrapped by `persistentBufferedSink` spill | none (buffered to Redis) |
| `postgresSink` | partition missing (current month not yet rotated) | Auto-create or write to default partition; emit Sentry warning | none |
| `persistentBufferedSink` | Capacity overflow (10K) | Lossy with Sentry alert + `recordSinkFailure({sink: "buffered", reason: "capacity"})` per inv 05 | none — **decision proceeds** per master plan §"R2" |
| `persistentBufferedSink` | Redis storage write fails | `PersistentBufferedSpillReason.drain-failure` per inv 05; Sentry critical | none — kernel returns Decision; audit lost (Sentry+metric record the loss) |
| `multiSink` strict (T3 default) | Any inner sink throws | Re-throw aggregated `AuditSinkError`; caught by buffered wrapper | none (buffered) |

**Per master plan §"R2 mitigation"**: "Sink failure must not block decisions (fail-open with metric)." The `persistentBufferedSink → multiSink(...)` composition achieves this: the kernel's `adjudicateAndAudit` returns the Decision to the caller **before** the sink's emit promise settles. The buffer absorbs latency; spillover absorbs persistent failure.

### Fail-closed exception

Per investigation 06 §"Intent ledger wiring" — the **ledger** is fail-closed by default (`IBX_LEDGER_FAIL_OPEN=false`), unlike audit sinks. When the ledger Redis circuit-breaker opens AND `IBX_LEDGER_FAIL_OPEN=false`, `adjudicateAndAudit` surfaces `LedgerUnavailableError` and the responder emits a REFUSE with code `ledger_unavailable`. This is intentional for financial mutations (mass duplicate execution is worse than a brief refusal storm).

Per intent class:
- **Financial mutations** (`payment.*`, `order.checkout.create`, `order.cancel`, `payment.refund.*`): fail-closed (`IBX_LEDGER_FAIL_OPEN=false`).
- **Non-financial mutations** (everything else): fail-open (`IBX_LEDGER_FAIL_OPEN=true` per-kind override; not yet plumbed — recommend separating into two env vars `IBX_LEDGER_FAIL_OPEN_FINANCIAL=false` and `IBX_LEDGER_FAIL_OPEN_DEFAULT=true`).

## Pack release rollback

Per master plan §"Risk register R5" — pack policy drift between repos. Procedure for rolling back a bad pack release:

1. **Immediate**: trip global kill switch via admin endpoint → all envelopes REFUSE with `kill_switch_active`.
2. **Un-register the pack**: pack registration is by `installPack(pack, options)` at boot per investigation 05 §"installPack". To swap, redeploy with the previous pack version pinned in `package.json`:
   ```bash
   pnpm add @ibatexas/pack-orders@^1.2.0 -F @ibatexas/llm-provider
   pnpm install
   ibx svc restart api    # ~60s
   ```
3. **Verify boot conformance**: `assertPackConformance(pack)` runs in `installPack` (per investigation 05 §"installPack"). Bad pack version that re-introduces the regression will crash at boot rather than serve traffic.
4. **Clear kill switch**: once the rollback restart settles, `POST /api/admin/kernel/kill {active: false, reason}`.
5. **Audit trail**: every step produces a `system.kernel.*` audit record per [`01-intent-taxonomy.md`](./01-intent-taxonomy.md) §"system". The `analyzeKillSwitchTimeline` (per investigation 05) shows the full incident timeline.

### Fallback bundle for total pack failure

If `assertPackConformance` rejects every available version, the boot path **must** fall back to a "default REFUSE" PolicyBundle that produces REFUSE for every kind. This is the same default-deny bundle from [`04-decision-policy.md`](./04-decision-policy.md) §"Default REFUSE on unmatched" but applied to every known kind:

```ts
// apps/api/src/plugins/kernel-bootstrap.ts fallback path
import { constant, decisionRefuse, refuse, basis } from "@adjudicate/core";

const refuseAllBundle: PolicyBundle<string, unknown, unknown> = {
  stateGuards: [],
  authGuards: [],
  taint: ibxTaintPolicy,
  business: [],
  default: constant(decisionRefuse(
    refuse("system", "pack_unavailable", "Sistema em manutenção. Tente em alguns minutos."),
    [basis("kernel", "default_deny" as const)]
  )),
};
```

The startup logic:
```ts
try {
  installPack(ordersPack);  // throws PackConformanceError on bad pack
} catch (e) {
  Sentry.captureException(e, { tags: { stage: "pack_install" } });
  installPack(refuseAllBundle, { id: "@ibatexas/pack-fallback", version: "0.0.0" });
  setKillSwitch(true, "pack_install_failure");  // forces operator review
}
```

## Stop-the-world procedure

Per master plan §"Success criteria — failsafe": kill switch verified in staging once per quarter.

### Procedure

1. Admin runs: `POST /api/admin/kernel/kill {active: true, reason: "incident_<id>"}`.
2. Endpoint:
   - Builds `system.kernel.kill_switch.toggle` envelope.
   - Adjudicates (always REQUEST_CONFIRMATION per [`04-decision-policy.md`](./04-decision-policy.md) §"Confirmation policy table").
   - For genuine emergencies, admin provides a pre-issued bypass-confirmation token (out-of-band: ops team has a sealed printed list of single-use tokens; this is the only way to skip the confirmation step in an actual emergency).
3. After confirmation, `setKillSwitch(true, reason)` runs in-process.
4. `killHandle.trip(reason)` from the distributed pub/sub handle fans out via Redis pub/sub.
5. Other replicas receive the pub/sub event in <100ms; their `RuntimeContext.killSwitch` flips active.
6. Every subsequent adjudicate call returns REFUSE with `kill_switch_active`.

### Total latency

- Single-replica: <1s (immediate `setKillSwitch` call).
- Multi-replica with pub/sub: <100ms additional propagation per investigation 05.
- Worst case (pub/sub disconnected): 2s poll fallback per investigation 05 `pollMs` default.

**Per master plan §"Success criteria — failsafe"**: the SLA is <60 seconds end-to-end. Including HTTP round-trip + admin auth + confirmation receipt, the practical floor is ~5-15s for a full multi-step admin flow; for true emergency the bypass-token path is <1s.

### "Soft stop-the-world"

For non-emergency rollback, prefer: move every kind from `IBX_KERNEL_ENFORCE` to `IBX_KERNEL_SHADOW`. Procedure:

```bash
# Read current state
ibx kernel status   # prints current IBX_KERNEL_ENFORCE / SHADOW

# Stage rollback in SSM secrets
ibx infra secrets:set IBX_KERNEL_ENFORCE=""
ibx infra secrets:set IBX_KERNEL_SHADOW="*"
ibx infra secrets:push

# Rolling restart
ibx svc restart api --rolling
```

After ~60s rolling restart, every kind is back on the legacy-EXECUTE path. The kernel still adjudicates (in shadow) so divergence dashboards keep recording. No customer impact (assuming legacy was previously functional).

## Recovery from a stuck DEFER

Per [`06-deferred-execution-policy.md`](./06-deferred-execution-policy.md) §"Timeout policy" — TTL expiry triggers a sweeper. Manual recovery:

### Symptoms

- Customer reports "Estou aguardando confirmação" message stuck for hours.
- Operator sees `defer:pending:*` keys in Redis with TTL > 0 but no matching wire signal arriving.
- Audit subject `ibatexas.audit.intent.defer.v1` shows park events; `ibatexas.audit.intent.resume.v1` has no corresponding resume.

### Triage procedure

1. **Identify the parked envelope**. Keys are namespaced by `rk()` with `<APP_ENV>:` (per `packages/tools/src/redis/key.ts`); substitute the live `APP_ENV` value (e.g. `production`, `staging`, `development`):
   ```bash
   # Example assumes APP_ENV=production:
   redis-cli SCAN 0 MATCH "${APP_ENV}:defer:pending:*"
   # → e.g. "production:defer:pending:cust_abc"
   ```
2. **Read the envelope**:
   ```bash
   redis-cli GET "${APP_ENV}:defer:pending:{sessionId}"
   # JSON contains { envelope, signal, parkedAt }
   ```
3. **Check the wire path**:
   - For `payment.confirmed` signal: was the Stripe webhook delivered? Check `webhook:processed:{event.id}` in Redis.
   - Was the NATS `payment.status_changed` published? Check the Postgres `OrderEventLog` (idempotencyKey-keyed).
4. **Manual resume** (operator command, W7-O1 CLI):
   ```bash
   ibx kernel defer resume <sessionId> --signal=pix.confirmed
   ```
   This calls `resolveDeferredSession` directly with a synthesised wire event so the parked envelope re-adjudicates and dispatches without waiting for the real NATS signal. The resume goes through the same `adjudicate()` + audit path used by `defer-resolver` per [`06-deferred-execution-policy.md`](./06-deferred-execution-policy.md) §"Re-execution semantics".
5. **If manual resume produces REFUSE** (state advanced): notify customer via WhatsApp (`whatsapp.message.send` with template `defer_timeout_apology`).

### Replay log

Every parked + resumed + timed-out envelope is in the audit log per [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) §"Sink topology". A nightly replay job (per investigation 07 P1 #10) re-runs all DEFER decisions and flags ones that lack a corresponding resume within TTL — these are leaked parks that need operator attention.

## Per-stage runbook integration

The 4-stage rollout runbook (per `docs/ops/runbooks/01-05*.md`) integrates these rollback mechanisms:

| Stage | Stop-loss criteria | Rollback action |
|---|---|---|
| 1 — Read mutations shadow | `audit_kernel_shadow_diverged_kind > 0.1%` for >5 min | Per-intent: remove kind from `IBX_KERNEL_SHADOW`; analyze offline |
| 2 — Cart shadow | tool_call_success_rate drops >5% vs prior week | Per-intent rollback |
| 3 — Checkout shadow | any `audit_kernel_shadow_diverged_rewrite` event | Per-intent rollback + investigation |
| 4 — Financial enforce | `kernel_refusal_total{kind=payment.*}` rate > 2× baseline for 5 min | Per-intent + alert on-call |
| 5 — PIX charge pack enforce | replay drift class `regressing` or `flapping` for >24h | Pack version rollback + global kill if drift critical |

Each stage's runbook references real metrics from the `MetricsSink` per [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) §"Metrics" — without the metrics implementation (per investigation 06 §"P0-4") the runbooks are uncheckable. **Recommendation**: do not flip Stage 1 enforce until `MetricsSink` lands per master plan §"Workstreams WS1".

## Recovery test (quarterly)

Per master plan §"Success criteria": kill switch verified in staging once per quarter.

Test procedure:
1. Deploy staging copy with full kernel enforce.
2. Run a load test against `/api/cart/checkout` at 10× baseline RPS.
3. Trip kill switch via admin endpoint.
4. Verify:
   - All subsequent requests return 503 with `kill_switch_active` body within 100ms of trip.
   - Audit subject `ibatexas.audit.intent.killswitch.v1` receives the toggle event.
   - All API replicas (if multi-replica) flip within 2s of trip.
   - `analyzeKillSwitchTimeline` shows `KillSwitchStabilityClass.single_incident`.
5. Clear kill switch.
6. Verify recovery latency: first successful request within 10s of clear.

Output: pass/fail report stored at `docs/ops/quarterly-failsafe-test-{YYYY-Q}.md`.

## What this design does NOT do

- **Does not invent a new kill switch primitive.** Per master plan §"Style requirements" — every export above is already in `@adjudicate/{core,audit}` per investigation 05.
- **Does not require code change for any rollback.** Per master plan §"Governance principles" #8 — "Reversible rollouts. Every enforce flip has a kill switch reachable from a privileged admin endpoint and a documented runbook."
- **Does not promise zero-downtime rollback at the env-var layer.** `ibx svc restart api` is ~60s rolling. Sub-second rollback requires the in-process kill switch, not env-var changes.
- **Does not auto-roll-back.** All rollbacks require human authorization. Auto-trip is only for sink-failure watchdog (per §"Global kill switch" trigger table); auto-clear is never done.

## Cross-references

- Intent kinds that drive kill switch operations: [`01-intent-taxonomy.md`](./01-intent-taxonomy.md) §"system".
- Decision outcomes during kill switch active: [`04-decision-policy.md`](./04-decision-policy.md) §"Refusal taxonomy" (code `kill_switch_active`).
- Audit emissions for kill switch toggle: [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) §"Subject naming convention" — `ibatexas.audit.intent.killswitch.v1`.
- DEFER timeout vs kill switch: [`06-deferred-execution-policy.md`](./06-deferred-execution-policy.md) §"Timeout policy".
- Framework kill switch APIs: `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/kernel/enforce-config.ts`, `/Users/thaisrodolpho/projects/adjudicate/packages/audit/src/kill-switch-distributed.ts`, `kill-switch-timeline.ts`.
- Runbook stages: `/Users/thaisrodolpho/projects/ibatexas/docs/ops/runbooks/01-05*.md` (existing).
