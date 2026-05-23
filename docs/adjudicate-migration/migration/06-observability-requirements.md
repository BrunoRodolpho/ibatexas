# 06 — Observability Requirements

**Status:** Draft v0.1
**Owner:** Migration Planner
**Last updated:** 2026-05-22
**Companion docs:** `01-rollout-strategy.md`, `04-shadow-enforce-sequencing.md` (per-tier thresholds), `05-kill-switch-strategy.md`, `07-production-safety-checklist.md`

---

## Executive summary

- **Six contract metrics.** Every implementation MUST emit exactly these names with exactly these label sets. They become the wire contract for dashboards, alerts, and replay tooling.
- **Four dashboards.** Decision overview, per-intent enforce-readiness, DEFER backlog, audit pipeline health. Built on `@adjudicate/audit-postgres` + Prometheus + PostHog (per `investigation/05 §"Capabilities ibatexas should adopt"` Tier 1).
- **Three sinks, fan-out.** PostHog (product-side dashboards + analytics matching `apps/web/src/domains/analytics/events.ts:107-114`), Sentry (alerting + breadcrumbs), Prometheus (`/metrics` endpoint for Grafana). Wired by the `MetricsSink` adapter delivered in M4.
- **CI gates audit redaction.** Contract test asserts no CPF / email / phone in audit payloads. Failure blocks deployment per `01-rollout-strategy.md`.
- **All metric names match what's emitted.** This document IS the contract. Implementation diverging from these names is a bug.

---

## The six contract metrics

Each metric below is **mandatory** for the migration. Names are stable; label sets are constrained. Implementations emitting different names break the dashboards and the runbooks.

### Metric 1 — `kernel_decision_total`

**Type:** Counter
**Backend:** Prometheus + PostHog (as `audit_decision_executed | audit_decision_refused | audit_decision_<other>`)
**Labels:** `kind` (intent kind), `decision` (`EXECUTE | REFUSE | DEFER | REQUEST_CONFIRMATION | ESCALATE | REWRITE`), `actor` (`llm | user | system`)

**Increment trigger:** Every call to `adjudicate()` or `adjudicateWithShadow()` produces exactly one `kernel_decision_total` increment.

**Example PromQL:**
```promql
rate(kernel_decision_total{kind="order.cancel"}[5m])
sum by (decision) (rate(kernel_decision_total{kind="payment.refund.issue"}[1h]))
```

**Example PostHog event:**
```typescript
posthog.capture("audit_decision_executed", {
  intent_kind: "order.cancel",
  actor: "user",
  session_id: "<uuid>",
  audit_record_id: "<uuid>"
})
```

---

### Metric 2 — `kernel_decision_latency_seconds`

**Type:** Histogram
**Backend:** Prometheus
**Labels:** `kind`
**Buckets:** `0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` (seconds)

**Recording trigger:** Measured from `adjudicate()` entry to `adjudicate()` return. Excludes audit emit time (audit is async).

**Why this matters:** Per `investigation/07 §"Alerting gaps"`, the runbooks reference `kernel_decision_duration_seconds` p99 > 100ms as an alert threshold. Slow guard = customer-visible latency in WhatsApp/web chat.

**Example PromQL:**
```promql
histogram_quantile(0.99, rate(kernel_decision_latency_seconds_bucket{kind="order.confirm"}[5m]))
```

---

### Metric 3 — `kernel_refusal_total`

**Type:** Counter
**Backend:** Prometheus + Sentry breadcrumb + PostHog (as `audit_decision_refused`)
**Labels:** `kind`, `basis` (the `<category>:<code>` flattened basis string per `investigation/05 §"@adjudicate/core/kernel"` `flattenBasis` helper)

**Increment trigger:** Every `Decision.kind === "REFUSE"` (also when REWRITE / ESCALATE / REQUEST_CONFIRMATION carry a non-EXECUTE outcome).

**Example PromQL:**
```promql
# Sustained refusal-rate spike alert
sum by (kind) (rate(kernel_refusal_total[5m]))
  / sum by (kind) (rate(kernel_decision_total[5m])) > 0.1
```

**Sentry breadcrumb (per refusal):**
```json
{
  "category": "kernel",
  "level": "warning",
  "message": "kernel REFUSE on order.cancel",
  "data": {
    "kind": "order.cancel",
    "basis": "business:pay.captured_required",
    "refusalCode": "payment.not_captured",
    "intentHash": "<sha256>"
  }
}
```

