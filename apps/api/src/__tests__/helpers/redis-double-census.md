# Redis test-double census (R5-S8)

Companion to `redis-testcontainer.ts` (the W4 RULE 3 harness) and to
`packages/tools/src/testing/in-memory-redis.ts` (the canonical in-memory
adapter). This file exists so the owner's testcontainer-vs-alternative
decision has its evidence in one place: **which** doubles emulate Lua,
**which** production script each one emulates, **which** keys and
invariants ride on that emulation, and what the alternatives cost.

Measured on branch `feat/arch-r5-s8-defer-park-census`, tip `cb8f5793`.

---

## How the population was measured

Name-based greps miss doubles (R5-S7's finding: the deps-bag-ready doubles
lived under names the `mockRedis` metric never saw). This census is
**shape-based**: every `.ts` file under a test path is parsed for method
definitions whose name is a Redis command **and** whose body reads or writes
a test-local backing store. Two or more such methods ⟹ a hand-rolled
behavioural double.

Two metrics are therefore reported, because they measure different things:

| Metric | Definition | cb8f5793~1 | cb8f5793 (R5-S7) | this slice |
|---|---|---|---|---|
| `mockRedis` | files in `apps/api/src` matching `mockRedis\s*=` | 27 | 27 | 27 |
| hand-rolled behavioural doubles | the shape sweep above | 23 | 17 | 15 |

The `mockRedis` metric is unchanged and, per R5-S7, **exhausted** — it names
constant-answering `vi.fn()` mocks, not behavioural doubles.

The shape sweep's 17 is broader than the "11" R5-S7's residual named: it also
catches the four consume-script doubles (`cart-routes`,
`checkout-confirmation-store`, `order-cancel-confirm`, `escalation-park-store`)
and the two package-level ones (`journeys`, `audit-sink`). Those are genuinely
in the same class and are classified below. Three further files that the sweep
does **not** flag are included anyway because they are part of the same
defer/park cluster and their status is decision-relevant (they already use real
Redis).

---

## Class (i) — EVAL-BEARING. The double emulates a Lua script. **Owner-gated.**

These are the W4 RULE 3 theater cases: a JS `eval` stub returns a plausible
value for a script whose entire reason for existing is server-side atomicity.
The in-memory adapter deliberately **refuses** these (`LuaAtomicityNotEmulated`),
so none of them can migrate — they need real Redis or a different design.

| # | File | Script emulated (production site) | Script-blind? | Keys | Invariant riding on the emulation |
|---|---|---|---|---|---|
| 1 | `apps/api/src/subscribers/__tests__/defer-resolver.test.ts` | CAD — `lib/defer-resuming-lock.ts:39` `RELEASE_LOCK_SCRIPT`; also `adapters/park-nx.ts:65` `RELEASE_PLACEHOLDER_SCRIPT` | **Yes** — ignores `_script`, releases iff stored value `=== arguments[0]` | `{env}:defer:resuming:{deferResumeHash}`, `{env}:defer:pending:{sessionId}` | Only the lock's owner may release it — the sweeper-vs-resolver double-dispatch window (audit-2026-05-24 E2 / 2026-05-25 I7) |
| 2 | `apps/api/src/jobs/__tests__/defer-timeout-sweeper.test.ts` | CAD — same two scripts | **Yes** — identical shape | as above, plus the `{env}:defer:resuming:fallback:{sessionId}` branch | as above, from the sweeper side |
| 3 | `apps/api/src/escalation/__tests__/escalation-park-store.test.ts` | CONSUME — `escalation/escalation-park-store.ts:164` | **Yes** — unconditional GET+DEL returning the value | `{env}:escalation:park:{token}` | Single-use atomic consume: two racing approvals must not both win. (Second fiction: its `set` returns `undefined`; node-redis returns `"OK"`.) |
| 4 | `apps/api/src/__tests__/checkout-confirmation-store.test.ts` | CONSUME — `routes/checkout-confirmation-store.ts:50` | **Yes**, but its comment's claim ("the only script it runs") is TRUE for this SUT | `{env}:checkout:confirmation:*` | Single-use confirmation receipt |
| 5 | `apps/api/src/__tests__/order-cancel-confirm.test.ts` | CONSUME — `routes/order-cancel-confirmation-store.ts:43` | **Yes** | order-cancel receipt key | Single-use consume. (`withLock` is separately stubbed as a pass-through, so no CAD runs here.) |
| 6 | `apps/api/src/__tests__/cart-routes.test.ts` | CONSUME — `routes/checkout-confirmation-store.ts:50` | **Yes** | cart-owner claim + checkout receipt keys | Idempotency gate, cart-owner claim, single-use receipt |
| 7 | `packages/journeys/src/runner/__tests__/journey-lock.test.ts` | CAD (`journey-lock.ts:58`) **and** CAE (`:67`, PEXPIRE) | **No — the only script-DISPATCHING double in the repo** (`script.includes("DEL")` / `("PEXPIRE")`, throws on an unknown script) | `{env}:journey:lock:{journeyId}` | Same-journey serialization + heartbeat extension by the owner only |

