# 07 — Testing & Observability

> Investigator 7 of 8 — test coverage and observability of the adjudicate integration in ibatexas. Companion to investigations 01–06 (kernel surface area, policy bundle, audit/ledger wiring, runbook playbooks).

## Executive summary

The ibatexas repository contains **171 vitest/playwright test files** (counted at `*.test.ts`, `*.spec.ts`, `tests/e2e/`). Direct exercise of the kernel migration surface is essentially **two unit-shaped tests**:

- `packages/llm-provider/src/__tests__/pack-signal-contract.test.ts` — pins one wire constant (`PIX_CONFIRMATION_SIGNAL === "payment.confirmed"`).
- `packages/llm-provider/src/__tests__/validation-rewrite.test.ts` — exercises `validateBufferedTextTyped` (which uses `isKnownBasisCode` from `@adjudicate/core`).

Everything else — every kernel decision path, every shadow/enforce branch, the full DEFER park/resume round trip, the audit sink contract, ledger fail-open behaviour, the `orderPolicyBundle`, `intent-audit-wiring`, `intent-ledger` modules, and `apps/api/src/subscribers/defer-resolver.ts` — has **zero direct unit-test coverage in ibatexas**. The two high-level integration suites that could plausibly run a real intent (`apps/api/src/__tests__/chat.test.ts`, `apps/api/src/__tests__/whatsapp-webhook-route.test.ts`, `apps/api/src/__tests__/chat-integration.test.ts`) all do `vi.mock("@ibatexas/llm-provider", () => ({ runOrchestrator: mockRunAgent }))` and never reach the kernel.

The adjudicate platform repo at `/Users/thaisrodolpho/projects/adjudicate` carries **135 framework-side test files**, including `pack-payments-pix/tests/{defer-round-trip,six-outcomes,adopter-guard}.test.ts` and `runtime/tests/{defer-park,defer-resume,resume-hash-verify,defer-resume-cycle-cap,clinic-example}.test.ts`. These cover the *framework* contracts. They do **not** cover the IbateXas-specific composition: that the kernel actually runs in production through `llm-responder.ts`, that the PolicyBundle composes correctly with `createPixPendingDeferGuard`, that the audit/ledger sinks are wired into Redis + NATS, and that `defer-resolver.ts` reads back the parked envelope shape the responder writes.

Observability is **not migration-grade**:
- No `MetricsSink` is installed into `@adjudicate/core/kernel` from any apps/api boot path (`apps/api/src/plugins/sentry.ts` initialises Sentry only).
- The seven `audit_kernel_*` and `audit_decision_*` event names exist in the `AnalyticsEvent` union (`apps/web/src/domains/analytics/events.ts:106-114`) but are **never emitted** from any code path — grep finds the strings only in the union declaration.
- No Grafana/Prometheus dashboard, no APM (Datadog/Honeycomb/NewRelic/OpenTelemetry), no Sentry alerts wired to kernel/refusal/divergence counters.
- The runbooks (`docs/ops/runbooks/01-05*.md`) repeatedly reference `kernel_decision_total`, `kernel_refusal_total`, `kernel_defer_resume_duration_seconds`, `kernel_shadow_divergence_total`, `audit_kernel_shadow_diverged_kind` PagerDuty alerts — none of which exist in code today.

**Bottom line:** the migration cannot safely flip Stage 1 ENFORCE on the current observability stack. Operators would have no signal that REFUSE is spiking, no dashboard to compare shadow vs enforce decisions, and no automated alert when divergence occurs.

---

## Existing test inventory

171 tests total. The subset that exercises (or could exercise) the adjudicate-migration surface:

| File | Surface | Relevant to kernel? |
|---|---|---|
| `packages/llm-provider/src/__tests__/pack-signal-contract.test.ts` | `PIX_CONFIRMATION_SIGNAL === "payment.confirmed"` wire pin | Yes — cross-repo Pack signal contract |
| `packages/llm-provider/src/__tests__/validation-rewrite.test.ts` | `validateBufferedTextTyped` + `isKnownBasisCode` from `@adjudicate/core` | Partial — only the validation layer; no `adjudicate()` call |
| `packages/llm-provider/src/__tests__/refusal-taxonomy.test.ts` | `refuse*` factories + `GUARD_REFUSAL_MAP` | Indirectly — refusal helpers consumed by `orderPolicyBundle` guards. Doesn't invoke kernel. |
| `packages/llm-provider/src/__tests__/tool-registry.test.ts` | `executeTool` returning `IntentEnvelope` for MUTATING tools | Partial — verifies envelope shape but not adjudication |
| `packages/llm-provider/src/__tests__/tool-registry-edge-cases.test.ts` | Same — edge cases | Partial — same |
| `packages/llm-provider/src/__tests__/agent.test.ts` | `runAgent` unit tests | No — does not exercise responder kernel branch |
| `packages/llm-provider/src/__tests__/agent-edge-cases.test.ts` | `runAgent` edge cases | No |
| `packages/llm-provider/src/__tests__/checkout-state-detection.test.ts` | Checkout state detection logic | No |
| `packages/llm-provider/src/__tests__/system-prompt.test.ts` | Prompt builder | No |
| `packages/llm-provider/src/__tests__/budget-bypass.test.ts` | Per-session token budget bypass for checkout states; mocks aggressively | No — mocks `executeTool`, persistence, Redis, Anthropic SDK |
| `packages/llm-provider/src/__tests__/scenarios/scenario-runner.test.ts` | End-to-end JSON-driven conversation scenarios | Partial — runs through `runOrchestrator` but doesn't assert kernel decisions |
| `apps/api/src/__tests__/chat.test.ts` | POST `/api/chat` route | **No** — `vi.mock("@ibatexas/llm-provider", () => ({ runOrchestrator: mockRunAgent }))` |
| `apps/api/src/__tests__/chat-integration.test.ts` | Chat route integration with session | **No** — same mocking |
| `apps/api/src/__tests__/whatsapp-webhook-route.test.ts` | WhatsApp inbound webhook | **No** — same mocking |
| `tests/e2e/api-golden-path.spec.ts` | Playwright HTTP — health/auth/catalog/cart | No — does not drive an LLM intent through kernel |
| `tests/e2e/web-golden-path.spec.ts` | Playwright browser — browse → search → PDP → cart | No — no kernel-mutating intent reached |
| `tests/e2e/smoke.spec.ts` | Smoke | No |

**Untested-in-ibatexas modules that own kernel wiring:**
- `packages/llm-provider/src/llm-responder.ts` (the `adjudicate()` / `adjudicateWithShadow()` call sites, DEFER park, audit emit) — no test file
- `packages/llm-provider/src/intent-audit-wiring.ts` (sink construction, multiSink, NATS subject `audit.intent.decision.v1`) — no test file
- `packages/llm-provider/src/intent-ledger.ts` (fail-open policy, `LedgerUnavailableError`, `wrapWithFailOpenPolicy`, `recordLedgerOp` instrumentation) — no test file
- `packages/llm-provider/src/order-policy-bundle.ts` (the IbateXas PolicyBundle composition + `createPixPendingDeferGuard` integration) — no test file
- `apps/api/src/subscribers/defer-resolver.ts` (NATS `payment.status_changed` → `resumeDeferredIntent` → Redis SCAN of `defer:pending:*`) — no test file

### Test infrastructure

- **Vitest** — root `vitest.config.ts` (node env, v8 coverage, lcov reporter). No `setupFiles`, no global setup that installs a `MetricsSink` or `AuditSink` mock. Tests opt into Redis/NATS mocks per-file via hoisted `vi.fn()` stubs.
- **Playwright** — root `playwright.config.ts`. Three projects: `web`, `api`, `smoke`. The `webServer` block spawns `pnpm --filter @ibatexas/web dev` + `pnpm --filter @ibatexas/api dev` against `localhost:3000` / `:3001`. **No environment override for `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` / `IBX_LEDGER_*`** — E2E tests run in whatever the default (legacy) configuration is.
- **No dedicated test DB / Redis fixtures** — every test mocks Redis through `vi.mock("@ibatexas/tools")` and provides `getRedisClient: vi.fn()`.
- **No `vitest.setup.ts`** in any package — test isolation depends on per-file `beforeEach` and the `_reset*` exports (`_resetLedger`, `_resetAuditSink`) which are referenced nowhere outside their declarations (grep confirms).

