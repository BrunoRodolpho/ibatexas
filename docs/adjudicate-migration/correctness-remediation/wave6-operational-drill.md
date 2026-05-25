> ⚠️ **SUPERSEDED on 2026-05-24.** W6 on-call drill (2026-05-23). The `SHADOW-ENFORCE-ROLLOUT.md` runbook + `ibx kernel kill-switch` CLI subcommands that this drill exercised were deleted by the IBX-IGE v3.0 cutover (`f3bea43`); the always-on kernel has no kill switch. For current operator runbook, see `docs/ops/runbooks/kernel-operations.md`. Content preserved unchanged below as historical record.

---

# Wave 6 — Operational Drill Audit

**Auditor:** Operational Drill Auditor (Wave 6)
**Date:** 2026-05-23
**Method:** On-call simulation — execute every concrete operator action from
`runbooks/SHADOW-ENFORCE-ROLLOUT.md`, `remediation/NATS-AUTH-REQUIREMENTS.md`,
and `migration/05-kill-switch-strategy.md`. Real Redis spun up via Docker.

Every drill captures: command issued, observed output, pass/fail, and what would
block a real 3am responder.

---

## Drill 1 — Engage emergency kill switch

### Commands

```bash
docker run --rm -d -p 6379:6379 --name w6-op-redis redis:7-alpine
env -u REDIS_PASSWORD REDIS_URL=redis://localhost:6379 IBX_OPERATOR=drill-tester \
  node packages/cli/dist/index.js kernel kill-switch enable --reason="drill test 1"
```

### Output (verbatim)

```
ibx kernel kill-switch enable
Sinal global enviado — todas as réplicas refusam mutações.

  motivo    : drill test 1
  operador  : cli:drill-tester
  desde     : 2026-05-23T20:59:58.159Z
  TTL        : 24h (auto-disengage)

Para liberar:  ibx kernel kill-switch disable --reason "<motivo>"
```

### Redis verification

```bash
docker exec w6-op-redis redis-cli KEYS '*'   # → development:kill-switch:global
docker exec w6-op-redis redis-cli GET 'ibatexas:kill-switch:global'   # → (empty)
```

### `ibx kernel kill-switch status --json`

```json
{
  "active": true,
  "enabledBy": "cli:drill-tester",
  "enabledAt": "2026-05-23T20:59:58.159Z",
  "reason": "drill test 1"
}
```

### Verdict — PARTIAL

- CLI enables the switch and writes the Redis key. Status returns expected JSON.
- **The key is `<APP_ENV>:kill-switch:global` (e.g. `development:kill-switch:global`),
  NOT `ibatexas:kill-switch:global` as the operator might infer from the project
  name.** Verified in `packages/tools/src/redis/key.ts:14` — prefix is `process.env.APP_ENV`.
  Operator querying with `ibatexas:` prefix sees nothing.
- **No two-key check on the CLI.** Runbook §"Two-key rollout" requires two
  operators. The CLI (this command) writes the Redis flag directly via
  `createKillSwitchStore` — no human confirmation. Only the **HTTP admin route**
  (`apps/api/src/routes/admin/kernel.ts`) implements two-step + same-actor refusal.
- **Role check mismatch.** `kill-switch-strategy.md` table line 528 says scope=Global
  requires `OWNER`. The route uses `requireManagerRole`
  (`apps/api/src/routes/admin/kernel.ts:172`). MANAGER can engage the kill switch
  via HTTP today.
- A 3am responder using ONLY the CLI bypasses the two-person rule entirely. The
  runbook needs to call this out: CLI is for solo emergencies, HTTP is for
  scheduled flips.

---

## Drill 2 — Roll back enforce on a problem intent

### Test harness

Synthesised against the actual `enforce-config` cache:

