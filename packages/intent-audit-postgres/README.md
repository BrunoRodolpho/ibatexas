# @adjudicate/intent-audit-postgres

Postgres durable governance trail for IBX Intent-Gated Execution.

Implements `AuditSink` from `@adjudicate/intent-audit` against a partitioned-by-month
`intent_audit` table. Adopters supply a Postgres writer that runs an INSERT;
the sink flattens each `AuditRecord` into the table's row shape.

## Schema

See [`migrations/001-create-intent-audit.sql`](./migrations/001-create-intent-audit.sql).

Partitioned by `recorded_at` (range, monthly). Adopters create partitions
monthly via cron, [pg_partman](https://github.com/pgpartman/pg_partman), or
their migration tooling. Retention is set by dropping old partitions
according to the compliance window (typically 7y for financial intents,
2y for general transactional audit).

## Usage

```ts
import { createPostgresSink } from "@adjudicate/intent-audit-postgres";
import { multiSink, createConsoleSink, createNatsSink } from "@adjudicate/intent-audit";

const sink = multiSink(
  createConsoleSink(),
  createNatsSink({ publisher: natsPublisher }),
  createPostgresSink({
    writer: {
      async insertAudit(row) {
        await pgClient.query(
          `INSERT INTO intent_audit (intent_hash, session_id, kind, principal,
             taint, decision_kind, refusal_kind, refusal_code, decision_basis,
             resource_version, envelope_jsonb, decision_jsonb, recorded_at,
             duration_ms, partition_month)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
             $12::jsonb, $13, $14, $15)
           ON CONFLICT DO NOTHING`,
          [
            row.intent_hash, row.session_id, row.kind, row.principal,
            row.taint, row.decision_kind, row.refusal_kind, row.refusal_code,
            row.decision_basis, row.resource_version, row.envelope_jsonb,
            row.decision_jsonb, row.recorded_at, row.duration_ms, row.partition_month,
          ],
        );
      },
    },
    onError: (err, record) => {
      Sentry.captureException(err, { extra: { intentHash: record.intentHash } });
    },
  }),
);
```

## Replay

```ts
import { readAuditWindow } from "@adjudicate/intent-audit-postgres";
import { replay } from "@adjudicate/intent-audit";

const records = await readAuditWindow(myQuery, {
  fromIso: "2026-04-01T00:00:00Z",
  toIso: "2026-04-30T23:59:59Z",
  intentKind: "order.submit",
});

const report = replay(records, (r) => adjudicate(r.envelope, currentState, policy));
console.log(`${report.matched}/${report.total} matched, ${report.mismatches.length} divergences`);
```

The replay is deterministic — running today's policy against last month's
records detects drift before any audit. Hook this into CI for "no
divergence" regression fences.

## When to ship this vs ConsoleSink-only

Per the v2.0 plan's open decision #3: ship after P0-h (intent-level dedup
authoritative) so 30 days of records are available before the first
compliance audit. Earlier adoption is fine but adds operational surface
(migrations, partition rotation, retention) that's not strictly required
until durable retention matters.

## Why a separate package

`@adjudicate/intent-audit` stays free of Postgres-specific imports — adopters that
ship to environments without Postgres (edge functions, mobile-first runtimes)
do not pull in this dependency. The base `AuditSink` interface is everything
they need.