---

## Test categories — coverage matrix

| Category | Current coverage | Gap | Priority |
|---|---|---|---|
| Kernel contract — `adjudicate(envelope, state, bundle)` per intent kind | None in ibatexas | Need per-intent table: cart.add, cart.remove, cart.update, cart.create_or_get, cart.reorder, checkout.create, reservation.{create,modify,cancel}, waitlist.join, handoff.human, order.submit, order.cancel, order.amend, order.confirm, payment.{regenerate_pix,set_pix_details}, preference.update, coupon.apply, review.submit, followup.schedule, order.note.add. Each: input envelope + state → expected `Decision.kind` + basis codes. | **P0** — gates Stage 1 enforce |
| Shadow-mode — `adjudicateWithShadow` logs DECISION_KIND / PAYLOAD_REWRITE / BASIS_ONLY divergence | None | Test that with `IBX_KERNEL_SHADOW=order.confirm` and a divergent legacy returning EXECUTE while kernel returns REFUSE, the divergence event fires and the legacy decision is preserved. | **P0** — gates safe rollout |
| Enforce-mode — REFUSE actually blocks `onToolIntent` | None | Test that with `IBX_KERNEL_ENFORCE=order.submit`, an unauthenticated state produces REFUSE and `onToolIntent` is never invoked. | **P0** — the core enforcement claim |
| DEFER park + resume round trip | None in ibatexas (platform has `pack-payments-pix/tests/defer-round-trip.test.ts` but doesn't exercise ibatexas's adapter glue) | Park: assert Redis key `defer:pending:<sessionId>` written with `{ envelope, signal, parkedAt }` and TTL = `timeoutMs/1000 + 60`. Resume: deliver `payment.status_changed` via NATS subscriber path, scan `defer:pending:*`, call `resumeDeferredIntent`, assert intent dispatched + SET-NX dedup on second delivery. | **P0** — Stage 4 critical path |
| Audit emission contract | None | Test that `getAuditSink().emit(record)` is called once per intent, that `record` includes the actual `Decision`, `durationMs`, `envelope.intentHash`, and that the NATS sink publishes on subject `audit.intent.decision.v1`. | **P0** — compliance/legal sign-off (Stage 4 pre-flight) |
| Pack guard tests — PIX | Platform-side only (`@adjudicate/pack-payments-pix/tests/`) | ibatexas composition test: feed `order.confirm` envelope with `paymentMethod: "pix" && paymentStatus: "pending"` through `orderPolicyBundle` and assert `Decision.kind === "DEFER"` with `signal === "payment.confirmed"`. | **P0** — Stage 4 |
| Policy bundle composition — guards combine in order | None | Test ordering: `requireAuthenticated` (auth) → `requireCheckoutEligibility` → state guards → taint → business. Assert short-circuit at first non-null guard. Assert `default: "REFUSE"` triggers on unknown intent kind. | **P1** |
| Replay determinism — same envelope+state → same decision hash | None | Test that re-feeding a stored audit record's `(envelope, state)` to `adjudicate()` produces the same `Decision.kind` and `intentHash`. Powers the `ibx kernel replay` workflow referenced in runbook 05. | **P1** — gates safe Pack version bumps |
| Bypass detection — a tool that bypasses the envelope is detectable | None | Test that a hand-written tool result skipping `buildEnvelope` is rejected by the responder or surfaces an audit anomaly. Currently the responder simply runs `decision = legacyDecisionAsKernelDecision({ kind: "EXECUTE" })` when no envelope is present — a silent bypass. | **P0** for security |
| Ledger — fail-open vs fail-safe semantics | None | Test that with `IBX_LEDGER_FAIL_OPEN=true`, a `CircuitOpenError` returns null from `checkLedger` and logs `recordLedgerOp({outcome:"error"})`; with `IBX_LEDGER_FAIL_OPEN=false`, it throws `LedgerUnavailableError` and the responder surfaces `SECURITY/ledger_unavailable`. | **P0** — Stage 4 critical |
| Ledger — duplicate execution suppression | None | Test that two `recordExecution` calls with the same `intentHash` produce one persisted record (SET-NX semantics) and the second `checkLedger` returns a hit. | **P0** — Stage 4 dedup invariant |
| Audit sink — backpressure / failure modes | None | Test that NATS publish failure logs `recordSinkFailure({sink:"nats"})` but does NOT block the decision path (best-effort via `Promise.allSettled` in `multiSink`). | **P1** |
| Refusal taxonomy — every guard maps to a `Refusal` shape | `refusal-taxonomy.test.ts` covers `refuse*` factories | Extend to: assert every guard in `orderPolicyBundle` returns a refusal whose `code` is in `GUARD_REFUSAL_MAP` and whose `kind` matches the basis category. | **P1** |
| Webhook → DEFER resume → ledger SET-NX | None | End-to-end test through `defer-resolver.ts`: publish two `payment.status_changed` events with identical `paymentId/orderId`, assert only one resume executes and the duplicate logs `duplicate_resume_suppressed`. | **P0** — Stage 4 |
| Capability planner — mutating tools hidden from LLM | Not directly | Test that `TOOL_CLASSIFICATION` keeps MUTATING tools out of the planner's visible list. Indirectly covered by `tool-registry.test.ts`. | **P2** |
| Per-stage smoke tests (matches runbook smoke procedures) | None | One scripted run per runbook stage that triggers the listed scenarios end-to-end against a staging-like fixture. Today the runbook smoke is a manual checklist. | **P2** |

