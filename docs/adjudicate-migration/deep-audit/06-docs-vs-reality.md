> ⚠️ **SUPERSEDED on 2026-05-24.** Pre-cutover doc/reality drift audit (2026-05-23). Drove the doc cleanup arc that culminated in the civilization-health 2026-05-24 sweep. The SHADOW-ENFORCE-ROLLOUT runbook this audit walks no longer exists (archived in `f87fb0b` under `../superseded/`). For current state, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md) and [`../CIVILIZATION-HEALTH-2026-05-24.md`](../CIVILIZATION-HEALTH-2026-05-24.md). Content preserved unchanged below as historical record.

---

# Documentation vs Reality Audit

**Auditor:** Documentation vs Reality Auditor (deep-audit wave)
**Date:** 2026-05-23
**Scope:** Every operator-facing markdown in `docs/adjudicate-migration/**` plus `CLAUDE.md` + `docs/PROJECT_STATE.md`.
**Method:** Each concrete claim (file:line, command, env var, metric, intent kind) checked against source code at `feat/adjudicate-w6-tests-docs` HEAD.

## Methodology

1. **Read each governance / migration / remediation / runbook doc end-to-end.**
2. **For each concrete claim**, open the cited code path. Three verdicts:
   - **VERIFIED** — claim matches code today.
   - **DRIFT** — was once true (or partially true); code has since moved.
   - **GHOST** — never existed in code; doc invented or aspirational and never marked as such.
3. **Walk the SHADOW-ENFORCE-ROLLOUT runbook as if it were 03h00 and Sentry is paging.** Every CLI command typed; every URL clicked; every metric grepped.
4. **Cross-reference REMEDIATION-COMPLETE.md against the actual W1–W6 code changes** to find P0 closures whose evidence in source is weaker than claimed.

I checked **~140 concrete claims** across 19 documents.

| Status | Count |
|---|---|
| VERIFIED | ~92 |
| DRIFT | ~32 |
| GHOST | ~16 |

---

## Per-doc drift inventory

### `CLAUDE.md` — top-level agent guide

| Claim | Status | Severity | Notes |
|---|---|---|---|
| Rule #9: LLM is a semantic parser with zero state-mutation authority | **VERIFIED (in the LLM path only)** | n/a | `executeToolDirect` removed; `onToolIntent` is wired at `agent.ts:352`; `TOOL_CLASSIFICATION` at `packages/llm-provider/src/machine/types.ts:378`. But the rule is silent that **47 HTTP routes, ~50 Prisma writes, and 32 NATS subscribers still bypass the kernel** (Master Plan §"Current state — the gap"). An LLM agent reading rule #9 will think governance is total; it is not. |
| Rule #9: "IBX_KERNEL_SHADOW / IBX_KERNEL_ENFORCE parsed in enforce-config" | **VERIFIED** | low | `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/kernel/enforce-config.ts:36-67`. |
| Rule #9: "Execution dedup gated by IBX_LEDGER_ENABLED / _ENFORCE / _FAIL_OPEN" | **VERIFIED** | low | `packages/llm-provider/src/intent-ledger.ts:40`. |
| Rule #9: "PIX charge lifecycle lives in @adjudicate/pack-payments-pix … order-policy-bundle.ts composes the Pack's createPixPendingDeferGuard" | **DRIFT** | medium | The composition has moved into `packages/pack-orders/src/policies.ts:282`, not `order-policy-bundle.ts`. The latter file still exists in `packages/llm-provider/src/order-policy-bundle.ts` but its top docstring says "re-exports pack-orders policy bundle for backwards compat" (D8). Operators looking at the cited file will not find the guard composition there. |
| Rule #9: "see docs/ops/runbooks/ for the 4-stage playbook" | **DRIFT** | high | Those runbooks (`01-stage-read-mutations.md` … `05-stage-pix-charge-pack.md`) are **pre-migration artifacts** from 2026-03 that pre-date W1–W6. The actual current operator playbook is `docs/adjudicate-migration/runbooks/SHADOW-ENFORCE-ROLLOUT.md`. An operator following the pointer in rule #9 lands on stale 4-stage docs instead of the W6 runbook. |
| Rule #10: Redis locks via UUID + Lua release; "see `apps/api/src/whatsapp/session.ts`" | **VERIFIED** | low | `apps/api/src/whatsapp/session.ts:106,230,259` uses `redis.eval(...)` with `ROTATE_SESSION_SCRIPT`, `EXTEND_LOCK_SCRIPT`, `RELEASE_LOCK_SCRIPT`. The bypass-detection test (`apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:466-499`) enforces this for new code via W6-8. |
| All other rules (1-8) | **VERIFIED** | n/a | Spot-checked rk(), centavos, allergens — match code. |

