> ⚠️ **SUPERSEDED on 2026-05-24.** Pre-cutover SRE/on-call audit (2026-05-23). The shadow-rollout, kill-switch CLI, and observability surface this audit assumed have been deleted by the always-on cutover (`f3bea43`). Current operator-facing surface is `docs/ops/runbooks/kernel-operations.md`. For current outstanding items, see [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md). Content preserved unchanged below as historical record.

---

# Operational Readiness Audit

**Date:** 2026-05-23
**Auditor:** Operational Readiness Auditor (SRE / On-Call Lead perspective)
**Subject:** Adjudicate-kernel shadow-rollout claim
**Reference docs:**
- `docs/adjudicate-migration/runbooks/SHADOW-ENFORCE-ROLLOUT.md` (W6-11 runbook)
- `docs/adjudicate-migration/migration/05-kill-switch-strategy.md`
- `docs/adjudicate-migration/migration/06-observability-requirements.md`
- `docs/adjudicate-migration/migration/07-production-safety-checklist.md`
- `docs/adjudicate-migration/remediation/REMEDIATION-COMPLETE.md`

---

## Methodology

I walked through every claimed operational scenario as the 3am on-call engineer would, asking three questions for each:

1. **Detection** — what alert fires? what dashboard shows the symptom? (verified against `kernel-metrics-sink.ts` and `06-observability-requirements.md`)
2. **Investigation** — what command does the operator type? (verified by reading every `packages/cli/src/commands/*.ts` file)
3. **Recovery** — what's the documented runbook step? does it actually work? (verified by following the runbook against the implementation)

If any of the three is missing or stub-only, the verdict is downgraded.

The CLI surface was inspected against `packages/cli/src/index.ts` registration (line 248-253 lists the documented `kernel` subcommands: `status`, `replay`, `divergence`). Anything beyond those three subcommands does NOT exist regardless of what runbooks claim.

---

## Incident scenario walkthroughs

### INC-1 — Kernel pack drift detected in production

**Symptom:** divergence rate > threshold for `order.checkout.create`.

- **Detection:** `kernel_shadow_divergence_total{intent_kind, class}` counter exists (`kernel-metrics-sink.ts:184-191`). Alert rule `kernel-divergence-decision-kind` is *documented* (`06-observability-requirements.md:339`) but **no Prometheus AlertManager / PagerDuty config exists in `infra/terraform/**` to deploy it.** The metric emits; the alert does NOT fire.
- **Dashboard:** the runbook (`SHADOW-ENFORCE-ROLLOUT.md:44`) says "open `https://grafana.{env}.ibatexas.com/d/kernel-shadow` (URL TBD when M4 dashboards deploy)". Grep finds zero Grafana dashboard JSON in the repo. **Dashboard does not exist.**
- **Investigation:** `ibx kernel divergence --since=1h --intent-kind=order.checkout.create` is wired (`kernel.ts:352-559`) and *does* parse `--since` and `--intent-kind` correctly. BUT: the `--intent-kind` option is parsed (line 597) yet never threaded into the SQL query (line 449 ignores it; `limit: 10_000` only). So the CLI returns **everything in the window**, then groups in-memory and the printed table may include other kinds. Output is functional but the filter is broken.
- **Decision/recovery:** roll back via `ibx kernel kill-switch disable <intent>` — **THIS COMMAND DOES NOT EXIST** (`packages/cli/src/commands/kernel.ts` registers exactly `status`/`replay`/`divergence`; no `kill-switch` subcommand anywhere). Per `05-kill-switch-strategy.md` the admin endpoint `POST /api/admin/kernel/kill-switch` is also missing — no file under `apps/api/src/routes/admin/` references `setKillSwitch`. To rollback the operator must redeploy with a changed `IBX_KERNEL_ENFORCE` env var (~5 min ECS rolling deploy).
- **Verdict:** **NEEDS WORK.** Metric emits; alert + dashboard + kill-switch CLI absent. The 3am operator can't follow the documented "open dashboard → rollback" path.