---

## Observability stack

### Logging

- **Pino** in `apps/api/src/lib/logger.ts` with `LOG_LEVEL`, ISO timestamps, `pino-pretty` in dev, raw JSON to CloudWatch in prod (`/ecs/ibatexas-api` log group per `docs/ops/logging.md`).
- Kernel decision sites in `packages/llm-provider/src/llm-responder.ts` use **`console.warn`** / `console.error`, **not** pino. Lines counted: `console.warn("[llm-responder] Intent captured for mutating tool: %s", ...)` at L252; ledger error at L294; DEFER park failure at L401; audit emit failure at L343. These bypass the structured log pipeline.
- `apps/api/src/subscribers/defer-resolver.ts` accepts a `FastifyBaseLogger?` and uses `log.info` / `log.debug` correctly. But the subscriber is started from `index.ts` so the log it receives is the standalone module logger, not the request-scoped one.
- **Gap:** kernel decisions are not correlatable to a request id. Pino's `reqId` lives in Fastify's child logger; the responder runs deep inside `runOrchestrator` and has no logger reference threaded through.

### Metrics

- **No `MetricsSink` is installed.** `@adjudicate/core/kernel` exposes `setMetricsSink(MetricsSink)` (`/Users/thaisrodolpho/projects/adjudicate/packages/core/src/kernel/metrics.ts`) with default `noopSink()`. A grep for `setMetricsSink|MetricsSink` across ibatexas returns zero hits.
- Therefore `recordLedgerOp`, `recordDecision`, `recordRefusal`, `recordSinkFailure`, `recordShadowDivergence`, `recordResourceLimit` are no-ops in production. The runbook references to `kernel_decision_total{kind="..."}`, `kernel_refusal_total{basis="..."}`, `kernel_defer_resume_duration_seconds`, `kernel_shadow_divergence_total`, `ledger_hit_ratio` are **aspirational** — no metric backend renders them.
- **No Prometheus exporter, no `/metrics` endpoint, no StatsD client** in `apps/api/`.

### Tracing

- **No OpenTelemetry, no Honeycomb, no Datadog APM, no NewRelic.** `apps/api/package.json` lists `@sentry/node ^10.45.0`; that's it for runtime telemetry. Sentry tracing is initialised at `tracesSampleRate: 0.1` (`apps/api/src/plugins/sentry.ts:14`) but no kernel spans are created.
- Sentry's `onError` hook captures Fastify-level errors but never sees a kernel REFUSE (because REFUSE is a successful tool result from Fastify's perspective).

