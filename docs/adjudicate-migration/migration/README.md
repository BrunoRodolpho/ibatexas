# `migration/` — pre-cutover milestone-tracking docs

## What's in this directory

Five docs describing the pre-cutover rollout strategy: three-track plan,
M0-M8 milestones, blast-radius analysis, observability contract, and
production safety checklist. The numbering skips 04 and 05 — those files
(`04-shadow-enforce-sequencing.md`, `05-kill-switch-strategy.md`) were
archived under `../superseded/` during the IBX-IGE v3.0 cutover.

Four of the remaining five docs describe a rollout model that no longer
exists (shadow → enforce phases, kill-switch flips, M5/M7/M8 rollout
choreography). One (`06-observability-requirements.md`) carries
genuinely load-bearing content: a metric contract with `verified at`
line numbers pointing to current code — the metrics documented are
still emitted today.

## Classification

| File | Classification | One-line summary |
|---|---|---|
| `01-rollout-strategy.md` | Historical preserved | Three-track plan (plumbing, coverage, rollout) with shadow → enforce sequencing. The "Track C" rollout-choreography track was abandoned by the cutover. |
| `02-milestones.md` | Historical preserved | M0-M8 milestone breakdown. M0-M4 + M6 closed via the work-arc; M5/M7/M8 (shadow + tiered enforce) abandoned by the cutover. |
| `03-blast-radius-analysis.md` | Historical preserved | Per-workstream blast-radius matrix. The rollback mechanics ("kill-switch flip back to shadow") describe deleted machinery, but the audit-sink loss tolerance + revenue-at-risk + LGPD-exposure analyses remain informative for production-safety thinking. |
| `06-observability-requirements.md` | Load-bearing (the metric contract) — Historical preserved (the rollout framing) | The six contract metrics (`kernel_decision_total`, `kernel_decision_duration_seconds`, `kernel_refusal_total`, `kernel_shadow_divergence_total`, `kernel_defer_pending_gauge`, `kernel_audit_lag_seconds`) are still emitted from `apps/api/src/plugins/kernel-metrics-sink.ts` — the doc is the contract-of-record. The "before enforce flip" gating language throughout is stale. |
| `07-production-safety-checklist.md` | Historical preserved | Pre-flight checklist "per intent kind, per enforce flip." There are no enforce flips today; the checklist as a procedure does not apply. Several individual checks (Pack contract test passes, bypass-detection green, audit-redaction contract test) are still relevant individually but not as a gated procedure. |

## Notes

The 04 and 05 docs explicitly mentioned in the headers of these files
were moved to `../superseded/` in commit `f87fb0b`. References to them
from these files still point to `../superseded/04-shadow-enforce-sequencing.md`
and `../superseded/05-kill-switch-strategy.md`; those links remain valid
for following the historical chain but the content is intentionally
archived.

`06-observability-requirements.md` is the most load-bearing doc in this
directory. Future contributors adding a new metric should:
1. Update the doc with the metric name, type, labels, and `verified at`
   pointer.
2. Register the metric in `apps/api/src/plugins/kernel-metrics-sink.ts`.
3. Add a test asserting the metric appears in `/metrics`.

## Current-state pointers

- **Constitutional rule:** `CLAUDE.md` rule #9 — "LLM Authority — IBX Intent-Gated Execution v3.0"
- **Always-on cutover commit:** `f3bea43` (deleted Track C / M5+M7+M8 / kill-switch / shadow-mode)
- **Operator runbook:** `docs/ops/runbooks/kernel-operations.md`
- **Closeout status:** [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md)
- **Metrics implementation:** `apps/api/src/plugins/kernel-metrics-sink.ts`
- **Archived 04/05:** [`../superseded/`](../superseded/)
