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
| `apps/api/src/__tests__/park-deferred-intent-nx.test.ts` | **Already real Redis**, but gated on its **own** `REDIS_URL` check rather than the shared harness — so it skips wherever `REDIS_URL` is unset, which includes CI. |

### The remaining map, over this enumeration

**14 remaining = 13 owner-gated + 1 refused. Nothing actionable is left in it.**

| Bucket | Count | Files |
|---|---|---|
| Owner-gated, class (i) — eval-bearing atomicity theater | 7 | items 1-7 |
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

**One double left honest rather than "fixed".** The stub in
`adapters/__tests__/park-deferred-intent-nx-hoist.unit.test.ts` deliberately
does NOT carry `evalIncrCheck`/`compareAndDelete`, so the framework takes its
non-atomic branch *inside that unit test*. Adding in-memory versions would be
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

### Deliberately deferred with reason (2)

**`adapters/__tests__/park-deferred-intent-nx-hoist.unit.test.ts` — F-22.**
Migratable today (it already takes a client), but excluded by owner ruling: it
is F-22's site, and a naive migration silently routes `releaseNxPlaceholder`
down its unconditional-`del` branch — the unsafe path the F-22 ruling is about.
Waits on that ruling.

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

### Map after R5-S12

| Bucket | Count |
|---|---|
| Owner-gated, class (i) — eval-emulating | 7 |
| Owner-gated, class (i-b) — remaining | 2 (`defer-resume-integrity`, `park-nx-hoist` — both feature-detect-blocked) |
| Refused — leaf-purity edge | 1 |
| Migrated (R5-S8/S9) | 3 |
| Migrated (R5-S12) | 4 |
| **Enumerated population** | **17** |

The `redisFake` cluster (12) is untouched and still owner-gated on `multi()`.