---

### Metric 4 — `kernel_shadow_divergence_total`

**Type:** Counter
**Backend:** Prometheus + PostHog (as `audit_kernel_shadow_diverged_basis | audit_kernel_shadow_diverged_kind | audit_kernel_shadow_diverged_rewrite` matching the existing union in `apps/web/src/domains/analytics/events.ts:107-114`)
**Labels:** `kind`, `class` (`BASIS_ONLY | DECISION_KIND | PAYLOAD_REWRITE`)

**Increment trigger:** `adjudicateWithShadow` returns a divergence; the `ShadowTelemetrySink` (per `investigation/05 §"@adjudicate/core/kernel"`) records it.

**Why this matters:** This is the **enforce-flip gate metric** per `04-shadow-enforce-sequencing.md`. Per-tier thresholds:
- Tier 1: `BASIS_ONLY < 5%`, `DECISION_KIND = 0`, `PAYLOAD_REWRITE = 0` for 7 days.
- Tier 4: `BASIS_ONLY < 1%`, others = 0 for 14–28 days.

**Example PromQL:**
```promql
# Per-intent divergence over rolling 7 days (the soak window)
sum by (kind, class) (rate(kernel_shadow_divergence_total[7d]))
```

---

### Metric 5 — `kernel_defer_pending_gauge`

**Type:** Gauge
**Backend:** Prometheus
**Labels:** `kind`

**Update trigger:** Scraped or computed from the Redis `defer:pending:*` key count (per `investigation/04 §"Park mechanism"`). Updated every 30 seconds via a background poll.

**Why this matters:** Per `investigation/04 §"P0 #5"`, the DEFER subscriber is currently unwired. Once wired (M0), the gauge tells on-call how many intents are parked waiting for `payment.confirmed` signals. Above-baseline values indicate stuck flows or PSP outages.

**Example PromQL:**
```promql
kernel_defer_pending_gauge{kind="order.confirm"} > 10
```

---

### Metric 6 — `kernel_audit_lag_seconds`

**Type:** Histogram
**Backend:** Prometheus
**Labels:** `sink` (`postgres | nats | console | spill`)

**Buckets:** `0.001, 0.01, 0.1, 0.5, 1, 2, 5, 10, 30, 60` (seconds)

**Recording trigger:** Measured per audit record: time from `getAuditSink().emit(record)` call to durable write confirmation on each sink. For NATS this is publish-time (Core mode is fire-and-forget); for Postgres it's commit-time; for spill it's disk-fsync-time.

**Why this matters:** Per master plan §Success criteria, `audit.intent.decision.v1` NATS lag must be <1s p99. Per `docs/ops/runbooks/04-stage-financial-mutations.md`, Postgres lag must be <30s.

**Example PromQL:**
```promql
histogram_quantile(0.99, rate(kernel_audit_lag_seconds_bucket{sink="postgres"}[1m])) > 5
```

---

## Additional contract metrics (supporting)

These extend the six core metrics and are also part of the contract:

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `kernel_ledger_op_total` | Counter | `op` (`check | record`), `outcome` (`hit | miss | error`) | Ledger fail-open detection |
| `kernel_sink_failure_total` | Counter | `sink` | Sink-level failures for `recordSinkFailure` events |
| `kernel_replay_drift_total` | Counter | `class` (`stable | improving | regressing | flapping | insufficient_data`) | Daily replay job results |
| `kernel_replay_drift_count_total` | Counter | `kind` | Number of records with detected drift |
| `kernel_kill_switch_state` | Gauge | `scope`, `target` | 0 = disengaged, 1 = engaged |
| `kernel_kill_switch_toggle_total` | Counter | `scope`, `target`, `direction` (`engage | disengage`) | Per-toggle audit |
| `kernel_pack_install_total` | Counter | `pack` | One per `installPack` call (typically once per boot) |
| `kernel_entrypoint_coverage_ratio` | Gauge | (no labels) | Adjudicated entrypoints / total inventoried |
| `kernel_defer_quota_exceeded_total` | Counter | `kind` | DEFER quota violations per `investigation/05 §"@adjudicate/runtime"` |
| `kernel_defer_timeout_total` | Counter | `kind` | DEFER intents parked past `timeoutMs` |
| `kernel_defer_resume_duration_seconds` | Histogram | `kind` | Time from park to resume per `docs/ops/runbooks/05-stage-pix-charge-pack.md` |
| `kernel_audit_sink_failures_total` | Counter | `sink` | Engagement count for audit-sink kill switch (`05-kill-switch-strategy.md`) |

