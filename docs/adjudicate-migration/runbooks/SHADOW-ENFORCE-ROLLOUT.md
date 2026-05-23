# SHADOW → ENFORCE Rollout — Operator Runbook

**Status:** W6-11 (final wave)
**Owner:** Migration lead + on-call
**Last updated:** 2026-05-23
**Companion docs:** `../migration/04-shadow-enforce-sequencing.md` (tier classification, divergence thresholds), `../migration/05-kill-switch-strategy.md` (rollback procedure), `../migration/07-production-safety-checklist.md` (pre-flight), `../audit/AUDIT-SYNTHESIS.md` (P0 gate).

---

## Read this first

> **Do NOT flip `IBX_KERNEL_ENFORCE` for any intent kind until every P0 finding from `audit/AUDIT-SYNTHESIS.md` is closed AND the corresponding remediation is in production.** The remediation tracking lives in `../remediation/REMEDIATION-COMPLETE.md`. If that doc says "DO NOT flip" anywhere, halt.

> **Two-key rollout.** No single operator flips `IBX_KERNEL_ENFORCE`. The migration lead AND one of (CTO, ops lead, on-call primary) must both sign off in the rollout ticket before the env var changes hit the running ECS task definition.

---

## Vocabulary

| Term | Meaning |
|---|---|
| **Shadow mode** | The kernel runs adjudicate() ALONGSIDE the legacy code; legacy stays authoritative. Divergences emit `kernel_shadow_divergence` events but the customer-facing response is the legacy one. |
| **Enforce mode** | adjudicate() IS authoritative. Legacy behaviour is bypassed for the flipped intent kind. |
| **Tier** | Risk class from `migration/04-shadow-enforce-sequencing.md` — Tier 1 (idempotent, reversible) through Tier 4 (money, LGPD). |
| **Divergence class** | `BASIS_ONLY` (same decision kind, different basis codes), `DECISION_KIND` (legacy and kernel disagree on EXECUTE/REFUSE/etc), `PAYLOAD_REWRITE` (kernel returned REWRITE), `NONE` (perfect match — no event emitted). |

---

## Per-tier rollout procedure

### Step 0 — Pre-flight (every tier)

Run the production safety checklist BEFORE touching any env var:

```
docs/adjudicate-migration/migration/07-production-safety-checklist.md
```

All boxes MUST be checked off in the rollout ticket. The non-negotiable items:

1. **Latest deploy GREEN.** `pnpm test` clean on `main` for ≥24h. Tests = 911 (api) + 354 (llm-provider) + (other packages). Coverage of governance surface ≥ 88% (W5-9 metric).
2. **`audit.intent.decision.v1` is flowing.** Grafana panel `audit_records_per_minute` reads non-zero for ≥48h. Postgres `intent_audit` row count growing at expected rate.
3. **Sentry alerting on `kernel.bootstrap.enforce_config_typo` is on.** This catches the P0-9 typo scenario before it lands.
4. **Shadow-divergence dashboard is open in another tab.** `https://grafana.{env}.ibatexas.com/d/kernel-enforcement-readiness` (per-intent enforce-readiness, Wave-3 artifact at `infra/grafana/dashboards/kernel-enforcement-readiness.json`). The decision overview lives at `/d/kernel-decision-overview`; the audit pipeline panel is at `/d/kernel-audit-pipeline-health`; the DEFER backlog at `/d/kernel-defer-backlog`. Deployment of the JSON to a running Grafana instance is operator-side.
5. **Kill-switch procedure rehearsed.** Refer to `migration/05-kill-switch-strategy.md` and verify the on-call engineer can revert `IBX_KERNEL_ENFORCE` within 5 minutes.
6. **NATS auth deployed.** Per audit P0-12 — without NKey/JWT auth, anyone on the network can forge resume signals. Enforcement requires authenticated NATS. (DEFERRED: see `remediation/NATS-AUTH-REQUIREMENTS.md`.)
7. **The intent's policy bundle is COMPLETE in its Pack.** `KNOWN_INTENT_KINDS` (in `packages/llm-provider/src/intent-kinds.ts`) contains the kind; the Pack registers a guard for every adjudicate call site that uses it.

If ANY of these is false, STOP. Update the audit/remediation tracker, fix, re-run pre-flight.

---

### Step 1 — Flip `IBX_KERNEL_SHADOW`

```
# In the ECS task definition (or k8s ConfigMap), set:
IBX_KERNEL_SHADOW=<intent.kind>
```

Comma-separated list to flip multiple at once — but per `migration/04` §"Per-intent flip cadence", flip ONE per day for Tier 1, ONE per 2 days for Tier 2, etc.

After the rolling deploy completes (verify `kubectl rollout status` or ECS task health = stable for ≥10 min):

```
# Verify enforce-config picked up the flip — should print the new kind.
ibx kernel status --json | jq '.shadow'
```

Sentry should be quiet during the rolling deploy. If you see `kernel.bootstrap.enforce_config_typo` events, the spelling is wrong — fix immediately (P0-9 makes this fail-closed but a typo still requires intervention).

