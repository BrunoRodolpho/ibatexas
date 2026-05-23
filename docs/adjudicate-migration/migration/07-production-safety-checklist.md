# 07 — Production Safety Checklist

**Status:** Draft v0.1
**Owner:** Migration Planner
**Last updated:** 2026-05-22
**Companion docs:** `01-rollout-strategy.md`, `04-shadow-enforce-sequencing.md`, `05-kill-switch-strategy.md`, `06-observability-requirements.md`

---

## Executive summary

- **No enforce flip happens without all checklist items signed off.** This document is the operational gate, mirroring the structure of `docs/ops/runbooks/01-stage-read-mutations.md` §"Pre-flight checklist" but extended for the full migration.
- **Tiered sign-offs.** Tier 1 = ops lead. Tier 2 = ops lead + migration lead. Tier 3 = ops lead + migration lead + product owner. Tier 4 = ops lead + migration lead + finance (payment) or legal (LGPD) + product owner.
- **Incident response is paged and time-boxed.** PagerDuty rotation primary; WhatsApp escalation to owner; 15-min response SLA for S1, 30-min for S2.
- **Post-incident replay is mandatory.** Every kill-switch event triggers a replay job + post-mortem within 7 days. Replay drift = 0 is the baseline.
- **Quarterly chaos schedule** validates the kill switches, the shadow→enforce roundtrip, and the Pack rollback procedure. Drill failure blocks the next enforce flip.

---

## Pre-flight checklist (per intent kind, per enforce flip)

Before flipping any intent kind from shadow to enforce, **every** item below must be checked. The migration lead owns the sign-off; on-call confirms each item.

### Section 1 — Pack and code readiness

- [ ] **Pack contract test passes.** `pnpm test --filter @ibatexas/pack-<x>` green on the deployed SHA.
- [ ] **Bypass-detection test passes in CI.** The synthetic test that writes to `prisma.<model>` outside a wrapped command service must fail; the test itself runs in the default CI flow.
- [ ] **Pack conformance check green.** `adjudicate analyze --pack @ibatexas/pack-<x> --strict --format=sarif` returns zero violations.
- [ ] **`assertPackConformance` succeeds at boot.** Confirmed by log: `[kernel-bootstrap] installPack ok` (per `investigation/05 §"Capabilities ibatexas should adopt"` Tier 0 item 3).
- [ ] **`validateEnforceConfig` warns nothing on the proposed enforce set.** `ibx kernel validate-config` returns empty `unknownEnforce[]`.

### Section 2 — Shadow data

- [ ] **Shadow data for ≥ tier-minimum days.** Tier 1+2: ≥7 days. Tier 3: ≥14 days. Tier 4: ≥21 days (or 28 for `customer.anonymize`).
- [ ] **`kernel_shadow_divergence_total{class="DECISION_KIND"} = 0`** over the soak window.
- [ ] **`kernel_shadow_divergence_total{class="PAYLOAD_REWRITE"} = 0`** over the soak window.
- [ ] **`kernel_shadow_divergence_total{class="BASIS_ONLY"}` rate below tier threshold** (5% / 3% / 2% / 1% per `04-shadow-enforce-sequencing.md` per tier).
- [ ] **All `BASIS_ONLY` patterns documented** in the per-intent shadow review doc (matching `docs/ops/runbooks/01-stage-read-mutations.md` §"Expected divergence patterns").

### Section 3 — Observability and audit

- [ ] **Audit sink lag <5s p99 for 24 hours** (`kernel_audit_lag_seconds{sink="postgres"} < 5s p99` per master plan §Success criteria).
- [ ] **Replay drift = 0 for last 24h.** `ibx kernel replay --since=24h --intent-kind=<target> --format=ci-line` returns `regressing: 0; flapping: 0`.
- [ ] **PostHog events firing for the target intent kind.** Dashboard 1 (Decision overview) shows non-zero decision rate for the kind.
- [ ] **Dashboard 2 (Per-intent enforce-readiness) shows `ENFORCE-READY ✓`** for this intent.
- [ ] **Sentry breadcrumbs visible** on at least one synthetic refusal in the last 24h (confirms the alert path works).
- [ ] **`/metrics` endpoint scraping in production.** Grafana shows live data points.

### Section 4 — Kill switch and rollback