---

## Dashboard 1 — Decision overview

**Audience:** On-call, anyone monitoring system health.

**Refresh:** 30 seconds.

**Time range:** Default 1h; selectors for 6h, 24h, 7d, 30d.

**Layout:**

```
┌─────────────────────────────────────────────────────────────┐
│  KERNEL DECISION OVERVIEW                          [1h] [6h] [24h] [7d] │
├──────────────────────────────┬──────────────────────────────┤
│  Total decisions/min         │  Decision breakdown          │
│  [line chart]                │  [pie chart]                 │
│  (kernel_decision_total)     │  (EXECUTE / REFUSE / DEFER…) │
├──────────────────────────────┼──────────────────────────────┤
│  Latency p50/p95/p99         │  Refusal-rate by basis       │
│  [line chart]                │  [stacked bar]               │
│  (kernel_decision_latency)   │  (kernel_refusal_total)      │
├──────────────────────────────┼──────────────────────────────┤
│  Top 10 refusing intents     │  Audit lag p99 per sink      │
│  [bar chart]                 │  [line chart]                │
└──────────────────────────────┴──────────────────────────────┘
```

**Key queries:**
- Decisions/min: `sum(rate(kernel_decision_total[1m]))`
- Refusal rate: `sum(rate(kernel_refusal_total[1m])) / sum(rate(kernel_decision_total[1m]))`
- p99 latency by kind: `histogram_quantile(0.99, rate(kernel_decision_latency_seconds_bucket[5m]))`

**Watchlist** (visible at top of dashboard):
- Active kill switches: `kernel_kill_switch_state > 0` → red badge
- Audit lag warning: `kernel_audit_lag_seconds > 5s p99` → yellow badge
- DEFER backlog warning: `kernel_defer_pending_gauge > 10` → yellow badge

---

## Dashboard 2 — Per-intent enforce-readiness

**Audience:** Migration lead, on-call during enforce flips.

**Refresh:** 1 minute.

**Time range:** Default 7d (matches Tier 1+2 soak window). Selectors for 14d, 21d, 28d.

**Layout** (one row per intent kind in scope):

```
┌─────────────────────────────────────────────────────────────────┐
│  PER-INTENT ENFORCE-READINESS                              [7d]  │
├─────────────────────────────────────────────────────────────────┤
│  reservation.create  [Tier 1] [Status: ENFORCE-READY ✓]         │
│  Decisions: 1,234   DECISION_KIND div: 0   PAYLOAD_REWRITE: 0    │
│  BASIS_ONLY: 0.3%  (threshold < 5%)                              │
│  Last divergence: 2026-05-15  [view in audit explorer]           │
├─────────────────────────────────────────────────────────────────┤
│  order.cancel        [Tier 3] [Status: SOAKING (4d / 14d)]      │
│  Decisions: 5,678   DECISION_KIND div: 0   PAYLOAD_REWRITE: 0    │
│  BASIS_ONLY: 0.8%  (threshold < 2%)                              │
│  Last divergence: 2026-05-19  [view in audit explorer]           │
├─────────────────────────────────────────────────────────────────┤
│  payment.refund.issue [Tier 4] [Status: BLOCKED]                │
│  Decisions: 89      DECISION_KIND div: 2   ⚠ INVESTIGATE        │
│  Last divergence: 2026-05-21  [view in audit explorer]           │
└─────────────────────────────────────────────────────────────────┘
```

**Status classification** (auto-computed):
- `ENFORCE-READY ✓`: All thresholds met for the tier's soak window.
- `SOAKING (Nd / Md)`: In the middle of the soak window; thresholds currently met.
- `BLOCKED`: At least one divergence threshold violated; soak window reset.
- `IN ENFORCE`: Already in `IBX_KERNEL_ENFORCE`.

**Key queries** (per intent kind):
- Decisions: `sum(rate(kernel_decision_total{kind="$intent"}[7d]) * 7 * 86400)`
- DECISION_KIND divergence: `sum(increase(kernel_shadow_divergence_total{kind="$intent", class="DECISION_KIND"}[7d]))`
- BASIS_ONLY %: `sum(increase(kernel_shadow_divergence_total{kind="$intent", class="BASIS_ONLY"}[24h])) / sum(increase(kernel_decision_total{kind="$intent"}[24h]))`