```js
process.env.IBX_KERNEL_ENFORCE = "order.checkout.create,order.cancel,reservation.modify"
_resetEnforceConfig()
isEnforced("order.checkout.create")   // true
isEnforced("order.cancel")            // true
isEnforced("reservation.modify")      // true

process.env.IBX_KERNEL_ENFORCE = "order.checkout.create,reservation.modify"
_resetEnforceConfig()
isEnforced("order.cancel")            // false   ← gracefully reverts
isEnforced("order.checkout.create")   // true
isEnforced("reservation.modify")      // true

delete process.env.IBX_KERNEL_ENFORCE
_resetEnforceConfig()
// all three → false
```

### Verdict — PASS (behaviour) / PARTIAL (deployment story)

- The set-membership logic is correct: removing one kind leaves others enforced,
  removed kind reverts to shadow/legacy.
- In production this requires a rolling deploy (env-var change isn't hot-pickup).
  Runbook acknowledges this ("After the rolling deploy completes…").
- `_envSnapshot` cache in `@adjudicate/core/kernel/enforce-config.ts:24-48` is
  process-local; a single replica with a partial env update would diverge from
  peers until the deploy completes. Runbook should mention "verify
  `kubectl rollout status` is clean on EVERY replica" — currently says ≥10 min,
  no explicit "all replicas" check.
- `IBX_KERNEL_SHADOW` change requires the same restart. There's no `ibx kernel
  reload` to force a re-read.

---

## Drill 3 — Investigate divergence for one intent kind

### Command

```bash
env -u REDIS_PASSWORD REDIS_URL=redis://localhost:6379 IBX_AUDIT_POSTGRES_ENABLED=false \
  node packages/cli/dist/index.js kernel divergence --since=7d --intent-kind=order.checkout.create
```

### Output (verbatim)

```
ibx kernel divergence
Janela: últimos 7d; kind: order.checkout.create

⚠  IBX_AUDIT_POSTGRES_ENABLED=false — sem dados de shadow ainda.

TODO para o operador:

    1. Habilitar IBX_AUDIT_POSTGRES_ENABLED=true em .env.
    2. Setar IBX_KERNEL_SHADOW=<kinds> para iniciar shadow.
    3. Aguardar uma janela de 24h+ com tráfego real.
    4. Rodar `ibx kernel divergence --since=24h` novamente.

Classes de divergência: BASIS_ONLY, DECISION_KIND, PAYLOAD_REWRITE.
```

### Code verification

`kernel.ts:691-701` — `intentKind` IS now threaded through `readAuditWindow`.
SQL at line 670 includes `AND intent_kind = $N` when window.intentKind is set.

### Verdict — PASS

- W3 D4 fix is real. The `--intent-kind` filter is correctly forwarded.
- Postgres-off message is honest and actionable.

---

## Drill 4 — Replay window for an incident

### Command (postgres off)

```bash
env IBX_AUDIT_POSTGRES_ENABLED=false node packages/cli/dist/index.js kernel replay --since=24h
```

### Output

```
ibx kernel replay
Janela: últimos 24h; limite: 1000; kind: todos

⚠  IBX_AUDIT_POSTGRES_ENABLED=false — replay não pode ser executado.

TODO para o operador (quando audit-postgres for habilitado):

  1. Habilitar IBX_AUDIT_POSTGRES_ENABLED=true no .env de produção.
  2. Rodar pnpm migrate em @adjudicate/audit-postgres para criar a tabela intent_audit.
  3. Rodar `ibx kernel replay --since=24h` novamente.
```

### Verdict — PARTIAL (broken followup instructions)

- The `--intent-kind` filter is threaded (kernel.ts:300 + SQL at 279).
- **Dead end in followup:** the TODO says `pnpm migrate em @adjudicate/audit-postgres`.
  Reading `/Users/thaisrodolpho/projects/adjudicate/packages/audit-postgres/package.json`:
  there is NO `migrate` script. Only `build`, `lint`, `test`. The migrations are
  raw SQL files at `packages/audit-postgres/migrations/*.sql` (001 through 008).
  An operator following the runbook will run `pnpm migrate` and get `No script
  matched. Available: build, lint, test.` — full stop.
- Operator's actual path: `psql ${DATABASE_URL} -f .../001-create-intent-audit.sql`
  etc. for all 8 files. Nowhere documented.

---

## Drill 5 — Stuck DEFER intent recovery

### Commands tried

```bash
node packages/cli/dist/index.js kernel --help          # no defer subcommand
grep -r "defer.*resume" packages/cli/src/commands/      # no matches
```

### Verdict — FAIL (operator hits dead end)

- No `ibx kernel defer resume <sessionId>` command exists.
- The defer-sweeper auto-fires on worker boot via `runRecoveryScan()`
  (`apps/api/src/jobs/defer-timeout-sweeper.ts:30-48`). This is the ONLY
  recovery path the codebase supports.
- An operator with a stuck DEFER that the sweeper isn't picking up has these
  options, all manual:
  1. `redis-cli SCAN 0 MATCH "development:defer:pending:*"` — find parked envelopes.
  2. Read the JSON, extract `sessionId` + `intentHash` + `signal`.
  3. `nats pub ibatexas.intent.defer.timeout '<json>'` — manually fire the timeout.
  4. Or just bounce the API replica so the sweeper boots and runs recovery scan.
- **Runbook silent on this.** No published Lua script template, no Redis query
  reference, no "restart this worker" guidance. Audit finding confirmed.

---

## Drill 6 — Audit-postgres enable

### What happens with `IBX_AUDIT_POSTGRES_ENABLED=true` and no migrations

- `apps/api/src/index.ts` starts `audit-consumer` (NATS-backed redundant writer)
  AND `intent-audit-wiring.ts` composes the in-process `createPostgresSink`.
- Both writers use `multiSinkLossy` and are wrapped fail-open (see
  `packages/llm-provider/src/intent-audit-wiring.ts:345`, `:365`, `:393-420`).
- Every audit emit: SQL fires, fails with `relation "intent_audit" does not exist`,
  is logged as a sink-failure, kernel continues.
- **No bootloop.** **No silent failure** (sink-failure metric increments).
- Threat model line 164 (`threat-model/THREAT-MODEL.md`) WARNS that without the
  `intent_audit_refusal_pair` ON CONFLICT constraint, first write crashes with
  `42P10`. The SHADOW-ENFORCE-ROLLOUT runbook does NOT reference this.

### Where is the operator told what to apply?

- `OVERNIGHT-RUN-SUMMARY.md:140` says "Audit-Postgres SQL migrations not run
  tonight" — but doesn't say which.
- The migrations are committed: `001-create-intent-audit.sql` through
  `008-add-v4-fields.sql`. No README in `packages/audit-postgres/migrations/`.
- There is no `pnpm migrate` script in `audit-postgres`. A grep for "migrate"
  in that package shows no runner.

### Verdict — PARTIAL

- Code path is fail-open (no bootloop, good).
- Operator has no runbook trail to know exactly which SQL files to run, in which
  order, against which database. The `pnpm migrate` reference in the replay
  CLI's TODO message and (by implication) in the rollout runbook is broken.

---

## Drill 7 — Sweeper outage recovery

### Code reference

`apps/api/src/jobs/defer-timeout-sweeper.ts:30-48` documents:
- Recovery scan runs on worker boot (`runRecoveryScan` invoked by start path).
- Heartbeat at `rk("heartbeat:defer-sweeper")` with 120s TTL (2× the 60s tick).

### Operator check

No CLI. Operator runs:

```bash
docker exec w6-op-redis redis-cli GET 'development:heartbeat:defer-sweeper'
# → "2026-05-23T..." if alive, (nil) if down (or TTL expired)
docker exec w6-op-redis redis-cli TTL 'development:heartbeat:defer-sweeper'
```

There is no `ibx kernel sweeper status` or similar.

### Verdict — PARTIAL

- Recovery on worker reboot is real and automatic.
- The runbook claims "if sweeper is down >TTL, run recovery scan" — but the only
  way to RUN it is to restart the worker. No standalone trigger.
- Heartbeat key is not exposed in any operator-friendly CLI. Operator must know
  the rk() prefix (`<APP_ENV>:heartbeat:defer-sweeper`) — not documented in the
  runbook.

---

## Drill 8 — Same-actor confirmation refusal

### Code reference

`apps/api/src/routes/admin/kernel.ts:217-225`:

```ts
const requestStaff = (staffId ?? "").trim()
const pendingStaff = (pending.staffId ?? "").trim()
if (requestStaff.length === 0 || pendingStaff.length === 0) {
  return reply.code(403).send({ error: NULL_STAFF_REFUSAL })
}
if (constantTimeEqual(requestStaff, pendingStaff)) {
  return reply.code(403).send({ error: SAME_ACTOR_REFUSAL })
}
```

Refusal text (pt-BR): `"Outro operador precisa confirmar — você iniciou a etapa 1 desta ação."`

Test: `apps/api/src/routes/admin/__tests__/kernel-kill-switch.test.ts:194` —
"step 2 same actor → 403 (two-person rule)".

### Verdict — PASS

- 403 + pt-BR refusal text wired correctly.
- Constant-time compare avoids timing leaks.
- Unit test exists at the expected location.

---

## Drill 9 — Grafana dashboard sanity

### JSON validity + uid

| File | UID | Title | Panels |
|------|-----|-------|--------|
| kernel-audit-pipeline-health.json | `kernel-audit-pipeline-health` | Kernel Audit Pipeline Health | 4 |
| kernel-decision-overview.json | `kernel-decision-overview` | Kernel Decision Overview | 4 |
| kernel-defer-backlog.json | `kernel-defer-backlog` | Kernel DEFER Backlog & Timeouts | 4 |
| kernel-enforcement-readiness.json | `kernel-enforcement-readiness` | Kernel Enforcement Readiness (per intent) | 3 |

All UIDs match runbook references (`/d/kernel-enforcement-readiness`, etc.).

### Metric audit (cross-checked against `kernel-metrics-sink.ts:175-353`)

| Dashboard query | Registered? |
|---|---|
| `kernel_decision_total` | ✓ |
| `kernel_refusal_total` | ✓ |
| `kernel_decision_duration_seconds_bucket` | ✓ |
| `kernel_audit_lag_seconds_bucket/_count` | ✓ |
| `kernel_audit_sink_failure_total` | ✓ |
| `kernel_intent_kind_coverage` | ✓ |
| `kernel_shadow_divergence_total` | ✓ |
| `kernel_defer_pending_gauge` | ✓ |
| `kernel_defer_quota_exceeded_total` | ✓ |
| `kernel_defer_resume_duration_seconds_bucket` | ✓ |
| `kernel_defer_timeout_total` | ✓ |
| **`kernel_audit_spill_bytes`** | **✗ NOT REGISTERED** |

The closest registered metric is `kernel_audit_sink_spill_size`
(`kernel-metrics-sink.ts:338-345`). The dashboard panel
`kernel-audit-pipeline-health.json:252` queries
`max(kernel_audit_spill_bytes{env="$env"})` which will render EMPTY in
production — the spill panel is broken.

### Verdict — PARTIAL (1 of 4 dashboards has a dead panel)

- JSON validates, UIDs match.
- One panel will be silently blank because the metric name doesn't match what
  the sink registers.

---

## Drill 10 — Alert YAML sanity

### Metric audit

All 14 alert rules in `infra/alerts/kernel.yaml`:

| Alert | Metric | Registered? |
|---|---|---|
| 1 KernelRefusalRateSpike | `kernel_refusal_total`, `kernel_decision_total` | ✓ |
| 2 KernelDivergenceDecisionKind | `kernel_shadow_divergence_total` | ✓ |
| 3 KernelDivergencePayloadRewrite | `kernel_shadow_divergence_total` | ✓ |
| 4 KernelDecisionLatencyHigh | `kernel_decision_duration_seconds_bucket` | ✓ |
| 5 KernelAuditLagHighPostgres | `kernel_audit_lag_seconds_bucket` | ✓ |
| 6 KernelAuditLagHighNats | `kernel_audit_lag_seconds_bucket` | ✓ |
| 7 KernelLedgerUnavailable | `kernel_ledger_op_total` | ✓ |
| 8 KernelDeferTimeoutRate | `kernel_defer_timeout_total` | ✓ |
| 9 KernelDeferQuotaExceeded | `kernel_defer_quota_exceeded_total` | ✓ |
| 10 KernelReplayDriftRegressing | `kernel_replay_drift_total` | ✓ |
| 11 KernelKillSwitchEngaged | `kernel_kill_switch_state` | ✓ |
| 12 KernelAuditSinkFailureBurst | `kernel_audit_sink_failure_total` | ✓ |
| **13 KernelAuditSpillOverflow** | **`kernel_audit_spill_bytes`** | **✗ NOT REGISTERED** |
| 14 KernelToolCallSuccessDrop | `kernel_decision_total` | ✓ |

Alert 13 (`KernelAuditSpillOverflow`) — `max(kernel_audit_spill_bytes) > 1073741824` — will never fire. It depends on a metric that the API never emits.

### Anti-theater test reality check

`packages/cli/src/__tests__/infra-grafana-alerts.test.ts:48-68` defines a
CANONICAL_METRICS allowlist used to validate dashboards + alerts. The allowlist
includes `kernel_audit_spill_bytes` (line 65). This test passes because the
list is internally consistent — but it does NOT cross-check against
`kernel-metrics-sink.ts`. The "anti-theater" guarantee is itself theatrical
when the canonical list is wrong.

### Runbook URLs

All 8 distinct runbook_url paths exist:

```
docs/adjudicate-migration/governance/05-audit-replay-requirements.md           EXISTS
docs/adjudicate-migration/governance/06-deferred-execution-policy.md           EXISTS
docs/adjudicate-migration/migration/05-kill-switch-strategy.md                 EXISTS
docs/adjudicate-migration/remediation/NATS-AUTH-REQUIREMENTS.md                EXISTS
docs/adjudicate-migration/runbooks/SHADOW-ENFORCE-ROLLOUT.md (#anchors valid)  EXISTS
docs/ops/runbooks/01-stage-read-mutations.md                                   EXISTS
docs/ops/runbooks/04-stage-financial-mutations.md                              EXISTS
docs/ops/runbooks/05-stage-pix-charge-pack.md                                  EXISTS
```

### Verdict — PARTIAL

- 13 of 14 alerts reference real metrics.
- All runbook URLs map to real files.
- Alert 13 is dead on arrival. PagerDuty will never page on audit spill.

---

# Final scorecard

| # | Drill | Verdict |
|---|---|---|
| 1 | Engage emergency kill switch | PARTIAL — works, but CLI bypasses two-person rule; role mismatch (doc says OWNER, code says MANAGER); key namespace is `<APP_ENV>:` not `ibatexas:` |
| 2 | Roll back enforce on problem intent | PASS (behaviour) / PARTIAL (deployment requires rolling restart, no hot-reload) |
| 3 | Investigate divergence | PASS — `--intent-kind` threaded; postgres-off message helpful |
| 4 | Replay window | PARTIAL — `pnpm migrate` followup is a dead end (no script) |
| 5 | Stuck DEFER recovery | **FAIL** — no CLI; only manual Redis SCAN + NATS publish |
| 6 | Audit-postgres enable | PARTIAL — no bootloop, but no clear migration-application path |
| 7 | Sweeper outage recovery | PARTIAL — auto on reboot, but no CLI status/trigger |
| 8 | Same-actor confirmation | PASS — 403 + pt-BR text + unit test |
| 9 | Grafana dashboard sanity | PARTIAL — 1 panel queries nonexistent `kernel_audit_spill_bytes` |
| 10 | Alert YAML sanity | PARTIAL — Alert 13 (`KernelAuditSpillOverflow`) dead; rest OK |

**Operational drill: 2/10 pass without help (Drills 3, 8); 7 partial (would
make a 3am responder fumble or improvise); 1 fail (Drill 5 — operator hits
real dead end with no documented recovery path).**

---

# Top 5 dead-ends an operator would hit

1. **Stuck DEFER recovery (Drill 5).** No `ibx kernel defer resume` exists.
   Operator must SCAN Redis, parse JSON, manually publish NATS. Or restart the
   worker and hope `runRecoveryScan` clears it.
2. **"Run pnpm migrate" lies (Drills 4, 6).** The CLI's TODO message tells the
   operator to run `pnpm migrate` in `@adjudicate/audit-postgres`. That script
   does not exist. They will sit at a useless error and have to figure out the
   migration manifest themselves.
3. **Broken alert + dashboard panel for audit spill (Drills 9, 10).** Both
   reference `kernel_audit_spill_bytes` which the sink never emits. A real spill
   incident will not page anyone. The "anti-theater" test passes because it
   shares the same wrong name.
4. **Two-person rule isn't enforced when using the CLI (Drill 1).** The runbook
   prominently advertises two-key rollout, but `ibx kernel kill-switch enable`
   writes Redis directly. Solo operator can disable the entire kernel.
5. **Role contract mismatch (Drill 1).** Strategy doc says scope=Global requires
   OWNER; the HTTP route enforces only `requireManagerRole`. Any MANAGER can
   engage. Either the doc lies or the code is too permissive.

---

# Top 3 surprises

1. **Good:** The `--intent-kind` filter for `kernel divergence` (W3 D4 fix) and
   `kernel replay` are both correctly threaded into the SQL. The fix wasn't
   marketing — it actually closed the leak.
2. **Good:** The same-actor refusal (Drill 8) has constant-time compare, pt-BR
   text, AND a real unit test. This is one of the few areas where the
   end-to-end claim matches the implementation.
3. **Bad:** The Redis key prefix `<APP_ENV>:` is silently injected by `rk()`,
   meaning every key in the runbook ("ibatexas:kill-switch:global",
   "heartbeat:defer-sweeper", etc.) is actually
   "<APP_ENV>:kill-switch:global" / "<APP_ENV>:heartbeat:defer-sweeper" at
   runtime. Operators following docs literally will see "(nil)" and panic.

---

# Verdict — is the system on-call ready?

**No. Not yet.** The kernel itself behaves correctly, but the operator-facing
runbooks, CLI, dashboards, and alerts are out of sync with each other:

- Kill switch is functional, but the runbook over-promises two-person enforcement
  that only the HTTP path provides.
- One alert + one dashboard panel will silently fail to ever fire (audit spill).
- The single most consequential failure mode (stuck DEFER) has zero CLI surface.
- Migration steps the runbook tells operators to run don't exist as written.

What ship-blocks a Tier-3 / Tier-4 enforce flip:
- Drill 5 (stuck DEFER recovery) MUST have either a CLI tool OR an explicitly-
  documented redis-cli + NATS recipe before flipping `customer.anonymize` or
  any financial intent.
- Drills 9/10 (`kernel_audit_spill_bytes`) MUST resolve to either a real metric
  OR the dashboard/alert must be edited to use `kernel_audit_sink_spill_size`.
  Otherwise a real spill incident silently corrupts audit retention.
- Drill 1's role/two-person mismatch MUST resolve — either the runbook softens
  the two-person language, or the code adds the same-actor check to the CLI
  surface.

What is safe to ship as-is for Tier 1 (idempotent + reversible) flips:
- Drill 2 (env-var rollback) behaviour is correct.
- Drill 3 (divergence investigation) works end-to-end.
- Drill 8 (same-actor) is correct via the HTTP path.

Everything else either compromises the migration's safety claims or makes
the on-call lead improvise at 3am.
