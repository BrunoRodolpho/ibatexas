# `governance/` — load-bearing constitutional artifacts

## What's in this directory

Seven design documents that codify the constitutional contracts of
IBX-IGE (Intent-Gated Execution). Six are still load-bearing — they
define the intent taxonomy, capability model, trust-boundary model,
decision policy, audit/replay requirements, and deferred-execution
policy that every contributor must respect. The seventh
(`07-rollback-recovery.md`) describes a rollback model — env-var-gated
enforce, kill switches, shadow mode — that was deleted by the IBX-IGE
v3.0 always-on cutover (`f3bea43`); it has been downgraded to historical.

These documents were authored before the cutover and describe the
contract in pre-cutover language ("future first-party Pack", "before
enforce flip", "migration target"). The CORE contracts are unchanged
and still authoritative; the migration-arc framing has aged. Treat the
substance as load-bearing and ignore the rollout-procedural framing
unless cross-referenced against `CLAUDE.md` rule #9.

## Classification

| File | Classification | One-line summary |
|---|---|---|
| `01-intent-taxonomy.md` | Load-bearing constitutional (with localized stale refs) | The 6-domain intent kind catalog + naming convention. **Still authoritative for `IntentEnvelope.kind` naming.** Three system-kernel intent kinds in the catalog (lines 142-144 — `system.kernel.kill_switch.toggle`, `system.kernel.shadow.add`, `system.kernel.enforce.add`) reference deleted machinery and should be ignored. |
| `02-capability-model.md` | Load-bearing constitutional | `CapabilityPlanner<S,C>` + `safePlan()` + `ToolClassification<R,M>` contract. Referenced by `CLAUDE.md` rule #9. The migration-target framing ("currently dead code, the migration adopts it") is past tense; the contract is now live. |
| `03-trust-boundary-model.md` | Load-bearing constitutional (with localized stale refs) | The `UNTRUSTED < TRUSTED < SYSTEM` taint lattice + per-boundary identity assertions. **Still authoritative for `IntentActor.taint`.** Lines 83 and 148 reference `setKillSwitch` and `IBX_KERNEL_ENFORCE` — deleted machinery. |
| `04-decision-policy.md` | Load-bearing constitutional (with localized stale refs) | Six decision outcomes (`EXECUTE/REFUSE/DEFER/ESCALATE/REQUEST_CONFIRMATION/REWRITE`) + refusal taxonomy + pt-BR localization. **Still authoritative.** Line 216 references the (deleted) `IBX_KERNEL_ENFORCE` env-var typo-guard. |
| `05-audit-replay-requirements.md` | Load-bearing constitutional (with stale rollout framing) | The `AuditRecord` v4 schema + PII redactor contract + replay/drift policy. **Still authoritative.** Multiple "before enforce flip" gates throughout reference the deleted rollout framework; the substantive contracts are unchanged. |
| `06-deferred-execution-policy.md` | Load-bearing constitutional | DEFER semantics + park/resume protocol + TTL + idempotency rules. **Still authoritative.** The "two bugs in today's implementation" callouts (resolver not started, resume doesn't re-execute) have been closed; treat those paragraphs as historical context. |
| `07-rollback-recovery.md` | Historical preserved (DOWNGRADED from load-bearing) | The three-concentric-rollback-layers model (per-intent / per-process / cluster-wide kill switch) describes machinery that was deleted by the IBX-IGE v3.0 cutover. The kernel is now always-on with no kill switch; this doc no longer describes current state. |

## How to use these docs today

For contract-level questions (what an intent kind means, what a
decision outcome means, what trust lattice level applies, what fields
go in an `AuditRecord`):
- **Trust the docs.** Cross-check against `CLAUDE.md` rule #9 if a
  rollout-procedural detail seems to contradict.

For rollout / rollback / kill-switch questions:
- **Do not trust these docs.** The post-cutover constitutional rule is
  "kernel always authoritative, no shadow mode, no kill switch." See
  `CLAUDE.md` rule #9 and `docs/ops/runbooks/kernel-operations.md`.

For "which Pack owns which intent kind":
- 01's per-domain catalog is the design intent; the actual Pack
  ownership lives in the platform repo's `@adjudicate/pack-*` packages.
  When in doubt, the Pack's `intent-kinds` export is authoritative.

## Localized contradictions to flag for future-fix

These are minor and don't justify SUPERSEDED banners on the whole
files, but a future maintenance pass should clean them up:

- `01-intent-taxonomy.md:142-144` — three `system.kernel.*` intent kinds for the deleted kill-switch / shadow / enforce admin endpoints. Remove from the catalog.
- `03-trust-boundary-model.md:83,148` — references to `setKillSwitch` and `IBX_KERNEL_ENFORCE`. Update or remove the bypass-callout rows.
- `04-decision-policy.md:216` — sidebar reference to `IBX_KERNEL_ENFORCE` typo-guard. `validateEnforceConfig` may still exist as a contract; verify before editing.
- `05-audit-replay-requirements.md` — multiple "before enforce flip" gating references. Rewrite as "before production deploy" or remove gating language entirely (no enforce flip exists today).

## Current-state pointers

- **Constitutional rule:** `CLAUDE.md` rule #9 — "LLM Authority — IBX Intent-Gated Execution v3.0"
- **Always-on cutover commit:** `f3bea43` (deleted shadow/enforce/kill-switch — invalidates `07-rollback-recovery.md`)
- **Operator runbook:** `docs/ops/runbooks/kernel-operations.md` (replaces the deleted SHADOW-ENFORCE-ROLLOUT.md)
- **Closeout status:** [`../audit-2026-05-24/CLOSEOUT-STATUS.md`](../audit-2026-05-24/CLOSEOUT-STATUS.md)
- **Threat model:** [`../threat-model/THREAT-MODEL.md`](../threat-model/THREAT-MODEL.md)
- **Civilization-health meta-review:** [`../CIVILIZATION-HEALTH-2026-05-24.md`](../CIVILIZATION-HEALTH-2026-05-24.md)