---

## Dashboard 3 — DEFER backlog & timeout rate

**Audience:** On-call, especially after PIX-related incidents.

**Refresh:** 30 seconds.

**Time range:** Default 1h; selectors for 24h, 7d.

**Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│  DEFER BACKLOG & TIMEOUT                                  [1h]   │
├─────────────────────────────────────────────────────────────────┤
│  Currently parked (by intent)        │  Parks / minute           │
│  [stacked area chart]                │  [line chart]             │
│  (kernel_defer_pending_gauge)        │  (rate(_total))           │
├──────────────────────────────────────┼──────────────────────────┤
│  Resume duration p99                 │  Timeouts / hour          │
│  [line chart]                        │  [bar chart]              │
│  (kernel_defer_resume_duration_…)    │  (kernel_defer_timeout)   │
├──────────────────────────────────────┴──────────────────────────┤
│  Top parked sessions (>10 minutes parked)                       │
│  [table: session_id, intent_kind, parked_at, age]               │
└─────────────────────────────────────────────────────────────────┘
```

**Watchlist:**
- `kernel_defer_pending_gauge` total > 50 → yellow.
- `kernel_defer_timeout_total` rate > 0 for 5 min → red.
- `kernel_defer_resume_duration_seconds` p99 > 5s for `pix.charge.confirm` → yellow (per `docs/ops/runbooks/05-stage-pix-charge-pack.md`).

---

## Dashboard 4 — Audit pipeline health

**Audience:** On-call, compliance reviewers.

**Refresh:** 1 minute.

**Time range:** Default 6h; selectors for 24h, 7d, 30d.

**Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│  AUDIT PIPELINE HEALTH                                   [6h]    │
├─────────────────────────────────────────────────────────────────┤
│  Records emitted / minute            │  Records persisted        │
│  [stacked: postgres, nats, console]  │  [comparison line chart]  │
├──────────────────────────────────────┼──────────────────────────┤
│  Sink lag p99                        │  Sink failures            │
│  [line chart]                        │  [stacked bar]            │
│  (kernel_audit_lag_seconds)          │  (kernel_sink_failure_…)  │
├──────────────────────────────────────┼──────────────────────────┤
│  Replay drift class today            │  Postgres table size      │
│  [single value]                      │  [single value]           │
│  stable / improving / regressing /…  │  intent_audit row count   │
├──────────────────────────────────────┴──────────────────────────┤
│  Buffered sink disk spill                                       │
│  [gauge: spill bytes; threshold: < 1GB]                         │
└─────────────────────────────────────────────────────────────────┘
```

**Watchlist:**
- Postgres lag p99 > 5s for 5 min → page on-call (S2 per `04-stage-financial-mutations.md`).
- NATS lag p99 > 1s for 5 min → page (master plan §Success criteria).
- Replay drift = `regressing` or `flapping` → page (S1 per `investigation/07 §"Alerting gaps"`).
- Sink failure > 5 consecutive → page.
- Buffered sink spill > 1GB → page (capacity issue).

---

## Alerting rules

Each rule deploys to PagerDuty + Slack `#ibx-rollout` (per `docs/ops/runbooks/01-stage-read-mutations.md` §Escalation).

