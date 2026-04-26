# @ibx/intent-audit

Execution Ledger + durable audit sinks + replay harness.

## Ledger vs Sink — two concerns, two primitives

| | Purpose | Backend (v1.0) | TTL | Authority |
|---|---|---|---|---|
| **Execution Ledger** | Hot-path replay/dedup: "has `intentHash` already executed?" | Redis (`SET NX` + JSON blob) | 14 days | **Execution dedup only** — not the governance record of truth |
| **Audit Sink** | Durable governance trail: "what happened, why, on what basis?" | `ConsoleSink`, `NatsSink`, `PostgresSink` (opt-in `@ibx/intent-audit-postgres`) | Permanent / stream-lifetime | **Governance record of truth** |

**Do not conflate them.** Redis is not a durable audit substrate. If the
ledger is ever lost, execution dedup regresses (retries may duplicate). Audit
records stay intact because Sinks persist independently.

## Execution Ledger

```ts
import { createRedisLedger, createMemoryLedger } from "@ibx/intent-audit";

const ledger = createRedisLedger({
  client: myRedisClient,               // exposes `set(key, value, options)` + `get(key)`
  keyFor: (suffix) => rk(suffix),      // adopter-supplied namespacer
  ttlSeconds: 14 * 24 * 60 * 60,       // default 14 days
});

const hit = await ledger.checkLedger(envelope.intentHash);
if (hit) return { alreadyExecuted: true, at: hit.at };

await ledger.recordExecution({
  intentHash: envelope.intentHash,
  resourceVersion: orderVersion,
  sessionId: envelope.actor.sessionId,
  kind: envelope.kind,
});
```

SET NX + TTL. First writer wins. Memory implementation available for tests.

## Audit Sinks

```ts
import { createConsoleSink, createNatsSink, multiSink } from "@ibx/intent-audit";

const sink = multiSink(
  createConsoleSink({ prefix: "[audit]" }),
  createNatsSink({ publisher: myNatsPublisher }),
);

await sink.emit(auditRecord);
```

`multiSink` fans out in parallel via `Promise.allSettled` — one sink's failure
does not block the others. Audit is fail-open on the hot path; the replay
harness catches dropped records later.

## Replay harness

```ts
import { replay } from "@ibx/intent-audit";

const report = replay(records, (r) => adjudicate(r.envelope, state, policy));
// report.matched === report.total means your policy still produces identical
// decisions for every historical intent — no drift.
```

## Feature flags

- `IBX_LEDGER_ENABLED=true` → shadow writes (record but do not enforce)
- `IBX_LEDGER_ENFORCE=true` → `checkLedger` is authoritative on the write path

Both flags are parsed case-insensitively (`1`, `true`, `yes`, `on`).
