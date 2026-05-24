# Task 05 — MetricsSink Implementation (PostHog + Sentry + Prometheus)

**Milestone:** M0 (Plumbing flip) — finishes M0
**Estimated effort:** M — 1.5–2 dev-days
**Blocks:** 20 (test coverage depends on metrics emission), every M3 enforce flip (runbooks require these dashboards)
**Blocked by:** 01 (kernel bootstrap is where the sink is installed)
**Owner:** unassigned

## Objective

Replace the stub `MetricsSink` from Task 01 with a real adapter that publishes to PostHog (product-side dashboards), Sentry (alerting + breadcrumbs), and Prometheus (SLO charts via `/metrics` endpoint). After this lands, the seven `audit_kernel_*` events already declared in `apps/web/src/domains/analytics/events.ts:107-114` are actually emitted from the kernel, the runbooks' PagerDuty alerts and PostHog dashboards have a real producer, and the staged enforce-mode rollouts become observable.

## Architecture context

Cite: investigation 06 §"Telemetry / metrics wiring" + §"P0-4: no `MetricsSink` installed" + investigation 07 §"Observability stack".
> "Every `recordLedgerOp`, `recordDecision`, `recordRefusal`, `recordSinkFailure`, `recordShadowDivergence`, `recordResourceLimit` call in the kernel returns immediately without emitting anywhere. The PostHog event names declared in `apps/web/src/domains/analytics/events.ts:107-114` ... have no producer."

Framework primitives (already implemented in `@adjudicate/core/kernel`):
- `MetricsSink` interface with 5 required methods + optional `recordResourceLimit`
- Event shapes: `LedgerOpEvent`, `DecisionEvent`, `RefusalEvent`, `SinkFailureEvent`, `ShadowDivergenceEvent`, `ResourceLimitEvent`

Declared but unused PostHog event names (`apps/web/src/domains/analytics/events.ts:107-114`):
- `audit_kernel_shadow_diverged_basis`
- `audit_kernel_shadow_diverged_kind`
- `audit_kernel_shadow_diverged_rewrite`
- `audit_decision_executed`
- `audit_decision_refused`
- `audit_ledger_hit`
- `audit_nats_sink_failed`
- `audit_replay_divergence`

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/kernel-bootstrap.ts` (created in Task 01 — replaces the stub sink)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/sentry.ts` (existing Sentry init)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/lib/posthog.ts` (if it exists; otherwise check apps/web/src/lib/posthog.ts for the pattern)
- `/Users/thaisrodolpho/projects/ibatexas/apps/web/src/domains/analytics/events.ts:107-114`
- `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/kernel/metrics.ts` (the `MetricsSink` interface)

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/kernel-metrics-sink.ts`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/prometheus-exporter.ts` (or co-locate in kernel-metrics-sink.ts)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/metrics.ts` (the `/metrics` endpoint)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/__tests__/kernel-metrics-sink.test.ts`

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/kernel-bootstrap.ts` — swap stub for real sink
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/server.ts` — register the `/metrics` route
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/package.json` — add `prom-client` dep

## Constraints