| Rule name | Trigger | Severity | Action |
|---|---|---|---|
| `kernel-refusal-spike` | `sum by (kind) (rate(kernel_refusal_total[5m])) / sum by (kind) (rate(kernel_decision_total[5m])) > 0.1 for 5m` | S1 | Page + investigate |
| `kernel-divergence-decision-kind` | `sum(increase(kernel_shadow_divergence_total{class="DECISION_KIND"}[1m])) > 0` | S2 | Page on-call; block enforce flip for this kind |
| `kernel-divergence-payload-rewrite` | `sum(increase(kernel_shadow_divergence_total{class="PAYLOAD_REWRITE"}[1m])) > 0` | S2 | Page; manual review per `01-stage-read-mutations.md` |
| `kernel-latency-spike` | `histogram_quantile(0.99, rate(kernel_decision_latency_seconds_bucket[5m])) > 0.1 for 5m` | S2 | Page |
| `kernel-audit-postgres-lag` | `histogram_quantile(0.99, rate(kernel_audit_lag_seconds_bucket{sink="postgres"}[5m])) > 5 for 5m` | S2 | Page |
| `kernel-audit-nats-lag` | `histogram_quantile(0.99, rate(kernel_audit_lag_seconds_bucket{sink="nats"}[5m])) > 1 for 5m` | S2 | Page |
| `kernel-ledger-unavailable` | `sum(rate(kernel_ledger_op_total{outcome="error"}[1m])) > 0` | S1 | Page + WhatsApp owner per `investigation/07 §"Alerting gaps"` |
| `kernel-defer-timeout` | `sum by (kind) (rate(kernel_defer_timeout_total[1m])) > 0` | S1 | Page; PSP outage suspected |
| `kernel-defer-quota` | `sum by (kind) (rate(kernel_defer_quota_exceeded_total[5m])) > 0` | S2 | Page; abuse / stuck flow |
| `kernel-replay-drift` | Daily job emits `kernel_replay_drift_total{class="regressing"\|"flapping"} > 0` | S1 | Page; gate release |
| `kernel-kill-switch-engaged` | `kernel_kill_switch_state > 0` (state change) | S2 | Notify Slack; track in dashboard |
| `kernel-sink-failure-burst` | `sum by (sink) (increase(kernel_sink_failure_total[1m])) > 5` | S2 | Page |
| `kernel-buffered-spill-overflow` | spill bytes > 1GB | S1 | Page; capacity issue |
| `kernel-tool-call-success-drop` | tool-call success rate < 95% post-enforce | S1 | Page + trigger rollback per `01-stage-read-mutations.md` |

Each rule has a corresponding entry in `apps/api/src/plugins/sentry.ts` (or a sibling `kernel-alerts.ts` module created in M4) wiring `Sentry.metrics.alert(...)` or the PagerDuty integration.

---

## PostHog event names (matching existing union)

Per `apps/web/src/domains/analytics/events.ts:107-114`, the existing union already declares the event names. The MetricsSink implementation MUST emit these exact strings:

| PostHog event name | Triggered by metric | Properties |
|---|---|---|
| `audit_kernel_shadow_diverged_basis` | `recordShadowDivergence` with class `BASIS_ONLY` | `intent_kind`, `legacy_basis`, `kernel_basis` |
| `audit_kernel_shadow_diverged_kind` | `recordShadowDivergence` with class `DECISION_KIND` | `intent_kind`, `legacy_kind`, `kernel_kind` |
| `audit_kernel_shadow_diverged_rewrite` | `recordShadowDivergence` with class `PAYLOAD_REWRITE` | `intent_kind`, `field_paths` |
| `audit_decision_executed` | `recordDecision` with `decision.kind === "EXECUTE"` | `intent_kind`, `actor`, `latency_ms` |
| `audit_decision_refused` | `recordDecision` with `decision.kind === "REFUSE"` | `intent_kind`, `refusal_code`, `basis_codes[]` |
| `audit_ledger_hit` | `recordLedgerOp` with `outcome === "hit"` | `intent_kind`, `intent_hash` |
| `audit_nats_sink_failed` | `recordSinkFailure` with `sink === "nats"` | `error_class`, `consecutive_failures` |
| `audit_replay_divergence` | Daily replay job per record divergence | `intent_kind`, `divergence_class` |

These are the **PostHog/analytics contract**. The Prometheus contract uses `kernel_decision_total{decision="EXECUTE"}` etc. as canonical names; the PostHog names are user-facing analytics labels.

---

## Audit redaction contract test (CI gate)

**Test file:** `packages/llm-provider/src/__tests__/audit-redaction-contract.test.ts`

**Purpose:** Block deployment if audit pipeline can emit PII.

**Test cases:**

```typescript
describe("audit redaction contract", () => {
  it("strips CPF from envelope.payload", async () => {
    const envelope = buildEnvelope({
      kind: "order.tool.propose",
      payload: {
        toolName: "set_pix_details",
        input: { cpf: "111.222.333-44", name: "Joao", email: "j@x.com" },
        toolUseId: "test"
      },
      actor: { principal: "llm", sessionId: "test" },
      taint: "UNTRUSTED"
    })
    const record = buildAuditRecord({ envelope, decision: ..., ... })
    const redacted = await redactor.redact(record)
    expect(JSON.stringify(redacted)).not.toContain("111.222.333-44")
    expect(JSON.stringify(redacted)).not.toContain("j@x.com")
    expect(JSON.stringify(redacted)).toContain("[REDACTED:CPF]")
    expect(JSON.stringify(redacted)).toContain("[REDACTED:EMAIL]")
  })

  it("strips phone numbers from envelope.payload", async () => {
    // similar
  })

  it("preserves non-PII fields", async () => {
    // envelope.kind, envelope.intentHash, decision.basis remain visible
  })

  it("redacts at all sinks consistently", async () => {
    // assert all three sinks (postgres, nats, console) receive the same redacted record
  })
})
```

