# Kernel Operations (always-on)

> The adjudicate kernel is always authoritative — every mutation is adjudicated,
> every decision audited. No env-var gating, no shadow mode, no kill switch.
> See [ADRs #9 + #14](../../architecture/decisions.md) for the rationale.

## Daily operations

### Inspect kernel state

```
ibx kernel status          # add --json for machine output
```

Prints known intent kinds (grouped by domain), the execution-ledger flags, and
the audit-sink topology (console + NATS always on, Postgres). `status` only
*describes* configuration — it needs no `DATABASE_URL` and opens no connection.

### Re-feed historical traffic through a new policy

After bumping a `@adjudicate/*` package (typically a Pack policy update), replay
recent audit records to detect drift before it shows up in live traffic:

```
ibx kernel replay --since=24h
ibx kernel replay --since=7d --intent-kind=order.checkout.create
ibx kernel replay --since=24h --dry-run    # list records, no re-adjudication
```

Replay reads the `intent_audit` Postgres table, re-calls `adjudicate()` against
each historical envelope with the currently-installed Pack policy bundle, and
reports decisions that diverge from the recorded one (by DECISION_KIND, by
BASIS, or by REWRITE payload).

> **Prerequisite — replay is gated.** Unlike `status`, `replay` opens a live
> Postgres connection, so it gates on `IBX_AUDIT_POSTGRES_ENABLED`
> (`runReplay` in `packages/cli/src/commands/kernel.ts`). When the flag is unset
> or falsy, replay prints an operator-TODO stub (enable the flag, apply the SQL
> migrations, re-run) and exits 0 *without connecting*. It also requires
> `DATABASE_URL`. Set both before relying on replay output.
>
> Note this flag is a known residue: the kernel cutover (ADR #14) deleted
> `IBX_AUDIT_POSTGRES_ENABLED` for the always-on sink, and `status` correctly
> reports Postgres as unconditionally active — but `replay` still reads the flag
> as a connect guard. Treat it as a replay-only prerequisite, not a kernel
> kill switch.

Re-adjudication runs against an empty default state (point-in-time projections
aren't reconstructed), so state-reading guards may report "no-state-context"
drift on a subset of records — interpret the divergence summary against expected
thresholds, not as absolute.

---

## First-time setup / migrations

The audit-postgres sink writes every decision to the `intent_audit` table.
`@adjudicate/audit-postgres` ships its schema as raw SQL files in its
`migrations/` directory (no migration-runner script).

`ibx bootstrap` applies them as part of standard setup. To (re-)run only the
kernel migrations — e.g. after pulling a newer `@adjudicate/audit-postgres` that
adds columns:

```
ibx kernel migrate
```

Idempotent: a per-file `audit_schema_migrations` ledger records each applied
file so every migration runs at most once, and the runner tolerates
already-applied additive DDL plus superseded intermediate constraints. Requires
`DATABASE_URL`.

Boot preflight (`assertAuditPostgresReady` in
`apps/api/src/plugins/kernel-bootstrap.ts`) probes `intent_audit` before the api
serves traffic. If the table (or `DATABASE_URL`) is missing it throws
`AuditPostgresPreflightError` and refuses to boot, naming `ibx bootstrap` /
`ibx kernel migrate` as the fix.

---

## DEFER troubleshooting

The DEFER decision parks an envelope in Redis (`defer:pending:{sessionId}`, keyed
via `rk()`) and resumes it when the awaited signal (e.g. PIX confirmation) fires.
The live `defer-resolver` subscriber sweeps `defer:pending:*` on each settled
`payment.status_changed` event.

Operator recovery for a stuck-deferred session:

```
ibx kernel defer resume <sessionId>
ibx kernel defer resume <sessionId> --json   # dry-run: print the synthesised event, publish nothing
```

The CLI reads the parked blob, verifies its hash via `verifyParkedEnvelopeHash`
(`@adjudicate/runtime`, fail-closed on tamper — a tampered envelope is refused,
never resumed), then publishes a synthesised `payment.status_changed` NATS event
(short form; the client prefixes `ibatexas.`) so the live resolver picks it up.
The CLI does NOT bypass `adjudicate()` — it kicks the existing resume pipeline.
(`--signal` defaults to `pix.confirmed`; the resolver matches parked sessions by
signal.)

---

## Pack version updates

`@adjudicate/*` packages are consumed as pinned registry deps. Top-level
`package.json` files that pin them:

- `apps/api/package.json`
- `packages/audit-sink/package.json`
- `packages/cli/package.json`
- `packages/domain/package.json`
- `packages/intent-kinds/package.json`
- `packages/tools/package.json`
- `packages/pack-customer-onboarding/package.json`
- `packages/pack-orders/package.json`
- `packages/pack-payments/package.json`
- `packages/pack-reservations/package.json`
- `packages/pack-whatsapp/package.json`

(The legacy `@ibatexas/llm-provider` brain — a former consumer — was deleted in
the claustrum cutover; the conversational turn now runs through the claustrum
Conductor.)

Routine bump procedure:

1. Update the version in every consuming `package.json` (keep `@adjudicate/core`
   aligned across all of them).
2. `pnpm install`.
3. `ibx kernel migrate` — applies any new audit-postgres migrations.
4. `ibx dev build` — typecheck across the workspace.
5. `pnpm test` — verify the behavioral contract didn't shift.
6. After restart, with `IBX_AUDIT_POSTGRES_ENABLED=true` and `DATABASE_URL` set:
   `ibx kernel replay --since=24h` — catches policy drift on recent live traffic.

The boot-time `assertPackCoverage` validator (in `kernel-bootstrap.ts`) requires
every Pack-registered `KNOWN_INTENT_KINDS` entry to be declared by an installed
Pack. If a Pack upgrade drops support for a kind, the api refuses to boot with a
`PackCoverageError` naming the missing kind.

> The installed Pack roster is the single list `FIRST_PARTY_PACK_SPECS` in
> `kernel.ts`, kept in lockstep with `installFirstPartyPacks()` in
> `kernel-bootstrap.ts`. `ibx kernel` also exposes governance subcommands
> (`pack-bom`, `analyze`, `seal`) over that same roster — see `--help`.

---

## Incident response

The kernel cannot be disabled at runtime — that's intentional. If a Pack policy
is producing bad decisions in production:

1. Identify the bad Pack — `ibx kernel status` lists installed Packs; the
   `intent_audit` table records every decision with `pack` metadata.
2. Pin the prior `@adjudicate/<pack>` version in the consuming `package.json`
   files.
3. `pnpm install` + `ibx dev build` + deploy.
4. Open a Pack-side issue in
   [BrunoRodolpho/adjudicate](https://github.com/BrunoRodolpho/adjudicate) so the
   regression is fixed upstream.

**Redis outage (ledger offline):** `adjudicate()` REFUSES mutations with
`code: "ledger_unavailable"`. This is by design — the execution ledger is
fail-closed (a duplicate financial mutation is worse than a brief refusal
storm). Restore Redis to unblock.

**Postgres outage (audit-postgres offline):** `adjudicate()` continues; audit
emit is best-effort at the IbateXas boundary and the kernel never blocks on
Postgres. The in-process Postgres sink is the authoritative writer; the
NATS-fed `audit-consumer` subscriber (subject `audit.intent.decision.v1`) is an
at-least-once redundancy writer behind it. When Postgres is unreachable the
consumer pushes the record to the DLQ list `dlq:audit.intent.decision.v1` for
**manual replay after recovery** (`apps/api/src/subscribers/audit-consumer.ts`)
— it does not buffer to Redis or auto-drain.