### `docs/PROJECT_STATE.md`

| Claim | Status | Severity | Notes |
|---|---|---|---|
| Whole document dated 2026-03-31 | **STALE** (not drift per se, but harmful) | high | Pre-dates the entire adjudicate migration. Marks LLM architecture as "Zero-Trust" and lists `executeTool()` as the bridge — both reflect a pre-W1 state. An LLM agent reading PROJECT_STATE before the migration docs would think the kernel was never built. |

### `MASTER_PLAN.md`

| Claim | Status | Severity | Notes |
|---|---|---|---|
| TL;DR: "onToolIntent is never wired in agent.ts:329" | **DRIFT** | high | `agent.ts:352` now wires `onToolIntent: (intent) => dispatch(intent, context)`. W1 closed this; Master Plan was not updated. |
| TL;DR: "MetricsSink is never installed, so every kernel metric is a no-op" | **DRIFT** | high | `installKernelMetricsSink()` in `apps/api/src/plugins/kernel-bootstrap.ts:96-...` is called from `apps/api/src/server.ts:49`. Prometheus, PostHog, Sentry are all wired. |
| TL;DR: "the MetricsSink is never installed, so … the runbooks reference Prometheus counters and a CLI that don't exist" | **PARTIAL DRIFT** | n/a | Counters now exist (W1+W5-9). CLI exists (`ibx kernel status/replay/divergence`). But `ibx kernel kill-switch` is still GHOST (see migration/05 below). |
| TL;DR: "47 mutating HTTP routes, ~50 Prisma mutation sites, 32 NATS/queue handlers — 0% adjudicated" | **PARTIAL DRIFT** | medium | W3 wrapped refund / retry / regenerate-pix / amend-order. W1+W3 wrapped admin-reservation cancel, no-show-checker. Real number today is ~20-30% adjudicated, not 0%. But the plan never restates it. |
| WS5 deliverables: "ibx kernel status, replay, divergence" | **VERIFIED** | low | All three exist in `packages/cli/src/commands/kernel.ts:567-600`. |

### `governance/01-intent-taxonomy.md`