**CI integration:**
- This test runs in the default `pnpm test:ci` flow.
- A daily ops job samples 100 audit records from the NATS subject `ibatexas.audit.intent.decision.v1` and runs them through the same redaction tests. Failures page the on-call (S1).

Per `investigation/08 §"Top P0/P1 security gaps"` P0 #1: this is non-negotiable; the audit pipeline today leaks CPF/email/phone, and the redactor lands in M0.

---

## Implementation guidance — `MetricsSink` adapter

Per `investigation/06 §"Required to make the kernel flip-the-switch ready"` step 3, the implementation lives at `apps/api/src/plugins/kernel-metrics.ts`.

**Skeleton:**

```typescript
// apps/api/src/plugins/kernel-metrics.ts
import { setMetricsSink, type MetricsSink, type DecisionEvent, type RefusalEvent, type LedgerOpEvent, type ShadowDivergenceEvent, type SinkFailureEvent, type ResourceLimitEvent } from "@adjudicate/core/kernel"
import * as Sentry from "@sentry/node"
import { PostHog } from "posthog-node"
import { Counter, Histogram, Gauge, register } from "prom-client"

// Prometheus registry
const kernelDecisionTotal = new Counter({
  name: "kernel_decision_total",
  help: "Kernel decisions by kind, decision, and actor",
  labelNames: ["kind", "decision", "actor"] as const
})
const kernelDecisionLatency = new Histogram({
  name: "kernel_decision_latency_seconds",
  help: "Kernel decision latency",
  labelNames: ["kind"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
})
const kernelRefusalTotal = new Counter({
  name: "kernel_refusal_total",
  help: "Kernel refusals by kind and basis",
  labelNames: ["kind", "basis"] as const
})
const kernelShadowDivergenceTotal = new Counter({
  name: "kernel_shadow_divergence_total",
  help: "Shadow divergence events by kind and class",
  labelNames: ["kind", "class"] as const
})
const kernelDeferPendingGauge = new Gauge({
  name: "kernel_defer_pending_gauge",
  help: "Currently parked deferred intents",
  labelNames: ["kind"] as const
})
const kernelAuditLagSeconds = new Histogram({
  name: "kernel_audit_lag_seconds",
  help: "Audit pipeline lag per sink",
  labelNames: ["sink"] as const,
  buckets: [0.001, 0.01, 0.1, 0.5, 1, 2, 5, 10, 30, 60]
})

const posthog = new PostHog(process.env.POSTHOG_API_KEY ?? "")

export function installKernelMetricsSink(): void {
  const sink: MetricsSink = {
    recordDecision(event: DecisionEvent) {
      kernelDecisionTotal.inc({ kind: event.kind, decision: event.decision, actor: event.actor }, 1)
      kernelDecisionLatency.observe({ kind: event.kind }, event.latencyMs / 1000)
      posthog.capture({
        distinctId: event.sessionId ?? "system",
        event: event.decision === "EXECUTE" ? "audit_decision_executed" : "audit_decision_refused",
        properties: { intent_kind: event.kind, actor: event.actor, latency_ms: event.latencyMs }
      })
    },
    recordRefusal(event: RefusalEvent) {
      const basis = event.basisCodes.join(";")
      kernelRefusalTotal.inc({ kind: event.kind, basis }, 1)
      Sentry.addBreadcrumb({
        category: "kernel",
        level: "warning",
        message: `kernel REFUSE on ${event.kind}`,
        data: { kind: event.kind, basis, refusalCode: event.refusalCode, intentHash: event.intentHash }
      })
    },
    recordLedgerOp(event: LedgerOpEvent) { /* ... */ },
    recordSinkFailure(event: SinkFailureEvent) { /* ... */ },
    recordShadowDivergence(event: ShadowDivergenceEvent) {
      kernelShadowDivergenceTotal.inc({ kind: event.kind, class: event.class }, 1)
      const postHogEvent =
        event.class === "BASIS_ONLY" ? "audit_kernel_shadow_diverged_basis"
        : event.class === "DECISION_KIND" ? "audit_kernel_shadow_diverged_kind"
        : "audit_kernel_shadow_diverged_rewrite"
      posthog.capture({
        distinctId: "system",
        event: postHogEvent,
        properties: { intent_kind: event.kind, /* ... */ }
      })
    },
    recordResourceLimit(event: ResourceLimitEvent) { /* ... */ }
  }
  setMetricsSink(sink)
}

// /metrics endpoint
export function registerMetricsRoute(fastify: any) {
  fastify.get("/metrics", async (_req: any, reply: any) => {
    reply.type(register.contentType)
    return register.metrics()
  })
}
```