### Analytics events

- `apps/web/src/domains/analytics/events.ts` (the `AnalyticsEvent` union) declares the kernel observability events at lines 106–114:
  - `audit_kernel_shadow_diverged_basis`
  - `audit_kernel_shadow_diverged_kind`
  - `audit_kernel_shadow_diverged_rewrite`
  - `audit_decision_executed`
  - `audit_decision_refused`
  - `audit_ledger_hit`
  - `audit_nats_sink_failed`
  - `audit_replay_divergence`
- **None of these are emitted.** Grep across the repo for any `track("audit_kernel_*")` or `track("audit_decision_*")` returns zero matches outside the union declaration. The runbooks' "watch in PostHog" instructions therefore have nothing to watch.
- PostHog *is* wired (`apps/web/src/lib/posthog.ts`, server-side via `POST /api/analytics/track` per `docs/ops/analytics-dashboards.md`) — the wire is there, the kernel just never sends.

### NATS audit subjects

- Audit sink wires the framework `createNatsSink` to `@ibatexas/nats-client`'s `publishNatsEvent` (`packages/llm-provider/src/intent-audit-wiring.ts:27`).
- Configured subject: `"audit.intent.decision.v1"` (matches the platform-side default at `/Users/thaisrodolpho/projects/adjudicate/packages/audit/src/sink-nats.ts:73`).
- IbateXas's NATS client prepends `ibatexas.` → resulting wire subject: `ibatexas.audit.intent.decision.v1`.
- **No subscriber listens on this subject.** Grep across `apps/api/src/subscribers/` for `audit.intent` returns zero hits. Records are published but only the ConsoleSink (which prints to stderr) actually surfaces them. The "durable streaming trail" promised in `intent-audit-wiring.ts:9` does not exist downstream.
- **Recommended subject naming convention:** the framework default `audit.intent.decision.v1` plus version bumps via `.v2` etc. when the AuditRecord schema breaks. Consider sibling subjects for high-volume signals: `audit.intent.defer.v1` (park events), `audit.intent.resume.v1` (resume events), `audit.ledger.op.v1` (ledger check/record latency stream). All under the `ibatexas.` prefix per house convention.

---

## Runbooks status

Read of `docs/ops/runbooks/{01..05}*.md`:

| Stage | File | Length | Quality | Critical gaps |
|---|---|---|---|---|
| 1 — Read-like mutations | `01-stage-read-mutations.md` | 123 lines | Strong — clear pre-flight, smoke, observation thresholds, post-stage template | Assumes `audit_kernel_shadow_diverged_*` events flow to PostHog — they do not. Assumes Sentry alerts on these — none configured. |
| 2 — Cart / order updates | `02-stage-cart-mutations.md` | (read first 40 lines; structure matches Stage 1) | Strong | Same — relies on metrics that don't exist. |
| 3 — Checkout / order submission | `03-stage-checkout-mutations.md` | (read first 40 lines) | Strong — explicitly warns about mid-flow stranding | Same; also references `ibx db check:slots` which may not exist. |
| 4 — Financial reversals | `04-stage-financial-mutations.md` | (read first 40 lines) | Strong — requires 14-day window, two-person on-call, ledger flags staged, Postgres audit lag <30s | Postgres audit sink (`@adjudicate/audit-postgres`) referenced but no Prisma migration / table in ibatexas. `defer-resolver.ts` smoke test is described but no automated regression harness. |
| 5 — `@adjudicate/pack-payments-pix` intent kinds | `05-stage-pix-charge-pack.md` | 106 lines | Strong — explicit replay harness, pack version pinning, two-person on-call | References `kernel_decision_total{...}` Prometheus-style metrics + `npx ibx kernel replay --intent-kind ...` CLI that may not be implemented in `packages/cli/`. |

The runbooks are **well-written and operationally rigorous**, but they describe a target observability posture that the codebase has not implemented yet. Following them as-written today would produce a "smoke test passed because no events fired" false negative.