- [ ] **Kill switch tested in staging within last 7 days.** `ibx kernel kill-switch enable <intent>` engaged + disengaged successfully in staging. Refusal rate observed to flip and recover within 30s.
- [ ] **Distributed kill-switch propagation verified.** Multi-replica staging deploy confirms all replicas mirror the kill-switch state.
- [ ] **Runbook reviewed and rehearsed.** A team member can execute the rollback procedure from the runbook in <2 minutes.
- [ ] **Customer-impact rollback plan documented.** Per `03-blast-radius-analysis.md` scenarios.
- [ ] **Rollback owner identified and reachable.** Per-tier owner per `04-shadow-enforce-sequencing.md`.

### Section 5 — Communication and staffing

- [ ] **On-call engineer paged for awareness.** PagerDuty rotation acknowledgement received.
- [ ] **Migration lead aware.** Slack message in `#ibx-rollout` linking to the pre-flight doc, expected flip time, expected impact.
- [ ] **Stakeholder sign-off** (per tier):
  - Tier 1: Ops lead.
  - Tier 2: Ops lead + migration lead.
  - Tier 3: Ops lead + migration lead + product owner.
  - Tier 4: Ops lead + migration lead + (finance lead for payment intents OR legal counsel for LGPD intents) + product owner.

### Section 6 — Tier 4 extended checks

For Tier 4 only:

- [ ] **Two-person on-call.** Primary + secondary on PagerDuty.
- [ ] **Pre-flip canary deployed.** 10% of traffic for ≥1 hour with the intent in enforce, observed clean.
- [ ] **Auto-kill-switch armed.** `refusal-rate > 10× baseline for 60s → auto-kill`.
- [ ] **Finance sign-off** for payment intents (`payment.refund.issue`, `payment.force.status`, `order.force.cancel` when refunds may cascade).
- [ ] **Legal sign-off** for LGPD intents (`customer.anonymize`).
- [ ] **PII redaction confirmed.** Sample 100 audit records from the last 24h NATS subject; zero CPF/email/phone matches.
- [ ] **Audit retention extended.** ≥5 years for `customer.anonymize`; ≥1 year for `payment.*` intents.

### Section 7 — Final sign-off

- [ ] **Migration lead signature** with timestamp.
- [ ] **Ops lead signature** with timestamp.
- [ ] **Per-tier additional signatures** as required.
- [ ] **Time of flip recorded** (ISO 8601 UTC).
- [ ] **Time-of-day check.** Avoid: Friday evenings, weekends, public holidays. Prefer: Tuesday or Wednesday, 10:00–14:00 local time.

---

## Per-intent pre-flight worksheet template

Each enforce flip files this worksheet at `docs/ops/runbooks/reports/<intent>-preflight-<date>.md`:

```markdown
# Pre-flight: <intent kind> enforce flip on <date>

## Intent metadata

- Intent kind: <e.g. order.cancel>
- Tier: <1 / 2 / 3 / 4>
- Pack: <e.g. @ibatexas/pack-orders>
- Entry surfaces: <list per investigation/02–04>
- Rollback owner: <name>

## Shadow data window

- Started: <ISO timestamp>
- Days elapsed: <N>
- Required minimum: <7 / 14 / 21 / 28>

## Divergence summary

- DECISION_KIND: <count>
- PAYLOAD_REWRITE: <count>
- BASIS_ONLY: <rate>%
- Threshold (per tier): <DECISION_KIND=0; PAYLOAD_REWRITE=0; BASIS_ONLY < X%>

## Documented BASIS_ONLY patterns

- <Pattern 1>: <description; vocab upgrade vs. bug?>
- <Pattern 2>: ...

## Audit health

- Postgres lag p99 last 24h: <Xms>
- NATS lag p99 last 24h: <Xms>
- Sink failure count last 24h: <N>

## Replay verification

- Replay drift last 24h: <stable / improving / regressing / flapping>
- Replay drift last 7d: <class>

## Kill switch verification

- Last staging drill: <ISO timestamp>
- Drill outcome: <pass / fail with notes>
- Propagation time observed: <Xs>

## Sign-offs

- [ ] Pack contract test (CI link: <URL>)
- [ ] Bypass-detection test (CI link)
- [ ] Pack conformance (CI link)
- [ ] Shadow data ≥ tier-minimum days ✓
- [ ] Divergence thresholds met ✓
- [ ] Audit lag <5s p99 (Grafana link: <URL>)
- [ ] Kill switch tested in staging (drill log: <URL>)
- [ ] Runbook reviewed (link: <URL>)
- [ ] On-call paged (PagerDuty ack: <ID>)
- [ ] Stakeholder sign-off (per tier; signed by: <names>)
- [ ] (Tier 4) PII redaction confirmed
- [ ] (Tier 4) Finance / legal sign-off

## Flip authorization

- Migration lead signature: <name>, <ISO timestamp>
- Ops lead signature: <name>, <ISO timestamp>
- (Tier 4 additional signatures)

## Flip execution

- Time of flip: <ISO timestamp>
- Command executed: `ibx kernel enforce enable <intent>`
- Verification: `ibx kernel status` shows <intent> in enforce set ✓
- Initial 5-minute observation: <clean / anomaly>

## 24h post-flip watchlist

- [ ] tool-call success rate stable ±2%
- [ ] no refusal-rate surprise
- [ ] no Sentry alerts fired
- [ ] no customer-support tickets attributable to this intent

## 7d post-flip watchlist (Tier 1+2) / 14d (Tier 3+4)

- [ ] Sustained stability
- [ ] No kill-switch engagement
- [ ] Replay drift remains `stable`

## Sign-off — flip considered stable

- Date stable confirmed: <ISO>
- Migration lead signature: <name>
```