The full implementation is M4 scope; this is the contract shape.

---

## Audit subject naming convention

Per `investigation/07 §"NATS audit subjects"`:

- **Primary subject:** `audit.intent.decision.v1` (prefixed to `ibatexas.audit.intent.decision.v1`).
- **Version bump rule:** `.v2` etc. when AuditRecord schema breaks.
- **Sibling subjects (future, M8+):**
  - `audit.intent.defer.v1` — park events (envelope, signal, parkedAt).
  - `audit.intent.resume.v1` — resume events (parked envelope hash, resumed at).
  - `audit.ledger.op.v1` — ledger latency stream.
  - `audit.intent.kill_switch.v1` — kill switch toggles (per `05-kill-switch-strategy.md`).

All subjects under the `ibatexas.` house prefix.

---

## Replay infrastructure

Per `investigation/05 §"Replay & integrity"` and `02-milestones.md` M4:

**CLI commands:**

```bash
# Daily replay job (cron, 02:00 UTC)
ibx kernel replay --since=24h --format=ci-line

# Pre-enforce-flip replay
ibx kernel replay --since=24h --intent-kind=order.cancel --format=operator

# Post-enforce-flip replay (strict mode)
ibx kernel replay --since=24h --intent-kind=order.cancel --format=ci-line --strict

# Forensic replay (one envelope)
ibx kernel replay --intent-hash=<sha256> --format=operator
```

**Output format:**

- `ci-line`: one line per drift class for CI integration (`stable: 1234; regressing: 0; flapping: 0`).
- `operator`: human-readable summary with mismatched decisions, basis-code deltas, intent-hash drift cases.
- `json`: machine-readable for downstream tooling.

**Cron schedule** (BullMQ repeatable in `apps/api/src/jobs/`):

```typescript
queue.add("kernel-replay-daily", {}, { repeat: { cron: "0 2 * * *" } })
```

Failures (any `regressing` or `flapping`) emit `kernel_replay_drift_total{class}` and page on-call.

---

## Acceptance — observability is ready when:

- [ ] All six contract metrics emitting from `apps/api`.
- [ ] `/metrics` endpoint returning Prometheus exposition format.
- [ ] All eight PostHog event names firing.
- [ ] Sentry breadcrumbs for refusal + sink-failure visible.
- [ ] Dashboard 1 (Decision overview) deployed to Grafana.
- [ ] Dashboard 2 (Per-intent enforce-readiness) deployed; one row per intent in scope.
- [ ] Dashboard 3 (DEFER backlog) deployed.
- [ ] Dashboard 4 (Audit pipeline health) deployed.
- [ ] 14 alerting rules in PagerDuty with runbook links.
- [ ] CI gate: audit redaction contract test green for 14 consecutive days.
- [ ] Daily replay job running; last 7 days drift class = `stable`.
- [ ] `ibx kernel status` and `ibx kernel replay` CLIs functional.
- [ ] On-call drilled on dashboards (quarterly chaos test pass per `05-kill-switch-strategy.md`).

---

## Open questions

1. **PostHog vs OpenTelemetry tracing.** `investigation/05 §Tier 3 #18` recommends `@adjudicate/observability` OTLP exporters. Current plan uses PostHog (already wired) + Prometheus (new). OTLP/Tempo adoption is a follow-on; should it be in M4 scope or post-migration?
2. **Per-intent dashboard auto-provisioning.** Dashboard 2 (per-intent enforce-readiness) currently lists every intent kind. As the migration adds intents, rows are added by hand. Should we provision panels via Terraform/Grafana-as-code? Current plan: manual until 5+ intents, then automate.
3. **Replay schedule frequency.** Daily is the master plan default. Should we run hourly for Tier 4 intents during their soak window for faster drift detection? Trade-off: hourly drift detection vs. daily-vs-hourly noise in `kernel_replay_drift_total`.