---

### Step 2 — Monitor the soak window

Duration per `migration/04`:

| Tier | Min | Target |
|---|---|---|
| 1 | 7d | 7d |
| 2 | 7d | 10d |
| 3 | 14d | 14d |
| 4 | 14d (LGPD: 21d) | 21d |

During the soak:

- **Watch the shadow-divergence Grafana panel daily** (`/d/kernel-enforcement-readiness?var-intent_kind=<kind>`). Specifically: `kernel_shadow_divergence_total{intent_kind="<kind>",class="DECISION_KIND"}` MUST stay at zero for every flip. Non-zero = STOP. Investigate. (W3 fix: the label is `class`, not `divergence`.)
- **`BASIS_ONLY` divergence is tolerated at the Tier threshold.** Tier 1 allows up to 5% rolling 24h; Tier 4 demands < 1%.
- **Run `ibx kernel divergence --since=24h --intent-kind=<kind>`** every weekday at 09h00 BRT. Output is JSON; pipe to `jq` to grep for `class=="DECISION_KIND"`. Any hit triggers an incident review.
- **Run `ibx kernel replay --since=24h --intent-kind=<kind>`** every weekday. The CLI's replay path feeds yesterday's audit records back through adjudicate(); drift > 0 indicates a regression in either the legacy code OR the Pack — investigate via `intent_hash` cross-reference in `intent_audit`.
- **Watch the audit-sink lag panel** (`/d/kernel-audit-pipeline-health`). `kernel_audit_lag_seconds{sink="postgres"}` p99 should stay < 5s; `{sink="nats"}` p99 < 1s. Spikes during a shadow flip suggest the new code path is amplifying writes. PagerDuty rules: `KernelAuditLagHighPostgres` / `KernelAuditLagHighNats` in `infra/alerts/kernel.yaml`.

If at any point a `DECISION_KIND` or `PAYLOAD_REWRITE` divergence fires:

1. **Don't flip enforce.** Reset the soak clock to day 0.
2. Investigate via the audit record — `intent_hash` lookup in `intent_audit`. The kernel's decision vs the legacy's projected decision should be in the row.
3. File a remediation ticket. Fix the Pack OR the legacy code OR the test fixture.
4. Re-run pre-flight (Step 0).
5. Re-flip shadow.

---

### Step 3 — Enforce-readiness checklist

When the soak window completes:

- [ ] **7-day divergence check is clean.** `ibx kernel divergence --since=7d --intent-kind=<kind>` shows `DECISION_KIND=0`, `PAYLOAD_REWRITE=0`, `BASIS_ONLY` below tier threshold.
- [ ] **7-day replay drift = 0.** `ibx kernel replay --since=7d --intent-kind=<kind>` shows zero drift records.
- [ ] **Sentry has zero `kernel_shadow_divergence` events with severity=high in the past 24h.** A long-tail straggler resets the window.
- [ ] **Migration lead + secondary signoff in the rollout ticket.**
- [ ] **Kill-switch procedure validated in staging within the past 7 days.** Per `migration/05`. Specifically: `IBX_KERNEL_ENFORCE` reverted, traffic redirected, no in-flight DEFER lost.
- [ ] **Tier 4 only**: legal + finance signoff for `payment.refund.issue`, `payment.force.status`, `customer.anonymize`, `order.force.cancel`. These require formal product-owner approval before enforce flips.

---

### Step 4 — Flip `IBX_KERNEL_ENFORCE`

```
# Update the ECS task / k8s ConfigMap:
IBX_KERNEL_ENFORCE=<intent.kind>
# Keep IBX_KERNEL_SHADOW=<intent.kind> too — shadow stays on so the
# kernel still records adjudicate-vs-legacy divergence for the
# transition period (recommended +14 days).
```

After the rolling deploy:

```
ibx kernel status --json | jq '.enforce'
```

The intent kind MUST appear under `enforce`. If not, the env var didn't propagate — rollback and investigate.

---

### Step 5 — Observe enforce

The first 24h after enforce flips:

- **Watch the kernel-decision Grafana panel** (`/d/kernel-decision-overview`). `kernel_decision_total{intent_kind="<kind>",kind=...}` distribution should match the shadow-soak distribution within ±5%. Big shifts mean the legacy was filtering traffic in a way the Pack doesn't.
- **Watch Sentry for refusal-burst breadcrumbs.** The kernel-metrics-sink emits Sentry breadcrumbs on every REFUSE (`audit_refused` category, see `apps/api/src/plugins/kernel-metrics-sink.ts`). PagerDuty rule `KernelRefusalRateSpike` in `infra/alerts/kernel.yaml` fires when the refusal rate exceeds 10% for 5m.
- **Watch the audit-pipeline DLQ.** `ibx dlq list` should show no growth in `audit.intent.decision.v1`. Growth here = Postgres can't ingest fast enough, possibly correlated with enforce-driven volume change.
- **Customer support tickets, the first day**. New refusals = customer-visible behaviour change. The on-call lead should triage all new refusal patterns within 2 hours.