---

## Incident response playbook

When an alert fires post-enforce:

### S1 — Critical (page primary + secondary)

**Triggers** (per `06-observability-requirements.md` alerting rules):
- Sustained refusal-rate spike (>10% for 5 min).
- Ledger unavailable.
- DEFER timeout rate > 0.
- Replay drift = `regressing` or `flapping`.
- Tool-call success rate drop >5% post-enforce.
- Buffered sink spill overflow.

**Response SLA:** Primary on-call acknowledges within 15 minutes. Secondary on-call paged after 15 min if unacknowledged.

**Decision authority:**
- Engage per-intent or global kill switch: Primary on-call (no further escalation needed).
- Roll back a Pack version: Primary on-call + migration lead approval.
- Roll back a deployment: Primary on-call + migration lead + ops lead.

**Procedure** (mirrors `05-kill-switch-strategy.md` §"Recovery procedure"):
1. Acknowledge in PagerDuty.
2. Open the related dashboard (Dashboard 1 / 2 / 3 / 4 per symptom).
3. Triage the scope: which switch?
4. Engage kill switch via `ibx kernel kill-switch enable ...`.
5. Verify dashboards within 5 min — refusal rate dropping, audit lag recovering, etc.
6. Post update to `#ibx-rollout` Slack.
7. Begin investigation (root cause analysis within 24h).

### S2 — High (page primary)

**Triggers:**
- DECISION_KIND divergence in shadow (single event).
- PAYLOAD_REWRITE divergence in shadow.
- Latency spike (p99 > 100ms for 5 min).
- Audit sink lag (Postgres >5s p99, NATS >1s p99).
- DEFER quota exceedance.
- Sink failure burst.
- Kill switch engaged.

**Response SLA:** Primary on-call acknowledges within 30 minutes.

**Decision authority:**
- Block enforce flip pending investigation: Primary on-call.
- Open PR for fix: Primary on-call.
- Escalate to S1: Primary on-call.

**Procedure:**
1. Acknowledge in PagerDuty.
2. Open the dashboard.
3. If symptom is enforce-related: consider per-intent kill switch.
4. If symptom is shadow-related: block the next enforce flip for this intent.
5. Investigate within 24h.

### S3 — Informational (Slack only)

**Triggers:**
- BASIS_ONLY divergence rate above threshold but not yet blocking.
- `kernel_pack_install_total` reports unexpected boot count.
- Buffered sink spill > 100MB (warning, not page).

**Response SLA:** Best-effort, daily review.

**Decision authority:** Reviewer of `#ibx-rollout` triages.

---

## Post-incident replay procedure

Within 7 days of any kill-switch event or S1/S2 incident:

### Step 1 — Pull the affected audit window