| Claim | Status | Severity | Notes |
|---|---|---|---|
| "Total in this taxonomy union: 67 intent kinds" | **DRIFT** | low | Doc-acknowledged: the table arithmetic is 19+14+8+14+6+6 = 67 (taxonomy view) but `KNOWN_INTENT_KINDS` runtime = 62 (per `intent-kinds.ts:188-195`). The drift section explicitly enumerates the deltas. Operators reading the top get 67; runtime check yields 62. |
| `order.cart.ensure | kernel-executor.ts:282 (ensureCart())` | **DRIFT** | low | Actual ensureCart call is at `kernel-executor.ts:519`. Line 282 is the `parkDeferredIntent` payload block (added in W2). |
| `order.item.add | kernel-executor.ts:282 (addItemToCart)` | **DRIFT** | low | Actual addItemToCart call sites are at `kernel-executor.ts:564,605`. |
| `order.checkout.create | kernel-executor.ts:366 (processCheckout)` | **DRIFT** | low | Actual processCheckout call is at `kernel-executor.ts:710`. |
| `order.cancel | kernel-executor.ts:425 (cancelOrderAction)` | **DRIFT** | low | Actual cancelOrderAction is defined at line 340; called at line 792. |
| `payment.pix.regenerate | kernel-executor.ts:449 (regeneratePixAction)` | **DRIFT** | low | Actual regeneratePixAction is defined at line 360; called at line 856. |
| `order.cancel.system | apps/api/src/jobs/stale-order-checker.ts:60-130` | **DRIFT** | low | The transition site is at line 139 (`kind: "order.status.transition" as const`). Note: stale-order-checker now publishes an `order.status.transition` envelope, NOT `order.cancel.system` (taxonomy is aspirational here). |
| `reservation.create | reservation.service.ts:270` | **DRIFT** | low | Actual `create` method is at `reservation.service.ts:288`. |
| `reservation.modify | reservation.service.ts:336-345` | **DRIFT** | low | Actual `modify` is at line 343. |
| `reservation.cancel | reservation.service.ts:371-376` | **DRIFT** | low | Actual `cancel` is at line 404. |
| `reservation.no_show.mark | reservation.service.ts:400-405` | **DRIFT** | low | Actual transition method (`transitionStatus`) for noShow is at line 431. |
| `reservation.waitlist.notify | reservation.service.ts:428 (promoteWaitlist)` | **DRIFT** | low | Actual promoteWaitlist is at line 459. |
| `reservation.waitlist.join | reservation.service.ts:468` | **DRIFT** | low | Actual waitlist join is at line 494. |
| `customer.loyalty.stamp.award | loyalty.service.ts:25,32` | **DRIFT** | low | Actual addStamp is at line 19; lines 25/32 reference the internal `prisma.update` blocks. |
| `customer.loyalty.redeem | loyalty.service.ts:12 redemption path` | **GHOST** | medium | **No redemption method exists in loyalty.service.ts.** Line 12 is `getOrCreateAccount`. The redemption logic is folded into `addStamp`'s reward branch. This is a kind in the taxonomy with no callable surface. |
| `customer.welcome_credit.grant | apps/api/src/whatsapp/session.ts (setWelcomeCredit)` | **VERIFIED** (no line cited) | low | Actual location: `apps/api/src/whatsapp/session.ts:376`. |
| `whatsapp.message.send | subscribers/cart-intelligence.ts:665 (notification.send handler)` | **DRIFT** | low | Actual `subscribeNatsEvent("notification.send", ...)` is at `subscribers/cart-intelligence.ts:790`. |
| `subscribers/cart-intelligence.ts:446` paymentCmdSvc.create | **DRIFT** | low | Spot check failed: the cited site does not match. Need a fresh sweep. |
| The 5 taxonomy-only kinds NOT in `KNOWN_INTENT_KINDS` | **DRIFT** | low | Doc lists them in the "runtime delta" table: `customer.session.*`, `customer.loyalty.*`, `customer.welcome_credit.*`, `whatsapp.handoff.request`, `whatsapp.followup.schedule`, `whatsapp.outreach.send`, `system.*`, `order.cancel.force`. That's well over 5 — the "5 taxonomy-only" framing in the prompt is misleading; doc honestly lists ~21 differences. |

### `governance/04-decision-policy.md`

| Claim | Status | Severity | Notes |
|---|---|---|---|
| Refund > R$500 → ESCALATE; R$500-R$1000 → REQUEST_CONFIRMATION | **DRIFT** (off by 2x) | high | Pack-payments code (`packages/pack-payments/src/types.ts:340-355`): default CONFIRM threshold = R$500 (50_000); default ESCALATE threshold = R$1000 (100_000). So actual behaviour is: amount ≥ R$500 AND < R$1000 → REQUEST_CONFIRMATION; amount ≥ R$1000 → ESCALATE. The doc says "Refund > R$500" → ESCALATE which is the wrong threshold. |
| Large-ticket checkout: "Cart total > R$2000 (large-ticket policy)" → ESCALATE for `order.checkout.create` | **DRIFT** | high | Pack-orders code (`packages/pack-orders/src/policies.ts:418-432`): "Large-ticket checkout — REQUEST_CONFIRMATION at or above R$1.000 (100_000 centavos)". Both threshold (R$2000 vs R$1000) and decision kind (ESCALATE vs REQUEST_CONFIRMATION) are wrong. |
| `customer.anonymize | DEFER (24h grace, signal customer.anonymize.confirmed_after_grace)` | **VERIFIED** | low | Code in pack-customer-onboarding uses the same signal name. |
| The full 6 decision kinds with `decisionExecute/Refuse/Defer/Escalate/RequestConfirmation/Rewrite` constructors | **VERIFIED** | low | All present in `@adjudicate/core/kernel`. |
| Refusal taxonomy table (15+ codes) | **VERIFIED** (spot-checked 4 codes) | low | `kill_switch_active`, `default_deny`, `pix_pending`, `ledger_replay_suppressed` all present in basis-codes + portugueseRefusalMessages. |

