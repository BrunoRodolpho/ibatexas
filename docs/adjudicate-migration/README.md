# Adjudicate migration — IbateXas

Last updated: 2026-05-24

## Where to look first

- **Current state + closure map**: [`audit-2026-05-24/CLOSEOUT-STATUS.md`](./audit-2026-05-24/CLOSEOUT-STATUS.md) — authoritative as of 2026-05-24 evening (post-H2 closeout)
- **Civilization health (meta-layer assessment)**: [`CIVILIZATION-HEALTH-2026-05-24.md`](./CIVILIZATION-HEALTH-2026-05-24.md) — institutional-memory, governance-drift, and evolutionary-forecast lens
- **Architectural rule**: `IbateXas/CLAUDE.md` rule #9 ("LLM Authority — IBX Intent-Gated Execution v3.0")
- **The cutover commit**: `f3bea43` (IBX-IGE v3.0 — always-on cutover, delete staged-rollout machinery)
- **Historical**: [`audit-2026-05-23/SYNTHESIS.md`](./audit-2026-05-23/SYNTHESIS.md) — pre-H2 gap report; superseded by 2026-05-24 closeout for "what remains"

## Document map (current docs)

- `audit-2026-05-24/` — closeout + per-stream task files (CLOSEOUT-STATUS.md is authoritative)
- `CIVILIZATION-HEALTH-2026-05-24.md` — meta-layer assessment (institutional-memory + governance-drift)
- `audit-2026-05-23/` — fresh as-of-2026-05-23 audits (synthesis + 5 investigation reports; superseded for "what remains" by audit-2026-05-24)
- `correctness-remediation/` — Wave 1-9 remediation artifacts with adversarial verifier reports
- `governance/` — design docs (intent taxonomy, capability model, audit/replay, etc.) — load-bearing constitutional artifacts
- `migration/` — milestone-tracking docs (some superseded — see below)
- `tasks/` — per-task implementation specs from M0-M6
- `threat-model/` — security & trust-boundary docs

## Document map (superseded — kept as historical record)

- `MASTER_PLAN.md` — original pre-cutover plan (banner)
- `current-state.md` — pre-cutover task ledger (banner)
- `open-blockers.md` — pre-Wave-7 open-items list (partially superseded; banner)
- `superseded/` — 3 mislead-risk runbooks archived in `f87fb0b`:
  - `SHADOW-ENFORCE-ROLLOUT.md`
  - `04-shadow-enforce-sequencing.md`
  - `05-kill-switch-strategy.md`

## How to extend this directory

- New per-wave or per-audit work should land in a dated subdirectory (e.g., `audit-2026-05-23/`, `correctness-remediation/wave-N-Y/`)
- Cross-cutting design docs go under `governance/`
- Operator-facing runbooks go under `runbooks/`
- Stale docs get a SUPERSEDED banner; they're not deleted (history preservation)