---

## Alerting gaps (what should page)

Recommendations for what an on-call engineer needs paged on before flipping any stage to ENFORCE. None of these exist today.

| Signal | Detect | Severity | Action threshold |
|---|---|---|---|
| **Sustained REFUSE rate spike** | `kernel_refusal_total{kind=X}` rate > 2× rolling 24h baseline for 5 min | S1 (page on-call) | Possible policy bug, customer impact; investigate within 15 min |
| **Decision-kind divergence in shadow mode** | Any `audit_kernel_shadow_diverged_kind` event for an intent kind in `IBX_KERNEL_SHADOW` | S2 (page on-call) | Forbid enforce flip until investigated; per runbook 01 |
| **Payload-rewrite divergence in shadow mode** | Any `audit_kernel_shadow_diverged_rewrite` event | S2 (page on-call) | Manual review required per runbook 01 |
| **Decision latency spike** | p99 `kernel_decision_duration_seconds{kind=X}` > 100ms for 5 min | S2 (page on-call) | Slow guard or contention; investigate within 30 min |
| **Audit sink backpressure** | `audit_nats_sink_failed` rate > 0 sustained 1 min; or `recordSinkFailure` consecutiveFailures > 5 | S2 (page on-call) | Audit trail compromised; compliance risk; investigate within 30 min |
| **Ledger backpressure / unavailability** | `LedgerUnavailableError` count > 0 in 1 min (i.e. `IBX_LEDGER_FAIL_OPEN=false` is active and circuit is open) | S1 (page on-call + WhatsApp owner) | Mutations refused with `SECURITY/ledger_unavailable`; if fail-open is true, alert at warn instead of page |
| **DEFER timeout rate** | `kernel_defer_timeout_total{kind=X}` rate > 0 (intents parked past `timeoutMs` without resume) | S1 (page on-call) | PSP outage or `defer-resolver.ts` regression; customer money status unknown |
| **DEFER park/resume p99 latency** | `kernel_defer_resume_duration_seconds` p99 > 5s for `pix.charge.confirm` per runbook 05 | S2 | NATS lag or Redis SCAN slowness |
| **Parked envelope quota** | `recordResourceLimit({resource:"defer_quota"})` count > 0 | S2 | A session is accumulating parks (potential abuse or stuck flow) |
| **Replay divergence** | Daily `ibx kernel replay` job emits non-zero divergence | S1 (page on-call) | A code change broke determinism; gate the release |
| **Postgres audit lag** | `intent_audit` write-lag > 30s per runbook 04 | S2 | Compliance/audit risk |
| **Tool-call success rate drop post-enforce** | `tool_call_success_rate{kind=X}` drops > 5% vs prior week per runbook 01 | S1 (page on-call + trigger rollback) | Stage rollback procedure |

The escalation tree should also include the existing BetterStack uptime channel (email + WhatsApp via Twilio, per `docs/ops/uptime-monitoring.md`). Kernel-specific PagerDuty integration is referenced as `intent-kernel` in runbook 01 but no integration config exists in the repo.

---

## Recommendations

Ordered by what unblocks the rollout fastest.

### P0 — must land before Stage 1 ENFORCE

1. **Wire a real `MetricsSink`** in `apps/api/src/index.ts` (or a new `apps/api/src/plugins/kernel-metrics.ts`). The sink should: (a) emit a `track()` call for each event into the existing PostHog pipeline using the names already declared in `AnalyticsEvent`; (b) optionally write the same payload to Sentry as breadcrumbs; (c) for Prometheus-style metrics, ship a minimal `prom-client` exporter on a `/metrics` endpoint, gauges/counters keyed by `intentKind` + `decision.kind`.

2. **Write the kernel-contract test suite** (`packages/llm-provider/src/__tests__/kernel-contract.test.ts`). One `describe` per intent kind in the union; for each, a table of `(envelope, state) → expected Decision` rows. Aim ≥ 60 cases to cover all guards. This is the single highest-leverage test investment: it replaces the manual smoke steps in every runbook.

