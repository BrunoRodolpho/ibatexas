# Kernel Operations (always-on)

> The adjudicate kernel is always authoritative — every mutation is adjudicated,
> every decision audited. No env-var gating, no shadow mode, no kill switch.
> See [ADRs #9 + #14](../../architecture/decisions.md) for the architecture
> rationale.

## Daily operations

### Inspect kernel state

```
ibx kernel status
```

Reports installed Packs, known intent kinds, audit sink topology, and ledger
health.

### Re-feed historical traffic through a new policy

After bumping a `@adjudicate/*` package version (typically a Pack policy
update), replay recent audit records to detect drift before it shows up in
live traffic:

```
ibx kernel replay --since=24h
ibx kernel replay --since=7d --intent-kind=order.checkout.create
```

The replay reads from the `intent_audit` Postgres table, calls `adjudicate()`
with the current policy bundle, and reports any decision that differs from
the historical record.

---

## First-time setup / migrations

The audit-postgres sink writes every decision to the `intent_audit` table.
The schema ships as raw SQL files in `@adjudicate/audit-postgres/migrations/`.

`ibx bootstrap` applies them as part of the standard setup. To re-run only
the kernel migrations (e.g. after pulling a newer `@adjudicate/audit-postgres`
that adds columns):

```
ibx kernel migrate
```

Idempotent — re-running is safe; the SQL files use `IF NOT EXISTS` patterns
and the CLI swallows "already exists" / "duplicate" errors.

Boot preflight (`apps/api/src/plugins/kernel-bootstrap.ts`) verifies the
`intent_audit` table exists before the api starts serving traffic — if it's
missing, the api refuses to boot and points the operator at this runbook.

---

## DEFER troubleshooting

The DEFER decision parks an envelope in Redis (`defer:pending:{sessionId}`)
and resumes it when the associated signal (e.g. `payment.confirmed`) fires
via the `defer-resolver` subscriber.

Operator recovery for a stuck-deferred session:

```
ibx kernel defer resume <sessionId>
ibx kernel defer resume <sessionId> --signal pix.confirmed --json   # dry-run
```

The CLI verifies the parked-envelope hash (fail-closed on tamper) and
publishes a synthesised `payment.status_changed` NATS event so the live
resolver picks it up. The CLI does NOT bypass `adjudicate()` — it kicks
the existing resume pipeline.

---

## Pack version updates

`@adjudicate/*` packages are pinned in:
- `apps/api/package.json`
- `packages/cli/package.json`
- `packages/domain/package.json`
- `packages/llm-provider/package.json`
- `packages/tools/package.json`
- `packages/pack-customer-onboarding/package.json`
- `packages/pack-orders/package.json`
- `packages/pack-payments/package.json`
- `packages/pack-reservations/package.json`
- `packages/pack-whatsapp/package.json`

Routine bump procedure:

1. Update the version in every consuming `package.json` (keep them aligned).
2. `pnpm install`.
3. `ibx kernel migrate` — applies any new audit-postgres migrations.
4. `ibx dev build` — verifies typecheck across the workspace.
5. `pnpm test` — verifies behavioral contract didn't shift.
6. `ibx kernel replay --since=24h` after restart — catches policy drift on
   live recent traffic.

The boot-time `assertPackCoverage` validator (in `kernel-bootstrap.ts`)
ensures every `KNOWN_INTENT_KINDS` entry has a Pack policy. If a Pack
upgrade drops support for an intent kind, the api will refuse to boot with
a `PackCoverageError` naming the missing kind.

---

## Incident response

The kernel cannot be disabled at runtime — that's intentional. If a Pack
policy is wrong and producing bad decisions in production:

1. Identify the bad Pack (CLI `ibx kernel status` shows installed Packs; the
   `intent_audit` table records every decision with `pack` metadata).
2. Pin to the prior `@adjudicate/<pack>` version in the relevant consumer
   `package.json` files.
3. `pnpm install` + `ibx dev build` + deploy.
4. Open a Pack-side issue in [BrunoRodolpho/adjudicate](https://github.com/BrunoRodolpho/adjudicate)
   so the regression is addressed upstream.

For a Redis outage that takes the ledger offline, `adjudicate()` will REFUSE
mutations with `code: "ledger_unavailable"`. This is by design (fail-closed
on at-least-once delivery). Restore Redis to unblock.

For a Postgres outage that takes audit-postgres offline, `adjudicate()`
continues — records spill to Redis and the `audit-consumer` subscriber
drains them once Postgres recovers. Audit emit is best-effort at the
IbateXas boundary; the kernel never blocks on Postgres.