### `governance/05-audit-replay-requirements.md`, `06-deferred-execution-policy.md`, `07-rollback-recovery.md`

Spot-checked. The replay requirements doc references `replayWithIntegrity` (exists in `@adjudicate/audit`) but the report does NOT verify `classifyReplayDrift` exists. **`classifyReplayDrift` is GHOST** — REMEDIATION-COMPLETE.md acknowledges this as F2 follow-up but several governance docs use it as an in-spec primitive.

### `runbooks/SHADOW-ENFORCE-ROLLOUT.md`

See "Runbook walkthrough findings" below.

### `threat-model/THREAT-MODEL.md`

| Claim | Status | Severity | Notes |
|---|---|---|---|
| "trust boundaries diagram match the auth code in `staff-auth.ts` + `customer-jwt.ts`" | **PARTIAL GHOST** | medium | `apps/api/src/middleware/staff-auth.ts` exists. **No `customer-jwt.ts` file exists.** Customer JWT logic lives inline in `apps/api/src/routes/auth.ts`. The threat model's trust boundary 1 ("UNTRUSTED → kernel") references a file that doesn't exist. |
| Asset inventory: customer PII, payment data, order state, audit records | **VERIFIED** | n/a | Covered. |
| Asset inventory missing: kernel metrics endpoint, audit-postgres, Sentry | **DRIFT** (incompleteness) | low | The threat model lists "Pack policy code" as an asset but does not enumerate `/metrics` (Prometheus scrape), the `intent_audit` table, or Sentry breadcrumbs as separate assets despite each having a distinct sensitivity profile. |
| Residual risks list (1-8) vs deferred items in REMEDIATION-COMPLETE | **VERIFIED** | low | Match: P0-12 NATS, P1-H API-key, P1-E sweeper PagerDuty, P0-14 audit-postgres SQL, P0-15 audit redactor hash, F2 classifyReplayDrift. |

### `remediation/REMEDIATION-COMPLETE.md`

| Claim | Status | Severity | Notes |
|---|---|---|---|
| "P0 closed in-codebase: 13 of 15" | **VERIFIED** | low | Spot-checked P0-1 (refund magnitude), P0-6 (installPack fail-fast), P0-9 (typo gate), P0-10 (actor.sessionId hash). All confirmed in code. |
| "Governance coverage: pack-orders 22 / pack-payments 17 / pack-reservations 7 / pack-whatsapp 8 / pack-customer-onboarding 8 = 62 kinds" | **DRIFT** | medium | **Code reality: pack-reservations 8 (not 7), pack-whatsapp 4 (not 8).** Per `packages/pack-reservations/src/index.ts:183-192` and `packages/pack-whatsapp/src/index.ts:175-180`. Total 62 still adds up because the doc omits `@adjudicate/pack-payments-pix` (3 kinds) and the per-pack arithmetic is off. |
| Test count: "@ibatexas/api tests 911" | **NOT INDEPENDENTLY VERIFIED** | n/a | I did not run the suite; the doc itself notes 3 known failures in `cli/.../kernel.test.ts` from the pre-W5 baseline. |
| "ibx kernel divergence implementation beyond stub" | **VERIFIED** | low | Real implementation in `packages/cli/src/commands/kernel.ts:336-559`. |

### `remediation/NATS-AUTH-REQUIREMENTS.md`

Walked through every operator step. **All commands and env var names align with code in `packages/nats-client/src/index.ts`**: `NATS_CREDS_PATH`, `NATS_NKEY_SEED`, `NATS_TLS_CA`, `NATS_TLS_REQUIRED` all consumed exactly as documented (lines 62, 67, 82, 83). The `nsc` invocations are NATS-tooling-standard. The validation checklist (line 138) is testable. **VERIFIED end-to-end.** Highest-quality operator doc in the migration set.

### `decisions-log.md` (D1-D10)

