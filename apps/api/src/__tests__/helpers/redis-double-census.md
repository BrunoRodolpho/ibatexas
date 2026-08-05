# Redis test-double census (R5-S8, extended R5-S9)

Companion to `redis-testcontainer.ts` (the W4 RULE 3 harness) and to
`packages/tools/src/testing/in-memory-redis.ts` (the canonical in-memory
adapter). This file exists so the owner's testcontainer-vs-alternative
decision has its evidence in one place: **which** doubles emulate Lua,
**which** production script each one emulates, **which** keys and
invariants ride on that emulation, and what the alternatives cost.

Measured on branch `feat/arch-r5-s8-defer-park-census`, tip `cb8f5793`.
Extended on branch `feat/arch-r5-s9-spill-migration`, tip `1ce0df35` — R5-S9
executed this census' one remaining ACTIONABLE item and re-closed the map.
It also records a **population correction** the R5-S8 sweep missed; see
"Population correction (R5-S9)" below before quoting any total from this file.

---

## How the population was measured

Name-based greps miss doubles (R5-S7's finding: the deps-bag-ready doubles
lived under names the `mockRedis` metric never saw). This census is
**shape-based**: every `.ts` file under a test path is parsed for method
definitions whose name is a Redis command **and** whose body reads or writes
a test-local backing store. Two or more such methods ⟹ a hand-rolled
behavioural double.

Two metrics are therefore reported, because they measure different things:

| Metric | Definition | cb8f5793~1 | cb8f5793 (R5-S7) | R5-S8 | R5-S9 |
|---|---|---|---|---|---|
| `mockRedis` | files in `apps/api/src` matching `mockRedis\s*=` | 27 | 27 | 27 | 27 |
| hand-rolled behavioural doubles | the enumeration below | 23 | 17 | 15 | 14 |

The `mockRedis` metric is unchanged and, per R5-S7, **exhausted** — it names
constant-answering `vi.fn()` mocks, not behavioural doubles. R5-S9 re-measured
it (27) and confirmed the file it migrated was never in that population, so the
metric is untouched for the third slice running.

The behavioural-double row counts **the rows enumerated in this file** — 7 in
class (i), 6 in class (i-b), 3 migrated in class (ii), 1 refused in class (iii)
= 17, less the 3 migrated = 14. It is NOT a re-run of the sweep: R5-S9 tried to
re-derive the population from the stated method and got a different, larger
answer. That gap is recorded below rather than folded into this row.

The shape sweep's 17 is broader than the "11" R5-S7's residual named: it also
catches the four consume-script doubles (`cart-routes`,
`checkout-confirmation-store`, `order-cancel-confirm`, `escalation-park-store`)
and the two package-level ones (`journeys`, `audit-sink`). Those are genuinely
in the same class and are classified below. Three further files that the sweep
does **not** flag are included anyway because they are part of the same
defer/park cluster and their status is decision-relevant (they already use real
Redis).

---

## Class (i) — EVAL-BEARING. The double emulates a Lua script. **RETIRED by M2.**

> **STATUS: all 7 retired (M2).** No file in this table emulates a Lua script
> any more. The table below is kept as the record of what each one WAS and what
> now holds its invariant — see "M2 — the class (i) retirement" further down for
> the per-file dispositions, the revert-to-red measurements, and the
> script-blindness finding. Six went to unit observation
> (`helpers/lua-call-observer.ts`); item 7 went to real Redis.

These were the W4 RULE 3 theater cases: a JS `eval` stub returned a plausible
value for a script whose entire reason for existing is server-side atomicity.
The in-memory adapter deliberately **refuses** these (`LuaAtomicityNotEmulated`),
so none of them could migrate to it — they needed real Redis or a different
design. M2 gave six of them the different design and the seventh real Redis.

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

> **CLOSED STRUCTURALLY by M2**, and the population was LARGER than this section
> says — see "M2 — the class (i) retirement" below. Four production modules run
> two or more distinct scripts through one client, one of them three.

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
| 11 | `apps/api/src/__tests__/audit-2026-05-24/defer-resume-integrity.test.ts` | same — **RESOLVED in Phase 5**: on the shared testcontainer harness; the release EVAL is real and the marker IS cleared (asserted) |
| 12 | `apps/api/src/__tests__/boot-window-race.test.ts` | same |
| 13 | `apps/api/src/adapters/__tests__/park-deferred-intent-nx-hoist.unit.test.ts` | `park-nx.ts` → `releaseNxPlaceholder` — **RESOLVED in Phase 5**: the SUT no longer reaches a Lua site from this file at all (see below) |

Swapping the in-memory adapter into these files is **behaviour-preserving but
pointless**: the adapter's `eval` throws too (deliberately, naming W4 RULE 3),
the same catch swallows it, and the same invariant stays uncovered. They are
listed as owner-gated for that reason, not because the swap is unsafe.

Item 13 is worse than the others: `releaseNxPlaceholder` *feature-detects*
`typeof r.eval === "function"`. With no `eval` on the double the detection fails
and the code takes its **plain-`del`** branch — so that file exercises only the
unsafe path, and the CAD it is nominally about never runs. See the defect below.

> **RESOLVED in Phase 5 for items 11 and 13, by different routes** — which is
> the point: "reaches a Lua site with a double that omits `eval`" has two exits,
> and only one of them is a container.
>
> **Item 11 migrated** onto `setupRedisTestContainer` (enrolled in the M0 roll
> call, 3 cases). It parks through `createParkRedisCapabilities()`, so the
> framework's ATOMIC quota branch runs, and the resolver's
> `defer:resuming:*` release is a real Lua compare-and-delete. The class-(i-b)
> hole R5-S12 measured — a fully GREEN resume that never clears the marker — is
> now an assertion in that file rather than a finding in this one.
>
> **Item 13 did not need a container: the property it tests never reaches
> Redis.** `hoistAndValidateVerificationFields` runs to completion before the
> wrapper's first command, so its coverage is Redis-independent. It stays a unit
> file, but its double is now a `ParkRedisCapabilities`-typed **tripwire** whose
> every member (including the two Lua ones) rejects with a sentinel. Nothing is
> emulated, and the SUT no longer reaches `parkDeferredIntent` — so the file's
> membership in this class lapses rather than being repaired.

---

## Class (ii) — MIGRATABLE. Migrated.

| # | File | Slice | Commands | Fictions killed |
|---|---|---|---|---|
| 14 | `apps/api/src/subscribers/__tests__/audit-consumer.test.ts` | R5-S8 | get/set/lPush/expire | `lPush` appended to a newline-joined **string** under a key production writes as a **list** (`subscribers/dlq.ts:29` LPUSH) — the DLQ assertions were satisfied by a string the stub invented, and a WRONGTYPE could never surface. `rk` de-faked (it agreed with the real one here — the suite stubs `APP_ENV=test` — so this was a coincidence made into a fact, not a wrong-prefix fiction). |
| 15 | `packages/cli/src/commands/__tests__/dlq.test.ts` | R5-S8 | scanIterator/lLen | `scanIterator` reduced the glob to `startsWith` after stripping one trailing `*` — MATCH was pattern-matching in name only. `lLen` measured a JS array the **test** planted; seeding now goes through `lPush`, the way `pushToDlq` writes. `rk` was a genuine wrong-prefix fiction here — measured: the fake wrote `test:dlq:x` while the real `rk` under this package's test env returns `development:dlq:x` (no `APP_ENV` is pinned for `packages/cli`). |
| 16 | `apps/api/src/__tests__/integration/audit-sink-fail-resilience.test.ts` | R5-S9 | rPush/lPop/lLen/expire | The constant-`1` `expire`. The double answered a truthy `1` and recorded nothing, so `redis-spill-storage.ts`'s documented 7-day backlog window (`DEFAULT_TTL_SECONDS = 604_800`, "enough for any plausible inner-sink outage") was asserted into a void — nothing in this file, or anywhere, could tell a 7-day EXPIRE from a 7-second one. The adapter models TTL on an injected clock, so the file now pins it exactly (`ttlMs === 604_800_000` against a frozen clock). Two further strengthenings that were not fictions but were unobservable: the spill list is now asserted to be the **only** key the sink wrote, and the record is read back with **LPOP** — the same command, off the same end, the storage's own `readAll()` drain uses — rather than by indexing the double's backing array. `rk` was NOT faked here and is unchanged; see F-23 below for the correction to the comment that explains it. |

Items 14 and 15 kept their test counts identical (7 → 7, 3 → 3) and needed no
new adapter command. Item 16 also kept its count (4 → 4) but did need two:
`rPush` and `lPop`, added in R5-S9 with `packages/audit-sink/src/redis-spill-
storage.ts` as the backing consumer (RPUSH on append, LPOP-until-null on drain).

Note what item 16 does **not** cover, since the honest bound matters more than
the migration: only ONE record ever reaches the spill in this file, so nothing
in it distinguishes FIFO from LIFO. Aliasing `rPush` onto `lPush` in the adapter
leaves all four cases green. The ordering guarantee is pinned in the adapter's
own suite instead (`packages/tools/src/catalog/__tests__/delivery-cache-seam.test.ts`,
three cases go red under that aliasing) — which is where a shared double's
semantics belong, but it means this file rides on that suite for the property
its SUT documents most loudly.

---

## Class (iii) — Everything else, with the reason

| File | Status |
|---|---|
| `packages/audit-sink/src/__tests__/redis-spill-storage.test.ts` | **Refused.** The double is honest — a real FIFO list, real TTL recording, and the **real** inlined `rk` (the `test:` prefix comes from `APP_ENV=test` pinned in `packages/audit-sink/vitest.config.ts`, not from a fake). There is no fiction to kill, and migrating would add `@ibatexas/tools` to `packages/audit-sink`'s dependency graph — the edge `redis-spill-storage.ts` deliberately avoids, stated as a leaf-purity invariant in the module and in the test header. Cost exceeds benefit. |
| `apps/api/src/__tests__/integration/audit-sink-fail-resilience.test.ts` | ~~Deferred, not refused.~~ **MIGRATED in R5-S9** — moved to class (ii), item 16. The two commands it was waiting on (`rPush`, `lPop`) were added in the same slice. |
| `apps/api/src/__tests__/chat-integration.test.ts` | **Not a hand-rolled double.** Constant-answering `vi.fn()` stub (the `mockRedis` class under another name). Its constants are load-bearing *by design* and documented: `get` returns `null` so the SSE GET-not-found case falls through the ownership/secret checks to the empty-replay path. Migrating would change behaviour, not remove a fiction. |
| `apps/api/src/__tests__/audit-2026-05-24/sweeper-resolver-race.test.ts` | **Already real Redis** (`setupRedisTestContainer`). |
| `apps/api/src/adapters/__tests__/park-deferred-intent-nx-hash.test.ts` | **Already real Redis** (`setupRedisTestContainer`). |
| `apps/api/src/__tests__/park-deferred-intent-nx.test.ts` | ~~**Already real Redis**, but gated on its **own** `REDIS_URL` check rather than the shared harness — so it skips wherever `REDIS_URL` is unset, which includes CI.~~ **FIXED in M0** — migrated onto `setupRedisTestContainer`. See the correction immediately below: this row named ONE file; there were FIVE. |

### The remaining map, over this enumeration

**14 remaining = 13 owner-gated + 1 refused. Nothing actionable is left in it.**

| Bucket | Count | Files |
|---|---|---|
| ~~Owner-gated, class (i) — eval-bearing atomicity theater~~ **RETIRED in M2** | 7 | items 1-7 |
| Owner-gated, class (i-b) — SUT reaches Lua, double omits `eval` | 6 | items 8-13 |
| Refused — leaf-purity edge, no fiction to kill | 1 | `packages/audit-sink/.../redis-spill-storage.test.ts` |
| **Remaining** | **14** | |
| Migrated | 3 | items 14, 15 (R5-S8), 16 (R5-S9) |
| **Enumerated population** | **17** | |

Every one of the 13 is gated on the same owner decision — real Redis
(testcontainers) or a different design for the Lua-bearing paths — not on adapter
coverage. No further adapter command unblocks any of them, so the R5-S6→S9
migration line ends here unless that decision changes. Read the population
correction immediately below before treating 14 as the whole surface.

---

## Population correction (R5-S9) — the enumeration above is INCOMPLETE

**Status: NEEDS-VERIFICATION. Do not quote "the map is complete" without reading
this.**

R5-S9 re-derived the population from the method stated at the top of this file
rather than trusting the enumerated 17, and got a larger answer. The
re-implementation is not faithful — it over-matches on `Set`, `type`, `publish`
and `subscribe`, so its raw total (28) is not a corrected count and is not used
anywhere above. But it surfaced one cluster that is **not** a false positive:

**Twelve `apps/api` test files each define their own `redisFake` — a
store-backed behavioural double with real `get`/`set`/`del`/`hGetAll`/`hSet`
semantics over local `Map`s, plus a `multi()` chain.** They are copy-pasted
per file (`vi.mock` hoisting forces the double into the test file, so the
customer-plane e2e harness cannot own them), and none appears in the
enumeration above.

```
apps/api/src/__tests__/alias-canonicalization.e2e.test.ts
apps/api/src/__tests__/chat-l1-parse-memo.e2e.test.ts
apps/api/src/__tests__/chat-pix-checkout.e2e.test.ts
apps/api/src/__tests__/chat-stayhome-pickup-contradiction.e2e.test.ts
apps/api/src/__tests__/l0-social-short-circuit.e2e.test.ts
apps/api/src/__tests__/l2-scoped-parse.e2e.test.ts
apps/api/src/__tests__/paid-cancel-parity.e2e.test.ts
apps/api/src/__tests__/reorder-last-workflow.e2e.test.ts
apps/api/src/__tests__/swap-for-coupon-workflow.e2e.test.ts
apps/api/src/__tests__/tool-dispatch-self-readjudication.test.ts
apps/api/src/__tests__/workflow-runtime-v1.e2e.test.ts
apps/api/src/__tests__/workflow-runtime.e2e.test.ts
```

What this does and does not change:

- It does **not** change R5-S8's actionable conclusion. All twelve define a
  `multi()` that returns a chained stub ending in `exec: async () => []`
  (measured: exactly 12 files match that literal), and one of them
  (`tool-dispatch-self-readjudication`) stubs `eval`/`evalSha`/`scriptLoad`
  as well. The in-memory adapter refuses every one of those commands
  (`LuaAtomicityNotEmulated`, W4 RULE 3), so **none of the twelve is
  migratable** — they are class (i) atomicity theater, owner-gated for the
  same reason items 1-7 are. R5-S9 really was the last actionable item.
- It **does** change the owner-gated total. "13 owner-gated" counts the
  enumeration only; the true figure is at least 25, and the class-(i)
  atomicity-theater group is at least 19 rather than 7. Any decision priced
  against "seven files" — the testcontainer-adoption question below in
  particular — is priced against a third of the real surface.
- The `multi()` chains deserve their own note, because they are worse than
  missing atomicity. The chain is built as
  `{ hSet: () => chain, expire: () => chain, exec: async () => [] }` — the
  queued commands return the chain and **never touch the backing store**. So a
  write issued through the transaction path is silently DROPPED, while the
  identical write issued directly through `hSet` is stored. Any SUT that writes
  transactionally and reads back directly sees its own write vanish; any SUT
  that only writes transactionally is asserting against a store that never
  changed. And `exec` answering `[]` means zero replies for N queued commands,
  so a caller reading replies positionally gets `undefined` throughout. (Real
  EXEC returns one reply per queued command; a WATCH-aborted transaction is a
  nil reply, which node-redis v4 surfaces as a thrown `WatchError` — neither
  shape is `[]` for a non-empty transaction.)

Not fixed here: classifying twelve files, re-pricing the owner's decision, and
deciding whether the copy-pasted `redisFake` should become one shared harness
are all outside a spill-migration slice. Filed so the next census slice starts
from the real number.

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
2. ~~**CI has no Redis service and sets no `REDIS_URL`.**~~ **CLOSED by M0.**
   The original text read: *"`ci.yml` runs `pnpm exec turbo test` with neither.
   Files using the shared harness default to running (the flag is unset, so
   `RUN_REAL_REDIS` is `true`) and depend on the runner's Docker; files using
   their own `REDIS_URL` gate — item 21 above — skip silently and report
   green."* Both halves were right; the count in the second was not. See the
   correction below.

### Population correction (M0) — the silent-skip class was FIVE files, not one

The class-(iii) row above named `park-deferred-intent-nx.test.ts` as *the*
file gated on its own env check. The env var is `REDIS_TEST_URL` (not
`REDIS_URL`), and grepping for it returns **five** apps/api test files, all
with the identical shape — an own-env `RUN_REAL_REDIS` const, a
`describe.skipIf`, and a trailing non-skipped "synthetic guard" describe whose
stated purpose was *"so vitest reports the file as ran"*. That last part is
what made the skip quiet: the file always had one passing case, so it printed
a ✓.

Measured in the required `check` job on dev @ `2f5c4979` — not inferred:

| File | CI reported | Real-Redis cases lost |
|---|---|---|
| `__tests__/park-deferred-intent-nx.test.ts` | `✓ (4 tests \| 3 skipped)` | 3 |
| `__tests__/otp-brute-force-atomic.test.ts` | `✓ (5 tests \| 4 skipped)` | 4 |
| `__tests__/otp-brute-force-before.test.ts` | `✓ (2 tests \| 1 skipped)` | 1 |
| `__tests__/refund-drip-cap-atomic.test.ts` | `✓ (4 tests \| 3 skipped)` | 3 |
| `__tests__/refund-drip-cap-before.test.ts` | `✓ (2 tests \| 1 skipped)` | 1 |
| **Total** | five green files | **12** |

Those 12 cover the refund drip-cap Lua (`routes/admin/payments.ts:182`), the
OTP-lockout Lua (`routes/me/anonymize-otp-gate.ts:404`) and the NX park guard
— i.e. two of the eight production script shapes had *zero* executing CI
coverage while the census recorded them as "already real Redis".