```bash
# Pull all records for the affected intent in the incident window
ibx kernel replay --since=<incident_start> --until=<incident_end> \
  --intent-kind=<affected> --format=operator > replay-<incident>-<date>.md
```

### Step 2 — Classify divergences

For each diverged decision in the replay output:

- **Kernel-correct, legacy-wrong (P2 cleanup):** The kernel refused but legacy executed — a latent legacy bug. File a separate PR to fix; no customer impact.
- **Kernel-wrong, legacy-correct (P0 fix):** The kernel refused a legitimate mutation. Customer-impacting; investigate and fix Pack code.
- **Both correct, different basis (P3):** A vocab difference. Document and move on.

### Step 3 — Customer-impact assessment

For "kernel-wrong" cases:

- Identify each affected customer.
- Determine whether the legacy path was reached after kill-switch (typical) or not (rare).
- For "not reached" cases: manually re-execute the mutation (via admin tooling) or contact the customer.
- File customer-support tickets for transparency.

### Step 4 — Replay validation post-fix

After deploying the Pack fix:

```bash
# Confirm replay over the original incident window now produces the correct decisions
ibx kernel replay --since=<incident_start> --until=<incident_end> \
  --intent-kind=<affected> --format=ci-line --strict
```

Expected output: `regressing: 0; flapping: 0` (all divergences resolved).

### Step 5 — File post-mortem

Use the template in `05-kill-switch-strategy.md` §"Recovery procedure" → Step 6.

---

## Quarterly chaos-test schedule

Every quarter, on-call drills the safety infrastructure in staging:

### Quarter X Week 1 — Kill switch propagation drill

**Drill 1: Global kill switch** (per `05-kill-switch-strategy.md` Drill 1)

- Run synthetic traffic generator at 10 req/s of mixed intents.
- Engage global kill switch via CLI.
- Verify propagation < 30s.
- Disengage; verify recovery < 30s.
- Pass = no replica stuck; metric counters reflect toggle.

**Drill 2: Per-intent kill switch** (per `05-kill-switch-strategy.md` Drill 2)

- Per active enforce intent: engage + disengage.
- Pass criteria: same.

**Drill 3: Per-pack kill switch** (per Drill 3)

- Per registered Pack: engage + disengage.
- Pass criteria: same.

### Quarter X Week 2 — Audit-sink resilience drill

**Drill 4: Audit-sink fail-open** (per Drill 4)

- Engage audit-sink kill switch for Postgres.
- Synthetic traffic continues; decisions don't fail.
- `persistentBufferedSink` spills to disk.
- Disengage; observe drain.
- Pass = no records lost; disk buffer drains within 60s.

### Quarter X Week 3 — Shadow→enforce roundtrip drill

**Drill 5: Shadow→enforce roundtrip** (per Drill 5)

- Choose a non-production intent (e.g. a sandbox `test.intent` kind).
- Run synthetic traffic.
- Flip to enforce.
- Engage per-intent kill switch.
- Verify intent returns to shadow within 30s.
- Disengage; verify enforce resumes.
- Pass = full roundtrip succeeds; metrics reflect each transition.

### Quarter X Week 4 — Pack rollback drill

**Drill 6: Pack rollback** (per Drill 6)

- Deploy a synthetic-broken Pack version to staging.
- Engage per-pack kill switch.
- Roll back the Pack deploy.
- Disengage kill switch.
- Pass = no cross-pack collateral damage.

### Failure mode

Any drill failing blocks the next enforce flip cycle. Migration lead opens a remediation PR within 1 week.

---

## Rollback decision matrix

| Situation | Recommended action | Decision-maker |
|---|---|---|
| Single refusal of legitimate mutation | Investigate; do not flip back | On-call |
| Sustained refusal-rate spike >10% for 5 min | Engage per-intent kill switch | On-call (no escalation) |
| Refusal-rate spike >50% for 1 min | Engage per-intent kill switch immediately; alert migration lead | On-call |
| Refusal across multiple intents in same Pack | Engage per-pack kill switch | On-call + migration lead approval |
| All intents refusing (`kernel_refusal_total` total spike) | Engage global kill switch | On-call (no escalation) |
| Audit Postgres lag >30s | Engage audit-sink kill switch for Postgres | On-call (no escalation) |
| Audit NATS lag >5s | Investigate; auto-fail-open per `multiSinkLossy` | On-call |
| DEFER timeout rate >0 | Check PSP (Stripe) status; if Stripe outage, kill `payment.confirmation` intent | On-call + migration lead |
| Replay drift `regressing` | Block next enforce flip; investigate | Migration lead |
| Replay drift `flapping` | Block all enforce flips for the affected intent; investigate | Migration lead |
| Customer support ticket spike (>2× baseline) | Triage tickets; correlate with enforce flips | Ops lead |
| Stripe webhook refusal rate spike | Engage `payment.confirmation` kill switch; alert finance | On-call + finance |
| Tier 4 intent any anomaly | Engage kill switch first; investigate second | On-call (two-person) |