- Must use the existing PostHog server-side wire (`POST /api/analytics/track` pattern per `apps/web/src/lib/posthog.ts`) — do NOT add a new PostHog SDK. The `MetricsSink` adapter posts to the in-process analytics pipeline that already handles batching/retries.
- Must emit only the eight event names already declared in the `AnalyticsEvent` union (CLAUDE.md rule #8 — add events to union AND document in `docs/ops/analytics-dashboards.md`).
- Sentry breadcrumbs for `recordRefusal` and `recordSinkFailure` only — avoid noise from `recordDecision` (high volume).
- Prometheus `/metrics` endpoint MUST be auth-gated — use `x-admin-key` header check or a separate `PROMETHEUS_TOKEN` env var, defaults closed.
- Use `prom-client` (popular, mature) for the counter/histogram primitives. Add to `apps/api/package.json` dependencies.
- Follow CLAUDE.md rule #3 (`process.env` for config), rule #8 (analytics events documented).

## Implementation requirements

1. **Author `kernel-metrics-sink.ts`** exporting `createKernelMetricsSink(deps): MetricsSink`:
   - Implement all 6 methods per `@adjudicate/core/kernel`'s `MetricsSink` interface.
   - For each method, fan-out: PostHog event (using existing analytics track function), Sentry breadcrumb (only for refusal/sinkFailure), Prometheus counter/histogram increment.

2. **Event mapping** (kernel event → PostHog event name):
   | Kernel event | PostHog event | Sentry breadcrumb |
   |---|---|---|
   | `DecisionEvent {kind: EXECUTE}` | `audit_decision_executed` | no |
   | `DecisionEvent {kind: REFUSE/ESCALATE/REQUEST_CONFIRMATION/DEFER/REWRITE}` | `audit_decision_refused` | no |
   | `RefusalEvent` | (rolled into above) | yes (category=`audit_refused`, basis included) |
   | `LedgerOpEvent` | `audit_ledger_hit` (only on hit, suppress miss) | no |
   | `ShadowDivergenceEvent {class: DECISION_KIND}` | `audit_kernel_shadow_diverged_kind` | no |
   | `ShadowDivergenceEvent {class: BASIS_ONLY}` | `audit_kernel_shadow_diverged_basis` | no |
   | `ShadowDivergenceEvent {class: PAYLOAD_REWRITE}` | `audit_kernel_shadow_diverged_rewrite` | no |
   | `SinkFailureEvent` | `audit_nats_sink_failed` | yes (category=`sink_failure`) |
   | `ResourceLimitEvent` | (no PostHog event today; Prometheus only) | no |

3. **Prometheus metrics** to expose:
   - `kernel_decision_total{kind, intent_kind}` (counter)
   - `kernel_refusal_total{kind, intent_kind, basis_category, basis_code}` (counter)
   - `kernel_decision_duration_seconds{intent_kind}` (histogram, buckets per `metrics.ts` event shape)
   - `kernel_shadow_divergence_total{class, intent_kind}` (counter)
   - `kernel_ledger_op_total{outcome, op}` (counter)
   - `kernel_audit_sink_failure_total{sink, reason}` (counter)
   - `kernel_defer_resume_duration_seconds` (histogram, populated by Task 03's resolver via a separate hook)

4. **`/metrics` endpoint** (`apps/api/src/routes/metrics.ts`):
   - GET only.
   - Auth: require `x-prometheus-token` header == `process.env.PROMETHEUS_TOKEN`; if env var unset, 503 (closed by default).
   - Returns Prometheus text-format from `register.metrics()`.

5. **Wire into `kernel-bootstrap.ts`** — replace the stub sink with `createKernelMetricsSink({...deps})`. Deps include the pino logger, the PostHog `track()` function, Sentry, and the `prom-client` Registry.

6. **Add `PROMETHEUS_TOKEN` to `.env.example`** under the existing Kernel stanza.

7. **Tests** (`__tests__/kernel-metrics-sink.test.ts`):
   - Each method fires the right PostHog event with expected properties.
   - Sentry breadcrumb is added on `recordRefusal` and `recordSinkFailure`.
   - Prometheus counters increment as expected (use `prom-client`'s `register.getSingleMetric` and `.get()`).
   - `/metrics` endpoint returns 503 when `PROMETHEUS_TOKEN` is unset; 200 with `text/plain; version=0.0.4` content when token matches.

## Acceptance criteria

- [ ] `createKernelMetricsSink` implements all 6 `MetricsSink` methods.
- [ ] kernel-bootstrap.ts installs the real sink (stub from Task 01 removed).
- [ ] PostHog receives the 8 declared event names on the appropriate kernel events.
- [ ] Sentry receives breadcrumbs on REFUSE and sink failures.
- [ ] `/metrics` endpoint serves Prometheus format when authenticated.
- [ ] `PROMETHEUS_TOKEN` env var documented in `.env.example`.
- [ ] All metrics-sink tests pass.
- [ ] `pnpm --filter @ibatexas/api typecheck` passes.
- [ ] Document the new Prometheus metric names in `docs/ops/analytics-dashboards.md` under a new "Kernel metrics" section.

## Testing requirements

- **Unit:** metrics-sink test file above.
- **Integration:** smoke test that hits `/metrics` after running a fake adjudicate cycle and asserts the counter increment.
- **Bypass-detection:** N/A.

## Rollout notes

Direct merge. The metrics start flowing the moment the deploy completes. No customer-facing change. Watch:
- PostHog ingestion — verify `audit_decision_executed` events appearing within 5 min of deploy.
- `/metrics` scrape from Prometheus — verify the new counters in Grafana.

If Sentry breadcrumb volume is too high, throttle via a sampling rate (env `KERNEL_SENTRY_BREADCRUMB_RATE`, default `1.0`).

## Rollback notes

Revert to the stub `MetricsSink` from Task 01. Metrics stop emitting; runbooks lose their data source. The `/metrics` endpoint returns empty registry. Rollback ETA: <5 min. No data loss in production; PostHog/Sentry/Prometheus simply stop receiving the kernel events.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 05: real MetricsSink adapter (PostHog + Sentry + Prometheus).

CONTEXT
Per investigations 06 and 07 in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/:
- @adjudicate/core/kernel exposes MetricsSink with 6 methods (recordLedgerOp, recordDecision, recordRefusal, recordSinkFailure, recordShadowDivergence, recordResourceLimit)
- No real sink is installed today — the stub from Task 01 only logs at debug level
- apps/web/src/domains/analytics/events.ts:107-114 declares 8 audit_* event names with no producer
- Runbooks reference Prometheus metrics that don't exist (kernel_decision_total, kernel_refusal_total, kernel_defer_resume_duration_seconds, etc.)

Your job: implement createKernelMetricsSink and wire it into kernel-bootstrap.ts, plus expose a /metrics endpoint.

REPO LAYOUT
- apps/api/src/plugins/kernel-bootstrap.ts (from Task 01 — has the stub sink)
- apps/api/src/plugins/sentry.ts (existing Sentry init)
- apps/api/src/server.ts (Fastify factory — registers routes)
- apps/web/src/lib/posthog.ts (PostHog client pattern; apps/api may have its own — check apps/api/src/lib/ first)
- apps/api/src/routes/analytics.ts (existing analytics track endpoint — pattern for emitting events)
- /Users/thaisrodolpho/projects/adjudicate/packages/core/src/kernel/metrics.ts (the MetricsSink interface + event types)

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- apps/api/src/plugins/kernel-metrics-sink.ts (CREATE)
- apps/api/src/plugins/prometheus-exporter.ts (CREATE — or inline in kernel-metrics-sink.ts)
- apps/api/src/routes/metrics.ts (CREATE — the /metrics endpoint)
- apps/api/src/plugins/__tests__/kernel-metrics-sink.test.ts (CREATE)
- apps/api/src/plugins/kernel-bootstrap.ts (MODIFY — swap stub for real sink)
- apps/api/src/server.ts (MODIFY — register /metrics route)
- apps/api/package.json (MODIFY — add prom-client dep)
- .env.example (MODIFY — add PROMETHEUS_TOKEN)
- docs/ops/analytics-dashboards.md (MODIFY — add "Kernel metrics" section listing the new Prometheus names)

WHAT TO BUILD

1. createKernelMetricsSink(deps): MetricsSink in apps/api/src/plugins/kernel-metrics-sink.ts
   - deps: { trackAnalytics, sentry, log, register } where register is a prom-client Registry
   - All 6 methods implemented per the table in this task file
   - Mapping kernel event → PostHog event (use the union names from apps/web/src/domains/analytics/events.ts:107-114)
   - Sentry.addBreadcrumb on recordRefusal and recordSinkFailure only
   - prom-client counters/histograms registered with stable names: kernel_decision_total, kernel_refusal_total, kernel_decision_duration_seconds, kernel_shadow_divergence_total, kernel_ledger_op_total, kernel_audit_sink_failure_total, kernel_defer_resume_duration_seconds

2. /metrics endpoint in apps/api/src/routes/metrics.ts:
   - GET only
   - Auth: require x-prometheus-token header matching process.env.PROMETHEUS_TOKEN; if env unset, return 503
   - Return register.metrics() with content-type "text/plain; version=0.0.4"

3. Wire into kernel-bootstrap.ts:
   - Replace the stub sink from Task 01 with createKernelMetricsSink({...})
   - Pull trackAnalytics from apps/api/src/lib/analytics.ts (or wherever the server-side PostHog wire lives — look for existing usage)
   - Pull sentry from apps/api/src/plugins/sentry.ts
   - Create one shared prom-client Registry and pass it to both the sink AND the /metrics route

4. apps/api/server.ts: server.register(metricsRoute) under /metrics, before other routes if you want it to skip auth middleware. Make sure it doesn't conflict with the existing /health route.

5. .env.example: append under "# ─── Adjudicate Kernel ───":
   PROMETHEUS_TOKEN=                          # required to scrape /metrics; closed by default if unset

6. apps/api/package.json: add "prom-client": "^15.1.0" (or current latest) to dependencies.

7. docs/ops/analytics-dashboards.md: append a "## Kernel metrics" section listing all 7 Prometheus metric names with their labels, and the 8 PostHog audit_* event names already in the union.

8. Tests in __tests__/kernel-metrics-sink.test.ts (vitest):
   - "recordDecision EXECUTE fires audit_decision_executed" — assert PostHog mock receives the named event with intent_kind label
   - "recordRefusal fires Sentry breadcrumb" — assert Sentry mock addBreadcrumb called once with category audit_refused
   - "recordSinkFailure fires Sentry breadcrumb" — assert
   - "recordShadowDivergence with class DECISION_KIND fires audit_kernel_shadow_diverged_kind" — assert
   - "Prometheus counter increments on recordDecision" — read register, assert kernel_decision_total{kind=EXECUTE,intent_kind=X}.get() === 1
   - "/metrics returns 503 when token unset" — fastify test instance, GET /metrics without env
   - "/metrics returns 200 with prom format when token matches" — fastify test instance with env set

CONSTRAINTS
- Use prom-client (npm install prom-client) — add to apps/api/package.json deps
- Use the existing PostHog wire pattern — do NOT add a new PostHog SDK. Find the server-side track function and reuse.
- Sentry breadcrumbs ONLY for refusal + sink failure (avoid noise from recordDecision)
- pt-BR not relevant (operator-facing metrics in English)
- TypeScript strict, ESM, .js extensions on local imports
- CLAUDE.md rule #3 — all config from process.env
- CLAUDE.md rule #8 — events documented (analytics-dashboards.md)

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] createKernelMetricsSink implements all 6 MetricsSink methods
- [ ] kernel-bootstrap.ts uses the real sink (no stub left)
- [ ] /metrics endpoint exists, auth-gated by PROMETHEUS_TOKEN
- [ ] 8 PostHog event names emitted at the right times
- [ ] Sentry breadcrumbs on refusal + sink failure only
- [ ] All metrics-sink tests pass: `pnpm --filter @ibatexas/api test kernel-metrics-sink`
- [ ] `pnpm --filter @ibatexas/api typecheck` passes
- [ ] docs/ops/analytics-dashboards.md updated with Kernel metrics section

When complete, return: files created/modified, test output, and confirm the 8 PostHog event names match the existing AnalyticsEvent union exactly.
```