M0 migrated all five onto `setupRedisTestContainer` and deleted the synthetic
guards. There is now exactly one real-Redis knob, `IBX_SKIP_REAL_REDIS=1`
(local-dev only), and `scripts/check-real-redis-suites.mjs` — a hand-written
roll call of 9 suites / 27 cases, run as its own `ci.yml` step — fails the
build if any enumerated suite executes fewer cases than it names.

Still standing, and worth reading before M1: the harness suites
(`sweeper-resolver-race`, `park-deferred-intent-nx-hash`,
`ledger-replay-suppression`) *were* running in CI all along, on the runner's
preinstalled Docker. Validated Docker, not a `services:` container, is what
this repo's harness needs — it starts its own `redis:7-alpine` per file.

### The full production Lua inventory (20 sites, 8 script shapes)

> **CORRECTED BY M1 — the count is 25 sites, not 20.** Two omissions, found by
> grepping `redis.call` over the whole tree while building the shape suites:
>
> 1. **CAD has ELEVEN sites, not ten.** `apps/api/src/claustrum/trigger-dedup-redis.ts:59`
>    (`TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT`, exported) is a CAD site and is
>    missing from the list below. It is covered — `agent-trigger-dedup-ownership.test.ts`
>    is one of the F-21 rollout suites — so this was a bookkeeping gap, not a
>    coverage gap. It is now a row in the CAD shape suite's site table.
> 2. **The park-quota script is a ninth shape.** `EVAL_INCR_CHECK_SCRIPT`
>    (`adapters/park-redis-capabilities.ts:124` — INCR + EXPIRE + DECR-on-refuse)
>    is not in the eight, but it is production Lua and it is covered by
>    `park-nx-release-failure-mode.test.ts` (the atomicity race and the TTL
>    refresh). Named here so the inventory is closed rather than merely long.
>
> Two line numbers below have also drifted: `park-nx.ts:66` is now
> `adapters/park-redis-capabilities.ts:108` (moved by F-22) and
> `lib/defer-resuming-lock.ts:40` is now `:50`. The shape suites anchor on
> declaration TEXT rather than line numbers for exactly this reason.

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

## M1 — the script-shape contract suites (all 8 shapes)

Six new suites, 86 executing cases, all enrolled in the M0 roll call (61 → 147
cases; 137 container-backed). Two shapes needed no new suite. Ruling and the
full status table: `docs/architecture/redis-lua-testing-decision.md`.

| Shape | Sites | Suite | Cases |
|---|---|---|---|
| CAD | 11 | `lua-shape-cad-contract.test.ts` | 27 |
| CONSUME | 4 | `lua-shape-consume-contract.test.ts` | 15 |
| CAE | 3 | `lua-shape-cae-contract.test.ts` | 12 |
| Rate limit | 2 | `lua-shape-rate-limit-contract.test.ts` | 12 |
| Session rollover | 1 | `lua-shape-session-rollover-contract.test.ts` | 10 |
| Token bucket | 1 | `lua-shape-token-bucket-contract.test.ts` | 10 |
| OTP lockout | 1 | *already served* — `otp-brute-force-atomic.test.ts` + `-before` | — |
| Refund cap | 1 | *already served* — `refund-drip-cap-atomic.test.ts` + `-before` | — |

### What a shape suite does that a site suite cannot

Every one of the 14 suites M0 enrolled is a SITE suite: it drives one call
site's production functions and proves that site releases/consumes correctly.
None can see a divergent script at a site it does not cover, and CAD alone has
11 sites across 4 packages.

The shape suites read the Lua TEXT out of each production site
(`helpers/lua-script-sources.ts`, `extractLuaAfter(file, anchor)`) and run one
contract against all of them on a real Redis. This is what makes Q2's
"call sites inherit the shape's invariant from the contract suite" a fact rather
than a hope — the contract runs the site's own bytes, so a site that drops
`== ARGV[1]` reds at that site's row whether or not it has a suite. Reading
source rather than importing is also what lets one apps/api suite cover
`packages/tools`, `packages/cli` and `packages/journeys` sites without adding a
dependency edge; only 3 of ~20 script constants are exported and two sites have
no constant at all (inline literals in the `eval()` call).

Three guards keep that seam honest: `extractLuaAfter` throws on a missing
anchor, an AMBIGUOUS anchor, a literal with no `redis.call`, or an interpolated
script (where source text would not be what runs); the CAD suite requires the
extractor's output to be byte-identical to the imported value for all three
EXPORTED constants; and each site table is pinned by a hand-written NAME roll
call, not a count and not a derivation from the table itself (F-14).

### Each suite fails when its conjunct is removed — in two independent ways

1. **In-suite, per site.** Each suite rewrites each site's own script with the
   conjunct deleted and requires the damage to appear: CAD/CAE strip the
   ownership test and the foreign key must be destroyed / extended; CONSUME runs
   the client-side GET-then-DEL and the same receipt must be redeemed more than
   once; rate limit and token bucket strip the TTL-set and the key must go
   immortal; rollover strips the idle test and every message must rotate. Each
   mutation helper THROWS when it finds nothing to remove, so a control cannot
   silently degenerate into a re-run of the unmutated script.
2. **Against production source.** Each shape was verified by corrupting the real
   file and observing the red — deliberately at sites with no site suite of
   their own (`packages/cli/src/lib/lock.ts`, `escalation-park-store.ts`,
   `journeys/journey-lock.ts`, `tools/atomic-rate-limit.ts`, `whatsapp/session.ts`,
   `whatsapp/client.ts`). Reds were confined to the corrupted site's own rows.

### Remainder map for M2 / M3

**M2 (class (i), the 7 eval-emulating doubles) is unblocked, and the shape
suites now hold the invariant each double was faking** — **M2 is DONE; see "M2
— the class (i) retirement" below for the per-file dispositions:**

| Census item | Double emulates | Inherits from |
|---|---|---|
| 1 `defer-resolver.test.ts` | CAD ×2 | CAD suite |
| 2 `defer-timeout-sweeper.test.ts` | CAD | CAD suite |
| 3 `escalation-park-store.test.ts` | CONSUME | CONSUME suite |
| 4 `checkout-confirmation-store.test.ts` | CONSUME | CONSUME suite |
| 5 `order-cancel-confirm.test.ts` | CONSUME | CONSUME suite |
| 6 `cart-routes.test.ts` | CONSUME | CONSUME suite |
| 7 `journeys/journey-lock.test.ts` | CAD **and** CAE | CAD + CAE suites |

Per Q2 each then needs only unit-level observation that the site issues the
right script with the right arguments — the spy-delegate idiom, not a second
container. Item 7 is the one to do first: it is the repo's only
script-DISPATCHING double, and it is the only class-(i) file whose SUT reaches
two shapes, so it is where a script-blind swap would do the most damage.

**Two findings M2/M3 should not rediscover:**

- **`sweeper-resolver-race.test.ts` is enrolled as real-Redis but its CAD never
  runs.** Its `vi.mock("@ibatexas/tools")` (:107) returns a client with no
  `eval`, and `releaseDeferResumingLock` swallows the resulting TypeError
  (`lib/defer-resuming-lock.ts:128`, "best-effort cleanup"). Its 3 cases prove
  SETNX exclusivity, not the `defer:resuming:*` compare-and-delete. That site's
  only positive-arm coverage is `defer-resume-integrity.test.ts:327`; its
  ownership arm now lives in the CAD shape suite. This is class (i-b) wearing a
  container — worth a row in M3's disposition.

  > **RESOLVED in M3, and it was hiding two worse things.** Proved before
  > fixing: after a sweeper-won sweep the `defer:resuming:*` mutex was still
  > present with `ttl=60` — the release had run and done nothing. Fixed by
  > forwarding `eval` VERBATIM to the container the file already had (not an
  > emulation; the in-memory adapter still refuses `eval`). The file is 3 → 6
  > cases and declares `expectLuaCalls: true` to the harness.
  >
  > **F-39 — a dead spy.** `mockAuditSinkEmit` was declared, cleared in
  > `beforeEach` and asserted on three times, but NO `vi.mock` ever connected
  > it to anything, so `auditEmits` was structurally always 0: every
  > `expect(auditEmits).toBe(0)` was vacuous, and the `park_missing_after_lock`
  > arm's `toBe(1)` was unsatisfiable. It stayed green only because that arm
  > was unreachable while the release was dead. Now wired to
  > `getAuditSink().emit`, the seam the resolver actually uses.
  >
  > **F-40 — a live ~0.8% double-mutation window in production code.** With the
  > release working, the 100-iteration case caught BOTH surfaces firing. The
  > resolver has re-checked parkKey after its own SETNX since E2 Fix-b; the
  > SWEEPER never did. Between the sweeper's E3 blob GET and its SETNX, the
  > resolver can complete a resume and release the shared mutex — the sweeper
  > then acquires it and publishes `intent.defer.timeout` for an
  > already-resumed envelope. **The file's "hard zero" was an artifact of the
  > broken release**: with the mutex only ever ending by TTL, the window could
  > not open, so the regression this file exists to catch was unreproducible in
  > it. 4 violations / 500 iterations before the sweeper-side re-check, 0 / 500
  > after, plus a deterministic case so the net is not a 1% rate.
  >
  > The general lesson, which is the one worth keeping: **roll-call enrolment
  > proves a FILE ran, not that its Lua ran** — and a suite whose Lua is a side
  > effect of the path under test, rather than the thing its assertions read, is
  > where that gap hides. See the gate strengthening in the ruling doc.
- **A stale comment in `force-routes-governance.test.ts`** (:1643-1650) still
  claims "the mocked redis.eval … emulates the Lua script". It does not — that
  suite forwards `eval` verbatim to a real container, and it is the only
  real-Redis coverage any CONSUME site had before M1 (the admin store).
  **FIXED in M2** — the comment now records what the file actually does. Both
  findings were re-verified before acting: `sweeper-resolver-race.test.ts` has
  no `eval` anywhere in it (F-37 stands, left to M3 — it did not block M2,
  because M2 re-homed the CAD onto the CAD SHAPE suite, never onto that file).

---

## M2 — the class (i) retirement

**All 7 eval emulations are gone.** Six files kept their in-memory doubles for
the non-atomic commands and replaced `eval` with unit observation; the seventh
moved to real Redis. No case was deleted. Three were renamed, because their
names claimed a property the file no longer proves.

| # | File | Disposition | What the emulation was providing | Where that coverage lives now |
|---|---|---|---|---|
| 1 | `subscribers/__tests__/defer-resolver.test.ts` | (b) unit observation | 3 cases asserted the `defer:resuming:*` marker was GONE after commit / rollback / park-missing-after-lock | CAD deletion semantics → `lua-shape-cad-contract.test.ts`. That the resolver ISSUES the release, on all 3 paths, with its own token → `expectResumingLockReleased()`, same 3 cases |
| 2 | `jobs/__tests__/defer-timeout-sweeper.test.ts` | (b) unit observation | 1 case asserted the sweeper's mutex key was GONE after commit | as above → CAD suite + `expectSweeperMutexReleased()`. (`recovery:fired:*` releases are a plain `del` and never touched the emulation) |
| 3 | `escalation/__tests__/escalation-park-store.test.ts` | (b) unit observation | "consume() is single-use" | single-use → CONSUME suite. Split into "issues THIS site's CONSUME script against the rk() park key" + "parses what the script returned, null once it returns nil" |
| 4 | `__tests__/checkout-confirmation-store.test.ts` | (b) unit observation | "consume() returns the pending exactly once (single-use)" | single-use → CONSUME suite. RENAMED to "issues THIS site's CONSUME script against the receipt key, and parses what it returns" |
| 5 | `__tests__/order-cancel-confirm.test.ts` | (b) unit observation + declared postconditions | "410 on a REUSED receipt — single-use consume" | single-use → CONSUME suite. RENAMED to "410 CONFIRMATION_EXPIRED when the CONSUME script reports the receipt already drained" — the ROUTE's half, which no shape suite covers |
| 6 | `__tests__/cart-routes.test.ts` | (b) unit observation + declared postconditions | the seam case asserted the receipt key was DRAINED from the injected keyspace | single-use → CONSUME suite. RENAMED to "…reads and CONSUMES OUR keyspace…"; the seam property (every command, eval included, landed on the INJECTED client) is unchanged and pinned by `expectLuaCallCount` + `expectLuaCall` |
| 7 | `packages/journeys/.../journey-lock.test.ts` | **(c) real Redis** | ALL of it — CAD ownership, CAE heartbeat, and the orchestration (contention, wait deadline, distinct keys) that needs a release which really frees the key | its own 9 cases, now container-backed. Script shapes additionally held by the CAD + CAE suites, which read this file's own bytes |

**Why not disposition (a) anywhere.** "Delete the emulation and let the call
fail loudly" does not fail loudly at these sites: `releaseDeferResumingLock`
swallows by design, so a throwing `eval` is absorbed and the case passes having
observed nothing. That is F-37's mechanism; (a) would have manufactured it at
two more sites. `lua-call-observer.ts` therefore offers no throwing mode at all.

**Why not (d) anywhere.** Docker was available; the one file that genuinely
needed the script's effect got real Redis.

### The seam — `helpers/lua-call-observer.ts`

Unit observation is worth something only if it names WHICH script the site
issued. `expectLuaCall(observer, i, { site, keys, arguments })` requires the
observed script to be byte-identical to the production text at a named anchor —
the SAME anchor the shape suite reads. What each half can and cannot catch is
written in the helper's header; in short:

- **the observation** catches: the site stopped issuing the script; the site
  issues a DIFFERENT script (the script-blindness hazard); the site issues the
  right script against the wrong KEY or wrong ARGV (F-21's constant lock value).
- **the shape suite** catches: a semantic corruption of the script constant.
  The observation is deliberately blind to that — it compares a runtime value
  against the source text it was compiled from, so a consistent edit moves both
  sides.

Neither is sufficient. The pair is.

### The script-blindness hazard is bigger than this census said

The section above ("The script-blindness hazard") treats a script-blind double
as safe while its SUT reaches one script family, and names `cart-routes` as the
closest to the edge. Measured across production, the exposure is wider: **four
modules run two or more distinct scripts through a single client.**

| Module | Scripts | Shapes |
|---|---|---|
| `apps/api/src/whatsapp/session.ts` | `ROTATE_SESSION_SCRIPT`, `RELEASE_LOCK_SCRIPT`, `EXTEND_LOCK_SCRIPT` | **3** |
| `apps/api/src/streaming/execution-queue.ts` | `RELEASE_LOCK_SCRIPT`, `EXTEND_LOCK_SCRIPT` | 2 (CAD + CAE) |
| `apps/api/src/adapters/park-redis-capabilities.ts` | `COMPARE_AND_DELETE_SCRIPT`, `EVAL_INCR_CHECK_SCRIPT` | 2 (CAD + quota) |
| `packages/journeys/src/runner/journey-lock.ts` | `RELEASE_LOCK_SCRIPT`, `HEARTBEAT_SCRIPT` | 2 (CAD + CAE) |

So journey-lock's dispatching double was not an oddity — it was the only
class-(i) file whose SUT forced a question the other six were quietly ducking.
Its dispatch was genuinely load-bearing: a CAD-shaped blind double handed the
HEARTBEAT script deletes the lock instead of extending it, and a CONSUME-shaped
one tells a foreign holder "released, here is the value". Any future double
standing in for one of the four modules above needs the named-anchor
observation, not a script-blind stub.

### Revert-to-red

Five experiments; two are control/treatment pairs run against the RETIRED
doubles (restored from `2d5b7336` with the production defect held constant), so
they measure whether M2 preserved coverage or added it. Every production edit
was restored and verified by content.

| # | Production defect injected | Retired (M1) double | M2 |
|---|---|---|---|
| 1 | `lib/defer-resuming-lock.ts:85` lock value → the constant `holder` (F-21's exact defect) | **35/35 GREEN** | **4 RED** |
| 2 | `escalation-park-store.ts` consume EVALs a CAD instead of its own CONSUME | **5/5 GREEN** | **1 RED** |
| 3 | `journey-lock.ts` CAD → `if true then` | — (retired to real Redis) | 2 RED |
| 4 | `journey-lock.ts` CAE → `if false then` | — | 1 RED |
| 5 | `checkout-confirmation-store.ts` consume key drops `rk()` (rule #7) | — | 3 RED, across both consuming files |

Rows 1 and 2 are the point. Row 1 is F-21 reproduced: a constant lock value
compares equal to itself, so the emulation deleted the key and every assertion
held. Row 2 is the script-blindness hazard reproduced: the double never looked
at the script, and the SHAPE SUITE does not catch it either — the suite reads
the anchor's constant, which is still correct CONSUME text that nothing
dispatches. The unit observation is the only thing in the repo that reds.

### Roll call

`scripts/check-real-redis-suites.mjs` now walks a LIST OF PACKAGES rather than
`apps/api` alone. Moving `journey-lock.test.ts` to a container put a real-Redis
suite in `packages/journeys`, and a suite that can skip in a tree the gate never
scans is the M0 hole reopened one package over. Both the existence check, the
completeness alarm and the drive-and-count step run per package.

| Package | Suites | Enrolled cases |
|---|---|---|
| `apps/api` | 20 | ≥147 (137 container-backed) |
| `packages/journeys` | 1 (`journey-lock.test.ts`, `minExecuted: 9`) | 9 (9 container-backed) |
| **Total** | **21** | **≥156 (146 container-backed)** |

`packages/journeys` gained `redis` as a devDependency (it already had
`testcontainers`); the suite drives the same three-method wrapper
`journey-lock.ts`'s own `defaultRedis()` builds.

---

## M3 — the class (i-b) rows, and the container that proved nothing

**Verified-open population: ONE — and it was not in the class (i-b) table.**
Every row was checked against the tree rather than read off the enumeration.

| Row | Hole proof | Disposition | Where the invariant lives now |
|---|---|---|---|
| 8 `defer-roundtrip` | reaches Lua ×1, refused (its own declared-bound case asserts it) | **keep** | CAD shape suite + M2 observation; the bound is a tested statement here |
| 9 `defer-roundtrip-extensions` | probe in the release catch: **1** refusal | **keep** | CAD shape suite + M2's `expectResumingLockReleased()` |
| 10 `defer-resolver-resumedkey-redis-error` | probe: **1** refusal | **keep** | as above |
| 12 `boot-window-race` | probe: **2** refusals | **keep** | as above |
| 11 `defer-resume-integrity` | n/a — on the container since Phase 5, enrolled at 3 | **already done** | its own cases |
| 13 `park-nx-hoist` | n/a — SUT never reaches Redis (Phase 5) | **already done** | `park-nx-hash`, `park-nx-release-failure-mode` |
| **F-37** `sweeper-resolver-race` | mutex present with **ttl=60** after a sweeper-won release | **FIXED** | its own cases, 3 → 6 |

Rows 8–12 are **not** holes to close. The adapter refuses `eval` on purpose
(W4 RULE 3) and the ownership invariant is held by the CAD shape suite plus the
unit observation; three more containers would buy no new signal, which is
ruling Q2 applied rather than quoted. Nothing was deleted, so no row needs a
"nothing covers this now" statement.

**The two F-22-deferred migrations needed nothing** — verified before touching
anything, per the brief. `defer-resume-integrity` is on the shared harness and
enrolled; `park-nx-hoist` is a unit file whose SUT provably never reaches
`parkDeferredIntent`.

### The two lessons worth keeping

**1. A green metric produced by a broken instrument (F-40).** This is the find
of the phase and the mechanism is the whole point.
`sweeper-resolver-race.test.ts` exists to police one invariant — that the
sweeper and the resolver never both mutate the same parked envelope — and it
reported HARD ZERO across five separate 100-iteration runs. That zero was an
**artifact of the broken release**. The interleaving the test is written to
catch requires the sweeper's SETNX to succeed *inside* an iteration, which
requires the mutex to have been released; while F-37 kept every release dead the
mutex could only end by TTL, so the window could not open and the regression was
physically unreproducible in the file built to reproduce it. Restore the release
and the violation appears immediately, at ~0.8% (4 / 500 iterations).

The generalisation: **a passing measurement is only as good as the instrument's
ability to produce a failing one.** Before trusting a zero, ask what would have
had to happen for it to be non-zero, and whether the harness can do that at all.
This is the same shape as a negative test that passes with the enforcement
deleted — the assertion is fine, the reachability is not.

**2. Classify by the property, not by the artefact.** The census classifies by
*what kind of double is it*. F-37 shows the property that actually matters is
*does the SUT's Lua execute* — and those come apart exactly once here: **a file
can wear a real container and still be class (i-b)**. That is why the one
genuinely open row sat in class (iii) as "Already real Redis" and was invisible
to a reading of the class (i-b) table. The sweep that bounds it is one line: of
22 container-backed `apps/api` suites, exactly one wraps its container in a
`@ibatexas/tools` mock that mentions `eval` nowhere.

### What F-37 cost, beyond the one file

Fixing it exposed **F-39** (a dead `mockAuditSinkEmit` spy — three vacuous
assertions and one unsatisfiable one) and **F-40** above. Both are written up in
full at the F-37 entry in "Two findings M2/M3 should not rediscover".

Two gate changes follow, both general and both measured (see the ruling doc):
the roll-call gate now fails on a **non-zero vitest exit** — previously a
throwing `afterAll` left every case reading "passed" and the gate certified the
run — and `setupRedisTestContainer({ expectLuaCalls: true })` fails teardown
when **zero** scripts reach the container. Proof they were both needed: with
`eval` removed and the two new F-37 cases neutered to trivial passes, vitest
reports **6 passed / 0 failed** and exits 1 on the alarm. The old gate read only
the case counts, and would have called that green.

A per-suite expected-EVAL COUNT was considered and refused: 21 hand-maintained
figures across the roll call, each a fresh way to red spuriously, to catch a
failure mode that is always "the Lua stopped entirely". Disproportionate gate
mechanisms are how a gate becomes noise and then gets ignored.

Roll call after M3: **21 suites / ≥159 cases (149 container-backed)**.

---

## Filed, not fixed

### F-41 — `scripts/` is covered by NO eslint config (M3)

There is no root `eslint.config.*`, and no package's lint task owns the
repo-root `scripts/` directory, so `scripts/check-real-redis-suites.mjs` — the
loud-skip gate itself — **cannot be linted from anywhere**. `npx eslint` at the
root fails with `eslint: command not found`; the binary only resolves inside a
package that declares the devDependency.

This is **F-38's class one directory over** (`packages/journeys` has no eslint
either: its `lint` script is `tsc --noEmit` only). The shared shape is a tree
whose lint gate silently covers nothing, so an unused import or variable reaches
CI unflagged — and `tsc` does not flag unused imports.

M3 verified its own edit to that file with `node --check` instead and added no
new identifiers. Filed rather than fixed because the fix is a repo-level lint
decision (a root config, or a `scripts` workspace) that is not M3's call.

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

> **RESOLVED by F-22** (branch `fix/f22-capability-validation`). Both branches
> are deleted; release is the CAD, always, and a failed CAD leaves the key to
> its TTL. See the F-22 section below.

### F-22 — capabilities are validated at the composition root

The owner ruled the F-21 finding above as a **class**, not a site:
*"Capabilities are validated at composition root. Runtime should never branch
based on optional Redis features."* The class had two measured members, with
different failure modes and — importantly — different repair surfaces.

**Member 1, in-repo: `park-nx.ts` `releaseNxPlaceholder`.** Fixed directly. The
feature detect and the `catch → plain del` fallback are both gone. `redis` is
now a `ParkRedisCapabilities` (see below), so `compareAndDelete` is a REQUIRED
member and there is nothing to ask. When the CAD **fails**, the key is
deliberately **left to its TTL** and the failure is logged loudly. That is a
behaviour change in the failure mode, and the safe direction: leaving the
placeholder costs the session one refused DEFER for at most `ttlSeconds`
(surfaced as the pt-BR collision refusal), where a blind DEL can permanently
destroy another owner's real parked envelope. The TTL was always documented as
the ultimate safety net; F-22 makes it the *only* fallback.

**Member 2, external: `@adjudicate/runtime`'s `parkDeferredIntent`.** It does
`typeof args.redis.evalIncrCheck === "function"` and takes a NON-ATOMIC
`INCR → EXPIRE → check → DECR` fallback when the member is absent — the
framework's own doc-comment names the resulting over-commit race (two
concurrent parks at `quota − 1` can both pass before either rolls back). That
package is a pinned npm dep whose source of truth is the platform repo, so it
is **not editable here** and was not touched.

**What the composition guarantee makes deterministic in this repo.**
`apps/api/src/adapters/park-redis-capabilities.ts` is the composition root for
this path's Redis surface. `createParkRedisCapabilities(client)` proves the
client carries `eval`/`set`/`incr`/`decr`/`expire` — throwing
`RedisCapabilityUnavailableError` with the missing names if not — and returns a
`ParkRedisCapabilities` that **promotes `evalIncrCheck` from optional to
REQUIRED** and adds `compareAndDelete`. `parkDeferredIntentWithNxGuard` accepts
only that type. Consequently the framework's probe is **deterministically TRUE**
for every park issued by this repo, and its non-atomic fallback is **dead code
here**. That is pinned by observation, not by assertion of intent: the
testcontainer case *"the framework consumes OUR evalIncrCheck — its non-atomic
INCR fallback never runs"* spy-delegates `evalIncrCheck`, `incr` and `expire`
and requires the first to be called with the framework's own arguments and the
other two never to be called at all.

**What the platform fix would be.** Delete the probe in
`packages/runtime/src/defer-park.ts` and promote `ParkRedis.evalIncrCheck` from
optional to required (a major for the `runtime` package), so every adopter is
forced to supply the atomic seam rather than silently inheriting the racy
sequence. Until then the fallback remains reachable for *other* adopters; the
in-repo guarantee only closes it here. **Not attempted in this repo** — see
CLAUDE.md rule #9 on `@adjudicate/*` source ownership.

**Regression surfaces.**

| Layer | File | Proves |
|---|---|---|
| structural | `__tests__/bypass-detection/redis-capability-detect-conformance.test.ts` | zero capability probes in `apps/api/src` + `packages/tools/src` production code, outside a 1-entry hand-written allowlist (the validator itself, whose probe's only outcome is a throw) |
| unit | `adapters/__tests__/park-redis-capabilities.unit.test.ts` | composition fails closed per command (hand-written roll call, not `it.each`); the atomic members delegate to `client.eval` with the exact script + arguments |
| testcontainer | `__tests__/park-nx-release-failure-mode.test.ts` | a failed CAD leaves the key (and never touches a foreign owner's); the working CAD is ownership-checked; `evalIncrCheck` is genuinely atomic under 40-way concurrency; and the pre-F-22 release, run verbatim in the same end state, DOES destroy the foreign key |

**One double left honest rather than "fixed".** ~~The stub in
`adapters/__tests__/park-deferred-intent-nx-hoist.unit.test.ts` deliberately
does NOT carry `evalIncrCheck`/`compareAndDelete`, so the framework takes its
non-atomic branch *inside that unit test*.~~ **Superseded in Phase 5** — that
stub is gone. Refusing to fake the two Lua members was right; keeping a double
that *omitted* them was the wrong way to express it, because omission is what
routes the framework down the non-atomic branch. The replacement declares the
full `ParkRedisCapabilities` contract and makes every member **reject** with a
`RedisTouchedSentinel`, so the non-atomic branch is unreachable from that file
and "the wrapper touched Redis" becomes the file's control rather than an
accident. Adding in-memory versions would still be
exactly the Lua-emulation theater W4 RULE 3 forbids — the atomicity claims are
proven at the testcontainer layer or not at all. The two real-Redis park suites
(`park-deferred-intent-nx.test.ts`, `park-deferred-intent-nx-hash.test.ts`)
previously hand-built a shim with no `eval` — meaning every park they ran took
the wrapper's plain-`del` "legacy" branch — and now compose through the
production factory instead.

**One consequence to know.** On the atomic path the framework reports
`observed: quota + 1` rather than the true count on a quota refusal (it would
cost an extra round trip). `me.ts` only logs that field, so nothing branches on
it; the user-facing refusal is unchanged.

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

### F-23 — the audit-sink leaf's inlined `rk` is NOT byte-identical to `rk()`

`packages/audit-sink/src/redis-spill-storage.ts:49-57` inlines `rk` to preserve
the leaf-purity invariant (zero runtime deps on `@ibatexas/tools`), and its
header states the copy "MUST stay byte-identical to
`packages/tools/src/redis/key.ts` so spill keys land in the same Redis namespace
the rest of the codebase uses". On the **capture-time** axis it is not:

| | `APP_ENV` read | Source |
|---|---|---|
| leaf copy | ONCE, at module load, into `const RK_ENV_PREFIX` | `redis-spill-storage.ts:54` |
| canonical `rk()` | at every CALL, deliberately | `redis/key.ts:31-33`, FE-D26 |

FE-D26 made the canonical one lazy on purpose — out-of-process tooling sets
`APP_ENV` after first import, and a module-level capture had produced exactly the
cross-prefix split this comment warns about. The leaf is the frozen version FE-D26
removed.

Production impact is nil today: `APP_ENV` is set before the process starts, so
both spellings agree. The reachable consequence is in tests, and it is already
recorded in the migrated file's own comment — a `vi.stubEnv("APP_ENV", …)` moves
the canonical `rk` and cannot move the leaf, so the two disagree and an assertion
written with the canonical `rk` reads an empty list. Item 16's key derivation
mirrors the leaf for that reason rather than importing `rk`.

Not fixed here because both directions are owner calls: making the leaf lazy
changes a leaf-purity-motivated implementation, and making the header's claim
accurate weakens a stated invariant. Either way the header should stop asserting
byte-identity it does not have.

---

## R5-S12 — the direct-caller census, and the first threaded family

Measured on branch `feat/arch-r5-s12-redis-threading` off `dev @ 78a44b75`.
This section adds the **production-side** half the earlier passes never had: the
census above enumerates *doubles*, and says nothing about which modules can
accept a client at all. It also corrects two counts. **Read the reconciliation
first — per this file's own calibration rule, a re-derived population is not
trusted until it reproduces the prior enumeration.**

### Reconciliation against R5-S8's enumerated 17

R5-S9 recorded that a re-derivation of the shape sweep produced a larger,
unfaithful number (28) that was never folded in. R5-S12 did **not** re-run the
shape sweep. It verified the *enumerated 13 owner-gated rows* file-by-file on
the axis that decides their class — whether the file's double defines `eval`:

| Class | Expected | Measured | Agrees |
|---|---|---|---|
| (i) items 1–7, eval-EMULATING | `eval` defined | `eval` defined in all 7 | YES |
| (i-b) items 8–13, eval-OMITTED | no `eval` | no `eval` in all 6 | YES |

All 13 files still exist at their recorded paths and all 13 still carry the
class the enumeration assigned them. The enumerated population of 17 is
therefore reproduced, and the corrections below are additive to it, not a
competing count. The `mockRedis` metric (27) and the `redisFake` cluster (12)
were re-measured and are **unchanged** — note that a naive
`git grep -l redisFake` now returns 13, because **this document** matches its
own grep; the cluster is still 12 test files.

### Correction 1 — the direct-caller population is 62, not 65

`grep -rln getRedisClient apps/api/src --include='*.ts' | grep -v __tests__`
returns 65, but **three of those never call it** — they reference it only to
derive a type (`Awaited<ReturnType<typeof getRedisClient>>`), and one of the
three imports it with `import type`:

- `claustrum/agent-trigger-bridge.ts`
- `claustrum/approval-engine-redis-wiring.ts`
- `claustrum/memory-redis-adapter.ts`  (`import type`)

**62 files issue 167 runtime `getRedisClient()` calls.** Any future slice sizing
this surface should use 62/167, and should count *call sites*, not files: the
distribution is very skewed — `routes/me/anonymize-otp-gate.ts` (16),
`whatsapp/session.ts` (14), `subscribers/cart-intelligence.ts` (14),
`routes/cart.ts` (10), `routes/auth.ts` (10).

| Class | n | Notes |
|---|---|---|
| (a) composition roots / bootstraps / plugins | 6 | `index.ts`, `claustrum-bootstrap.ts`, `audit-sink-bootstrap.ts`, `learning-sink-bootstrap.ts`, `plugins/kernel-bootstrap.ts`, `plugins/rate-limit.ts` — these legitimately resolve the singleton; NOT threading targets |
| (b) middleware | 2 | `middleware/auth.ts`, `middleware/staff-auth-infra-alert.ts` |
| (c) reachable from an existing route composition root | 28 | 19 `routes/*`, plus `session/store.ts`, `ops/ops-history.ts`, `ops/ops-read-executor.ts`, `tools/pix-payer-identity.ts`, `tools/register-workflow-scoped-tools.ts`, `escalation/escalation-store.ts`, `escalation/escalation-park-store.ts`, `claustrum/parse-memo.ts`, `claustrum/resolve-and-assemble.ts`, `claustrum/turn-reads.ts` |
| (d) jobs / subscribers / shared lib | 21 | `jobs/*` ×15, `subscribers/*` ×5, `lib/defer-resuming-lock.ts` |
| (e) streaming | 2 | `streaming/emitter.ts`, `streaming/execution-queue.ts` |
| (f) other | 2 | `whatsapp/client.ts`, `whatsapp/session.ts` |
| type-only, NOT callers | 3 | the three above |

Three modules already accept an injected client and are the in-repo deps-bag
precedent for class (d): `jobs/dlq-depth-checker.ts`,
`jobs/observability-liveness-checker.ts` (`readonly redis?: {...}` +
`deps.redis ?? (await getRedisClient())`) and
`jobs/escalation-park-expiry-sweeper.ts` (a **named** narrowed type,
`SweeperRedis`). `claustrum-bootstrap.ts` carries `options.redis ??` as well.

### Correction 2 — the 13 are NOT composition-root-gated

R5-S12's brief framed the 13 as blocked because "their modules under test never
accept a client". **That framing is wrong, and this document's Lua/eval framing
is right.** The decisive counter-example is this census's own item 13:

> `apps/api/src/adapters/__tests__/park-deferred-intent-nx-hoist.unit.test.ts`
> contains **no `vi.mock` at all**. `parkDeferredIntentWithNxGuard` already
> takes a `redis` argument. Nothing about composition roots blocks it.

So "threading unblocks the 13" is false. Threading unblocks a **subset of 5**,
and for a different reason than the brief assumed.

### The family threaded, and the honest bound on what it buys

**Threaded:** `subscribers/defer-resolver.ts` (`DeferResolverRedis`) and
`lib/defer-resuming-lock.ts` (`DeferResumingLockClient`), following the class-(d)
jobs deps-bag precedent above, not the route-root pattern. Default is the
singleton resolved at the same point as before.

**The bound, stated plainly: this buys ZERO new Lua coverage.** The
compare-and-delete ownership invariant on `defer:resuming:*` remains uncovered
and remains owner-gated on the real-Redis decision. What it buys is the
retirement of 4 hand-rolled doubles and 4 faked `rk`s.

R5-S12 **measured** the class (i-b) mechanism from the production side rather
than inferring it, and the measurement is now pinned as a test
(`defer-roundtrip.test.ts`, "[class (i-b) bound] the release EVAL is refused, so
the resuming marker is NEVER cleared"):

- The resolver's SUCCESS path issues exactly **one** `eval` — the CAD release.
- The retired double had no `eval` → `TypeError`. The adapter throws
  `LuaAtomicityNotEmulated`. **Both are swallowed** by
  `releaseDeferResumingLock`'s documented best-effort catch.
- Consequence, observed in the adapter keyspace after a *successful* resume:
  `development:defer:resuming:<hash>` **is still present**. The mutex is never
  released; only its TTL ends it.

This also corrects an assumption worth recording: **a reached `eval` is NOT a
red here.** One might expect the adapter's refusal to surface as a test failure
and thereby prove the eval-omitted classification wrong. It does not, because
the production code catches by design. Green tests are compatible with the hole;
that is precisely why the hole survived this long.

Bonus measurement, same run: the real `rk()` under `apps/api`'s vitest resolves
to a **`development:`** prefix (no `APP_ENV` is pinned in
`apps/api/vitest.config.ts` or `src/__tests__/setup.ts`). Every retired double in
this family faked `rk` to `test:`, so these were genuine wrong-prefix fictions,
not benign coincidences.

### Migrated by R5-S12 (4)

| File | Cases | Fiction killed |
|---|---|---|
| `__tests__/defer-roundtrip.test.ts` | 2 → 3 | `lPush` returned a constant `1` and stored nothing, so the DLQ write was asserted into a void. Now a real list write. Also pins that the happy path reaches ZERO singleton resolutions and the tamper path exactly ONE — the un-threaded `subscribers/dlq.ts`. |
| `__tests__/boot-window-race.test.ts` | 2 | faked `rk` |
| `__tests__/defer-roundtrip-extensions.test.ts` | 3 | the TTL case stored the `EX` argument and read it straight back, so it could only re-assert its own input. Now an exact remaining lifetime against a frozen clock. |
| `__tests__/defer-resolver-resumedkey-redis-error.test.ts` | 2 | the fault injector became a spy-delegate: it decides whether THIS `get` throws and otherwise forwards to the adapter, so the retry path now runs against real SET/DEL/INCR/SCAN semantics. |

### Deliberately deferred with reason (2) — **BOTH RESOLVED in Phase 5**

> Phase 5 (branch `test/phase5-deferred-park-migrations`) discharged both after
> the F-22 ruling landed. The two entries below are kept verbatim as the record
> of *why* they waited; each carries its resolution.

**`adapters/__tests__/park-deferred-intent-nx-hoist.unit.test.ts` — F-22.**
Migratable today (it already takes a client), but excluded by owner ruling: it
is F-22's site, and a naive migration silently routes `releaseNxPlaceholder`
down its unconditional-`del` branch — the unsafe path the F-22 ruling is about.
Waits on that ruling.

> **RESOLVED — ruling: it stays a UNIT test (option b), with the double
> replaced.** Read the file and the SUT: `hoistAndValidateVerificationFields` is
> the first statement of `parkDeferredIntentWithNxGuard` and the SETNX
> placeholder is the next one, so **7 of the file's 9 cases provably never reach
> the socket** — the property is Redis-independent and a container would buy no
> signal (ruling Q2: "8 container suites, not 20"). The remaining 2 were
> happy-path cases whose entire assertion was `result.parked === true`, i.e.
> "the wrapper did not refuse"; they were the ONLY reason the framework's
> non-atomic branch ran inside this file.
>
> What changed: the `redis` argument is now typed as the production
> `ParkRedisCapabilities` (previously it was cast into that type through
> `as unknown as`, which is how a stub missing the atomic members compiled at
> all), and every member — the two Lua ones included — **rejects** with a
> `RedisTouchedSentinel`. Nothing emulates a Redis command; the file's SUT never
> reaches `parkDeferredIntent`; the case count is unchanged at 9.
>
> **What the non-atomic branch loses, and why that is acceptable:** nothing that
> was ever a claim. No assertion in this file distinguished the atomic seam from
> the fallback — the fallback simply happened to be what ran. Per F-22's
> composition guarantee the branch is DEAD in this repo (every park site goes
> through `createParkRedisCapabilities()`, where `evalIncrCheck` is REQUIRED),
> and that deadness is pinned by observation, not by intent, in
> `park-nx-release-failure-mode.test.ts`'s spy-delegate case ("the framework
> consumes OUR evalIncrCheck — its non-atomic INCR fallback never runs").
> Exercising a branch production cannot reach was coverage of the wrong thing.
>
> **What the two retired happy-path cases became.** They were converted, not
> deleted: each is now the file's **control** — a complete (respectively, a
> hoist-requiring) envelope must get PAST validation and trip the wire, proving
> the seven negatives are not green because the validator refuses everything
> (F-14). Their stronger form — that the hoisted `actorPrincipal` actually lands
> on the blob Redis stores, and that the blob hash-verifies — already exists on
> real Redis in `park-deferred-intent-nx-hash.test.ts`.

**`__tests__/audit-2026-05-24/defer-resume-integrity.test.ts` — attempted,
reverted, blocked by the SAME class as F-22, and this generalizes it.** The
migration was written and run. All 3 cases died:

```
UnroutedRedisCall: [in-memory-redis] unrouted call: evalIncrCheck
  at parkDeferredIntent (@adjudicate/runtime/src/defer-park.ts:231)
  at parkDeferredIntentWithNxGuard (src/adapters/park-nx.ts:270)
```

`@adjudicate/runtime`'s `parkDeferredIntent` does
`if (typeof args.redis.evalIncrCheck === "function")` — a **feature detection on
an optional atomic command**. Against the retired plain-object double the
property read yields `undefined` and the code takes its non-atomic
INCR→EXPIRE→check→DECR fallback. Against the canonical adapter the property read
goes through the throw-on-unrouted **Proxy**, so `typeof` itself throws and the
park dies outright.

**The general rule this establishes, which is bigger than either file:** the
adapter's throw-on-access Proxy is structurally incompatible with
`typeof client.X === "function"` feature detection. F-22 was recorded as being
about `releaseNxPlaceholder`'s `eval` detect; there is at least a **second**
site, in the framework's park path, and it fails *differently* — F-22 degrades
silently, `evalIncrCheck` throws uncaught. Any module that feature-detects an
optional Redis command cannot receive this adapter unmodified, and the fix is
not to add the command: `evalIncrCheck` is a Lua script, so emulating it is the
W4 RULE 3 theater this adapter exists to refuse. Whatever ruling settles F-22
should settle the feature-detect class as a whole, not one call site.

> **RESOLVED — migrated to the testcontainer harness in Phase 5.** F-22 settled
> the feature-detect class exactly as this paragraph asked: the probe is not
> defeated, it is made deterministic at the composition root, so
> `createParkRedisCapabilities()` always carries `evalIncrCheck` and the
> `typeof` read cannot throw. But a deterministic probe does not make an
> in-memory home honest — `evalIncrCheck` is Lua, and the rule this paragraph
> ends on ("the fix is not to add the command") still holds. So the substrate
> moved instead: the file is now on `setupRedisTestContainer`, parks through the
> production factory, and is enrolled in the M0 roll call at 3 cases. Its three
> audit-chain assertions are unchanged in substance; what changed under them is
> that the park's quota claim is a real `EVAL`, the resolver's release is a real
> compare-and-delete, and the blob the file reads back is bytes Redis stored.
> Two fictions died with the stub: the faked `test:` `rk` (the real one resolves
> to `development:` here — this section's own bonus measurement), and the
> missing release EVAL. The tamper case's in-place blob edit is re-expressed as
> a real `SET … KEEPTTL`, so the tamper is still at REST.

### Map after R5-S12, updated by Phase 5

| Bucket | Count |
|---|---|
| Owner-gated, class (i) — eval-emulating | 7 |
| ~~Owner-gated, class (i-b) — remaining~~ | ~~2 (`defer-resume-integrity`, `park-nx-hoist` — both feature-detect-blocked)~~ → **0** |
| Refused — leaf-purity edge | 1 |
| Migrated (R5-S8/S9) | 3 |
| Migrated (R5-S12) | 4 |
| Resolved (Phase 5) | 2 — `defer-resume-integrity` to the container; `park-nx-hoist` retained as a unit test with a refusing typed double |
| **Enumerated population** | **17** |

Class (i-b) is now **empty**: items 8–10 and 12 were migrated by R5-S12, and
items 11 and 13 by Phase 5. The whole owner-gated remainder of the enumerated
population is class (i) — the 7 eval-EMULATING doubles, which M2 retires onto
the shape suites.

> **M3 CORRECTION — "empty" is true of the DOUBLES, not of the MECHANISM, and
> the enumeration was the wrong place to look.** Two things this paragraph
> gets wrong if read quickly:
>
> 1. **Items 8, 9, 10 and 12 still reach a Lua site and still have that release
>    refused.** R5-S12 retired their hand-rolled doubles for the canonical
>    adapter, whose `eval` throws `LuaAtomicityNotEmulated` — so the SUT still
>    reaches the site, the release still fails, and `releaseDeferResumingLock`
>    still swallows it. M3 measured this rather than reasoning about it: a
>    temporary `console.error` in that helper's catch counted **1 / 1 / 2**
>    refused releases in items 9 / 10 / 12 respectively. What changed in R5-S12
>    is that the refusal is now BY DESIGN (W4 RULE 3) instead of accidental,
>    and item 8 turns it into a declared, tested bound. The invariant lives in
>    M1's CAD shape suite plus M2's `expectResumingLockReleased()`; three more
>    containers would buy no new signal (Q2), so M3 left all four alone.
> 2. **The one genuinely open row was never in this table.** It was filed under
>    class (iii) as "Already real Redis" — `sweeper-resolver-race.test.ts`,
>    F-37. Classifying by "what kind of double is it?" put a container-backed
>    file out of scope, when the property that matters is "does the SUT's Lua
>    actually execute?". A file can wear a container and still be class (i-b);
>    see the F-37 entry below.
>
> The M3 sweep that established this looked at the right axis: of the 22
> container-backed suites in `apps/api`, exactly ONE wrapped its container in a
> `@ibatexas/tools` mock that mentions `eval` nowhere. The class-(i-b)
> population wearing a container was, and is, bounded at one.

The `redisFake` cluster (12) is untouched and still owner-gated on `multi()`.

---

## R5 rollout, family 1 — the cart/session cluster

Measured on branch `refactor/r5-rollout-cart-family`, rebased onto
`dev @ 7875c459` (PR #523 landed mid-slice; the suite was re-measured on
the new base — branch-local baseline **7421**, after **7433**, delta **+12**,
which is exactly the per-file arithmetic below).
R5-S12's correction 1 recorded `routes/cart.ts` as the top-3 direct caller (10
call sites) and `session/store.ts` in class (c). This section threads that
family and records what the threading did and did NOT buy.

### The family, enumerated BEFORE editing

The rule applied: a module is in the family iff it is (a) reachable from
`routes/cart.ts` AND (b) issues a Redis command AND (c) belongs to the same
deps flow. Three modules qualify — 14 call sites.

| Module | Sites | Commands issued | Seam taken |
|---|---|---|---|
| `routes/cart.ts` | 10 | `hGetAll` `expire` `multi` `hSet` `hDel` `del` `get` `set` | `CartRouteDeps.redis: () => Promise<CartRouteRedisClient>` — the route root R5-S2/S5 already built, extended by its own lazy-factory idiom |
| `routes/checkout-confirmation-store.ts` | 2 | `set`, `eval` | `CheckoutConfirmationStoreOptions.redis` — a client RESOLVER, because `cartRoutes` builds the store in its synchronous register phase and an instance would hoist the resolution |
| `session/store.ts` | 2 | `lRange`, `multi` | `SessionStoreOptions.client` per entry point — the R5-S6 `estimate-delivery.ts` shape, NOT the route root (see the exclusion note) |

**Excluded, with the measurement that decides each:**

- `claustrum/resolve-and-assemble.ts` (3 sites). Cart-reachable in name only:
  BOTH `loadCartCtx` calls in `routes/cart.ts` pass `{ cartId }`, and the
  module's Redis branch is guarded by `cartId === null && sessionId !== undefined`.
  The site is **unreachable from this family**. It is also R3 territory.
- `packages/tools/src/cart/get-or-create-cart.ts` (1 site + the F-21
  `acquireLockAtKey` lock). Post-F-21 it still resolves the package singleton
  itself (`getRedisClient()` at line 148) and takes no client. It is NOT
  reachable from `routes/cart.ts` at all — its callers are `routes/chat.ts`,
  `routes/whatsapp-webhook.ts` and the tool registry, i.e. a different
  composition flow. Threading it belongs to whichever family owns those roots.

### What the threading is, in one line each

- `CartRouteDeps.redis` is a FACTORY returning a promise, so every one of the 10
  sites keeps its `await` exactly where it was — including the two inside
  swallowing `try/catch`es, and including `trackCartId`'s own resolution, which
  is deliberately NOT collapsed into the caller's client (the resolution COUNT
  is asserted).
- Per-consumer `Pick`s: `CartOwnershipRedis` (`get`/`set`), `ActiveCartsRedis`
  (`hSet`/`expire`), `UntrackCartRedis` (`hDel`), `PixCacheReadRedis`
  (`hGetAll`/`expire`), `PixCacheWriteRedis` (`multi`), `CartOwnerReleaseRedis`
  (`del`), plus the hand-written exhaustive `CartRouteRedisClient` (9 commands).
  The union is hand-written rather than derived as an intersection of the
  consumer types: a derived union cannot disagree with its consumers, so it
  could not catch a consumer that grew an undeclared command (F-14).
- The store moved from a MODULE const to a registration-scoped one built off
  `deps.redis`. Construction stays IO-free, so the register→ready structure is
  unchanged and `await app.ready()` still resolves zero clients — pinned as a
  test, not asserted in prose.

### The fail-closed pick analysis (R5-S12's lesson, applied)

**Feature detection: MEASURED, none.** No `typeof client.X === "function"`
exists anywhere in the three modules, so the class that made `evalIncrCheck`
degrade silently does not occur here.

**Swallowing consumers: TWO, and they are the real hazard.**
`loadCachedPixDetails` (`catch { return null }`) and
`cachePixDetailsForCustomer` (`catch { console.warn }`, `void`-ed at the call
site) turn a client that cannot serve them into a cache miss, not an error.
Measured: un-threading `loadCachedPixDetails` alone reds THREE cases, one of
which — "falls back to the customer service when Redis has no cache" — reds
because the DB fallback lives INSIDE the same try block, so a Redis fault takes
the customer lookup down with it. Every other consumer awaits with no catch.

### The metric — vi.mock of `getRedisClient` in the family: 5 → 1

| File | Before | After | Reason |
|---|---|---|---|
| `routes/__tests__/cart-uncovered-handlers.test.ts` | 9-command constant double | **`createInMemoryRedis` + spy-delegate**; `getRedisClient` is a rejecting TRIPWIRE | driven paths reach neither `multi` nor `eval` — asserted, not assumed |
| `__tests__/session-store.test.ts` | whole-module `vi.mock` | **`vi.mock` DELETED**; double injected through `SessionStoreOptions`, real `rk` | double still hand-rolled: `appendMessages` is `multi`-only and the adapter has no `lRange` either |
| `__tests__/checkout-confirmation-store.test.ts` | whole-module `vi.mock` | **`vi.mock` DELETED**; eval-emulating double injected through the store's option, real `rk` | `consume` is Lua — W4 RULE 3, the adapter refuses `eval` |
| `routes/__tests__/cart-pix-details-envelope.test.ts` | supplied the client | injected through `deps.redis`; `getRedisClient` is a TRIPWIRE | `multi` is the subject's ONLY Redis touch |
| `__tests__/cart-routes.test.ts` | supplied the client | injected through `deps.redis`; `getRedisClient` is a TRIPWIRE | drives the park→confirm round trip, i.e. `eval` |

Counted as "the module mock still SUPPLIES a Redis client", the family goes
**5 → 1** — and the one that remains (`cart-routes.test.ts`) supplies it only
because `routes/cart.ts` imports `getRedisClient` as its own default and the
factory must return something. Counted as "still emulates a W4-refused command
somewhere", it is **4 → 3**: `multi` and `eval` are unchanged owner-gated
ground, and this slice does not claim otherwise.

Three fictions died on the way: the `ibatexas:` `rk` in four files (production
under apps/api's vitest writes `development:`); the `set`→"OK" constant that
made every ownership claim succeed; and a cross-suite LEAK in
`cart-routes.test.ts`, where two describes reached Redis on a double installed
by an earlier describe (`vi.clearAllMocks()` does not clear implementations).

The `redisFake` cluster (12) and the class (i) seven are untouched.

---

## R5 rollout, family 2 — the jobs / subscribers / shared-lib class (d)

Measured on branch `refactor/r5-rollout-jobs-family`, off `dev @ b1ebbe70`.
This section enumerates **all of class (d)** and threads a bounded sub-family of
it. Read the census before the slice: the enumeration is the deliverable, the
threading is a bounded first cut at it.

### Reconciliation against Correction 1

Correction 1 records class (d) as **21 files** (`jobs/*` ×15, `subscribers/*`
×5, `lib/defer-resuming-lock.ts`). Re-derived here with the same grep, from
`apps/api/src`, excluding `__tests__`:

| Directory | Expected | Measured | Agrees |
|---|---|---|---|
| `jobs/*` | 15 | 15 | YES |
| `subscribers/*` | 5 | 5 | YES |
| `lib/defer-resuming-lock.ts` | 1 | 1 | YES |

**21 reproduced, no correction needed.** The per-file call-site counts are new
(Correction 1 gave only the class total), and they sum to **44 runtime
`getRedisClient()` calls** — 26% of the 167 in the whole direct-caller
population, in 34% of its files.

### The full class-(d) enumeration

`Deps?` = the module already accepts an injected client.

| # | File | Sites | Commands issued | Deps? | Class |
|---|---|---|---|---|---|
| 1 | `jobs/abandoned-cart-checker.ts` | 1 | hScan exists ttl hDel get hGet hSet **(+ lRange downstream)** | no → **YES** | **(i) THREADED** |
| 2 | `jobs/anonymize-medusa-retry.ts` | 1 | set **eval** (CAD) | no | (ii) owner-gated — Lua |
| 3 | `jobs/defer-timeout-sweeper.ts` | 2 | scanIterator get ttl del; reaches CAD via `lib/defer-resuming-lock` | no | (ii) owner-gated — Lua |
| 4 | `jobs/dlq-depth-checker.ts` | 1 | scanIterator lLen | YES | already threaded (inline bag) |
| 5 | `jobs/escalation-park-expiry-sweeper.ts` | 1 | scanIterator get exists | YES | already threaded (`SweeperRedis`) |
| 6 | `jobs/follow-up-poller.ts` | 1 | zRangeByScore zRem | no → **YES** | **(i) THREADED (family 3)** |
| 7 | `jobs/hesitation-nudge.ts` | 2 | get del / set | no → **YES** | **(i) THREADED** |
| 8 | `jobs/observability-liveness-checker.ts` | 1 | incr expire del | YES | already threaded (inline bag) |
| 9 | `jobs/outbox-retry.ts` | 1 | set **eval** (CAD) lRange lRem | no | (ii) owner-gated — Lua |
| 10 | `jobs/pix-expiry-monitor.ts` | 3 | get / set / get+set | no → **YES** | **(i) THREADED** |
| 11 | `jobs/proactive-engagement.ts` | 1 | exists hGetAll set incr expire | no → **YES** | **(i) THREADED** |
| 12 | `jobs/reservation-reminder.ts` | 1 | set | no → **YES** | **(i) THREADED** |
| 13 | `jobs/review-prompt-poller.ts` | 1 | zRangeByScore zRem get **multi** | no | (ii) owner-gated — `multi` |
| 14 | `jobs/review-prompt.ts` | 1 | **multi** | no | (ii) owner-gated — `multi` |
| 15 | `jobs/weather-helper.ts` | 1 | get set | no → **YES** | **(i) THREADED** |
| 16 | `subscribers/cart-intelligence.ts` | 14 | get set del expire hGet hSet hDel hIncrBy hKeys scan zRem **multi** | no | (ii) owner-gated — `multi` |
| 17 | `subscribers/dedup.ts` | 4 | set del | no → **YES** | **(i) THREADED (family 3)** |
| 18 | `subscribers/defer-resolver.ts` | 3 | get set del incr decr scanIterator | YES | already threaded (R5-S12) |
| 19 | `subscribers/dlq.ts` | 1 | lPush lTrim expire | no → **YES** | **(i) THREADED (family 3)** |
| 20 | `subscribers/incident-notification-subscriber.ts` | 1 | set **(+ eval downstream via `atomicIncr`)** | no | (ii) owner-gated — Lua |
| 21 | `lib/defer-resuming-lock.ts` | 2 | set del **eval** (CAD) | YES | already threaded (R5-S12) |

**Arithmetic, files: 21 = 6 threaded + 3 deferred-migratable + 7 owner-gated +
5 already threaded.**

> **Superseded by family 3** (this file's last section): the three
> deferred-migratable rows — items 6, 17 and 19 — are all threaded, so the
> current arithmetic is `21 = 5 already + 6 (family 2) + 3 (family 3) + 7
> owner-gated` and class (d) has ZERO migratable rows left. The table above is
> kept as #539's dated record; read the family-3 remainder map for the live one.
Rows: threaded 1,7,10,11,12,15 · deferred 6,17,19 · owner-gated 2,3,9,13,14,16,20 ·
already threaded 4,5,8,18,21.

**Arithmetic, call sites: 44 = 9 + 6 + 21 + 8**, in the same order —
(1+2+3+1+1+1) + (1+4+1) + (1+2+1+1+1+14+1) + (1+1+1+3+2).

Item 20 is worth reading twice, because the honest Pick is what CLASSIFIES it.
`incident-notification-subscriber.ts` issues exactly one command, `set`. A Pick
of `{set}` would compile. But it hands its client to
`atomicIncr(redis, key, ttl)` from `@ibatexas/tools`, which is an **`eval`** of
the INCR+EXPIRE script — so the honest Pick is `{set} ∪ {eval}`, the adapter
refuses `eval` (W4 RULE 3), and the file is owner-gated rather than a one-line
migration. Nothing in the module's own text says so.

### The bounded slice: the customer-outreach send-guard cluster (6 of 9)

Nine files were migratable now, which exceeds the ~8 bound, so the slice took
the highest-value coherent sub-family and left an exact remainder map.

**The membership rule**, stated before the enumeration: a background job whose
output is a customer-facing WhatsApp message (or the event that produces one),
where a **Redis key is the only thing suppressing a duplicate or unwanted
send**. Items 1, 7, 10, 11, 12, 15 qualify — 9 call sites. `weather-helper` is
in because `proactive-engagement` calls it and a family that threads one without
the other leaks its seam.

**Deferred, with the reason (3):**

| File | Sites | Blocked on |
|---|---|---|
| `jobs/follow-up-poller.ts` | 1 | adapter lacks `zRangeByScore` + `zRem`. Sorted-set RANGE semantics are the fiddliest addition of the three and belong with `review-prompt-poller` (item 13), which issues the same pair — except that one ALSO issues `multi`, so it is owner-gated. Modelling a zset range for one migratable caller is the next slice's call. |
| `subscribers/dlq.ts` | 1 | adapter lacks `lTrim`. The module's cap logic (`lPush` → `if (newLen > MAX_DLQ) lTrim`) is the only thing `lTrim` would serve, and it is exactly the kind of property worth pinning — deferred rather than rushed. |
| `subscribers/dedup.ts` | 4 | Adapter-complete (`set` NX/EX + `del`); no blocker. Excluded ONLY by the size bound — it is not in the outreach family (it guards every NATS subscriber), and it is the single highest-value remaining item in class (d): 4 call sites, a fail-CLOSED contract, and the widest blast radius in the class. It should lead the next slice. |

### The seams, and the Pick decision each one records

Named types throughout, following `SweeperRedis` (the stronger of the two in-repo
precedents) rather than the inline `readonly redis?: {...}` bag.

| Module | Type(s) | Pick = issued ∪ downstream |
|---|---|---|
| `weather-helper.ts` | `WeatherCacheRedis` | {get,set} ∪ ∅ |
| `reservation-reminder.ts` | `ReservationReminderRedis` | {set} ∪ ∅ |
| `hesitation-nudge.ts` | `NudgeProcessorRedis`, `MarkRepliedRedis` | {get,del} ∪ ∅ / {set} ∪ ∅ |
| `pix-expiry-monitor.ts` | `PixPaidReadRedis`, `PixPaidWriteRedis`, `PixExpiryProcessorRedis` | {get} / {set} / **{set} ∪ {get}** |
| `proactive-engagement.ts` | `OutreachRedis` | {exists,hGetAll,set,incr,expire} ∪ ∅ |
| `abandoned-cart-checker.ts` | `AbandonedCartRedis` | {hScan,exists,ttl,hDel,get,hGet,hSet} ∪ **{lRange}** |

**Two of the six carry a command the module never issues**, and both were found
by reading what the module hands the client TO — never from the module's own
text:

1. `processPixExpiry` declares `get` because it passes its client to
   `isPixPaid`. Without it the paid-check throws and a customer who already
   paid is told "O PIX expirou".
2. `checkAbandonedCarts` declares `lRange` because it passes its client to
   `session/store.ts`'s `loadSession`, whose own type is `Pick<…,"lRange">`.

Case 2 is the family's clearest instance of the R5-S12 rule and is **measured,
not argued**: the seam suite runs the sweep with a client whose `lRange` is
removed and nothing else, over two seeded idle carts. The sweep **resolves**
(BullMQ sees success), and **zero** `cart.abandoned` events are published — each
cart's throw is absorbed by `checkAbandonedCarts`' per-cart `try/catch` into a
log line. The naive Pick compiles, typechecks, passes tsc, and silently kills
the entire abandoned-cart pipeline.

**Feature detection: MEASURED, none.** `typeof … === "function"` was swept over
`apps/api/src/{jobs,subscribers,lib,session}` and `packages/tools/src`: zero
hits in this family's graph. The repo-wide production hits are the four already
known (two `unref` probes, one Prisma-delegate probe, one taint probe) plus the
`park-redis-capabilities.ts` comments describing F-22 — none reachable here.

**One resolution deliberately NOT collapsed.** `checkDormantCustomers` does not
hand its client to `fetchWeatherCondition`; each keeps its own seam and its own
default resolution. Folding them would drop the default path's singleton
resolutions from two to one — a behaviour change smuggled under a refactor. The
standing rule from family 1 (`trackCartId`), and it is pinned as a test.

### Adapter extension — two commands, each with a named consumer

`hScan` (consumer: item 1's `do…while (cursor !== 0)` walk) and `lRange`
(consumer: `loadSession`, reached THROUGH item 1). R5-S9 listed `lRange` as
"no consumer"; it has one now, and not by being issued — by being consumed
downstream. Both are modelled on the existing `scan` cursor-session design so a
field deleted mid-walk is never handed back, which is item 1's actual caller
pattern (`hDel` while iterating). 14 cases added to the adapter's own suite
(`packages/tools/src/catalog/__tests__/delivery-cache-seam.test.ts`, 50 → 64).

Still NOT added, each with a class-(d) caller enumerated above but none in this
family: `lTrim` `zRangeByScore` `zRem` `hIncrBy` `hKeys` `rPop` `lRem` `blPop`.

### The metric, and what it does NOT cover

**Doubles in the family that SUPPLY a Redis client: 4 → 0.**

| File | Before | After |
|---|---|---|
| `__tests__/jobs/weather-helper.test.ts` | 2-command constant double + faked `rk` (`test:`) | `createInMemoryRedis`, injected; `getRedisClient` is a rejecting TRIPWIRE; real `rk` |
| `__tests__/abandoned-cart-checker.test.ts` | 7 bare `vi.fn()`s + faked `rk` (`test:`) + whole-module mock of `session/store.js` | in-memory adapter injected; **`session/store.js` mock DELETED**; real `rk` |
| `jobs/__tests__/pix-expiry-monitor.test.ts` | hand-rolled Map double in 3 different shapes + faked `rk` (`ibatexas:`) | in-memory adapter injected; real `rk` |
| `__tests__/proactive-engagement.test.ts` | already the adapter, but installed OVER `getRedisClient` | injected through the seam; `getRedisClient` is a TRIPWIRE |

Three wrong-prefix `rk` fictions died: two `test:` and one `ibatexas:` — none of
which production has ever written (apps/api's vitest resolves `rk` to
`development:`).

**What this does NOT cover, stated as the bound:**

- **Zero new Lua coverage**, exactly as R5-S12's family bought none. Nothing in
  this family reaches an `eval`; the 7 owner-gated class-(d) files are untouched
  and remain gated on the real-Redis / `multi` decisions.
- **Two files in the family still mock `getRedisClient`** and were NOT migrated:
  `__tests__/sentry-background-jobs.test.ts` and
  `__tests__/jobs/cart-recovery-tiers.test.ts`. Both drive `checkAbandonedCarts`
  / `sendReminders` through the DEFAULT path, which the threading preserves
  exactly, so they pass unedited. They are constant-answering `vi.fn()` stubs
  (the `mockRedis` class), not behavioural doubles, and migrating them is a
  separate call.
- **The `mockRedis` metric (27) is unchanged**, for the fourth slice running.
- The `redisFake` cluster (12) and the class (i) seven are untouched.

### Remainder map for the next slice

| Bucket | n | Files |
|---|---|---|
| Migratable now, adapter-complete | 1 | `subscribers/dedup.ts` (4 sites) — **lead with this** — DONE in family 3 |
| Migratable, needs `lTrim` | 1 | `subscribers/dlq.ts` — DONE in family 3 |
| Migratable, needs `zRangeByScore`+`zRem` | 1 | `jobs/follow-up-poller.ts` — DONE in family 3 |
| Owner-gated — Lua (`eval`) | 4 | items 2, 3, 9, 20 |
| Owner-gated — `multi` | 3 | items 13, 14, 16 (item 13 also needs the zset pair) |
| Already threaded | 5 | items 4, 5, 8, 18, 21 |
| Threaded by this slice | 6 | items 1, 7, 10, 11, 12, 15 |
| **Total** | **21** | |

### Suite arithmetic

Branch-local `apps/api`, run FROM `apps/api` (the root config has no
`setupFiles` and false-reds the audit sink — a recorded trap):

| | Files | Tests |
|---|---|---|
| baseline (`dev @ b1ebbe70`) | 489 | 7617 passed, 3 skipped |
| after | 490 | 7650 passed, 3 skipped |
| **delta** | **+1** | **+33** |

Closes exactly, per file:

| File | Before | After | Δ |
|---|---|---|---|
| `jobs/__tests__/outreach-client-seam.test.ts` (NEW) | — | 24 | +24 |
| `__tests__/jobs/weather-helper.test.ts` | 12 | 13 | +1 |
| `__tests__/abandoned-cart-checker.test.ts` | 15 | 18 | +3 |
| `jobs/__tests__/pix-expiry-monitor.test.ts` | 19 | 23 | +4 |
| `__tests__/proactive-engagement.test.ts` | 25 | 26 | +1 |
| **sum** | | | **+33** |

`packages/tools` moves separately: the adapter's own suite
`src/catalog/__tests__/delivery-cache-seam.test.ts` goes **50 → 64 (+14)** for
the `hScan` and `lRange` additions.

**An exact TTL assertion needs an INJECTED clock, or it is a full-suite flake.**
Caught here, in this slice's own new tests, and worth recording because the
isolated run is GREEN. The adapter's `ttlMs` is `expiresAtMs - now()`; with the
default `Date.now`, milliseconds elapse between the module's SET and the test's
read, so `toBe(120_000)` reads back `119_868` under a loaded full-suite run
(measured: the case took 132ms). Three assertions were affected — the nudge
marker and both PIX TTLs — and all three now run on a frozen clock.

The weakening that is NOT the fix: `toBeGreaterThan(0)`. That is precisely the
fiction the migration killed (a double that "answered a truthy `1` and recorded
nothing" — R5-S9, item 16), and it cannot tell a 2-hour marker from a 2-second
one. The exact equalities are kept and proved non-vacuous by mutation: changing
the production TTLs by ONE SECOND (`EX: 120 → 121`, `EX: 7200 → 7201`) reds
exactly three cases.

### Revert-to-red, per seam, with per-assertion attribution

Each module's `deps.redis ?? (await getRedisClient())` was neutered to
`await getRedisClient()` one module at a time (copy-then-restore, never
`git checkout --` against uncommitted work), plus the two client HAND-OFFS
(`isPixPaid(…, { redis: deps.redis })` and `loadSession(…, { client: redis })`).

| Neutered | RED | of | The cases that did NOT flip |
|---|---|---|---|
| `weather-helper` | 2 | 3 | its default-fallback control |
| `reservation-reminder` | 2 | 3 | its default-fallback control |
| `hesitation-nudge` | 3 | 4 | its default-fallback control |
| `pix-expiry-monitor` | 3 | 4 | its default-fallback control |
| `proactive-engagement` | 3 | 4 | its default-fallback control |
| `abandoned-cart-checker` | 3 | 4 | its default-fallback control |
| the BullMQ wrapper (F-32 below) | 1 | 2 | the treatment arm |
| `assertDepsBag`'s body (F-32 below) | 1 | 2 | the control arm |
| **total (client seams)** | **16** | **22** | **6** |

The 6 that a seam-neutering cannot flip are exactly the six
*"resolves the singleton when NO client is threaded"* arms — they assert the
FALLBACK, so a neutered module (which always falls back) keeps them green by
construction. Counting them as seam evidence would be the recurring error;
they are the arms that make the other 16 non-vacuous, not evidence themselves.
Control run before and after: 22/22 green, 0 red.

**The seam suite caught an unwired seam on its first run**, which is the
cheapest available proof it is not vacuous: `markPixPaid` had its
`MarkPixPaidDeps` type declared but its body never rewired, and two cases went
red immediately.

### F-32 — a deps bag in a BullMQ processor's 2nd slot collides with the lock token

> **Cross-reference — read this before threading any BullMQ processor.** Every
> future R5 slice that gives a BullMQ processor a deps bag INHERITS this hazard,
> because the collision is BullMQ's calling convention, not any one job's bug.
> The guard and the full note live in `apps/api/src/jobs/queue.ts`
> (`assertDepsBag`); the registration pattern is the one-argument wrapper in
> `jobs/hesitation-nudge.ts` and `jobs/pix-expiry-monitor.ts`.

(Numbered F-32, not F-29: **F-29 was already assigned** — the owner's PR #535
census finding that `tenant_binding_violation` is both a refusal CODE and a
basis REASON, same string across two fields with two different guards. Unrelated
class; this one is renumbered to clear the collision.)

Found by threading, not by the census. Two of this family's entry points are
BullMQ processors: `processNudge` and `processPixExpiry`. `jobs/queue.ts` types
a processor as `(job) => Promise<void>`, but **BullMQ calls it as
`(job, token)`** with a lock-token STRING — exactly where the R5 seam shape puts
its `deps`.

Registering the processor bare therefore hands a string to `deps`. The failure
is **silent**: `("tok").redis` is `undefined`, the module falls back to the
singleton, and nothing observable changes — until someone destructures `deps`,
validates it, or makes the client required, at which point every queued nudge
and every PIX reminder breaks at once. It is the same shape as the R5-S12
Pick class: correct-looking code whose defect only surfaces on a later edit.

**Two dead ends, recorded because both look convincing and one was written and
believed:**

1. `expect(processor.length).toBe(1)`. **Vacuous** — a parameter with a DEFAULT
   does not count toward `Function.length`, so `processNudge(job, deps = {})`
   already has length 1. It passed GREEN against the bare registration.
2. "drive the registered processor with a token, assert the singleton was
   used." Also vacuous: that is what BOTH spellings do today.

**The fix makes the collision observable rather than merely commented.**
`assertDepsBag(command, deps)` in `jobs/queue.ts` throws a `TypeError` on a
non-object deps, and each registration site passes a one-argument wrapper. The
guard lives in the chassis, not in a job, because the hazard is BullMQ's.

Pinned as a control/treatment pair, each with its own revert-to-red:

| Arm | Asserts | Reds when |
|---|---|---|
| treatment | the BARE processor REFUSES a token | `assertDepsBag`'s body is neutered |
| control | what `startX()` REGISTERS survives a token | the wrapper is replaced by the bare processor |

Neither arm can be green for the other's reason: the treatment measures the
guard exists, the control measures production clears it.

**Scope of the fix.** Only the two processors this slice threaded carry the
guard, because only they have a second positional slot. Any future R5 slice that
threads a BullMQ processor inherits the same collision — `jobs/queue.ts` is
where to look.

---

## R5 rollout, family 3 — the DEDUP family (class (d)'s three migratable rows)

Measured on branch `refactor/r5-rollout-dedup-family`, off `dev @ bc250411`.
This slice executes the remainder map R5 family 2 (PR #539) left: **all three**
"migratable" rows, in that map's own priority order.

### What was shipped, and why all three

| # | File | Sites | Blocked on (per #539) | Shipped |
|---|---|---|---|---|
| 17 | `subscribers/dedup.ts` | 4 | nothing — excluded by the size bound | YES, and it LED |
| 19 | `subscribers/dlq.ts` | 1 | adapter lacked `lTrim` | YES |
| 6 | `jobs/follow-up-poller.ts` | 1 | adapter lacked `zRangeByScore` + `zRem` | YES |

The bound offered was "ship 1 and 2 and enumerate 3". All three shipped
because the zset pair turned out to be **less** fiddly than the map feared, and
for a reason worth recording: the only migrating caller
(`processFollowUps`) issues the plain 3-argument form `zRangeByScore(key, 0,
now)`. Every fiddly part of ZRANGEBYSCORE — `-inf`/`+inf`, the exclusive
`"(score"` spelling, and `LIMIT` — belongs to the OTHER caller
(`jobs/review-prompt-poller.ts`), which is owner-gated on `multi` and does not
run against this adapter at all. So the honest modelling job was small, and the
fiddly forms are **refused rather than approximated** (see below). Had they been
approximated, this slice would have shipped two rows.

### The seams, and the Pick decision each one records

Named types throughout, following `SweeperRedis` / the outreach family.

| Module | Type(s) | Pick = issued ∪ downstream |
|---|---|---|
| `subscribers/dedup.ts` | `DedupClaimRedis`, `DedupReleaseRedis`, `WithDedupRedis` | {set} / {del} / **{set} ∪ {set, del}** |
| `subscribers/dlq.ts` | `DlqRedis` | {lPush, lTrim, expire} ∪ ∅ |
| `jobs/follow-up-poller.ts` | `FollowUpPollerRedis` | {zRangeByScore, zRem} ∪ ∅ |

**One of the three carries a command its own body never issues**, and it was
found the way #539's rule says to find it — by reading what the function hands
its client TO, not by reading the function:

- `withDedup` issues exactly one command, `set`. A Pick of `{set}` compiles,
  typechecks, and passes. But `withDedup` HANDS its client to `releaseClaim`
  (`del`) on the handler-throw path and to `markProcessed` (`set`) on the
  success path. The honest Pick is therefore `{set} ∪ {set, del} = {set, del}`,
  and the `del` is the one a naive reading drops. The consequence of dropping
  it is not a crash: `releaseClaim`'s body is wrapped in its own `try {} catch
  {}` ("best-effort — the in-flight TTL guarantees the claim eventually
  expires"), so a missing `del` is **swallowed**, the claim stands, and the
  event that just FAILED is suppressed for the full 5-minute in-flight window
  with the suite green. Same shape as #539's `lRange` finding, in a
  fail-closed module.

The other two hand their client to nothing: `pushToDlq`'s only non-Redis edge is
Sentry, and the poller's only hand-off is the PARSED member, to
`publishNatsEvent`. Both verified by reading the callees.

**A hand-off that is NOT a client hand-off, recorded because it looks like one.**
`withDedup(eventKey, handler)` invokes `handler()` with **no arguments**. The
handler is the caller's closure and resolves its own client; nothing of
`withDedup`'s client reaches it. So the subscriber layer's Redis usage — which
is large — is NOT downstream of this Pick. Checked at the call sites (11
`withDedup` / `isNewEvent` sites across `cart-intelligence`, `fiscal-emitter`,
`incident-subscriber`, `ingredient-depletion`, `payment-lifecycle`,
`handoff-subscriber`, `audit-consumer`, `incident-notification-subscriber`),
not inferred from the signature.

**Feature detection: MEASURED, none.** `typeof … === "function"` was swept over
`apps/api/src/{subscribers,jobs,lib}` and `packages/tools/src`: the only hit in
those trees is a COMMENT in `jobs/weather-helper.ts` describing the F-22 rule.
Zero live probes in this family's graph.

### Adapter extension — three commands, each with a named consumer

| Command | Named consumer | What the modelling has to get right |
|---|---|---|
| `lTrim` | `subscribers/dlq.ts`'s cap | WHICH END survives. LPUSH puts the newest at the head, so `lTrim(key, 0, cap-1)` keeps the NEWEST. A tail-keeping implementation satisfies `expect(lTrim).toHaveBeenCalledWith(key, 0, 999)` exactly and leaves ops paging on week-old failures. |
| `zRangeByScore` | `jobs/follow-up-poller.ts`'s due window | The upper bound is INCLUSIVE. An exclusive one leaves the entry that is due exactly now in the set on every tick, forever. |
| `zRem` | the same poller's drain | The COUNT. A constant `1` cannot tell a real removal from a member the poller never held — which is what "published twice" looks like from the drain side. |

`lTrim` also DELETES the key when the trim leaves nothing, and preserves the
list's TTL (both real-Redis behaviours, both pinned); `zRem` deletes the key when
the last member goes.

**Three forms are REFUSED rather than approximated**, all on `zRangeByScore`,
and the refusal is the reason this row was shippable at all:

- `"-inf"` / `"+inf"` — `Number("-inf")` is `NaN`, so a coercing implementation
  matches nothing and reads exactly like an empty due window.
- the exclusive `"(score"` spelling — worse, because it LOOKS numeric after a
  strip, so a wrong answer would be plausible.
- `LIMIT` — its only in-repo caller is `jobs/review-prompt-poller.ts`
  (`{ LIMIT: { offset: 0, count: BATCH_CAP } }`), owner-gated on `multi`.
  Ignoring a batch cap would hand a caller the WHOLE due set while its own test
  asserted a bounded one.

Still NOT added, each with a class-(d) caller but none in this family:
`rPop` `lRem` `blPop` `hIncrBy` `hKeys`.

### The metric, and what it does NOT cover

**Doubles in the family that SUPPLY a Redis client: 3 → 0.**

| File | Before | After |
|---|---|---|
| `__tests__/subscribers/dedup.test.ts` | 2 constant `vi.fn()`s (`set → "OK"`, `del → 1`) + faked `rk` (`test:`) | adapter, spy-delegated + injected; `getRedisClient` is a rejecting TRIPWIRE; real `rk` |
| `__tests__/subscribers/dlq.test.ts` | 3 constant `vi.fn()`s, with `lPush` PLANTING the length the cap branches on + faked `rk` (`test:`) | adapter, spy-delegated + injected; the list really grows past the cap; TRIPWIRE; real `rk` |
| `__tests__/jobs/follow-up-poller.test.ts` | 2 constant `vi.fn()`s (`zRangeByScore` per-case, `zRem → 1`) + faked `rk` (`development:` — a coincidence, not a fact) | adapter, spy-delegated + injected; entries SEEDED with `zAdd`; TRIPWIRE; real `rk` |

Two more wrong-prefix `rk` fictions died (`test:` ×2). The third file's fake
happened to AGREE with the real `rk`, which is the more dangerous shape — a
coincidence recorded as a fact, the same class R5-S8 found in `audit-consumer`.

**The spy-delegate is what kept the diff small.** Each command is a `vi.fn()`
that FORWARDS to the adapter, so every existing `toHaveBeenCalledWith` /
`toHaveBeenNthCalledWith` survives unedited while the keyspace becomes real. (A
plain object of spies, not a wrapped Proxy: the adapter's client is a Proxy and
has no spyable own properties.) All three files kept their case counts exactly:
10 → 10, 5 → 5, 5 → 5.

**Three fictions killed, named:**

1. `dlq.test.ts` PLANTED `lPush → 1003` so the list never grew. Nothing in that
   file could distinguish a cap that keeps the newest from one that keeps the
   oldest. The over-cap case now seeds 1002 real entries and lets the 1003rd
   push trip the cap, then reads the survivors back.
2. `follow-up-poller.test.ts`'s "does not publish entries that are not due" was
   `zRangeByScore → []`. That is indistinguishable from a poller that reads
   nothing at all. The case now seeds a genuinely FUTURE entry and asserts it is
   still scheduled afterwards.
3. `dedup.test.ts`'s duplicate case relied on `set → null` as a constant, so NX
   never ran against a keyspace. It now writes a REAL prior claim first.

**What this does NOT cover, stated as the bound:**

- **Zero new Lua coverage.** Nothing in this family reaches an `eval`. The 7
  owner-gated class-(d) files are untouched.
- **The producer of the follow-up zset is NOT driven.**
  `packages/tools/src/intelligence/schedule-follow-up.ts` resolves its client
  through a RELATIVE import inside the built package (`../redis/client.js`), so
  a `vi.mock("@ibatexas/tools")` — a mock of the package SPECIFIER — cannot
  reach it. The seam suite therefore seeds the zset by hand in the producer's
  shape, and the producer/consumer agreement rides on two independent
  assertions of the same key literal (`schedule-follow-up.test.ts` pins
  `development:follow-up:scheduled`; the seam suite reads the real `rk`), NOT on
  a driven path. This is the "parity contracts need BOTH real paths" class and
  it is OPEN here; a `deps` bag on `scheduleFollowUp` would close it and is the
  cheapest next step.
- **`__tests__/sentry-background-jobs.test.ts` still mocks `getRedisClient`**
  and was NOT migrated: it drives `processFollowUps` through the DEFAULT path,
  which the threading preserves exactly, so it passes unedited. It is a
  constant-answering `vi.fn()` stub (the `mockRedis` class), not a behavioural
  double.
- **The `mockRedis` metric (27) is unchanged**, for the fifth slice running.
- The `redisFake` cluster (12) and the class (i) seven are untouched.

### F-32 — this family's one BullMQ processor, and why the collision is NOT live

`jobs/follow-up-poller.ts` is a BullMQ job, so #539's cross-reference applies.
The measurement: **the collision is not live, and the guard is what keeps that
true.** What `startFollowUpPoller` registers is a ONE-ARGUMENT wrapper
(`(_job: Job) => processFollowUps()`), so BullMQ's `(job, token)` call puts the
token nowhere. `processFollowUps(log, deps)` is the function with a deps bag in
its second slot, and it is not what is registered.

`assertDepsBag("follow-up-poller", deps)` was added anyway, because "not
registered directly" is a property of one line that a future edit can silently
undo — and the failure would be silent in exactly #539's way (`("tok").redis` is
`undefined`, every tick falls back to the singleton, nothing observable
changes). It is pinned as the same control/treatment pair:

| Arm | Asserts | Reds when |
|---|---|---|
| treatment | `processFollowUps` REFUSES a token in its deps slot | `assertDepsBag`'s body is neutered |
| control | what `startFollowUpPoller()` REGISTERS survives a token | the wrapper is replaced by the bare `processFollowUps` |

The two recorded dead ends still hold and were not re-attempted:
`processor.length === 1` is VACUOUS (a defaulted parameter does not count toward
`Function.length`), and "drive it with a token and assert the singleton was
used" is vacuous because both spellings do that today.

`jobs/queue.ts` gained NO new code — `assertDepsBag` already existed. Three of
the repo's BullMQ processors now carry it.

### The fail-CLOSED contract, stated and pinned directionally

`dedup.ts`'s contract is the reason it led this slice, so the pin says what the
contract IS before proving it:

> **Fail closed here means: if the CLAIM cannot be taken (Redis unreachable),
> the handler does NOT run and a typed `DedupUnavailableError` propagates.** The
> alternative — fail OPEN — is every replica running the side effect unguarded.
> It is scoped to phase 1 only: a PROMOTE failure (phase 3) is deliberately
> swallowed, because the handler has already succeeded.

Three arms, because the load-bearing assertion is a NEGATIVE one:

1. the guarded direction — under a client whose `set` rejects, the handler is
   never called and the rejection is a `DedupUnavailableError`;
2. its control, **in the same test** — the SAME handler, under a working client,
   DOES run. Without it "handler not called" is satisfied by a `withDedup` that
   never calls handlers at all;
3. the scope — a promote failure resolves `true` with the handler having run,
   and leaves the marker at the SHORT TTL. So "fail closed" stays a scoped claim
   rather than a slogan about the module.

A fourth arm pins the contrast that makes the typed error meaningful:
`isNewEvent` PROPAGATES the raw Redis error and is asserted NOT to be a
`DedupUnavailableError` — wrapping it would silently change every staff-alert
call site's error handling.

### Clock discipline

Every TTL assertion in this slice is an EXACT equality on a FROZEN clock
(`createInMemoryRedis({ now: () => FROZEN })`), never `toBeGreaterThan(0)` —
which is the fiction R5-S9 found in the audit spill and cannot tell a 7-day
dedup window from a 7-second one. Non-vacuity is proved by MUTATION rather than
asserted: see the mutation rows in the revert-to-red table.

### Revert-to-red, per seam, with per-assertion attribution

Each seam's `deps.redis ?? (await getRedisClient())` was neutered to
`await getRedisClient()` one at a time, plus the two client HAND-OFFS
(`releaseClaim(eventKey, deps)` and `markProcessed(eventKey, deps)`).
Copy-then-restore throughout — never `git checkout HEAD --` (which errors on an
untracked file and leaves the neutering in place) and never `git stash` (shared
across worktrees). Every restore was verified BY CONTENT against the pre-mutation
bytes; `jobs/queue.ts` came back byte-identical and does not appear in the
slice's diff.

The population is the 43 cases this slice owns: 23 in the new seam suite + 10 +
5 + 5 in the three migrated files.

| Neutered | RED | of 43 |
|---|---|---|
| `dedup.isNewEvent` | 6 | |
| `dedup.markProcessed` | 10 | |
| `dedup.releaseClaim` | 2 | |
| `dedup.withDedup` | 11 | |
| hand-off `withDedup → markProcessed` | 8 | |
| hand-off `withDedup → releaseClaim` | 2 | |
| `dlq.pushToDlq` | 8 | |
| `follow-up-poller.processFollowUps` | 9 | |
| **total (client seams + hand-offs)** | **56** | |
| F-32 treatment — `assertDepsBag`'s body neutered | 1 | |
| F-32 control — bare registration replaces the wrapper | 1 | |

**The 4 cases that no seam-neutering can flip are exactly the four
*"resolves the singleton when NO client is threaded"* arms.** They assert the
FALLBACK, so a neutered module — which always falls back — keeps them green by
construction. They are what makes the other 56 non-vacuous; counting them as
seam evidence would be the recurring error, so they are EXCLUDED above. Verified,
not assumed: none of the four appears in any of the eight red lists.

Control run before and after the whole sweep: **43/43 green, 0 red.**

The F-32 arms are disjoint by construction, and measured so: neutering
`assertDepsBag` reds ONLY the treatment; registering `processFollowUps` bare reds
ONLY the control. Neither arm can be green for the other's reason.

### Non-vacuity of the EXACT equalities — proved by MUTATION

The exact-TTL and cap-property assertions are only worth their comments if a
one-unit change reds them. Measured, each mutation applied and reverted alone:

| Mutation | RED | What it proves |
|---|---|---|
| `NATS_DEDUP_TTL` 604_800 → 604_801 | 6 | the 7-day dedup window is pinned to the second, in both the two-phase promote and the single-phase claim |
| `NATS_INFLIGHT_TTL` 300 → 301 | 5 | the 5-minute claim is pinned separately — the two TTLs cannot cover for each other |
| `DLQ_TTL` 604_800 → 604_801 | 3 | the DLQ's 7 days is pinned, including after a trim |
| adapter `lTrim` keeps the TAIL instead of the head | 3 | the cap keeps the NEWEST entries |
| adapter `zRangeByScore` upper bound made EXCLUSIVE | 1 | an entry due exactly now is drained |

The `lTrim` row is the one worth reading twice, because it is the property the
#539 remainder map asked for rather than a call assertion. A tail-keeping LTRIM
preserves the list's LENGTH exactly, so every count assertion is invariant under
it — which is why the survivors are read back BY IDENTITY (`["e5","e4","e3"]`,
and `ids[0] === "newest"` at the default cap) rather than by `lLen`. The
`expect(lTrim).toHaveBeenCalledWith(key, 0, 999)` assertion the pre-slice file
carried is likewise invariant under it: the call is identical, only the surviving
elements differ.

### Suite arithmetic

Branch-local `apps/api`, run FROM `apps/api` (the root config has no
`setupFiles` and false-reds the audit sink — a recorded trap):

| | Files | Tests |
|---|---|---|
| baseline (`dev @ bc250411`) | 488 | 7659 passed, 3 skipped |
| after | 489 | 7682 passed, 3 skipped |
| **delta** | **+1** | **+23** |

Closes exactly, per file:

| File | Before | After | Δ |
|---|---|---|---|
| `subscribers/__tests__/dedup-family-client-seam.test.ts` (NEW) | — | 23 | +23 |
| `__tests__/subscribers/dedup.test.ts` | 10 | 10 | 0 |
| `__tests__/subscribers/dlq.test.ts` | 5 | 5 | 0 |
| `__tests__/jobs/follow-up-poller.test.ts` | 5 | 5 | 0 |
| **sum** | | | **+23** |

The three zeroes are the point: the spy-delegate let every migrated file keep
its exact case list while its double became real, so the +23 is entirely NEW
coverage rather than a reshuffle.

`packages/tools` moves separately: the adapter's own suite
`src/catalog/__tests__/delivery-cache-seam.test.ts` goes **64 → 84 (+20)** for
`lTrim` (7), `zRangeByScore` (8) and `zRem` (5). Package totals 74 files,
1099 → 1119 tests.

### Remainder map after this slice — class (d) has NO migratable rows left

| Bucket | n | Files |
|---|---|---|
| Migratable now | **0** | — |
| Owner-gated — Lua (`eval`) | 4 | items 2, 3, 9, 20 |
| Owner-gated — `multi` | 3 | items 13, 14, 16 (item 13 also issues the zset pair, which the adapter now HAS — `multi` is its only remaining blocker) |
| Already threaded (pre-R5-rollout) | 5 | items 4, 5, 8, 18, 21 |
| Threaded by family 2 (#539) | 6 | items 1, 7, 10, 11, 12, 15 |
| Threaded by family 3 (this slice) | 3 | items 6, 17, 19 |
| **Total** | **21** | |

**Arithmetic, files: 21 = 0 + 4 + 3 + 5 + 6 + 3.**
**Arithmetic, call sites: 44 = 8 + 9 + 6 + 21**, in the order
already-threaded / #539 / this slice / owner-gated —
(1+1+1+3+2) + (1+2+3+1+1+1) + (1+4+1) + (1+2+1+1+1+14+1).

One row changed CLASS, not just status: **item 13,
`jobs/review-prompt-poller.ts`, is now blocked on `multi` ALONE.** Its
`zRangeByScore` + `zRem` are in the adapter as of this slice — but it issues
`zRangeByScore(key, 0, now, { LIMIT: { offset: 0, count: BATCH_CAP } })`, and
the adapter REFUSES the `LIMIT` option deliberately. So if the owner's `multi`
decision ever unblocks it, modelling `LIMIT` is the follow-on adapter work, and
it must model the cap rather than ignore it.

**The class-(d) migration line ends here.** Every remaining row is gated on the
same two owner decisions — real Redis (testcontainers) for the Lua paths, and a
design answer for `multi` — not on adapter coverage. No further adapter command
unblocks any of the seven.

### What is still open, and where the next slice should look

Class (d) is exhausted, so the R5 rollout's next population is elsewhere. In
priority order, with what each is blocked on:

1. **`scheduleFollowUp` has no seam** (`packages/tools/src/intelligence/schedule-follow-up.ts`).
   This is the open half of THIS slice's one un-closed bound: the follow-up
   zset's producer cannot be driven from an apps/api test because it resolves
   its client through a relative import inside the built package. A deps bag on
   it turns the producer/consumer agreement from two independent assertions of
   the same literal into one driven path. Cheapest available win, and it closes
   a "parity contracts need BOTH real paths" gap rather than opening a new one.
2. **The `redisFake` cluster (12 files)** — unchanged, class (i), owner-gated on
   `multi`/`eval` for the same reason as items 13/14/16.
3. **The `mockRedis` metric (27)** — unchanged for the fifth slice running, and
   still exhausted per R5-S7: it names constant-answering `vi.fn()` stubs, not
   behavioural doubles.

---

## R5 rollout, family 4 — the me / order-actions route family

Measured on branch `refactor/r5-rollout-auth-me-family`, off `dev @ 2da48fd3`.
This slice was briefed as **`auth.ts` + `order-actions.ts` + `me.ts` +
`analytics.ts` (21 call sites)**, with the note that all four had been verified
to contain no `eval` and no `multi`. That verification is correct about each
module's OWN text and **wrong about two of the four**, for the reason #539
recorded as the rule. Read the classification finding first — it is the
deliverable; the threading is what was left after it.

### THE FINDING — `auth.ts` and `analytics.ts` are Lua-gated

Both import `atomicIncr` from `@ibatexas/tools` and hand it their client:

| File | Sites | Hand-off | Lines |
|---|---|---|---|
| `routes/auth.ts` | 10 | `atomicIncr(redis, key, ttl)` ×3 | 99, 106, 120 |
| `routes/analytics.ts` | 1 | `atomicIncr(redis, key, 60)` ×1 | 72 |

`atomicIncr` (`packages/tools/src/redis/atomic-rate-limit.ts:24`) is an **`eval`**
of the INCR + conditional-EXPIRE Lua — one of the two Rate-limit sites in the
production inventory above. So:

- the honest Pick for `auth.ts` is `{get, set, del} ∪ {eval}`, not `{get, set, del}`;
- the honest Pick for `analytics.ts` is `∅ ∪ {eval}` — its ONLY Redis use is the
  hand-off, so a Pick derived from what it calls is EMPTY;
- the in-memory adapter refuses `eval` (W4 RULE 3), so **neither file is
  migratable**. They join items 2, 3, 9 and 20 in the owner-gated-on-Lua bucket
  and belong with the M-phases.

Nothing in either module's own text says this. `auth.ts` reads as ten plain
`get`/`set`/`del` sites across eight small helpers; a Pick of what it issues
compiles, typechecks and passes the suite. This is the **third** measured
instance of the class (#539 `incident-notification-subscriber`, #543
`withDedup`'s `del`), and the first where it changed which files a briefed slice
could ship.

**The `analytics.ts` composition-root question is therefore moot.** The brief
asked whether its missing root was trivial enough to add in-slice. It does not
matter: with `eval` in its honest Pick, a root would thread a client the adapter
cannot serve. Building one would have been work whose only product is a type
that nothing can satisfy.

### What shipped, and why this pair

**Shipped: `routes/me.ts` (3 sites) + `routes/order-actions.ts` (5 sites) = 8.**

The two are a coherent family on the same rule the earlier slices used: a
`requireAuth`-gated customer-plane route with an existing R5-S5 composition root
whose entire Redis surface — after the hand-it-to analysis — is adapter-servable.
Both use Redis for exactly one job: **counters that cap an attempt**, plus one
profile cache. The brief's suggested fallback pair (`auth.ts` + `me.ts`, "the
customer-identity surface") is not shippable, because half of it is Lua-gated.

### The seams, and the Pick decision each one records

| Module | Type(s) | Pick = issued ∪ downstream |
|---|---|---|
| `routes/me.ts` | `ProfileCacheRefreshRedis`, `ProfileUpdateRateRedis`, `PendingDeletionClearRedis`; union `MeRouteRedisClient` | {hSet,expire} / {get,set} / {del} ∪ **∅** |
| `routes/order-actions.ts` | `OrderActionRateLimitRedis`, `PaymentRetryCapRedis`; union `OrderActionRouteRedisClient` | {incr,expire} / {get,incr,expire} ∪ **∅** |

**The downstream half is EMPTY in both, and that is a measurement.** Every
`redis` occurrence in both files was read (not just the eight call sites): each
site binds the client to a handler-local `const` and issues every command on it
directly. No site passes `redis` to anything.

**Two callees LOOK like client hand-offs and are NOT** — the #543
negative-measurement rule, applied and reported rather than assumed:

- **`withLock(resource, fn, ttlSeconds)`** (`me.ts` ×2, and the whole
  `stripe-webhook.ts` family) takes **no client** and invokes `fn()` with **no
  arguments**. It resolves its own client per command through `packages/tools`'
  `singletonLockClient`. Its release IS a CAD `eval` — so a reader who stops at
  "me.ts reaches a Lua site" would gate the file. It is not downstream of this
  Pick, and `me.ts` is migratable because of that.
- **`getParkRedisCapabilities()`** (`me.ts`, the DEFER park path) is F-22's own
  composition root and returns a `ParkRedisCapabilities`, not this seam's
  client. Collapsing the two would drag `eval` + `evalIncrCheck` into
  `MeRouteRedisClient` for zero gain.

**One resolution deliberately NOT collapsed, and it decides a file's class.**
`order-actions.ts` builds `createOrderCancelConfirmationStore()` in its plugin
body; the store resolves its own client and its `consume` is the single-use
CONSUME **Lua**. `routes/cart.ts` made the opposite choice for its sibling
checkout store — which is exactly why `CartRouteRedisClient` carries `eval`.
Threading it here would have moved `order-actions.ts` into the owner-gated
bucket. **The Pick boundary is what keeps the file migratable**, and a future
slice that threads that store must RE-CLASSIFY the file rather than widen a type.

**Feature detection: MEASURED, none.** `typeof … === "function"` was swept over
`apps/api/src` and `packages/tools/src`. Zero live Redis probes in this family's
graph: `packages/tools/src` has none at all, and the 11 `apps/api` hits are SIX
comments describing the F-22 rule (`park-redis-capabilities.ts` ×2, `park-nx.ts`,
`subscribers/dedup.ts`, `jobs/weather-helper.ts`, `routes/cart.ts`) plus FIVE
non-Redis probes — two `unref` timer probes (`plugins/kernel-bootstrap.ts:758`,
`claustrum/agent-trigger-bridge.ts:360`), a Prisma-delegate probe
(`claustrum-bootstrap.ts:3097`), a taint probe (`claustrum-bootstrap.ts:1404`)
and a thenable probe (`plugins/kernel-metrics-sink.ts:412`).

### Adapter extension — NONE

Both unions are covered by commands the adapter already models
(`get`/`set`/`del`/`incr`/`expire`/`hSet`). `packages/tools` is untouched by this
slice; its suite does not move.

### The metric, and what it does NOT cover

**Doubles in the family that SUPPLY a Redis client: 9 → 8.**

Nine test files mock `getRedisClient` while driving these two routes. Exactly one
of the nine emulates `eval`.

| File | Class | Disposition |
|---|---|---|
| `routes/__tests__/order-actions-notes-amend-payment.test.ts` | constant `vi.fn()` | **RETIRED** — adapter injected through `deps.redis`; `getRedisClient` is a rejecting TRIPWIRE; real `rk`. 24 → 24 cases. |
| `__tests__/me-routes.test.ts` | **class (i)** — Map-backed + `eval` | owner-gated. Its double emulates the anonymize CAD and the OTP-lockout Lua; migrating it is the M-phase question, not this slice's. |
| `__tests__/order-cancel-governance.test.ts` | constant | unblocked, not migrated |
| `__tests__/order-amend-governance.test.ts` | constant | unblocked, not migrated |
| `__tests__/payment-retry-regen-governance.test.ts` | constant | unblocked, not migrated |
| `__tests__/order-address-type-governance.test.ts` | constant | unblocked, not migrated |
| `__tests__/payment-method-switch-governance.test.ts` | constant | unblocked, not migrated |
| `__tests__/order-cancel-refund.test.ts` | constant | unblocked, not migrated |
| `__tests__/anonymize-empty-customerid.test.ts` | constant | unblocked, not migrated |

The seven "unblocked, not migrated" all drive these handlers through the DEFAULT
path, which the threading preserves exactly, so they pass unedited. They are
constant-answering stubs (the `mockRedis` class), and each is now a one-file
migration that needs no further seam work — the honest statement is that this
slice made them retireable and retired one.

**Two fictions killed in the one that was retired:**

1. `incr` answered a constant `1` and recorded nothing, so the rate-limit
   counter never counted. The 429 case had to PLANT its own answer
   (`mockRedisIncr.mockResolvedValueOnce(6)`) — which passes identically against
   a counter that is write-only, i.e. against the fail-OPEN direction the counter
   exists to prevent. It now seeds five real increments and lets the sixth trip.
2. `rk` was faked to `ibatexas:` — a prefix production has never written (under
   apps/api's vitest the real `rk` resolves to `development:`). The same
   `ibatexas:` fiction survives in `me-routes.test.ts`, which is owner-gated.

**What this does NOT cover, stated as the bound:**

- **Zero new Lua coverage.** Nothing threaded here reaches an `eval`. The two
  files this slice re-classified (`auth.ts`, `analytics.ts`) are untouched and
  remain gated on the real-Redis decision, as do `me.ts`'s Lua NEIGHBOURS
  (`me/anonymize-otp-gate.ts`, `me/anonymize-active-lock.ts`) and
  `order-actions.ts`'s cancel-confirmation store.
- **The class-(i-b) mechanism is exercised, not closed.** The pending-deletion
  seam case drives a handler whose `finally` releases the anonymize mutex with a
  CAD `eval` against the singleton. The adapter refuses it, the module's
  documented best-effort `catch` swallows the refusal, the mutex is never
  released, and the case is GREEN — the same shape R5-S12 measured for
  `defer:resuming:*`. The case says so in its own comment rather than being
  surprised by it.
- **The `mockRedis` metric (27) is unchanged**, for the sixth slice running.
- The `redisFake` cluster (12) and the class (i) seven are untouched.

### Clock discipline

Every TTL assertion in the new suite is an EXACT remaining lifetime on a FROZEN
clock (`createInMemoryRedis({ now: () => FROZEN })`) — `600_000` for the
cancel/amend windows, `3_600_000` for PIX regeneration, `PROFILE_TTL_SECONDS *
1000` for the profile cache. Never `toBeGreaterThan(0)`: the four caps here do
NOT share a window, and an exact equality is the only assertion that can tell a
10-minute cap from a 1-hour one.

### Revert-to-red, per seam, with per-assertion attribution

Each site's `await deps.redis()` was neutered to `await getRedisClient()` one at
a time. Copy-then-restore throughout — never `git checkout HEAD --` (errors on an
untracked file and leaves the neutering in place) and never `git stash` (shared
across worktrees). Both files were verified byte-identical after every restore.
`order-actions.ts`'s three `OrderActionRateLimitRedis` sites carry IDENTICAL
text, so the mutation is line-targeted; a text-matched sed would have neutered
all three at once and inflated every row.

Population: the 42 cases this slice owns — 18 in the new seam suite + 24 in the
retired-double file.

| Neutered seam | RED | Attribution |
|---|---|---|
| `me.ts` `ProfileCacheRefreshRedis` | 1 | the cache-refresh injected case |
| `me.ts` `ProfileUpdateRateRedis` | 2 | the get/set case + the directional cooldown case |
| `me.ts` `PendingDeletionClearRedis` | 1 | the seam-boundary case |
| `order-actions.ts` cancel cap | 2 | the count case + the directional 429 |
| `order-actions.ts` amend BATCH cap | 8 | 7 in the retired-double file (the TRIPWIRE fires) + the shared-bucket case |
| `order-actions.ts` amend cap | 7 | 5 in the retired-double file + shared-bucket + directional |
| `order-actions.ts` payment-retry cap | 2 | the GET-projection case + the directional money path |
| `order-actions.ts` pix-regen cap | 2 | the count case + the directional 429 |
| **total** | **25** | |

**The 6 cases that no seam-neutering can flip are exactly the six *"with no
deps.redis … the SINGLETON"* arms.** They assert the FALLBACK, so a neutered
route — which always falls back — keeps them green by construction. They are what
makes the other 25 non-vacuous; counting them as seam evidence would be the
recurring error, so they are EXCLUDED above. Verified, not assumed: no red list
contains a `[default arm` title.

Control run before and after the whole sweep: **green, 0 red**, both files
restored byte-identical.

The amend rows are the ones worth reading twice. Neutering EITHER amend seam reds
cases in the retired-double file, because that file now injects through
`deps.redis` and its `getRedisClient` is a rejecting tripwire — which is the
cheapest available proof that the migration is load-bearing rather than
decorative.

### A trap this slice paid for — `vi.resetModules()` counterfeits a broken seam

The seam suite deliberately carries NO `vi.resetModules()` in `afterEach`, and
the omission is load-bearing. The sibling seam suites have one because they
re-register BullMQ processors per case. Here it destroys the audit-sink singleton
that `apps/api`'s `setupFiles` initialises ONCE, so every adjudicated write after
the first case 500s.

The failure is a **perfect counterfeit of a broken seam**: it reds exactly the
INJECTED cases and leaves every singleton-fallback arm green — because those arms
assert on the decoy's call log rather than on a 200. Ten cases failed this way and
every one of them named a seam property in its title. Same family as the recorded
"read the error CLASS first" trap; recorded here so the next slice does not spend
the same hour.

### Suite arithmetic

Branch-local `apps/api`, run FROM `apps/api` (the root config has no `setupFiles`
and false-reds the audit sink — a recorded trap):

| | Files | Tests |
|---|---|---|
| baseline (`dev @ 2da48fd3`) | 496 | 7802 passed, 3 skipped |
| after | 497 | 7820 passed, 3 skipped |
| **delta** | **+1** | **+18** |

Closes exactly, per file:

| File | Before | After | Δ |
|---|---|---|---|
| `routes/__tests__/me-order-actions-client-seam.test.ts` (NEW) | — | 18 | +18 |
| `routes/__tests__/order-actions-notes-amend-payment.test.ts` | 24 | 24 | 0 |
| `routes/__tests__/me-route-deps-seam.test.ts` | 4 | 4 | 0 |
| `routes/__tests__/order-actions-route-deps-seam.test.ts` | 3 | 3 | 0 |
| **sum** | | | **+18** |

The three zeroes are the point: the retired double kept its exact case list while
its keyspace became real, and the two pre-existing R5-S5 deps-seam suites gained
`redis` as a rejecting TRIPWIRE member plus one assertion on an existing case
(*"the Redis resolver is per-REQUEST, so registration must not call it"*) rather
than a new case. `packages/tools` does not move: no adapter command was added.

### Remainder map — `routes/*` class (c), all 19 files / 67 call sites

| Bucket | n | Files (sites) |
|---|---|---|
| Threaded — family 1 (#524) | 2 | `cart.ts` (6), `checkout-confirmation-store.ts` (2) |
| **Threaded — family 4 (this slice)** | **2** | **`me.ts` (3), `order-actions.ts` (5)** |
| **Owner-gated — Lua via the `atomicIncr` HAND-OFF (found by this slice)** | **3** | **`auth.ts` (10), `analytics.ts` (1), `whatsapp-webhook.ts` (4)** |
| Owner-gated — Lua in the module's own text | 5 | `me/anonymize-otp-gate.ts` (16), `me/anonymize-active-lock.ts` (2), `order-cancel-confirmation-store.ts` (2), `admin/admin-confirmation-store.ts` (4), `admin/payments.ts` (2) |
| **Migratable now, adapter-complete — LEAD THE NEXT SLICE** | 3 | `admin/delivery-zones.ts` (1), `admin/orders.ts` (1), `admin/products.ts` (1) — all three issue the SAME idempotency-dedup `set(key,"1",{EX:300,NX:true})` and nothing else. One coherent 3-site family. |
| Migratable, pending the hand-off read | 3 | `stripe-webhook.ts` (2), `chat.ts` (2), `admin/analytics.ts` (1) |
| Needs an adapter command first | 1 | `health.ts` (2) — issues `ping`, which the adapter does not model, plus `lLen`, which it does |
| **Total** | **19** | **67 sites** |

**Arithmetic, files: 19 = 2 + 2 + 3 + 5 + 3 + 3 + 1.**
**Arithmetic, call sites: 67 = 8 + 8 + 15 + 26 + 3 + 5 + 2**, in the same order —
(6+2) + (3+5) + (10+1+4) + (16+2+2+4+2) + (1+1+1) + (2+2+1) + 2.

Three notes for whoever takes the next slice:

1. **`whatsapp-webhook.ts` is newly classified here, not previously known.** It
   hands its client to `atomicIncr` at three sites (699, 972, 981) and also calls
   `getOrCreateCart`, whose F-21 `acquireLockAtKey` is a lock. Same class as
   `auth.ts`; it was not in this slice's brief and would have been mis-scoped the
   same way.
2. **`stripe-webhook.ts` is NOT gated by its `withLock` calls.** The negative
   measurement above applies to it directly: `withLock` takes no client and
   invokes `fn()` with no arguments. Its own two `getRedisClient()` sites need the
   standard read, but the three `withLock` sites are not a reason to gate it —
   which is the trap a name-based sweep falls into.
3. **The three admin dedup routes are the cheapest remaining win in class (c)**
   and share one command shape, so they are a family rather than three errands.

---

## R5 rollout, family 5 — the ADMIN DEDUP family

Measured on branch `refactor/r5-rollout-admin-dedup-family`, off `dev @ ee5490f1`.
Briefed as the three routes #548's remainder map named "migratable now,
adapter-complete": `admin/delivery-zones.ts`, `admin/orders.ts`,
`admin/products.ts`, on the claim that *all three issue the SAME idempotency-dedup
`set(key,"1",{EX:300,NX:true})` and nothing else*.

### Family verification vs the remainder map's claim — CONFIRMED, exactly

Re-derived rather than trusted. Every `redis` occurrence (case-insensitive) in
each file was read, not just the call sites the map counted:

| File | `getRedisClient()` calls | Redis commands issued | `eval`/`multi`/`evalSha` | `atomicIncr`/`withLock`/`acquireLock` |
|---|---|---|---|---|
| `admin/delivery-zones.ts` | 1 (:38) | `set` ×1 (:39) | none | none |
| `admin/orders.ts` | 1 (:208) | `set` ×1 (:210) | none | none |
| `admin/products.ts` | 1 (:127) | `set` ×1 (:129) | none | none |

All three literally issue `SET <rk'd key> "1" {EX:300, NX:true}` and nothing
else. **The map's claim is accurate on every axis it asserted** — the first
briefed family in this rollout for which that is true (compare family 4, where
2 of the 4 briefed files turned out Lua-gated). 3 files, 3 sites, one shape.

### The HAND-IT-TO read (#548's rule), and its NEGATIVE half

The rule that caught the governor in #548 is "read what the module hands the
client TO, not only what it calls". Applied here:

**The downstream half of every Pick is EMPTY.** In all three files the client is
bound to a local `const` and its single command issued on it directly; no site
passes `redis` to anything. So `{issued} ∪ {optionally consumed downstream}` =
`{set}` for each.

**Three callees LOOK like they could carry a client. The negative measurement,
reported rather than assumed:**

| Callee | File | Verdict |
|---|---|---|
| `invalidateDeliveryCache()` | delivery-zones | **ACCEPTS a client — and is called with ZERO arguments** at all 3 sites, so it resolves its own singleton. Not downstream of this Pick. See the boundary note below. |
| `medusaAdjudicated({...})` | products | Takes NO client. `MedusaAdjudicatedArgs` has no Redis member, and `packages/tools/src/medusa/adjudicated.ts` issues no Redis command at all — `adjudicate()` is pure and the file's three "Redis"/"ledger" mentions are comments. |
| `commandSvc.transitionStatusFromEnvelope(envelope)` | orders | Envelope only. `createOrderCommandService(log, {auditSink, authGuards})` has no Redis member. (`medusaAdmin` is HTTP; `publishNatsEvent` is NATS; `getAuditSink()` takes no arguments.) |

**No file in this family reaches Lua by any route** — not in its own text, not
through a hand-off. `atomicIncr` is imported by none of the three.

### The one client-ACCEPTING callee, and why the boundary stays

`invalidateDeliveryCache(options?: DeliveryCacheOptions)` accepts
`options.client: Pick<RedisClientType, "get"|"set"|"scan"|"del">`. This is a
DIFFERENT shape from #548's `withLock` negative (which takes no client at all)
and from `order-actions.ts`'s CONSUME store (whose `eval` would have
re-classified the file). Here the boundary is a SCOPE call, not a
classification one — threading it would stay safe, because its commands are
`scan`/`del` with no Lua. It is left out for two reasons:

1. It already HAS its own client seam and its own suite
   (`packages/tools/src/catalog/__tests__/delivery-cache-seam.test.ts`).
   Threading it from the route would give one path two composition roots.
2. **Filed for whoever does thread it:** its body is a bare
   `try { … } catch { /* Best-effort */ }`. That is the #539 swallowing shape
   exactly. A Pick derived from what the ROUTE issues would leave `scan`
   absent, the TypeError would be absorbed by that catch, and the delivery
   cache would silently never be invalidated — green. The honest Pick for that
   future slice is `{set, scan, del}`, not `{set}`.

### The seams, and the Pick decision each one records

| Module | Type(s) | Pick = issued ∪ downstream | Composition root |
|---|---|---|---|
| `admin/delivery-zones.ts` | `ZoneDedupRedis`; union `DeliveryZoneRouteRedisClient` | {set} ∪ **∅** | NEW (`DeliveryZoneRouteDeps`, redis-only) |
| `admin/orders.ts` | `StatusDedupRedis`; union `AdminOrderRouteRedisClient` | {set} ∪ **∅** | EXISTING R5-S5 `AdminOrderRouteDeps` + a 5th member |
| `admin/products.ts` | `ProductDedupRedis`; union `AdminProductRouteRedisClient` | {set} ∪ **∅** | NEW (`AdminProductRouteDeps`, redis-only) |

Each union is hand-written rather than derived from its per-consumer type — a
derived union can never disagree with its consumer, so it could not catch a
consumer that grew a command nobody declared (F-14).

Both new roots are `redis`-only on purpose: the Medusa collaborators
(`medusaAdmin`, `medusaAdjudicated`) and the delivery-zone service are a
separate seam question and are untouched, so nothing about this slice changes
what those two files construct or when.

**Feature detection: MEASURED, none.** `typeof … === "function"` swept over
`apps/api/src` and `packages/tools/src`. `packages/tools/src` has none at all;
the `apps/api` hits are SIX comments describing the F-22 rule
(`park-redis-capabilities.ts` ×2, `park-nx.ts`, `subscribers/dedup.ts`,
`jobs/weather-helper.ts`, `routes/cart.ts`) plus FIVE non-Redis probes (two
`unref` timer probes, a Prisma-delegate probe, a taint probe, a thenable
probe). Reproduces #548's measurement exactly.

### Adapter extension — NONE

All three unions are `{set}`, which the adapter already models with full
`EX`/`NX` semantics (`in-memory-redis.ts:455-489`: `NX` with an existing key
returns `null`, and `EX` records a real TTL against the injected clock).
`packages/tools` is untouched by this slice; its suite does not move.

### The fail-CLOSED contract, stated and pinned DIRECTIONALLY

These are the double-submit gates for every mutating admin write in the three
files. The direction that matters is therefore FAIL-OPEN: a `set` that answers
"OK" and records nothing turns the gate into no gate, while every happy path
stays green. That is not hypothetical — it is precisely the fiction in all
three pre-existing suites, whose double is
`{ set: vi.fn().mockResolvedValue("OK") }` and whose duplicate arms PLANT the
verdict (`mockResolvedValue(null)`). Both arms pass identically against a
write-only gate.

So each module's directional case submits the SAME `x-request-id` TWICE against
a real NX keyspace and requires three things together:

1. the second response is 409,
2. the underlying MUTATION ran exactly ONCE (`create` /
   `transitionStatusFromEnvelope` / `medusaAdjudicated` — the property the gate
   exists for; a 409 alone is satisfied by a route that refuses everything), and
3. a CONTROL **in the same test** — a different `x-request-id` — that must get
   through, which is what rules out "refuses everything".

### Clock discipline

Every TTL assertion is an EXACT remaining lifetime on a FROZEN clock
(`createInMemoryRedis({ now: () => FROZEN })`): `300_000` ms, the `EX: 300` all
three sites share. Never `toBeGreaterThan(0)` — it cannot tell a 5-minute
replay window from a 5-second one, and a 5-second one is a dedup gate that
stops nothing.

### The metric — doubles in the family that SUPPLY a Redis client: 3 → 2

| File | Class | Disposition |
|---|---|---|
| `routes/admin/__tests__/delivery-zones.test.ts` | constant `vi.fn()` | **RETIRED** — adapter injected through `deps.redis`; `getRedisClient` is a rejecting TRIPWIRE; real `rk`. 14 → 14 cases. |
| `routes/admin/__tests__/orders-routes.test.ts` | constant | unblocked, not migrated |
| `routes/admin/__tests__/products-routes.test.ts` | constant | unblocked, not migrated |

The two "unblocked, not migrated" drive their handlers through the DEFAULT
path, which the threading preserves exactly, so they pass unedited. Each is now
a one-file migration needing no further seam work.

**Two fictions killed in the one that was retired:**

1. **The verdict was PLANTED.** `createMockRedis(null)` made SET NX answer
   "already exists" without anything ever having existed, at all three action
   arms (create / update / delete). They now seed the reservation through the
   SAME command the route issues and let real NX semantics produce the null.
   The fresh-id arm's `expect(redis.set).toHaveBeenCalledWith(...)` — which a
   write-only gate satisfies — became `peek(key) === "1"` plus an exact
   `ttlMs(key) === 300_000`.
2. **`rk` was faked to `ibatexas:`** — a prefix production has never written
   (under apps/api's vitest the real `rk` resolves to `development:`). The same
   `ibatexas:` fiction survives in `orders-routes.test.ts` and
   `products-routes.test.ts`, which are unblocked but not migrated.

**What this does NOT cover, stated as the bound:**

- **Zero new Lua coverage.** Nothing threaded here reaches an `eval`, and no
  owner-gated file was re-classified in either direction.
- **The delivery-cache invalidation stays unseamed from the route.** The
  retired double still replaces `invalidateDeliveryCache` with a `vi.fn()` —
  honest, because the route `void`s it and it resolves its own client, but it
  means "the cache was invalidated" is still a call assertion in that file.
- **The `mockRedis` metric (27) is unchanged**, for the seventh slice running.
- The `redisFake` cluster (12) and the class (i) seven are untouched.

### Revert-to-red, per seam, with per-assertion attribution

Each site's `await deps.redis()` / `await resolveRedis()` was neutered to
`await getRedisClient()` one at a time. Copy-then-restore throughout — never
`git checkout HEAD --` (errors on an untracked file and leaves the neutering in
place) and never `git stash` (shared across worktrees). All three files were
verified BYTE-IDENTICAL by `diff` against their snapshots after every restore,
and an `RTR-NEUTERED` marker grep over `apps/api/src` returns nothing.

Population: the 25 cases this slice owns — 11 in the new seam suite + 14 in the
retired-double file.

| Neutered seam | RED | Attribution |
|---|---|---|
| `delivery-zones.ts` `ZoneDedupRedis` | 7 | 3 in the seam suite (reservation+TTL, directional, per-action key) + 4 in the retired double (the TRIPWIRE fires: 3 duplicate arms + the fresh-id arm) |
| `orders.ts` `StatusDedupRedis` | 2 | reservation+TTL + the directional transition-once case |
| `products.ts` `ProductDedupRedis` | 2 | reservation+TTL + the directional egress-once case |
| **total** | **11** | |

Control run before and after the whole sweep: **green, 0 red.**

**Four cases no seam-neutering can flip, and why they are EXCLUDED rather than
counted:**

- **THREE are the *"[default arm] with no deps.redis … the SINGLETON"* arms**,
  one per module. They assert the FALLBACK, so a neutered route — which always
  falls back — keeps them green by construction. They are what makes the other
  11 non-vacuous; counting them as seam evidence would be the recurring error.
  Verified, not assumed: no red list above contains a `[default arm` title.
- **ONE is the *"with NO x-request-id the gate is skipped entirely"* case.** It
  is NOT a fallback arm — it is a guard-SHAPE property: the guard returns
  before resolving any client, so no client-threading mutation can reach it. It
  earns its place by pinning the early return as observable (without it, "the
  gate wrote a key" is compatible with a gate that writes one for every
  request), but it is not seam evidence and is not counted.

The `delivery-zones` row is the one worth reading twice. Neutering that seam
reds cases in the RETIRED double, because that file now injects through
`deps.redis` and its `getRedisClient` is a rejecting tripwire — the cheapest
available proof that the migration is load-bearing rather than decorative.

### Suite arithmetic

Branch-local `apps/api`, run FROM `apps/api` (the root config has no
`setupFiles` and false-reds the audit sink — a recorded trap):

| | Files | Tests |
|---|---|---|
| baseline (`dev @ ee5490f1`) | 497 | 7821 passed, 3 skipped |
| after | 498 | 7832 passed, 3 skipped |
| **delta** | **+1** | **+11** |

Closes exactly, per file:

| File | Before | After | Δ |
|---|---|---|---|
| `routes/admin/__tests__/admin-dedup-client-seam.test.ts` (NEW) | — | 11 | +11 |
| `routes/admin/__tests__/delivery-zones.test.ts` | 14 | 14 | 0 |
| `routes/admin/__tests__/orders-routes.test.ts` | 23 | 23 | 0 |
| `routes/admin/__tests__/products-routes.test.ts` | 6 | 6 | 0 |
| `routes/admin/__tests__/orders-route-deps-seam.test.ts` | 1 | 1 | 0 |
| **sum** | | | **+11** |

The zeroes are the point: the retired double kept its exact case list while its
keyspace became real, and the pre-existing R5-S5 deps-seam suite gained `redis`
as a rejecting TRIPWIRE member plus one assertion on its existing case (*"the
Redis resolver is per-REQUEST, so registration must not call it"*) rather than a
new case. `packages/tools` does not move: no adapter command was added.

### The counterfeit-signal trap, carried forward not re-paid

The new seam suite deliberately carries NO `vi.resetModules()`, and says so in
its own `afterEach`. #548 recorded this at ~10 red cases of diagnosis cost:
resetting modules drops the audit-sink singleton that `apps/api`'s `setupFiles`
initialises ONCE, so every adjudicated write after the first case 500s — a
PERFECT counterfeit of a broken seam, reddening exactly the injected cases and
leaving every fallback arm green. Not re-encountered here, because the warning
was read first.

### Remainder map — `routes/*` class (c), all 19 files / 67 call sites

| Bucket | n | Files (sites) |
|---|---|---|
| Threaded — family 1 (#524) | 2 | `cart.ts` (6), `checkout-confirmation-store.ts` (2) |
| Threaded — family 4 (#548) | 2 | `me.ts` (3), `order-actions.ts` (5) |
| **Threaded — family 5 (this slice)** | **3** | **`admin/delivery-zones.ts` (1), `admin/orders.ts` (1), `admin/products.ts` (1)** |
| Owner-gated — Lua via the `atomicIncr` HAND-OFF | 3 | `auth.ts` (10), `analytics.ts` (1), `whatsapp-webhook.ts` (4) |
| Owner-gated — Lua in the module's own text | 5 | `me/anonymize-otp-gate.ts` (16), `me/anonymize-active-lock.ts` (2), `order-cancel-confirmation-store.ts` (2), `admin/admin-confirmation-store.ts` (4), `admin/payments.ts` (2) |
| Migratable, pending the hand-off read — **LEAD THE NEXT SLICE** | 3 | `stripe-webhook.ts` (2), `chat.ts` (2), `admin/analytics.ts` (1) |
| Needs an adapter command first | 1 | `health.ts` (2) — issues `ping`, which the adapter does not model, plus `lLen`, which it does |
| **Total** | **19** | **67 sites** |

**Arithmetic, files: 19 = 2 + 2 + 3 + 3 + 5 + 3 + 1.**
**Arithmetic, call sites: 67 = 8 + 8 + 3 + 15 + 26 + 5 + 2**, in the same order —
(6+2) + (3+5) + (1+1+1) + (10+1+4) + (16+2+2+4+2) + (2+2+1) + 2.

**Class (c) `routes/*` is now 7 of 19 files threaded (12 of 67 sites).** The
"migratable now, adapter-complete" bucket is EMPTY: every remaining migratable
file needs its hand-it-to read done first.

Three notes for whoever takes the next slice:

1. **`stripe-webhook.ts` is still NOT gated by its `withLock` calls** (#548's
   negative measurement stands: `withLock` takes no client and invokes `fn()`
   with no arguments). Its own two `getRedisClient()` sites need the standard
   read.
2. **`health.ts` needs `ping` on the adapter.** That is the one remaining
   adapter-extension request in class (c), and per the standing rule it needs a
   named production consumer — which `health.ts` itself is.
3. **`invalidateDeliveryCache` is a filed #539-class hazard**, not a resolved
   one. It accepts a client, swallows every error in a bare catch, and its
   honest Pick is `{set, scan, del}` — see the boundary note above before
   threading it from `admin/delivery-zones.ts`.