| Claim | Status | Severity | Notes |
|---|---|---|---|
| D1: sequential branches | **NOT TESTABLE in code** | n/a | Workflow decision; not auditable here. |
| D7: STATE_TOOLS partition into `visibleReadTools` + `allowedIntents` | **VERIFIED** | low | `packages/llm-provider/src/capability-planner.ts` implements `partitionTools` and exports the wrapped planner via `safePlan(...)` at line 234. |
| D8: parallel `*FromEnvelope` surface, not breaking replacement | **VERIFIED** | low | `customer.service.ts:346` has `updatePixDetailsFromEnvelope`; `reservation.service.ts` has `createFromEnvelope/modifyFromEnvelope/cancelFromEnvelope`. Both legacy and envelope-typed surfaces coexist. |
| D9: REMOVE `slot.released` signal | **VERIFIED** | low | `packages/pack-reservations` has no `slot.released` exports; D9 also documented in pack-reservations source. |
| D10: medusa.* namespace excluded from KNOWN_INTENT_KINDS | **VERIFIED** | low | `packages/llm-provider/src/intent-kinds.ts:30-39` explicitly documents the exclusion. `intent-kinds.test.ts` asserts it. |

### `migration/02-milestones.md` and `migration/04-shadow-enforce-sequencing.md`

| Claim | Status | Severity | Notes |
|---|---|---|---|
| 9 milestones (M0-M8) | **VERIFIED** (organizationally) | n/a | These are planning artifacts, not code claims. |
| M0 exit criteria: "ibx kernel status … prints installPack ok; validateEnforceConfig ok; metricsSink installed" | **DRIFT** | low | The bootstrap logs (per `kernel-bootstrap.ts:152-164,213-219`) emit JSON events `kernel.bootstrap.pack_installed` and `kernel.bootstrap.enforce_config_validated`, not literal strings. The runbook-style log line in M0 won't be found by an operator grepping for it. |

### `migration/05-kill-switch-strategy.md` — the most problematic doc

| Claim | Status | Severity | Notes |
|---|---|---|---|
| "Activation surface 2: Admin endpoint. POST /api/admin/kernel/kill-switch" | **GHOST** | **CRITICAL** | **No such route exists.** Searched `apps/api/src/routes/**` and found zero matches for `kill-switch`, `killSwitch`, or `kill_switch`. |
| "Activation surface 3: CLI. `ibx kernel kill-switch enable --global --reason "<message>"`" | **GHOST** | **CRITICAL** | **No such CLI subcommand exists.** `packages/cli/src/commands/kernel.ts:563-600` only registers `status`, `replay`, `divergence`. |
| "Activation surface 4: createDistributedKillSwitchPubSub watches a Redis key + pub/sub channel" | **GHOST** | high | The primitive `createDistributedKillSwitchPubSub` exists in `@adjudicate/audit` but **is not imported or wired anywhere in ibatexas.** No `setKillSwitch(...)` call exists in any production code path. |
| "Boot env var IBX_KILL_SWITCH=1 boots in killed state" | **VERIFIED** | low | `enforce-config.ts:170-180` honours the env var. |
| Per-pack and per-intent kill switches | **GHOST** | high | None of these are wired. The framework offers the primitives; ibatexas hasn't adopted them. |

**This entire document advertises operator-facing controls that do not exist.**

### `migration/06-observability-requirements.md` — metric name drift

The doc declares 6 "contract metrics" plus 12 supporting metrics. Reality:

| Doc metric | Code reality |
|---|---|
| `kernel_decision_total` | **VERIFIED** |
| `kernel_decision_latency_seconds` | **DRIFT — actual name is `kernel_decision_duration_seconds`** |
| `kernel_refusal_total` | **VERIFIED** |
| `kernel_shadow_divergence_total` | **VERIFIED** |
| `kernel_defer_pending_gauge` | **GHOST** |
| `kernel_audit_lag_seconds` | **GHOST** (the runbook also references `kernel_audit_postgres_lag_seconds` which is also GHOST — only a code comment) |
| `kernel_ledger_op_total` | **VERIFIED** |
| `kernel_sink_failure_total` | **DRIFT — actual is `kernel_audit_sink_failure_total`** (sink-failure is audit-only) |
| `kernel_replay_drift_total` | **GHOST** |
| `kernel_replay_drift_count_total` | **GHOST** |
| `kernel_kill_switch_state` | **GHOST** |
| `kernel_kill_switch_toggle_total` | **GHOST** |
| `kernel_pack_install_total` | **GHOST** |
| `kernel_entrypoint_coverage_ratio` | **DRIFT — actual is `kernel_intent_kind_coverage`** |
| `kernel_defer_quota_exceeded_total` | **GHOST** |
| `kernel_defer_timeout_total` | **GHOST** |
| `kernel_defer_resume_duration_seconds` | **VERIFIED** |
| `kernel_audit_sink_failures_total` | **DRIFT — actual is singular `_failure_total`** |
| `kernel_distinct_intent_kinds_observed` | **VERIFIED** (in code but missing from doc) |
| `kernel_known_intent_kinds_total` | **VERIFIED** (in code but missing from doc) |

**Doc says "This document IS the contract. Implementation diverging from these names is a bug." — by the doc's own definition, 11+ bugs are live in the codebase.**

---

## Runbook walkthrough findings

### SHADOW-ENFORCE-ROLLOUT.md — operator walkthrough at 3am

Pretend it is 03h00 BRT. The on-call engineer follows the runbook step by step:

**Step 0 — Pre-flight.**
- "Grafana panel `audit_records_per_minute` reads non-zero for ≥48h." **GHOST metric.** Operator opens Grafana; no panel exists; can't satisfy the gate. Either invents a substitute (dangerous) or aborts (safe).
- "Sentry alerting on `kernel.bootstrap.enforce_config_typo` is on." **VERIFIED** — that event IS emitted by `kernel-bootstrap.ts:198`. But: it fires at boot, not at runtime. The runbook implies it's a runtime alert; it isn't.
- "Shadow-divergence dashboard is open: `https://grafana.{env}.ibatexas.com/d/kernel-shadow` (URL TBD when M4 dashboards deploy)." The runbook self-admits the URL is a placeholder. **The dashboard does not exist.** Operator has no place to look during the soak.

**Step 1 — Flip `IBX_KERNEL_SHADOW`.**
- `IBX_KERNEL_SHADOW=<intent.kind>` propagates through `enforce-config.ts:36-67`. **VERIFIED** — the env-parsing works.
- `ibx kernel status --json | jq '.shadow'` — **VERIFIED** — returns `{ raw, wildcard, kinds }` shape from `kernel.ts:100-115`.

**Step 2 — Monitor for 7 days.**
- "Watch `kernel_shadow_divergence_total{intent_kind="<kind>",divergence="DECISION_KIND"}`" — **DRIFT.** The actual label is `class`, not `divergence` (per `kernel-metrics-sink.ts:464` and the divergence reader in `kernel.ts:472-491`). PromQL using `divergence==` will always return empty.
- "Run `ibx kernel divergence --since=24h --intent-kind=<kind>`" — **DRIFT.** The CLI subcommand does NOT accept `--intent-kind` (per `kernel.ts:594-600`); the option is only on `replay`. Operator runs the command; gets every intent kind in the divergence summary; misinterprets "this kind has 0 divergences" because they can't filter and the global summary buries it.
- "Run `ibx kernel replay --since=24h --intent-kind=<kind>`" — **VERIFIED** — works as documented, but the "drift > 0" check is described as a hard gate while the code itself notes "TODO(audit-replay): re-feed records through adjudicate() with the matching policy bundle … the full re-adjudication harness requires composing the right PolicyBundle per intent kind which we defer". **The replay surface today only prints a kind-by-kind summary; the drift verdict claimed in Step 3 is not produced.**
- "Watch the audit-sink lag panel. `kernel_audit_postgres_lag_seconds` p99" — **GHOST metric.** Cannot watch what doesn't exist.

**Step 3 — Enforce-readiness checklist.**
- "Kill-switch procedure validated in staging within the past 7 days" — **CANNOT BE SATISFIED.** Per migration/05 review, the kill-switch admin endpoint and CLI subcommand are GHOST. Staging cannot validate something that doesn't exist.

**Step 4 — Flip enforce.** Works as documented.

