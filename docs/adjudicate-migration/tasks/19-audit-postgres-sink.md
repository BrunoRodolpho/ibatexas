# Task 19 — Audit Postgres Sink + Persistent Buffer

**Milestone:** M4 (Audit & observability)
**Estimated effort:** M — 2–3 dev-days
**Blocks:** M3 enforce flips (compliance pre-flight requires durable audit per runbook 04)
**Blocked by:** 01, 05, 18 (redactor must run before durable sink)
**Owner:** unassigned

## Objective

Wire `@adjudicate/audit-postgres` as the durable audit sink. Add `persistentBufferedSink` in front (spills to durable storage on overflow / failure; survives process restart). Add a NATS audit consumer subscriber that reads `ibatexas.audit.intent.decision.v1` and persists missed records as a redundancy path. After this lands, every adjudicated decision lands in a Postgres `intent_audit` table with monthly partitioning, replayable via `readAuditWindow`, and resilient to crashes.

## Architecture context

Cite: investigation 05 §"Capabilities ibatexas should adopt" Tier 1 #5-#7 + investigation 06 P0-5 + investigation 07 P1 #9.
> "**`@adjudicate/audit-postgres.createPostgresSink`** — Postgres is already in our stack. This drops governance into a durable substrate aligned with `multiSink(consoleSink, natsSink, postgresSink)`. Supports replay reading via `readAuditWindow`."
> "**`persistentBufferedSink`** — `bufferedSink` is lossy on overflow. `persistentBufferedSink` spills to durable storage and survives process restart. Governance-grade."
> "No consumer subscribed to `ibatexas.audit.intent.decision.v1`. The NATS audit sink publishes but nobody listens."

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/intent-audit-wiring.ts` (current sink stack)
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/prisma/schema.prisma` (existing schema; add intent_audit table)
- `/Users/thaisrodolpho/projects/adjudicate/packages/audit-postgres/src/index.ts` (createPostgresSink + readAuditWindow)

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/prisma/migrations/<timestamp>_add_intent_audit/migration.sql`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/subscribers/audit-archiver.ts` (NATS consumer)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/subscribers/__tests__/audit-archiver.test.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/__tests__/intent-audit-wiring-postgres.test.ts`

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/intent-audit-wiring.ts` — compose `persistentBufferedSink(multiSink(console, nats, postgres))`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/package.json` — add `@adjudicate/audit-postgres` dep
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/index.ts` — register the audit-archiver subscriber
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/prisma/schema.prisma` — add `IntentAudit` model

## Constraints

- Postgres sink uses monthly partitioning (per `@adjudicate/audit-postgres` convention) on the `intent_audit` table.
- `persistentBufferedSink` spill storage uses Redis (`rk('audit:spill:*')` with 7-day TTL) — sufficient durability without adding a new dependency.
- The redactor (Task 18) runs BEFORE the buffered sink — never let raw PII into the spill storage.
- The NATS audit-archiver is a redundancy consumer: it reads the published audit subject and writes to Postgres if the direct sink failed. Use `OrderEventLog.idempotencyKey`-style dedup (`audit.intent.decision.v1.{recordId}`) to prevent double-writes.
- Audit lag SLO: <30s p99 per runbook 04. Monitor via the metrics sink (Task 05) — add a `kernel_audit_postgres_lag_seconds` histogram.
- Follow CLAUDE.md rule #7 (rk for Redis keys).

## Implementation requirements

1. **Prisma migration** — add `IntentAudit` model:
   ```prisma
   model IntentAudit {
     id           String   @id @default(uuid())
     intentHash   String   @unique
     auditHash    String
     kind         String
     decisionKind String
     // ... mirror AuditRecord shape minus payload (it's already redacted but consider whether to persist raw vs redacted — see constraint)
     payload      Json     // REDACTED payload from Task 18
     decision     Json
     basis        Json
     actor        Json
     taint        String
     plan         Json?
     supersedes   String[]
     createdAt    DateTime @default(now())
     packId       String?
     packVersion  String?
     @@map("intent_audit")
     @@index([kind, createdAt])
     @@index([decisionKind, createdAt])
     // Monthly partitioning via raw SQL — Prisma supports this via @@map + manual SQL
   }
   ```

2. **Wire `createPostgresSink`** in `intent-audit-wiring.ts`:
   ```ts
   import { createPostgresSink } from "@adjudicate/audit-postgres";
   import { persistentBufferedSink, multiSink, createConsoleSink, createNatsSink, createInMemorySpillStorage } from "@adjudicate/audit";
   
   const postgresSink = createPostgresSink({client: prisma /* or a separate pg pool */});
   const inner = multiSink(createConsoleSink(...), createNatsSink(...), postgresSink);
   const buffered = persistentBufferedSink({
     inner,
     storage: createRedisSpillStorage({redis, keyPrefix: "audit:spill"}),
     capacity: 1000,
     onOverflow: "spill",
     onSpill: (reason, count) => log.warn({reason, count}, "audit-spill"),
   });
   const redacted = wrapWithRedactor(buffered, redactor); // Task 18
   ```

3. **Redis spill storage** — implement `createRedisSpillStorage(opts): PersistentSpillStorage` since the framework's `createInMemorySpillStorage` is in-memory only. Pattern:
   - `put(records[]): Promise<void>` — pushes JSON-serialized to `rk('audit:spill:queue')` Redis list, sets TTL 7 days.
   - `drain(): AsyncIterable<AuditRecord>` — pops via `LPOP` until empty.
   - `size(): Promise<number>` — `LLEN`.

4. **Audit archiver subscriber** (`audit-archiver.ts`):
   - Subscribes to NATS subject `audit.intent.decision.v1`.
   - On message, check Postgres via `intent_audit.findUnique({where: {intentHash}})`. If exists, skip (dedup).
   - Else insert via `intent_audit.create({...})`.
   - Idempotent: `intent_audit.intentHash` is a unique index.
   - Use `isNewEvent` from `dedup.ts` (per investigation 04) AND the unique constraint as two layers of dedup.

5. **Register subscriber** in `apps/api/src/index.ts`.

6. **Migration ops** — add monthly partition automation. Either:
   - Manual: schedule a monthly cron (BullMQ job) creating next month's partition.
   - Automatic: use `pg_partman` or hand-roll a Postgres function (preferred per `@adjudicate/audit-postgres` docs).
   - Document the choice in the PR description.

7. **Tests:**
   - **audit-archiver.test.ts:**
     - "writes new record to Postgres on NATS receive"
     - "skips duplicate record (intentHash unique constraint)"
     - "writes nothing if isNewEvent dedup catches first"
   - **intent-audit-wiring-postgres.test.ts:**
     - "postgresSink composes correctly with multiSink"
     - "persistentBufferedSink spills on capacity overflow"
     - "spilled records drain on next emit"
     - "redactor runs before postgresSink — Postgres row contains [REDACTED] not raw CPF"

## Acceptance criteria

- [ ] `IntentAudit` Prisma model exists; migration applied.
- [ ] `createPostgresSink` composed in `intent-audit-wiring.ts` behind `persistentBufferedSink`.
- [ ] Redis spill storage implementation.
- [ ] `audit-archiver` subscriber wired in `index.ts`.
- [ ] Postgres records contain redacted payloads (Task 18 runs first).
- [ ] `kernel_audit_postgres_lag_seconds` metric registered.
- [ ] Monthly partitioning automated (cron or Postgres function).
- [ ] All audit-archiver + wiring tests pass.

## Testing requirements

- **Unit:** the two new test files.
- **Integration:** spawn a real Postgres (use existing test DB) + ioredis-mock + NATS test stub; emit 100 records; assert all 100 land in Postgres within 5s.
- **Bypass-detection:** assert `intent_audit.payload` for a `set_pix_details` row contains `[REDACTED]` not raw CPF (catches if redactor was bypassed).

## Rollout notes

Land BEHIND a feature flag `IBX_AUDIT_POSTGRES_ENABLED` (default false). After 7 days of clean audit emission in staging, flip to true in production.

Watch:
- `kernel_audit_postgres_lag_seconds` p99 < 30s (runbook 04 requirement)
- Postgres connection pool — audit sink may need a dedicated pool (separate from `prisma` singleton)

## Rollback notes

Soft rollback: set `IBX_AUDIT_POSTGRES_ENABLED=false`. The Postgres sink is removed from the multi-sink; NATS + console continue. Spill storage drains naturally. ETA: 5 min.

Hard rollback: revert PR. ETA: 15 min. Postgres rows persist; can be migrated to a new schema if the rollback was due to a schema bug.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 19: durable audit-postgres sink + persistent buffer + NATS consumer.

CONTEXT
Per investigations 05 (Tier 1 #5-#7), 06 (P0-5), 07 (P1 #9) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/:
- @adjudicate/audit-postgres ships createPostgresSink with monthly partitioning + readAuditWindow
- persistentBufferedSink spills to durable storage on overflow/failure, survives process restart
- NATS audit subject ibatexas.audit.intent.decision.v1 has no consumer today — durability gap
- Runbook 04 requires Postgres audit lag <30s p99 + 14-day retention before flipping financial mutations to enforce

REPO LAYOUT
- packages/llm-provider/src/intent-audit-wiring.ts (current sink stack: multiSink(console, nats))
- packages/domain/prisma/schema.prisma (existing schema)
- packages/domain/src/client.ts (prisma singleton)
- @adjudicate/audit-postgres exports: createPostgresSink, readAuditWindow, partitionMonthOf, recordToRow
- @adjudicate/audit exports: persistentBufferedSink, createInMemorySpillStorage, multiSink, createConsoleSink, createNatsSink
- apps/api/src/subscribers/dedup.ts (isNewEvent)
- apps/api/src/index.ts (subscriber registration)

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/domain/prisma/schema.prisma (MODIFY — add IntentAudit model)
- packages/domain/prisma/migrations/<timestamp>_add_intent_audit/migration.sql (CREATE)
- packages/llm-provider/src/intent-audit-wiring.ts (MODIFY — compose postgresSink + persistentBufferedSink)
- packages/llm-provider/src/redis-spill-storage.ts (CREATE — Redis-backed PersistentSpillStorage)
- packages/llm-provider/package.json (MODIFY — add @adjudicate/audit-postgres dep)
- packages/llm-provider/src/__tests__/intent-audit-wiring-postgres.test.ts (CREATE)
- apps/api/src/subscribers/audit-archiver.ts (CREATE)
- apps/api/src/subscribers/__tests__/audit-archiver.test.ts (CREATE)
- apps/api/src/index.ts (MODIFY — register audit-archiver)
- .env.example (MODIFY — add IBX_AUDIT_POSTGRES_ENABLED)

WHAT TO BUILD

1. Prisma migration (packages/domain/prisma/schema.prisma):
   - Add IntentAudit model (fields per the task file above)
   - Run `pnpm --filter @ibatexas/domain prisma migrate dev --name add_intent_audit` to generate migration SQL
   - For monthly partitioning: append raw SQL in the migration to declare partition function and create initial partition. Use the pattern from @adjudicate/audit-postgres docs (or hand-roll).

2. redis-spill-storage.ts:
   ```ts
   import { PersistentSpillStorage, PersistentBufferedSpillReason } from "@adjudicate/audit";
   export function createRedisSpillStorage(opts: {redis, keyPrefix, ttlSeconds?}): PersistentSpillStorage
   ```
   - put(records[]): Promise<void> — RPUSH to rk(keyPrefix:queue), EXPIRE keyPrefix:queue ttlSeconds
   - async *drain(): AsyncIterable<AuditRecord> — loop LPOP rk(keyPrefix:queue) until empty
   - size(): Promise<number> — LLEN rk(keyPrefix:queue)
   - Default ttlSeconds = 7 * 24 * 3600

3. intent-audit-wiring.ts refactor:
   ```ts
   const postgresEnabled = process.env.IBX_AUDIT_POSTGRES_ENABLED === "true";
   const sinks = [createConsoleSink(...), createNatsSink(...)];
   if (postgresEnabled) sinks.push(createPostgresSink({client: prisma}));
   const inner = multiSink(...sinks);
   const buffered = persistentBufferedSink({
     inner,
     storage: createRedisSpillStorage({redis, keyPrefix: "audit:spill"}),
     capacity: 1000,
     onOverflow: "spill",
     onSpill: (reason, count) => log.warn({reason, count}, "audit-spill"),
   });
   const final = wrapWithRedactor(buffered, redactor); // From Task 18; redactor runs OUTSIDE buffered
   ```
   Important: redactor wraps the buffered sink, NOT inside it — never spill raw PII.

4. audit-archiver.ts subscriber:
   - Subscribe to NATS subject "audit.intent.decision.v1"
   - For each message:
     a) Check isNewEvent(`audit.intent.decision.v1.${record.intentHash}`) from dedup.ts; if not new, skip
     b) Try prisma.intentAudit.create({data: recordToRow(record)})
     c) Catch unique-constraint violation (Postgres P2002 in Prisma) — silently skip
     d) Push to pushToDlq("audit.intent.decision.v1", payload) on any other error

5. Register subscriber in apps/api/src/index.ts: await startAuditArchiver()

6. .env.example: append
   IBX_AUDIT_POSTGRES_ENABLED=false           # flip to true after staging soak

7. Tests:
   audit-archiver.test.ts:
   - "writes new record to Postgres" — emit NATS payload, mock prisma.intentAudit.create, assert called
   - "skips duplicate intentHash via unique constraint" — mock prisma to throw P2002, assert no DLQ push
   - "skips duplicate via isNewEvent" — make isNewEvent return false, assert no prisma call

   intent-audit-wiring-postgres.test.ts:
   - "postgresSink composes when IBX_AUDIT_POSTGRES_ENABLED=true" — mock createPostgresSink, assert it's in the multi-sink
   - "spills to Redis on capacity overflow" — fill buffer past capacity, assert RPUSH called
   - "drains spill on next emit" — pre-populate spill, emit a new record, assert LPOP loop drains
   - "redactor runs before any sink" — emit a record with raw CPF in payload, assert all sinks (console mock, nats mock, postgres mock) received [REDACTED]

CONSTRAINTS
- Read CLAUDE.md rules 7 first
- Use rk() for Redis spill keys (rule #7)
- Redactor (Task 18) MUST run before persistentBufferedSink — wrap the redactor OUTSIDE the buffered sink so spill storage never holds raw PII
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT modify @adjudicate/* source
- DO NOT bypass the redactor (compose order matters)

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] IntentAudit Prisma model + migration
- [ ] createRedisSpillStorage implements PersistentSpillStorage
- [ ] intent-audit-wiring.ts composes redactor → persistentBufferedSink → multiSink(console, nats, postgres)
- [ ] audit-archiver subscriber registered in index.ts
- [ ] IBX_AUDIT_POSTGRES_ENABLED env var documented
- [ ] All 7 tests pass
- [ ] `pnpm --filter @ibatexas/domain prisma generate` runs clean
- [ ] `pnpm --filter @ibatexas/llm-provider typecheck` passes

When complete, return: files created/modified, migration name, sample Postgres row for a set_pix_details audit record (showing [REDACTED] in payload), and whether monthly partitioning is automated via cron or Postgres function.
```