### The script-blindness hazard

Six of the seven ignore the script argument. That is safe only while a SUT
reaches exactly one script *family*. The two families have **opposite**
contracts:

- **CAD** (`GET == ARGV[1] then DEL`) returns `1`/`0` and deletes **only on an
  ownership match**.
- **CONSUME** (`GET; if value then DEL`) returns **the value** and deletes
  **unconditionally**.

So a script-blind CONSUME double, if a SUT ever routes a CAD script through it,
answers "released, here's the value" for a lock the caller does **not** own —
the exact inverse of CLAUDE.md rule #10, asserted green. Nothing in the test
files prevents this; it is held off only by which code paths each SUT happens to
reach today. Item 6 (`cart-routes`) is the closest to the edge, since the cart
route family is the one that grows new lock-bearing paths.

---

## Class (i-b) — SUT reaches a Lua site; the double **omits** `eval`

Not theater — a hole. The release throws (`redis.eval is not a function`), the
production code swallows it (`releaseDeferResumingLock` catches by design, "TTL
is the source-of-truth deadline"), and the marker is simply never cleared. Green
tests, uncovered invariant.

This is not inference. `defer-resolver.test.ts:106-110` records the mechanism
from the other side: *"Pre-WS5 this stub lacked `eval`, so the Lua release threw
(swallowed) and the `defer:resuming:*` marker was never cleared."* The files
below are that pre-WS5 state, still.

| # | File | Reaches |
|---|---|---|
| 8 | `apps/api/src/__tests__/defer-roundtrip.test.ts` | `defer-resolver.js` → `releaseDeferResumingLock` |
| 9 | `apps/api/src/__tests__/defer-roundtrip-extensions.test.ts` | same |
| 10 | `apps/api/src/__tests__/defer-resolver-resumedkey-redis-error.test.ts` | same |
| 11 | `apps/api/src/__tests__/audit-2026-05-24/defer-resume-integrity.test.ts` | same |
| 12 | `apps/api/src/__tests__/boot-window-race.test.ts` | same |
| 13 | `apps/api/src/adapters/__tests__/park-deferred-intent-nx-hoist.unit.test.ts` | `park-nx.ts` → `releaseNxPlaceholder` |

Swapping the in-memory adapter into these files is **behaviour-preserving but
pointless**: the adapter's `eval` throws too (deliberately, naming W4 RULE 3),
the same catch swallows it, and the same invariant stays uncovered. They are
listed as owner-gated for that reason, not because the swap is unsafe.

Item 13 is worse than the others: `releaseNxPlaceholder` *feature-detects*
`typeof r.eval === "function"`. With no `eval` on the double the detection fails
and the code takes its **plain-`del`** branch — so that file exercises only the
unsafe path, and the CAD it is nominally about never runs. See the defect below.

---

## Class (ii) — MIGRATABLE. Migrated in this slice.

| # | File | Commands | Fictions killed |
|---|---|---|---|
| 14 | `apps/api/src/subscribers/__tests__/audit-consumer.test.ts` | get/set/lPush/expire | `lPush` appended to a newline-joined **string** under a key production writes as a **list** (`subscribers/dlq.ts:29` LPUSH) — the DLQ assertions were satisfied by a string the stub invented, and a WRONGTYPE could never surface. `rk` de-faked (it agreed with the real one here — the suite stubs `APP_ENV=test` — so this was a coincidence made into a fact, not a wrong-prefix fiction). |
| 15 | `packages/cli/src/commands/__tests__/dlq.test.ts` | scanIterator/lLen | `scanIterator` reduced the glob to `startsWith` after stripping one trailing `*` — MATCH was pattern-matching in name only. `lLen` measured a JS array the **test** planted; seeding now goes through `lPush`, the way `pushToDlq` writes. `rk` was a genuine wrong-prefix fiction here — measured: the fake wrote `test:dlq:x` while the real `rk` under this package's test env returns `development:dlq:x` (no `APP_ENV` is pinned for `packages/cli`). |

Both kept their test counts identical (7 → 7, 3 → 3). No adapter command was
added: every command these two need was already consumer-backed from R5-S6/S7.

---

## Class (iii) — Everything else, with the reason

| File | Status |
|---|---|
| `packages/audit-sink/src/__tests__/redis-spill-storage.test.ts` | **Refused.** The double is honest — a real FIFO list, real TTL recording, and the **real** inlined `rk` (the `test:` prefix comes from `APP_ENV=test` pinned in `packages/audit-sink/vitest.config.ts`, not from a fake). There is no fiction to kill, and migrating would add `@ibatexas/tools` to `packages/audit-sink`'s dependency graph — the edge `redis-spill-storage.ts` deliberately avoids, stated as a leaf-purity invariant in the module and in the test header. Cost exceeds benefit. |
| `apps/api/src/__tests__/integration/audit-sink-fail-resilience.test.ts` | **Deferred, not refused.** Same honest FIFO double, deps-bag injected, and `apps/api` can already reach the adapter. Needs two consumer-backed adapter commands — `rPush` and `lPop`, consumer `packages/audit-sink/src/redis-spill-storage.ts`. Its only fiction is a constant-`1` `expire` with no TTL model. Legitimate next-slice work. |
| `apps/api/src/__tests__/chat-integration.test.ts` | **Not a hand-rolled double.** Constant-answering `vi.fn()` stub (the `mockRedis` class under another name). Its constants are load-bearing *by design* and documented: `get` returns `null` so the SSE GET-not-found case falls through the ownership/secret checks to the empty-replay path. Migrating would change behaviour, not remove a fiction. |
| `apps/api/src/__tests__/audit-2026-05-24/sweeper-resolver-race.test.ts` | **Already real Redis** (`setupRedisTestContainer`). |
| `apps/api/src/adapters/__tests__/park-deferred-intent-nx-hash.test.ts` | **Already real Redis** (`setupRedisTestContainer`). |
| `apps/api/src/__tests__/park-deferred-intent-nx.test.ts` | **Already real Redis**, but gated on its **own** `REDIS_URL` check rather than the shared harness — so it skips wherever `REDIS_URL` is unset, which includes CI. |

---

## Evidence for the owner's decision

### The testcontainer route already works here — for this exact cluster

`park-deferred-intent-nx-hash.test.ts` and `sweeper-resolver-race.test.ts` drive
the **defer/park** code under a real Redis 7 container today. Verified on this
branch: with `IBX_SKIP_REAL_REDIS` unset (the CI default) the suite runs and
passes, with `testcontainers`' ryuk reaper active; with `IBX_SKIP_REAL_REDIS=1`
it reports `1 skipped (1) / 3 skipped (3)`. Container lifecycle for a 3-test file
was ~1.2 s wall with the `redis:7-alpine` image warm.

So "adopt testcontainers for the class-(i) files" is not a greenfield build. It
is extending a harness that is already in-tree, already wired to these modules,
and already green.

### Two gaps to price in before choosing it

1. **`sweeper-resolver-race.test.ts` runs 100 iterations of a race.** Multiplying
   that shape across seven more files is the real cost question, not the harness.
2. **CI has no Redis service and sets no `REDIS_URL`.** `ci.yml` runs
   `pnpm exec turbo test` with neither. Files using the shared harness default to
   running (the flag is unset, so `RUN_REAL_REDIS` is `true`) and depend on the
   runner's Docker; files using their own `REDIS_URL` gate — item 21 above —
   **skip silently and report green**. Any decision that routes coverage through
   real Redis should also make the skip loud, or the gate will report success on
   an empty run.

### The full production Lua inventory (20 sites, 8 script shapes)

Any option chosen has to cover these, not just the defer/park ones:

- **CAD** (`GET == ARGV[1] then DEL`) — 10 sites: `streaming/execution-queue.ts:23`,
  `adapters/park-nx.ts:66`, `lib/defer-resuming-lock.ts:40`,
  `jobs/anonymize-medusa-retry.ts:228`, `jobs/outbox-retry.ts:134`,
  `whatsapp/session.ts:251`, `routes/me/anonymize-active-lock.ts:93`,
  `packages/tools/src/redis/distributed-lock.ts:11`, `packages/cli/src/lib/lock.ts:31`,
  `packages/journeys/src/runner/journey-lock.ts:58`
- **CAE** (`GET == ARGV[1] then EXPIRE/PEXPIRE`) — 3 sites:
  `streaming/execution-queue.ts:35`, `whatsapp/session.ts:263`,
  `packages/journeys/src/runner/journey-lock.ts:67`
- **CONSUME** (`GET; if value then DEL`) — 4 sites:
  `escalation/escalation-park-store.ts:164`,
  `routes/order-cancel-confirmation-store.ts:43`,
  `routes/admin/admin-confirmation-store.ts:63`,
  `routes/checkout-confirmation-store.ts:50`
- **Rate limit** (`INCR` + `PEXPIRE`/`PTTL`) — `plugins/rate-limit.ts:18`,
  `packages/tools/src/redis/atomic-rate-limit.ts:10`
- **OTP lockout** (`EXISTS` + `INCR` + `EXPIRE` + `SET` lockout) — `routes/me/anonymize-otp-gate.ts:404`
- **Refund cap** (`GET` + cap check + `INCRBY` + `EXPIRE`) — `routes/admin/payments.ts:182`
- **WhatsApp session rollover** (`HGET`/`HSET`) — `whatsapp/session.ts:76`
- **Token bucket** (`HMGET`/`HSET`/`PEXPIRE`) — `whatsapp/client.ts:291`

---

## Filed, not fixed

### F-21 class — `releaseNxPlaceholder` degrades to a plain `del`

`apps/api/src/adapters/park-nx.ts:78-103`. The function exists to release the NX
placeholder via Lua compare-and-delete, "so we never accidentally erase a real
envelope that another caller parked between our SETNX and this path". It has two
branches that defeat that:

```ts
if (typeof r.eval === "function") {
  try { await r.eval(RELEASE_PLACEHOLDER_SCRIPT, {...}); return }
  catch { /* Fall through to plain del — TTL is the ultimate safety net. */ }
}
await r.del?.(parkKey)?.catch(() => {})
```

1. **Feature-detect miss** → unconditional `del`. Documented as "legacy behavior".
2. **`eval` throws** → unconditional `del`.

Branch 2 is the reachable one, and it inverts the mitigation exactly where it
matters: both call sites are error paths (quota-exceeded, and `catch (err)` after
a mid-flight park failure), and the most likely cause of a mid-flight park failure
— a Redis blip — is also the most likely cause of the `EVAL` throwing. So in the
failure mode the CAD was written for, the CAD is skipped and an unconditional DEL
runs against a key another caller may by then own. CLAUDE.md rule #10.

No test covers the CAD branch: item 13's double has no `eval`, so the
feature-detect fails and only branch 1 is exercised.

### `ibx dlq list` cannot observe SCAN scoping

In `packages/cli/src/commands/dlq.ts`, discovered events are filtered by
`if (len > 0)` before printing. A key outside the `rk("dlq:")` prefix that leaked
through a broken `MATCH` would resolve to length 0 and be dropped — so no
assertion on this command's **output** can make MATCH load-bearing, and
`discoverDlqEvents` is not exported for direct assertion. The migration in item 15
therefore made `lLen` and `rk` real but left MATCH scoping unobservable; recorded
rather than papered over with an assertion that would pass either way.

Relatedly, that file's first case ("discovers new event subjects via SCAN, **not**
the hardcoded hint list") cannot distinguish the two: all three subjects it
asserts are themselves in `KNOWN_DLQ_EVENT_HINTS`, and both routes need the same
seeded lists. Revert-to-red confirms it is load-bearing on the injected keyspace,
but the third case is the only one that isolates SCAN discovery.