---

## Health metrics to monitor continuously (steady-state)

Beyond the alerts above, on-call should periodically check:

- Coverage ratio: `kernel_entrypoint_coverage_ratio` should trend up across M1–M3.
- Active enforce intents: `count by(kind) (kernel_kill_switch_state{scope="intent", target="*"} == 0 and kernel_decision_total > 0)` — should grow as M7/M8 progress.
- Audit Postgres row count: `intent_audit` table growth rate should match the live decision rate (verifies no records are silently dropped).
- Buffered sink spill bytes: ≥0; should be 0 in normal operations.

---

## Communication protocol

### Before flip

- **T-24h:** Migration lead posts in `#ibx-rollout`: "Planning to flip `<intent>` to enforce at <time>. Pre-flight checklist at <link>."
- **T-1h:** On-call announces in `#ibx-rollout` + WhatsApp ops group: "Flipping `<intent>` in 1 hour."
- **T-0:** Flip executed. On-call posts: "Flipped at <ISO time>. Initial 5-min observation: <status>."

### During incident

- **Within 5 min of alert:** On-call posts initial assessment in `#ibx-rollout`.
- **Within 15 min:** On-call posts engaged kill switch / recovery action.
- **Hourly:** Status update until incident resolved.

### After incident

- **Within 24h:** On-call posts incident summary.
- **Within 7 days:** Post-mortem filed; link in `#ibx-rollout`.

---

## Pre-launch baseline (M5–M6)

Before any production enforce flip (M7 onwards), confirm:

- [ ] All M0 deliverables complete.
- [ ] M4 dashboards deployed.
- [ ] M5 shadow-mode rollout 95%+ complete.
- [ ] M6 test coverage migration-grade.
- [ ] First quarterly chaos test passed.
- [ ] Audit redaction contract test green for 14 consecutive days.
- [ ] Daily replay job running with drift class `stable` for ≥7 days.
- [ ] Sentry alerts wired and verified (synthetic alert sent + acknowledged by on-call).
- [ ] PagerDuty rotation confirmed for next 30 days.
- [ ] Runbooks 01–05 in `docs/ops/runbooks/` updated to reference real metrics (per `02-milestones.md` M4 deliverable).

---

## Migration-complete acceptance

The migration is "done" when:

- ≥95% of inventoried mutation entrypoints in enforce.
- All 14 intent kinds in `IBX_KERNEL_ENFORCE`.
- Daily replay drift = 0 for 14 consecutive days.
- Bypass-detection CI gate green for 14 consecutive days.
- No P0/P1 incident attributable to the kernel in the last 30 days.
- All four dashboards live; all 14 alerts wired.
- Kill-switch quarterly chaos test passed in the last quarter.
- Audit Postgres retention configured per policy.
- LGPD anonymize flow: OTP-gated + DEFER 24h grace + cancel window.
- Stripe webhook adjudication live with finance sign-off.
- `customer.anonymize` enforce successful for 28 consecutive days.

---

## Open questions

1. **Time-of-day flip rules.** Current preference: Tuesday/Wednesday 10:00–14:00 local. Should we codify a "no flips during peak dinner hours (18:00–21:00)" rule, or trust on-call judgment?
2. **Multi-replica drill cadence.** Per-replica kill-switch testing today is implicit in the propagation drill. Should we add explicit per-replica drills (kill replica 1, leave 2+3 alive; observe behaviour)?
3. **Customer notification policy on kill-switch events.** Today no customer is told "we engaged a kill switch". Should there be a transparency report (monthly digest) for customers whose mutations were affected by a kill switch?