After 7 days of clean enforce:

- Disable shadow: `IBX_KERNEL_SHADOW` minus the flipped kind. Reduces overhead.
- File a postmortem: divergence-count delta from pre-shadow to post-enforce.
- Mark the intent kind GREEN on `remediation/REMEDIATION-COMPLETE.md`.

---

## Kill-switch procedure

Refer to `migration/05-kill-switch-strategy.md` for the full procedure. The short form:

```
# Revert the env var:
IBX_KERNEL_ENFORCE=<other.kinds.but.not.this.one>
# Trigger an immediate rolling deploy.
```

The legacy path resumes within 5 minutes (the time it takes ECS to roll). In-flight DEFER intents survive — the kernel's park primitives are Redis-backed and the deferred resumer runs regardless of enforce state.

After the kill-switch:

1. **File an incident report within 4 hours.** Include the audit query that showed the regression, the customer impact, the diagnosed root cause.
2. **The intent kind goes back to shadow** until the regression is fixed AND verified.
3. **Other intent flips PAUSE for 24h.** The on-call lead reviews whether the regression has correlated risk for other tiers (e.g., a Pack-runtime bug affects all kinds in that Pack).

---

## Per-tier quick reference

### Tier 1 (reservation.create, order.note.add, customer.preferences.update, whatsapp.message.send)

```
# Day 0
IBX_KERNEL_SHADOW=reservation.create,order.note.add,customer.preferences.update,whatsapp.message.send

# Day 7 — after 7 clean days
ibx kernel divergence --since=7d --intent-kind=reservation.create
ibx kernel replay --since=7d --intent-kind=reservation.create
# If clean:
IBX_KERNEL_ENFORCE=reservation.create
# Next day: order.note.add. Then customer.preferences.update. Then whatsapp.message.send.
```

### Tier 2 (order.item.add, cart.delivery.update, order.amend, reservation.modify)

Same shape, soak target = 10d. Flip cadence: 1 per 2 days.

### Tier 3 (order.cancel, payment.pix.regenerate, customer.profile.update)

Soak target = 14d. Flip cadence: 1 per 3 days. Tier 3 requires migration lead + product owner sign-off before each flip (not just at the end).

### Tier 4 (payment.refund.issue, payment.force.status, customer.anonymize, order.force.cancel)

Soak target = 21d (customer.anonymize: 28d). Flip cadence: 1 per week. Tier 4 requires migration lead + product owner + finance/legal sign-off before each flip.

**`customer.anonymize` is the LAST intent flipped.** LGPD irreversibility risk is unique. Confirm with legal that the 24h grace + cancel-cooldown UX is in production AND tested before this flips.

---

## Common failure modes

### "I flipped shadow and now `audit.intent.decision.v1` is silent"

The Pack's `policy()` function probably throws. Check Sentry for `pack.adjudicate.threw` events. Until you find it, the shadow flip is dropping every adjudicate call silently. Revert the shadow flip; the kernel doesn't crash but you have no telemetry while the Pack is broken.

### "The divergence panel shows zero events but I expected some"

The kernel might not be running shadow at all. Verify:

```
ibx kernel status --json | jq '.shadow'
```

If the kind isn't listed, the env var didn't propagate. Re-trigger the rolling deploy.

If the kind IS listed but events are silent, the audit sink might be broken. Check Postgres `intent_audit` for recent rows.

### "Divergence is `BASIS_ONLY` only — can I flip enforce?"

Only if `BASIS_ONLY` is BELOW the tier threshold AND has stabilized (no upward trend over the soak window). `BASIS_ONLY` represents vocabulary upgrades (the kernel emits richer basis codes than the legacy boolean). It's acceptable noise, not a regression. But: a sudden spike late in the soak is suspicious — investigate.

### "I see `DECISION_KIND` but only on test-account traffic"

Check whether the test account uses a different state shape than real customers. The Pack's state-projection might be inconsistent across surfaces. This is a Pack bug; fix and re-shadow.

### "I see `PAYLOAD_REWRITE` and I expected it"

REWRITE is acceptable when the Pack is designed to clamp values (e.g., quantity-above-stock). The shadow window verifies the REWRITE doesn't surprise the legacy. If the REWRITE rate exceeds your downstream's tolerance (e.g., > 1% of traffic), reconsider whether the Pack should REFUSE instead.

---

## Audit trail

Every flip MUST be recorded in the rollout ticket with:

- Date + time (UTC + BRT)
- Operator + signoff
- Pre-flip `ibx kernel status --json` output
- Post-flip `ibx kernel status --json` output (after rolling deploy completes)
- Divergence panel screenshot at flip time and at the soak completion
- Postmortem link if the flip required investigation

These rollout tickets are the operator-side complement to `intent_audit` Postgres records. The rollout ticket says "we deliberately changed behaviour at time X for kind Y"; the audit table says "here's every decision made before and after". Together they trace the migration.