**Step 5 — Observe enforce.**
- "Watch the kernel-decision Grafana panel" — no dashboard exists.
- "Watch Sentry for `kernel_decision_unexpected_*`" — **GHOST.** Not emitted by any code.
- "Watch `ibx dlq list`" — **VERIFIED** — exists and now uses SCAN (W6-9) so it includes `audit.intent.decision.v1`.

**Kill-switch procedure.**
- The runbook's "short form" says "Revert the env var: `IBX_KERNEL_ENFORCE=<other.kinds.but.not.this.one>`" — **VERIFIED.** This is the only kill switch that actually works today.
- But the runbook elsewhere ("Step 0 #5") references rehearsing the kill switch via `migration/05-kill-switch-strategy.md`, which advertises HTTP/CLI surfaces that don't exist.

### Verdict on the runbook

A meticulous operator can execute Steps 1, 4, and 5 (the env-var flips and the `ibx kernel status` check). Step 0 fails on missing dashboards. Step 2's monitoring loop relies on three metrics that don't exist (`audit_records_per_minute`, `kernel_audit_postgres_lag_seconds`, `kernel_decision_unexpected_*`) and one PromQL label that's wrong (`divergence` vs `class`). Step 3's gate (replay drift) can't be verified at the rigor the runbook implies. The 3am operator following this runbook will either (a) fly blind, or (b) page the migration lead because none of the URLs work.

### NATS-AUTH-REQUIREMENTS.md — exec steps

I walked the 7-step procedure. Every command works as written. Every env var is honoured by `packages/nats-client/src/index.ts`. The doc would survive a real 3am incident — it's the gold standard in this set.

---

## Critical drift: docs say X but code says Y

These are the drifts that would mislead a competent reader badly:

1. **migration/05 advertises a kill-switch admin endpoint and CLI subcommand that do not exist.** An operator told "engage the global kill switch" via the documented surfaces cannot do so. The only working kill switch is `IBX_KILL_SWITCH=1` at boot.
2. **migration/06 contract metrics: 11+ metric names in the doc are wrong or non-existent.** A Grafana operator building dashboards from the doc gets blank panels. Worse: the doc itself says diverging implementation is "a bug" — but the implementation, not the doc, is what shipped.
3. **SHADOW-ENFORCE-ROLLOUT references metrics + Grafana URLs + Sentry events + the kill-switch as if they existed.** Three or four of these are placeholders or ghosts. The runbook should self-flag.
4. **04-decision-policy refund thresholds are off by 2x** (R$500 → ESCALATE in doc; R$500 → REQUEST_CONFIRMATION in code; R$1000 is the actual ESCALATE point). For an admin processing a R$700 refund, the doc says "ESCALATE" but they'll get a REQUEST_CONFIRMATION prompt — the surprise is benign here, but it's a fingerprint of doc-rot in the most security-sensitive table.
5. **04-decision-policy large-ticket threshold for `order.checkout.create` is wrong on both threshold (R$2000 vs R$1000) and decision kind (ESCALATE vs REQUEST_CONFIRMATION).** Same flavour as #4.
6. **REMEDIATION-COMPLETE's per-pack kind table has wrong counts for pack-reservations (claims 7, code has 8) and pack-whatsapp (claims 8, code has 4).** Total 62 still adds up due to compensating errors, which makes the drift slippery.
7. **`customer.loyalty.redeem` kind in the taxonomy has no callable code surface.** The redemption logic is folded into `addStamp`'s reward branch in `loyalty.service.ts:23-30`. A pack-loyalty author looking for the intent's executor will find nothing.
8. **CLAUDE.md rule #9 pointer "see docs/ops/runbooks/" lands on stale 4-stage runbooks** from the pre-migration era. The current operator playbook is `runbooks/SHADOW-ENFORCE-ROLLOUT.md` in the adjudicate-migration tree.
9. **threat-model references `customer-jwt.ts`** which doesn't exist; the inline JWT logic in `routes/auth.ts` is the real code.
10. **classifyReplayDrift is GHOST framework-side.** Multiple governance docs treat it as in-spec; remediation acknowledges it as F2. Daily replay claims in MASTER_PLAN §"Success criteria" cannot be satisfied without it.