3. **Write a DEFER round-trip integration test** that talks to a real Redis (or ioredis-mock) and a NATS test stub. Verify:
   - Park: `defer:pending:<sid>` key written with correct shape + TTL.
   - Resume: subscriber callback invoked, `resumeDeferredIntent` returns `{ resumed: true, intentHash }`, the parked key is deleted, the resume-dedup key `defer:resumed:<hash>` is set NX.
   - Duplicate webhook: second delivery returns `{ resumed: false, reason: "duplicate_resume_suppressed" }`.

4. **Write a shadow-mode test for `adjudicateWithShadow`** — assert that when legacy says EXECUTE and kernel says REFUSE, the `MetricsSink.recordShadowDivergence` is called with `divergence: "DECISION_KIND"` and the legacy result is the one returned.

5. **Write an enforce-mode test** — set `IBX_KERNEL_ENFORCE=order.submit`, drive an unauthenticated `order.submit` envelope through the responder fake, assert `onToolIntent` is not called and the tool result content includes `"status": "refused"`.

6. **Wire `audit_decision_executed` and `audit_decision_refused` emissions** in `llm-responder.ts` immediately after the audit-sink emit. Currently the events are only declared in the union, not fired.

7. **Add a "bypass detection" test** — assert that the responder refuses to dispatch a tool whose execution result has no `envelope`. Today line 331 of `llm-responder.ts` silently EXECUTEs that case (`decision = legacyDecisionAsKernelDecision({ kind: "EXECUTE" })`). This is the silent-bypass vulnerability the runbook 04 audit-trail diff is supposed to catch.

### P1 — before Stage 4 ENFORCE

8. **Write `intent-ledger` fail-open/fail-safe tests** — both `IBX_LEDGER_FAIL_OPEN=true` and `false`. Cover `CircuitOpenError` from `safeRedis("critical", ...)`.

9. **Add an `audit.intent.decision.v1` NATS subscriber** in `apps/api/src/subscribers/audit-trail.ts` that writes records to either Postgres (`intent_audit` table — needs Prisma migration) or an S3-archived JSON-lines file. Without a subscriber, the durable trail required by Stage 4 compliance pre-flight does not exist.

10. **Build the `ibx kernel replay` CLI** in `packages/cli/src/replay.ts` referenced by runbook 05. Read audit records from Postgres or the JSON-lines archive, re-feed each through `adjudicate()` with the recorded state, diff the decision. Mark divergences. Schedule it as a daily job during shadow windows.

### P2 — before any S2 alert fires

11. **Replace `console.warn` with the request-scoped pino logger** in `llm-responder.ts`. Thread the logger through `runOrchestrator → runAgent → llm-responder` so kernel decisions carry `reqId` and can be correlated in CloudWatch.

12. **Wire the alerting rules** in Sentry + (a new) Grafana/PagerDuty config matching the table in "Alerting gaps". Each rule needs runbook link, on-call rotation binding, and a saved query.

13. **Add a per-stage smoke test script** under `tests/e2e/` matching each runbook's smoke section. Drive it via the existing Playwright API project against a staging environment.

14. **Document test infrastructure** — add a top-level `tests/README.md` covering the vitest setup absence, how to mock Redis/NATS, and the `_resetAuditSink` / `_resetLedger` hooks. Currently every test reinvents this in `beforeEach`.

### Effort estimate

- P0 items (1–7): **~6–9 engineer-days** for one person familiar with the codebase. The kernel-contract test suite is the bulk (3–4 days) because it requires building fixture envelopes and states for every intent kind in the migration scope.
- P1 items (8–10): **~5–7 engineer-days**. The Postgres audit sink + Prisma migration is the bulk (2–3 days); the replay CLI is another 2 days.
- P2 items (11–14): **~3–5 engineer-days**, mostly mechanical wiring.

**Total to reach migration-grade coverage: ~15–20 engineer-days.** Below 15 is dangerous (you'll go live without replay coverage); above 20 is over-engineering for Phase 1 of the migration. The minimum viable set to flip Stage 1 ENFORCE is P0 items 1–7, roughly one engineer-week.