---

### INC-2 — Audit pipeline backpressure (Postgres write latency > 5s p99)

**Symptom:** Postgres write latency > 5s p99.

- **Detection:** Alert rule `kernel-audit-postgres-lag` (`06-obs.md:342`) expects metric `kernel_audit_lag_seconds_bucket{sink="postgres"}`. **This metric does NOT exist.** `kernel-metrics-sink.ts` only emits `kernel_audit_sink_failure_total` (failures, not lag). There is no histogram named `kernel_audit_lag_seconds` anywhere in `apps/api` or `packages/**`. Per-sink lag is unobservable today.
- **Investigation:** no `ibx audit lag` command exists. The operator would have to query Postgres directly (no `ibx db query` command either). They'd ssh-tunnel into the audit DB and run a hand-written SQL.
- **Recovery:** runbook claims "audit-sink kill-switch enable --audit-sink postgres" (`05-kill-switch-strategy.md:289`) — command does not exist. Bumping Redis spill buffer requires editing `persistentBufferedSink` config and redeploying.
- **Risk:** how much audit data could be lost? `persistentBufferedSink` is supposed to spill to disk; if the sink fails AND the spill fills (1GB threshold per `06-obs.md:328`), records are lost. Disk capacity is not monitored.
- **Verdict:** **NOT READY.** Symptom undetectable because the lag metric is unimplemented; recovery commands don't exist.

---

### INC-3 — Redis outage during peak hours

**Symptom:** Redis ping failing.

