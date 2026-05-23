# Task 03 — Wire DEFER Resolver Subscriber

**Milestone:** M0 (Plumbing flip)
**Estimated effort:** S — 1 dev-day
**Blocks:** 20 (DEFER round-trip test depends on this)
**Blocked by:** 01 (kernel bootstrap), 02 (the resume path needs a real intent dispatcher to re-execute)
**Owner:** unassigned

## Objective

Three coupled fixes that make DEFER work end-to-end:
1. Call `startDeferResolverSubscriber` from `apps/api/src/index.ts` (one-line fix — the subscriber is defined but never invoked).
2. Fix `resumeDeferredIntent` semantics in the subscriber to actually re-execute the parked envelope through `adjudicate()` (currently it only flips the dedup ledger and deletes the parked key).
3. Add a timeout sweeper that publishes `intent.defer.timeout` for expired `defer:pending:*` keys so customers stuck waiting for a PIX confirmation get a follow-up.

After this lands, the documented DEFER park/resume flow (the lighthouse Pack pattern in PIX charge lifecycle) actually runs in production.

## Architecture context

Cite: investigation 04 §"Deferred intent system" + §"NATS subscribers inventory" + investigation 02 P0 #2.
> "`startDeferResolverSubscriber` is exported but never imported or called. `apps/api/src/index.ts` lines 6–10 register four subscribers ... defer-resolver is absent. ... Even if it were wired, `resumeDeferredIntent` only ... does not actually execute the parked intent. Nothing in the codebase consumes the `parked.envelope` returned by the function — the caller (`defer-resolver.ts`) only logs success."