---

## Operator-trap inventory (manual steps that look easy but break)

These are the spots where the documentation reads cleanly but a literal-minded operator gets bitten:

1. **"Run `ibx kernel divergence --since=7d --intent-kind=reservation.create`"** (runbook §"Tier 1 quick reference"). The `--intent-kind` flag is silently ignored by `divergence`; the operator sees aggregate counts and may green-light the flip on the wrong evidence.
2. **PromQL with `divergence="DECISION_KIND"` (runbook §Step 2).** Label is actually `class`. Operator's alert never fires; they assume soak is clean.
3. **"Open the shadow-divergence Grafana panel"** — the URL is a placeholder. Operator either invents one or skips the gate.
4. **"Sentry alerting on kernel.bootstrap.enforce_config_typo"** — fires at boot only. If an operator edits the env var post-boot (e.g., via ECS task update), the typo guard runs on the next boot. The runbook implies runtime alerting.
5. **"Engage the kill switch via `ibx kernel kill-switch`"** — the CLI subcommand doesn't exist; operator's incident response stalls.
6. **`ibx kernel replay --since=7d` "drift > 0 indicates regression"** — the CLI only emits a summary, not a drift verdict. Operator sees "N records" and assumes drift is 0 because the doc said it would be a number.
7. **REMEDIATION-COMPLETE table off-by-one on pack counts.** A team auditing coverage by running per-pack counts will see a mismatch and waste an hour reconciling.
8. **Taxonomy file:line references mostly correct on which file but wrong on which line** (e.g. ensureCart at "kernel-executor.ts:282" → actual 519). A reviewer auditing the pack-orders intent surface against the kernel-executor will follow the wrong lines.
9. **`docs/ops/runbooks/` pre-migration files** (`01-stage-read-mutations.md` through `05-stage-pix-charge-pack.md`) — these are still in the repo, look authoritative, and CLAUDE.md rule #9 still points to them. An LLM agent following CLAUDE.md will read these BEFORE the adjudicate-migration runbook. They predate every W*-tag.

---

## Recommendations

In priority order:

1. **Fix migration/05-kill-switch-strategy.md.** Either implement the documented HTTP/CLI surfaces this week, or rewrite the doc to reflect that only `IBX_KILL_SWITCH=1` (boot-time) + `IBX_KERNEL_ENFORCE` env reversion are real today. **This is the highest-severity drift — kill-switch reads as production-ready in the doc.**
2. **Reconcile migration/06 contract metrics with `kernel-metrics-sink.ts`.** Either rename code or rename doc; pick one. Run the rename against every dashboard/PromQL example in every other doc.
3. **Annotate every dashboard URL in SHADOW-ENFORCE-ROLLOUT with status: PLACEHOLDER / DRAFT / LIVE.** The runbook already has "URL TBD when M4 dashboards deploy" once; do it everywhere.
4. **Fix the refund threshold tables in 04-decision-policy.md** to match `pack-payments/src/types.ts`. Same for the large-ticket order policy.
5. **Either implement `customer.loyalty.redeem` or remove it from the taxonomy.** A kind with no executor is a footgun for future Pack work.
6. **Drop `--intent-kind` from divergence runbook examples** or add the flag to the CLI. Pick one.
7. **Fix the per-pack count table in REMEDIATION-COMPLETE.md.** pack-reservations = 8, pack-whatsapp = 4.
8. **Add a "DOC STATUS" header to MASTER_PLAN.md and PROJECT_STATE.md** noting the W1-W6 deltas. MASTER_PLAN's TL;DR is from before W1 closed and reads as if nothing has been remediated.
9. **Mark `docs/ops/runbooks/01..05` as DEPRECATED** or move them under an `archive/` subdirectory. CLAUDE.md rule #9 should point to `runbooks/SHADOW-ENFORCE-ROLLOUT.md`.
10. **Add a generated "doc-vs-code" CI check** that asserts (a) every cited file:line resolves, (b) every CLI command in a runbook is registered, (c) every metric name in 06-observability-requirements.md appears in `kernel-metrics-sink.ts`. The drift inventory in this report would not have grown to this size if such a check ran on every PR.

---

## Returned summary

(See task return value.)