- **Detection:** `ibx svc health redis` exists (per `cli/src/commands/svc.ts` registration; verified in `index.ts` help text line 80). Redis failure cascades into all 1) audit spill 2) DEFER park 3) session locks 4) rate limits 5) OTP storage 6) refund drip cap 7) admin confirmation receipts.
- **Operator action:** no documented Redis-outage runbook — search of `docs/ops/` and `docs/adjudicate-migration/runbooks/` returns only `SHADOW-ENFORCE-ROLLOUT.md` (which doesn't address Redis outages).
- **Recovery:**
  - DEFER parks: P0-7 is closed (all three sites now use `parkDeferredIntent`, verified in `kernel-executor.ts:276`, `llm-responder.ts:508`, `routes/me.ts:439,701`). So new parks **fail-loud** when Redis is down rather than silent-loss. BUT: in-flight parks lose their TTL countdown; on recovery, the sweeper's recovery scan (P1-E, `defer-timeout-sweeper.ts:32-48`) catches expired keys *only if the keys are still in Redis* — if Redis lost data during the outage, the parked envelopes are gone.
  - Audit spill: `persistentBufferedSink` spills to disk per `05-kill-switch-strategy.md:171` — should be resilient.
  - OTP / locks: 5-minute outage → all customers can't authenticate, can't checkout, can't anonymize. No graceful degradation.
- **Verdict:** **NEEDS WORK.** Redis is a single point of failure for 7+ subsystems; no documented runbook for the operator; recovery semantics for DEFER and audit spill are not tested in any integration test (verified: no test named `redis-outage-*` exists).

---

### INC-4 — NATS partition / unauth event spike

**Symptom:** subscriber lag, or unauth events detected.

- **Detection:** **NO metric for "unauth events"** exists today because the NATS auth itself is unwired (per `NATS-AUTH-REQUIREMENTS.md`: code path supports auth, server credentials not provisioned, env vars not flipped). Until P0-12 is deployed, every NATS connection is unauthenticated and there is nothing to detect.
- **Operator action:** the runbook references `nats sub`/`nats pub` smoke tests (`NATS-AUTH-REQUIREMENTS.md:140-145`) but those validate post-deploy. No live tool exists for "is unauth traffic currently happening on the bus."
- **Failover:** NATS is provisioned via `infra/terraform/environments/production/nats.tf`. Multi-server failover is not configured in `packages/nats-client/src/index.ts` (which connects to a single `NATS_URL`).
- **Validation:** how does operator confirm safe state? Subscribing to `ibatexas.audit.intent.decision.v1` from a host without creds should be refused. No automated probe exists.
- **Verdict:** **NOT READY.** Per `REMEDIATION-COMPLETE.md:166-180` P0-12 (NATS auth) is DEFERRED — operator must deploy creds before Tier 3+ enforce. Until then there is no detection and no defense.

---

### INC-5 — LGPD violation detection (anonymized customer's data still in audit)

**Symptom:** customer complains that their data wasn't fully purged.

- **Detection:** no metric, no alert. Customer-support-driven.
- **Investigation:** the operator must find audit records for this customer's `actor.sessionId` (which is now a hash per P0-10 remediation — verified at `REMEDIATION-COMPLETE.md:66`). **No `ibx audit search` command exists.** The operator must hand-write SQL against the `intent_audit` table. There is no documented mapping from "phone number" or "email" to the hashed `sessionId`. **Identifying the customer's audit footprint requires the operator to first build the phone→customer mapping → compute the hash → query.** No tool exists for any step.
- **Remediation:** no `ibx audit scrub --customer <id>` command. The operator must hand-write a DELETE query against `intent_audit` after manually identifying every affected row. This is risky and undocumented.
- **Verdict:** **NOT READY.** LGPD obligation enforcement is the entire reason for `customer.anonymize`; the operational follow-through (verify + scrub) has no tool. This is the most-likely real incident given the LGPD enforce risk.

---

### INC-6 — Stripe webhook flood (DDoS or genuine spike)

**Symptom:** webhook RPS > expected.

- **Detection:** Fastify rate-limit plugin (`apps/api/src/plugins/rate-limit.ts`) exists; no specific Stripe-flood alert.
- **Existing defenses (verified):** HMAC verification + 300s replay window + Redis dedup (per `tasks/12-stripe-webhook-governance.md` deliverable).
- **Failure mode if Redis dedup exhausts memory:** Redis returns OOM on `SET`. The webhook handler swallows? — needs verification. If it falls open, replay attacks succeed.
- **Recovery:** `ibx stripe flush` exists (per `index.ts:243` help line) and clears webhook idempotency keys. Useful for stuck-key recovery, not for OOM mitigation.
- **Verdict:** **NEEDS WORK.** Detection of "abnormal Stripe volume" is missing; OOM-on-dedup fallback semantics unverified.

---

### INC-7 — Stuck DEFER intent ("Aguardando confirmação" never resolves)

**Symptom:** customer support ticket.

- **Detection:** **`kernel_defer_pending_gauge` metric documented in `06-obs.md:121` does NOT exist** — `kernel-metrics-sink.ts` has no Gauge by that name. Per-intent DEFER backlog visibility = zero.
- **Investigation:** operator must look up the customer's parked intent. No `ibx defer list --session <id>` command. The operator would `ibx debug redis` (which exists per `index.ts:171`) with pattern `defer:pending:*` then inspect a specific key. Workable but tedious.
- **Manual resume CLI:** does NOT exist. Operator must hand-publish an `intent.defer.resume` NATS event via raw `nats pub` from a host with credentials. No `ibx defer resume <hash>` command.
- **If sweeper broken:** the P1-E recovery scan (`defer-timeout-sweeper.ts:32-48`) handles startup recovery, AND a heartbeat key `heartbeat:defer-sweeper` exists. Operator action when heartbeat is stale: restart the API process. No documented PagerDuty alert on stale heartbeat (per `REMEDIATION-COMPLETE.md:209`: "PagerDuty wiring for sweeper heartbeat is operator-side").
- **Verdict:** **NEEDS WORK.** Sweeper is reasonably robust (recovery scan + heartbeat) but operator-side observability (gauge, alert, manual-resume CLI) is missing.

---

### INC-8 — Refund drip cap hit unexpectedly during legitimate operations

**Symptom:** legitimate staff can't process refunds, see drip-cap refusal.

- **Detection:** runbook for refund drip cap is `payments.ts:503-510` — emits `admin.refund.drip_cap_exceeded` event. No alert wired to PagerDuty.
- **Operator action:** clear the daily counter. The Redis key shape is `refund:daily-total:${actor}:${day}` (`payments.ts:117`). **No `ibx refund flush-cap` or `ibx admin clear-drip` command exists.** Operator must `redis-cli DEL` against the live cluster, hand-computing the key with the `rk()` prefix. CLAUDE.md rule #7 explicitly forbids building raw key strings inline — but the operator has no other choice today.
- **Audit trail:** the event `admin.refund.drip_cap_exceeded` is published (`payments.ts:505`). To see why the cap was hit, the operator queries event-log or audit. No `ibx admin drip-cap status --staff <id>` reporting command.
- **Verdict:** **NEEDS WORK.** Counter-clear procedure is undocumented and violates the project's own Redis-key conventions; visibility into "why was the cap hit" is best-effort.

---

### INC-9 — Audit-postgres SQL migration not applied + IBX_AUDIT_POSTGRES_ENABLED=true accidentally

**Symptom:** every audit emit fails (P0-14 fallback uses `DO NOTHING` per remediation).

- **Detection:** `kernel_audit_sink_failure_total{sink="postgres"}` counter emits (`kernel-metrics-sink.ts:200-207`). Burst alert `kernel-sink-failure-burst` is *documented* (`06-obs.md:349`) but undeployed.
- **Investigation:** logs say `42P10` (the `ON CONFLICT` target doesn't exist) per `AUDIT-SYNTHESIS.md:113`. Detection by operator would be by tailing logs (`ibx infra logs api`).
- **Recovery:** flip `IBX_AUDIT_POSTGRES_ENABLED=false` and redeploy. The remediation report at `REMEDIATION-COMPLETE.md:181-187` says exactly this: "keep `IBX_AUDIT_POSTGRES_ENABLED=false`" until the migration is applied.
- **Verdict:** **AT BEST NEEDS WORK.** The fallback prevents catastrophe but the operator's discovery path is log-tailing, not a dashboard alert. The deployment-by-mistake risk is mitigated by P0-9's fail-closed-on-typo behavior in `IBX_KERNEL_*` env vars, but NOT in `IBX_AUDIT_POSTGRES_ENABLED` (which is boolean-only).

---

### INC-10 — Pack conformance drift detected post-deploy

**Symptom:** boot fails with `PackConformanceError` (W1 P0-6 fixed).

- **Detection:** the process dies with a fatal pino log `[kernel-bootstrap] pack conformance failed` (`kernel-bootstrap.ts:167`) + sync `throw` propagates to `start().catch(...)` which calls `process.exit(1)` (P0-6 closed). Sentry should capture it (Sentry init runs first at `apps/api/src/index.ts:52`).
- **Logs say:** the structured error with `event: "kernel.bootstrap.pack_installed"` (success) or the thrown `PackConformanceError` (failure) per `kernel-bootstrap.ts:152-170`.
- **Recovery:** revert the deploy — `ibx infra deploy` per `index.ts:232`. Roll-forward requires diagnosing which Pack drifted (the error message names the offending field).
- **Verdict:** **ON-CALL READY** for this scenario. Fail-loud-and-fast works. The recovery (revert deploy) uses an existing operator path. This is the *one* incident where the operator has clear signal + clear command.

---

### INC-11 — Two-person rule bypass detected

**Symptom:** audit shows same staffId on both steps (if the R3 race existed).

- **Detection:** P0-5 was closed (verified in `admin-confirmation-store.ts:178-195` — `consumeWithSameActorCheck` explicitly compares `requestStaffId === pending.staffId` and returns `same_actor_violation`). The route then emits a refusal. So the race shouldn't fire in normal operation.
- **Alert:** no metric `admin_two_person_violation_total` exists. If a violation does occur (e.g., a future regression), it surfaces only in the audit table.
- **Historical scan:** no `ibx audit search --event admin.two_person.violation` command. The operator would hand-write SQL against `intent_audit`.
- **Verdict:** **NEEDS WORK.** The defense is in place but historical-incident detection requires SQL skills + DB access. A production breach would be discovered after-the-fact, by accident.

---

### INC-12 — Coverage metric drops below 100%

**Symptom:** `kernel_intent_kind_coverage` < 1.0.

- **Detection:** the metric exists (`kernel-metrics-sink.ts:218-225`) and is published by `recordDecision` whenever an intent kind is observed (line 388-392). Coverage = (observed ∩ known) / |known|. Below 1.0 = there's an intent kind being emitted that's NOT in `KNOWN_INTENT_KINDS`.
- **Interpretation:** the coverage gauge's <1.0 reading means "the typo gate failed" — but wait, the typo gate is on `IBX_KERNEL_ENFORCE`/`IBX_KERNEL_SHADOW` (validated at boot per P0-9). The coverage gauge instead catches the *opposite* direction: an envelope built with an unknown kind passes through the kernel because `KNOWN_INTENT_KINDS` only gates env vars, not envelope construction.
- **Investigation:** **no `ibx kernel coverage --explain` command.** The gauge gives the ratio but not which kind is the leaker. Operator would need to compare `observedIntentKinds` (process-local) against `KNOWN_INTENT_KINDS` — and the process-local set is not exported.
- **Verdict:** **NEEDS WORK.** Detection works but identifying the leak is undebuggable without hand-querying Postgres.

---

## Tool inventory

| Tool | Documented at | Actually exists? | Stub or real? |
|---|---|---|---|
| `ibx dlq list` | `index.ts:243` (help), `dlq.ts:84-126` | YES | Real, W6-9 dynamic discovery via Redis SCAN |
| `ibx dlq peek <event>` | `dlq.ts:130-164` | YES | Real |
| `ibx dlq replay <event>` | `dlq.ts:166-228` | YES | Real, supports `--dry-run` |
| `ibx dlq purge <event>` | `dlq.ts:230-258` | YES | Real, interactive confirm |
| `ibx dlq drain` | runbook references "drain" semantics | **NO** | Not a separate command; `replay` covers similar UX |
| `ibx kernel status` | `kernel.ts:563-572` | YES | Real |
| `ibx kernel replay --since=Xh` | `kernel.ts:574-592` | PARTIAL | **STUB**: per inline TODO at line 298-305: "TODO(audit-replay): re-feed records through adjudicate() with the matching policy bundle... full re-adjudication harness requires composing the right PolicyBundle which we defer until the rollout playbook needs it". The CLI prints a per-kind count summary; **does NOT actually re-adjudicate or compute drift**. Per `REMEDIATION-COMPLETE.md:191-195`, `classifyReplayDrift` doesn't exist anywhere (filed upstream as F2). |
| `ibx kernel divergence` | `kernel.ts:594-600` | YES | Real (W5-8) BUT `--intent-kind` filter parsed but not applied to SQL query (line 449 omits the filter) — bug |
| `ibx kernel kill-switch enable\|disable <intent>` | `05-kill-switch-strategy.md:281-289` | **NO** | Documented extensively (~30 lines of CLI spec); zero implementation. No subcommand registered. |
| `ibx kernel kill-switch status` | `05-kill-switch-strategy.md:293-294` | **NO** | Same |
| `ibx kernel validate-config` | `07-production-safety-checklist.md:30` | **NO** | Referenced as a pre-flight check; doesn't exist |
| `ibx audit search` | implied by INC-5 | **NO** | No such command |
| `ibx audit scrub` | implied by INC-5 (LGPD) | **NO** | No such command |
| `ibx defer list` | implied by INC-7 | **NO** | No such command — `ibx debug redis defer:pending:*` is the workaround |
| `ibx defer resume <hash>` | implied by INC-7 | **NO** | No manual resume CLI |
| `ibx db query` | implied by INC-5, INC-11 | **NO** | No ad-hoc SQL command (db has migrate/seed/clean/reset/status — no query) |
| `POST /api/admin/kernel/kill-switch` admin endpoint | `05-kill-switch-strategy.md:196-228` | **NO** | No file under `apps/api/src/routes/admin/` references `setKillSwitch` or has a kill-switch endpoint. Grep finds zero matches. |
| `GET /api/admin/kernel/kill-switch` status endpoint | `05-kill-switch-strategy.md:248` | **NO** | Same |
| `ibx svc health redis` | `index.ts:80` | YES | Real |
| `ibx infra logs api` | `index.ts:231` | YES | Real |
| `ibx stripe flush` | `index.ts:243` | YES | Real |

**Summary:** 3 of the 4 most-critical kernel ops tools are **missing or stub**:
- `ibx kernel replay` is a stub (prints summary, no actual drift)
- `ibx kernel kill-switch` (all four switches) does NOT exist
- `ibx audit search` / `audit scrub` / `db query` (for LGPD verification) do NOT exist

---

## Monitoring sufficiency

The MetricsSink (`kernel-metrics-sink.ts`) emits the following Prometheus metrics:

| Metric (actually emitted) | Documented in `06-obs.md`? | Alert wired? | SLO defined? | Owner page-er configured? |
|---|---|---|---|---|
| `kernel_decision_total` | yes | yes (refusal-spike) | no | no |
| `kernel_decision_duration_seconds` | yes (named `kernel_decision_latency_seconds` in doc — naming drift) | yes (latency-spike) | implied <100ms p99 | no |
| `kernel_refusal_total` | yes | yes (refusal-spike) | no | no |
| `kernel_shadow_divergence_total` | yes | yes (divergence-decision-kind, divergence-payload-rewrite) | yes (per-tier) | no |
| `kernel_ledger_op_total` | yes | yes (ledger-unavailable) | no | no |
| `kernel_audit_sink_failure_total` | yes (named `kernel_sink_failure_total` in doc — naming drift) | yes (sink-failure-burst) | no | no |
| `kernel_defer_resume_duration_seconds` | yes | no | no | no |
| `kernel_intent_kind_coverage` | yes (W5-9) | no | yes (=1.0) | no |
| `kernel_distinct_intent_kinds_observed` | yes | no | no | no |
| `kernel_known_intent_kinds_total` | yes | no | no | no |

**Metrics documented but NOT emitted today** (these alerts would fail to fire):
- `kernel_audit_lag_seconds` (used by alert `kernel-audit-postgres-lag` and `kernel-audit-nats-lag`) — **CRITICAL: P0 success criterion is "<5s p99 audit lag" and the metric doesn't exist**
- `kernel_defer_pending_gauge` (used by Dashboard 3 + alert `defer-quota`) — **gap for INC-7**
- `kernel_kill_switch_state` (Watchlist badge per `06-obs.md:210`) — moot since kill-switch isn't implemented
- `kernel_kill_switch_toggle_total` — same
- `kernel_replay_drift_total{class}` — replay CLI is stub
- `kernel_defer_quota_exceeded_total` — no
- `kernel_defer_timeout_total` — no (sweeper publishes NATS but no counter)
- `kernel_pack_install_total` — no
- `kernel_entrypoint_coverage_ratio` — no
- `kernel_audit_sink_failures_total` (kill-switch-engaged counter) — kill-switch absent

**Dashboards (all four documented in `06-obs.md`):**
- Dashboard 1 — Decision overview: **does not exist** (no Grafana JSON in repo, runbook URL says "TBD")
- Dashboard 2 — Per-intent enforce-readiness: **does not exist**
- Dashboard 3 — DEFER backlog: **does not exist** (and the gauge it would chart doesn't emit)
- Dashboard 4 — Audit pipeline health: **does not exist** (and `kernel_audit_lag_seconds` doesn't emit)

**Alerts (14 documented in `06-obs.md:336-353`):**
- Zero deployed. No Prometheus AlertManager / PagerDuty integration files in `infra/terraform/**`.
- Per `06-obs.md:353`: "Each rule has a corresponding entry in `apps/api/src/plugins/sentry.ts` (or a sibling `kernel-alerts.ts` module created in M4) wiring `Sentry.metrics.alert(...)` or the PagerDuty integration." Grep for `Sentry.metrics.alert\|PagerDuty` returns zero matches.

**On-call paging:** no PagerDuty integration. Sentry breadcrumbs are emitted (verified in `kernel-metrics-sink.ts:421-431, 448-459`) but breadcrumbs are correlation context, not alerts — they only show after Sentry already has an event.

---

## Critical gaps blocking shadow rollout

In order of risk:

1. **Kill-switch is documented but does not exist** (admin endpoint + CLI). The runbook's "<2 min engagement" promise is broken; the only rollback is a 5-minute ECS redeploy with edited env vars. Recoverable but adds 4+ minutes to every incident. **This alone violates the runbook's pre-flight item §1.5: "Kill-switch procedure rehearsed" — operators have no kill switch to rehearse.**
2. **No dashboards.** Operators flying blind during shadow soak. The runbook says "watch the shadow-divergence Grafana panel daily" but there is no panel.
3. **No alerts wired to PagerDuty.** The 14 documented rules are paper-only. A divergence storm at 3am wakes no one.
4. **`kernel_audit_lag_seconds` metric absent.** The "<5s p99 audit lag" master-plan SLO is not measurable today.
5. **`ibx kernel replay` is a stub.** Pre-flight item §3 requires "Replay drift = 0 for last 24h" — this assertion can't be made because no drift classification exists.
6. **`kernel_defer_pending_gauge` absent.** DEFER backlog is invisible. INC-7 (stuck DEFER) is operator-blind until customer support raises it.
7. **No LGPD-investigation tooling** (`ibx audit search`, `audit scrub`, `db query`). When the first "you didn't delete me" complaint arrives, the operator's first investigative step doesn't exist.
8. **NATS auth deferred** (P0-12). Per `REMEDIATION-COMPLETE.md`, this gates Tier 3+4 enforce — but it ALSO leaves shadow rollout itself running on an unauthenticated bus, meaning shadow audit records can be exfiltrated (PII in `actor.sessionId` was fixed via P0-10 hashing, but other payload fields may carry PII).
9. **`--intent-kind` filter broken in `ibx kernel divergence`.** Operator can't isolate per-intent divergence; they see the whole window. Per `kernel.ts:449`, the SQL omits the intent-kind WHERE clause even though the CLI option is parsed.
10. **No Redis-outage runbook.** Single biggest dependency, zero documented procedure.

---

## Recommendations (ordered by ROI)

### Must-fix before any shadow flip (1-2 dev-days)

R1. **Implement `ibx kernel kill-switch` CLI + admin endpoint** (per `05-kill-switch-strategy.md` spec — both surfaces, in-process and HTTP). Without this, the documented runbook is fiction.

R2. **Emit `kernel_audit_lag_seconds` histogram** from the audit-sink layer (per-sink timing). Without this the lag SLO can't be tested.

R3. **Emit `kernel_defer_pending_gauge`** via a 30s SCAN of `defer:pending:*` keys (cheap: SCAN is non-blocking, count is small). Without this DEFER backlog is invisible.

R4. **Fix `--intent-kind` filter bug in `ibx kernel divergence`** — one-line change at `kernel.ts:449` to thread the option into the SQL params.

### Must-fix before enforce (3-5 dev-days)

R5. **Deploy at least Dashboard 1 (Decision overview) and Dashboard 4 (Audit pipeline health) to Grafana.** Even a hand-tuned JSON in `infra/grafana/dashboards/*.json` and provisioning via terraform.

R6. **Wire the 5 highest-severity alerts to PagerDuty:** divergence-decision-kind, audit-postgres-lag (after R2), refusal-spike, ledger-unavailable, defer-timeout. These cover the most-likely-customer-impacting incidents.

R7. **Implement `ibx kernel replay` actual re-adjudication** — not the stub. Per the inline TODO, this needs to compose the right PolicyBundle per intent kind. ~2 dev-days. Without this the pre-flight `replay drift = 0` assertion is fictional.

R8. **Implement `ibx audit search --customer <id>` + `ibx audit scrub --customer <id> --dry-run`.** Critical for LGPD operational follow-through. Should query `intent_audit` by hashed sessionId AND by phone-derived hash.

### Should-fix during shadow soak (1-2 dev-days)

R9. **Write a Redis-outage runbook** at `docs/ops/runbooks/redis-outage.md` covering DEFER park behavior, audit spill behavior, OTP/session impact, and recovery validation.

R10. **Implement `ibx defer list --session <id>` and `ibx defer resume <intent-hash>`.** Operators need both for stuck-intent recovery; the current "use ibx debug redis + raw NATS pub" is workable but error-prone.

R11. **Rename metrics to match documentation OR update documentation to match metrics.** `kernel_decision_duration_seconds` vs documented `kernel_decision_latency_seconds`; `kernel_audit_sink_failure_total` vs documented `kernel_sink_failure_total`. The doc IS the wire contract per `06-obs.md:16`; the drift breaks dashboards built from the doc.

### Nice-to-have

R12. **Add a `kernel_kill_switch_state` gauge once R1 lands.**

R13. **Add startup probe for `IBX_AUDIT_POSTGRES_ENABLED=true` + missing constraint** (instead of letting the first audit emit fail with 42P10). Reuse the same fail-closed pattern as P0-9 (typo-on-boot).

---

## Verdict

| Incident | On-call ready? |
|---|---|
| INC-1 Kernel pack drift | NEEDS WORK |
| INC-2 Audit pipeline backpressure | NOT READY |
| INC-3 Redis outage | NEEDS WORK |
| INC-4 NATS partition / unauth | NOT READY |
| INC-5 LGPD violation | NOT READY |
| INC-6 Stripe webhook flood | NEEDS WORK |
| INC-7 Stuck DEFER intent | NEEDS WORK |
| INC-8 Refund drip cap | NEEDS WORK |
| INC-9 Audit-postgres migration missing | NEEDS WORK |
| INC-10 Pack conformance drift | **ON-CALL READY** |
| INC-11 Two-person rule violation | NEEDS WORK |
| INC-12 Coverage metric drop | NEEDS WORK |

**1 of 12 incidents** has a complete detect→investigate→recover path that works as the runbook claims.

**"Shadow rollout ready" is overconfident.** The CODE is in a defensible shape — P0-1 through P0-15 (excluding NATS auth) are remediated, the kernel-bootstrap is fail-loud, packs are conformant, the metrics sink emits useful counters. But the OPERATIONAL surface that turns shadow into a safety system has not been built:

- No dashboards to watch.
- No alerts to wake on-call.
- No kill switch to engage when the dashboard you don't have shows a problem that isn't paged.
- No replay that actually computes drift.
- No tooling for the most-likely real incident (LGPD verification).

**Recommendation:** Tier 1 shadow can technically proceed because the code path is safe (legacy stays authoritative; divergences are metrics-only). But the value of shadow — *learning about regressions before they affect customers* — is wasted without dashboards + alerts + investigation tools. I would not declare shadow "ready" until at least R1–R5 land.

For enforce-mode rollout, R6 + R7 + R8 are also gating. Without `kernel kill-switch`, `kernel_audit_lag_seconds`, and `audit search`, the runbook's incident-response procedures are not executable. The 5-minute rollback promise becomes a redeploy-and-wait promise.

The migration is engineering-ready, not operations-ready. Closing the gap is 3-7 dev-days of work that has been deferred to "post-M4" but is the actual gate to a credible shadow rollout.