The PIX-pending DEFER guard (`createPixPendingDeferGuard` from `@adjudicate/pack-payments-pix`, composed in `order-policy-bundle.ts:183`) is the only intent class that currently defers. The resume signal is `payment.confirmed` (matching NATS subject `payment.status_changed` filtered to `paid|captured|confirmed`).

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/subscribers/defer-resolver.ts` (current dead-code resolver)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/index.ts:6-10` (subscriber registration block)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/llm-responder.ts:384-424` (park-side: where envelopes are written to `defer:pending:*`)
- `/Users/thaisrodolpho/projects/adjudicate/packages/runtime/src/defer-resume.ts` (resumeDeferredIntent semantics)
- `/Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/types.ts:115` (PIX_CONFIRMATION_SIGNAL)

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/index.ts` — add `startDeferResolverSubscriber()` call in the subscriber-registration block
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/subscribers/defer-resolver.ts` — fix resume to re-execute the envelope via `adjudicate()` and the intent dispatcher from Task 02
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/llm-responder.ts` — if needed, factor out an `executeAdjudicatedIntent(envelope, ctx)` helper so the subscriber can reuse it

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/jobs/defer-timeout-sweeper.ts` (BullMQ worker scanning expired `defer:pending:*` keys every 60s)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/subscribers/__tests__/defer-resolver.test.ts`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/jobs/__tests__/defer-timeout-sweeper.test.ts`

## Constraints

- Must use `verifyParkedEnvelopeHash` from `@adjudicate/runtime` before re-executing (T-005 invariant: re-derive intentHash and check byte-equality — if the parked envelope was tampered with, refuse).
- Must respect `DEFAULT_MAX_RESUME_CYCLES = 3` from `@adjudicate/runtime` to bound DEFER → resume → re-DEFER oscillation.
- Must use `rk()` from `@ibatexas/tools` for any new Redis keys (CLAUDE.md rule #7).
- Must NOT double-execute: `resumeDeferredIntent` already writes a `defer:resumed:*` dedup key via SET NX — honour the returned `resumed: false, reason: "duplicate_resume_suppressed"` path.
- pt-BR for any user-facing messaging on timeout (the timeout publishes a NATS event; downstream subscriber handles the WhatsApp message).
- Follow CLAUDE.md rule #10 if any Redis lock is needed (use `withLock` with UUID + Lua release).

## Implementation requirements

1. **Wire `startDeferResolverSubscriber`** in `apps/api/src/index.ts` alongside the existing four subscribers. Order: after `startPaymentLifecycleSubscriber` so the lifecycle has already settled the payment status when defer-resolver runs.

2. **Refactor `defer-resolver.ts`** to actually re-execute on resume:
   - Subscribe to `payment.status_changed` events.
   - For each event with `newStatus ∈ SETTLED_WIRE_STATUSES`, SCAN `defer:pending:*` for matching parked envelopes.
   - For each parked envelope: call `verifyParkedEnvelopeHash(parked)` first. On verification failure, log + push to DLQ + skip.
   - Call `resumeDeferredIntent(...)` to get `{resumed: boolean, intentHash, parked}`. If `resumed: false`, log the reason and skip.
   - If `resumed: true`, re-build the runtime context (sessionId from the parked envelope, customerId looked up from the order), then run `adjudicate(envelope, freshState, orderPolicyBundle)` to get the new decision.
   - If decision is `EXECUTE`, dispatch via the intent-dispatcher (the same one from Task 02). Emit an audit record with `supersedes: [parked.intentHash]` and `kind: "EXECUTE"`.
   - If decision is `REFUSE`/`DEFER`/`REWRITE` etc., follow the normal responder branching but without an LLM in the loop — log the supersession.

3. **Factor `executeAdjudicatedIntent(envelope, ctx)`** in `llm-responder.ts` if needed so both the responder hot path and the subscriber resume path share the same adjudicate-then-dispatch logic. This avoids drift between the two call sites.

4. **Create the timeout sweeper** `apps/api/src/jobs/defer-timeout-sweeper.ts`:
   - BullMQ repeatable job, every 60s.
   - Use Redis SCAN (NOT KEYS) over `defer:pending:*` namespace via `rk()`.
   - For each key whose TTL has elapsed past a grace period (e.g. TTL <= 60s remaining), publish `intent.defer.timeout` NATS event with `{sessionId, intentHash, signal, parkedAt}` payload.
   - Delete the parked key after publish (idempotent: subsequent runs see no key).
   - Add the new event to `OUTBOX_EVENTS` in `packages/nats-client/src/index.ts:77-85` for durability (optional, justify if you omit).

5. **Register the worker** in `apps/api/src/jobs/register-workers.ts`.

6. **Add `intent.defer.timeout` consumer** — minimal: log + publish `notification.send` so the customer gets a "Não recebemos confirmação do pagamento PIX. Deseja gerar um novo QR code?" message in pt-BR. Use the existing notification fan-out path in `cart-intelligence.ts`. (Or defer this to a follow-up; document the choice.)

7. **Tests** (subscriber + sweeper):
   - **defer-resolver.test.ts:**
     - Park a fake envelope at `defer:pending:test-session`; publish a `payment.status_changed { newStatus: "paid" }`; assert the parked key is deleted, the resume-dedup key is SET NX, and the intent-dispatcher mock is called with the same envelope.
     - Duplicate-delivery: deliver the same event twice; assert dispatcher called once.
     - Tampered-envelope: mutate the parked payload between park and resume; assert `verifyParkedEnvelopeHash` rejects and the dispatcher is NOT called.
     - Resume cycles: simulate DEFER → resume → re-DEFER 4 times; assert the 4th hits the cycle cap and refuses.
   - **defer-timeout-sweeper.test.ts:**
     - Park an envelope with TTL=1s; advance fake time; run sweeper; assert `intent.defer.timeout` published and key deleted.
     - No expired keys: sweeper publishes nothing.

## Acceptance criteria

- [ ] `startDeferResolverSubscriber` is called exactly once at boot.
- [ ] On `payment.status_changed { newStatus: "paid" }`, the subscriber re-executes the parked envelope through `adjudicate()` and dispatches if EXECUTE.
- [ ] `verifyParkedEnvelopeHash` is called before re-execution.
- [ ] Duplicate `payment.status_changed` delivery does not re-execute (dedup honoured).
- [ ] BullMQ `defer-timeout-sweeper` worker runs every 60s and publishes `intent.defer.timeout` for expired parks.
- [ ] All four subscriber tests + two sweeper tests pass.
- [ ] `pnpm --filter @ibatexas/api typecheck` passes.

## Testing requirements

- **Unit:** subscriber + sweeper test files above.
- **Integration:** an end-to-end test in `apps/api/src/__tests__/defer-roundtrip.test.ts` that uses ioredis-mock + a NATS test stub: park an envelope via the responder, publish the wire event, assert the dispatcher fires with the original envelope's `intentHash`.
- **Bypass-detection:** assert that a parked envelope with a mutated payload (re-signing the SET payload after park) does NOT re-execute. This catches tamper-at-rest.

## Rollout notes

This task lands plumbing for the PIX-pending DEFER path that has been silently dropping intents. The blast radius is zero today because no env vars enforce the PIX DEFER guard (per investigation 06 — `IBX_KERNEL_ENFORCE` is empty). Direct merge. The behavioural change kicks in only when the PIX DEFER guard is later turned on via Task 15's enforce-flip runbook.

## Rollback notes

Revert the PR. Removes the subscriber wire and the sweeper. The DEFER subscriber returns to dead-code state. No data loss — the parked-envelope Redis keys carry their own TTLs (signal timeout + 60s grace) and will be cleaned by Redis. Customers who were waiting for a PIX confirmation in a window between the resolver going live and rollback may see a duplicate "PIX confirmado" downstream message — acceptable, mitigated by the resume-dedup ledger. Rollback ETA: <5 min.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 03: wire defer-resolver subscriber + fix resume + add timeout sweeper.

CONTEXT
Per investigation 04 in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/04-background-jobs-nats.md (§"Deferred intent system"):
- apps/api/src/subscribers/defer-resolver.ts is never wired (startDeferResolverSubscriber never called)
- Even if wired, resumeDeferredIntent only flips a dedup ledger; it does NOT re-execute the parked envelope
- There is no timeout sweeper for expired defer:pending:* keys

Your job is to make DEFER work end-to-end: wire the subscriber, fix resume to re-execute, add a sweeper.

REPO LAYOUT
- apps/api/src/index.ts (lines 6-10 register subscribers; defer-resolver is missing)
- apps/api/src/subscribers/defer-resolver.ts (current dead resolver)
- apps/api/src/jobs/register-workers.ts (BullMQ worker registration)
- packages/llm-provider/src/llm-responder.ts (park-side at lines 384-424)
- @adjudicate/runtime exports: verifyParkedEnvelopeHash, resumeDeferredIntent, DEFAULT_MAX_RESUME_CYCLES, deferParkKey, deferCounterKey
- @adjudicate/pack-payments-pix: PIX_CONFIRMATION_SIGNAL = "payment.confirmed"

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- apps/api/src/index.ts (MODIFY — add startDeferResolverSubscriber call)
- apps/api/src/subscribers/defer-resolver.ts (REWRITE the resume logic to actually re-execute)
- apps/api/src/jobs/defer-timeout-sweeper.ts (CREATE)
- apps/api/src/jobs/register-workers.ts (MODIFY — register sweeper)
- apps/api/src/subscribers/__tests__/defer-resolver.test.ts (CREATE)
- apps/api/src/jobs/__tests__/defer-timeout-sweeper.test.ts (CREATE)
- packages/llm-provider/src/llm-responder.ts (OPTIONAL — extract executeAdjudicatedIntent helper if needed; do not change other behaviour)
- apps/api/src/__tests__/defer-roundtrip.test.ts (CREATE — end-to-end smoke)

WHAT TO BUILD

1. Wire subscriber in apps/api/src/index.ts: add `await startDeferResolverSubscriber()` after startPaymentLifecycleSubscriber. Pattern matches existing four calls.

2. Refactor defer-resolver.ts:
   - On payment.status_changed event with newStatus in {paid, captured, confirmed}:
     a) Use Redis SCAN over `rk('defer:pending:*')` to find all parked envelopes.
     b) For each: load parked JSON, call verifyParkedEnvelopeHash(parked); on mismatch, log + DLQ via pushToDlq from subscribers/dlq.ts + skip.
     c) Call resumeDeferredIntent({redis, intentHash, signal, sessionId, ...}) — already imported from @adjudicate/runtime. If returns {resumed: false}, log reason + skip.
     d) If resumed: true, build a runtime ctx (sessionId from parked, customerId looked up from order or stored in parked envelope's actor.sessionId), then call adjudicate(envelope, freshState, orderPolicyBundle).
     e) If decision.kind === "EXECUTE": dispatch via the intent-dispatcher (Task 02) — import createIntentDispatcher or use a wrapper. Emit audit record with supersedes: [parked.intentHash].
     f) Otherwise: emit audit record reflecting the new decision (REFUSE/DEFER/REWRITE) with supersedes link.
   - Honour DEFAULT_MAX_RESUME_CYCLES from @adjudicate/runtime — resumeDeferredIntent will report cycle exhaustion.

3. defer-timeout-sweeper.ts:
   - BullMQ repeatable job, name "defer-timeout-sweeper", repeat every 60s with jitter.
   - Body: SCAN rk('defer:pending:*'), for each key check TTL via redis.ttl; if TTL <= 60s (i.e. effectively expired or imminent), publish NATS event "intent.defer.timeout" with payload {sessionId, intentHash, signal, parkedAt}, then DEL the key.
   - Use safeRedis("critical", ...) from @ibatexas/tools and rk() for keys.
   - Optional minimal consumer: extend cart-intelligence.ts (or a new subscriber) to publish notification.send with pt-BR body "Não recebemos confirmação do pagamento PIX. Posso gerar um novo QR code para você?" on intent.defer.timeout. If you defer this, document a follow-up task ID.

4. register-workers.ts: register the sweeper worker similar to existing patterns (pix-expiry-checker is a good template — 5min cadence).

5. Tests:
   a) defer-resolver.test.ts:
      - "resumes parked envelope and dispatches" — park fake envelope, publish event, assert dispatcher called with envelope
      - "skips on duplicate webhook delivery" — deliver event twice, dispatcher called once
      - "refuses tampered envelope" — mutate parked JSON, assert verifyParkedEnvelopeHash rejects + dispatcher NOT called
      - "honours resume cycle cap" — simulate 4 cycles of DEFER→resume→re-DEFER; 4th rejected
   b) defer-timeout-sweeper.test.ts:
      - "publishes timeout and deletes key" — park with TTL 1s, advance time, run sweeper, assert NATS publish + key DEL
      - "no-op when no expired keys" — empty Redis, run sweeper, assert no NATS publish
   c) defer-roundtrip.test.ts:
      - end-to-end: park via responder → publish payment.confirmed → assert dispatcher receives same intentHash

CONSTRAINTS
- Use rk() from @ibatexas/tools for all Redis keys (CLAUDE.md rule #7)
- Use withLock + Lua release if any lock is needed (CLAUDE.md rule #10)
- pt-BR for any new user-facing strings (CLAUDE.md rule #4)
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT modify packages/llm-provider/src/order-policy-bundle.ts (Task 08 owns that migration)
- DO NOT modify @adjudicate/* source (sibling repo)

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] startDeferResolverSubscriber is called from index.ts
- [ ] defer-resolver.ts calls adjudicate() then the intent dispatcher on resume
- [ ] verifyParkedEnvelopeHash is called before re-execution
- [ ] resume-dedup is honoured (no double-execute on duplicate webhook)
- [ ] defer-timeout-sweeper job is registered and runs every 60s
- [ ] All 4 defer-resolver tests + 2 sweeper tests + 1 roundtrip test pass
- [ ] `pnpm --filter @ibatexas/api typecheck` passes
- [ ] No new exports from @ibatexas/llm-provider unless documented (executeAdjudicatedIntent if extracted)

When complete, return: files created/modified, test output, and whether the timeout-consumer was implemented inline or deferred.
```
