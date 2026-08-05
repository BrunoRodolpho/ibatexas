# Redis multi()/eval testing — the ruling

> **Decision (2026-08-04): Option A — testcontainers become the mandatory home
> for Lua-invariant coverage**, with the qualifications below. Option B (a
> standing exemption) is rejected. Decision produced under the owner's
> 2026-08-04 execution mandate; evidence base is
> `apps/api/src/__tests__/helpers/redis-double-census.md` (the census), which
> this doc deliberately does not restate.

## The question

The canonical in-memory Redis adapter refuses `eval` and `multi` by design
(W4 RULE 3: emulating atomicity primitives in a Map is theater — the test
asserts atomicity the double cannot provide). That refusal leaves ≥25 test
files owner-gated: 7 doubles that emulate Lua, 6 that omit it over Lua-reaching
paths, 12 whose `multi()` chains silently drop every queued write, plus the two
migrations deferred on the F-22 class. Production runs 20 Lua call sites across
8 script shapes — every distributed lock release, every confirmation-store
consume, both rate limiters.

## Why Option A

1. **The uncovered class provably produces real defects.** F-21 (constant-value
   lock, unconditional del) and both F-22 sites live exactly in the
   Lua-adjacent release paths that no current test can exercise. R5-S12
   measured the bound directly: after a fully green resume, the
   `defer:resuming:*` mutex is never released in the test universe — green
   tests are compatible with the hole. An exemption would document that our
   atomicity primitives are untested, in a codebase whose defect record shows
   that is where the defects are.
2. **Adoption is not a greenfield build.** The shared harness
   (`redis-testcontainer.ts`, `setupRedisTestContainer`) is in-tree, wired to
   the defer/park cluster, and green: ~1.2s wall per file with the
   `redis:7-alpine` image warm (census, "already works here").
3. **The cost objections are bounded and addressed by the qualifications
   below** rather than by rejecting the direction.

## Qualifications (binding on the migration)

- **Q1 — the CI silent-skip gap is a PRECONDITION, not a follow-up.** `ci.yml`
  provides no Redis service and no `REDIS_URL`; files gated on their own
  `REDIS_URL` check skip silently and report green today (census gap 2; the
  skipIf-binary class). Before any migration lands: CI gets a Redis service (or
  validated Docker on the runner), and the skip becomes LOUD — a gate that
  fails when the real-Redis suite count is zero. Routing coverage through real
  Redis without this ships theater at the CI boundary.

  > **SATISFIED by M0.** Mechanism: *validated Docker*, not a service
  > container — the shared harness starts its own `redis:7-alpine` per test
  > file, so a `services: redis:` block would sit unused; `ci.yml`'s existing
  > `docker info` probe is the provisioning, and the harness suites were in
  > fact already executing on it. The real gap was narrower and larger than
  > the census said: **five** files, not one, gated on their own
  > `REDIS_TEST_URL`, losing **12** real-Redis cases per CI run behind a green
  > ✓ (measured on dev @ `2f5c4979`; table in the census). All five are on the
  > shared harness now, leaving one knob — `IBX_SKIP_REAL_REDIS=1`, local-dev
  > only. The loud half is `scripts/check-real-redis-suites.mjs`, wired as its
  > own `ci.yml` step: a hand-written roll call of 9 suites / 27 cases that
  > drives them itself (a cached `turbo test` cannot certify them) and fails
  > when any executes fewer cases than enumerated — zero included.
- **Q2 — coverage is organized by SCRIPT SHAPE, not by file.** The 8 shapes in
  the census inventory each get ONE contract suite on the shared harness
  proving the shape's invariant against real Redis (CAD never releases a
  foreign owner; CONSUME is single-shot; the rate-limit window is atomic; …).
  Call sites then need only unit-level observation (spy-delegate proof that the
  site issues the right script with the right args) — they inherit the shape's
  invariant from the contract suite. 8 container suites, not 20.
- **Q3 — no new 100-iteration race suites.** `sweeper-resolver-race.test.ts`'s
  100× shape is the cost outlier (census gap 1), not the template. Race cases
  in shape suites use bounded iteration with the invariant asserted per
  iteration.
- **Q4 — the 12 `multi()` redisFake files get per-file dispositions,** not a
  blanket rule: a file whose assertions genuinely need transactional semantics
  migrates to the harness; a file that merely *happens* to observe through
  `multi` is refactored to non-transactional observation over the canonical
  adapter. The adapter itself never grows a non-atomic `multi` (W4 RULE 3
  stands, verbatim).
- **Q5 — sequencing with F-22.** The F-22 ruling (capabilities validated at the
  composition root; no runtime `typeof` feature-detection) defines the
  client-capability contract the migrated tests code against. Class-(i-b)
  migrations and the two deferred files land after it.
  **LANDED** (branch `fix/f22-capability-validation`): the contract is
  `ParkRedisCapabilities` + `createParkRedisCapabilities()` in
  `apps/api/src/adapters/park-redis-capabilities.ts` — a factory that proves the
  client carries the commands the path needs (throwing
  `RedisCapabilityUnavailableError` naming the missing ones) and returns a
  surface whose atomic members are REQUIRED. Migrated tests compose through it
  rather than hand-building a shim; the two real-Redis park suites already do,
  and the shape of their CAD contract suite (M1) is
  `apps/api/src/__tests__/park-nx-release-failure-mode.test.ts`. The policy is
  held repo-wide by
  `apps/api/src/__tests__/bypass-detection/redis-capability-detect-conformance.test.ts`.
  See the F-22 section of the census for the full record, including the
  platform-side follow-up this repo cannot make.

## What Option B would have bought, for the record

Zero CI changes and no container dependency — priced against a permanent blind
spot over all 20 production Lua sites, with the F-21/F-22 defect record as the
measured cost of that blind spot. Rejected.

## Migration plan and effort (post-finalization; do not start before Q1)

| Phase | Content | Est. slices |
|---|---|---|
| M0 | Q1: CI Redis service + loud-skip gate — **DONE** | 1 |
| M1 | The 8 script-shape contract suites — **DONE (8/8)** | 2–3 |
| M2 | Class (i): the 7 eval-emulating doubles retired onto shape suites + unit observation — **DONE (7/7)** | 2 |
| M3 | Class (i-b) bound cases + the two F-22-deferred migrations — **DONE** | 1 |
| M4 | The 12 `multi()` redisFake files, per-file disposition | 2–3 |

### M1 status — all 8 shapes covered

**Six shape suites written; two shapes found ALREADY SERVED by an existing
suite and left alone.** The six new suites add 86 executing cases to the M0 roll
call (61 → 147; 137 container-backed) and are the repo's FIRST shape suites:
every one of the 14 suites M0 enrolled is a SITE suite in Q2's sense, driving
one call site's production functions. Q2 estimated "8 container suites, not 20";
the actual cost was 6, because OTP-lockout and refund-cap are single-site shapes
whose site suite already IS the shape contract.

**The seam that makes Q2's inheritance real.** Q2 says call sites "inherit the
shape's invariant from the contract suite". That only holds if the contract
suite runs the bytes the site runs — otherwise a site could drop `== ARGV[1]`
tomorrow and every shape assertion would stay green, which is the ruling's own
green-lie shape one layer out. Only 3 of ~20 production script constants are
exported, and two sites have no constant at all (inline literals in the `eval()`
call), so importing them was not available. `apps/api/src/__tests__/helpers/lua-script-sources.ts`
reads each script out of its production source by a hand-written anchor and
throws on miss, ambiguity, or interpolation. The extractor is itself controlled:
the CAD suite requires its output to be byte-identical to the imported value for
all three exported constants.

| Shape | Sites | Status | Suite |
|---|---|---|---|
| CAD | **11** (not 10) | **DONE** | `lua-shape-cad-contract.test.ts` (27) |
| CONSUME | 4 | **DONE** | `lua-shape-consume-contract.test.ts` (15) |
| CAE | 3 | **DONE** | `lua-shape-cae-contract.test.ts` (12) |
| Rate limit | 2 | **DONE** | `lua-shape-rate-limit-contract.test.ts` (12) |
| OTP lockout | 1 | **DONE — already served** | `otp-brute-force-atomic.test.ts` (4) + `-before` control (1) |
| Refund cap | 1 | **DONE — already served** | `refund-drip-cap-atomic.test.ts` (3) + `-before` control (1) |
| WhatsApp session rollover | 1 | **DONE** | `lua-shape-session-rollover-contract.test.ts` (10) |
| Token bucket | 1 | **DONE** | `lua-shape-token-bucket-contract.test.ts` (10) |

The two shapes marked *already served* were checked, not assumed. Both scripts
are single-site and module-private, and both site suites drive the real
production bytes through the exported function that evals them
(`acquireOtpAttempt`, `tryReserveDailyRefund`) against a container, with the cap
boundary asserted on both sides and a sibling `-before` file standing as the
pre-fix control. Rewriting either for uniformity would buy nothing.

**Each suite fails when its shape's conjunct is removed — measured, not
asserted.** Every new suite carries a per-site CONTROL that rewrites that site's
own extracted script with the conjunct deleted and requires the damage to
appear, so a case that stopped testing anything cannot stay green. Each was also
verified by corrupting the PRODUCTION source and observing the red, at a site
with no site-suite of its own:

| Shape | Production edit | Result |
|---|---|---|
| CAD | `packages/cli/src/lib/lock.ts` → `if true then` | 3 red, only that site's rows |
| CONSUME | removed the `DEL` from `escalation-park-store.ts` | 5 red, only that site's rows |
| CAE | `packages/journeys/.../journey-lock.ts` `HEARTBEAT_SCRIPT` → `if true then` | 3 red, only that site's rows |
| Rate limit | removed the `EXPIRE` from `packages/tools/.../atomic-rate-limit.ts` | 3 red, only that site's rows |
| Session rollover | `whatsapp/session.ts` idle test → `if lastMsg then` | 5 red |
| Token bucket | removed the `PEXPIRE` from `whatsapp/client.ts` | 2 red |

Every corrupted file was restored and verified by content; `git status` is clean
of production edits.

**Clock discipline.** No shape suite sleeps to advance time. The two
time-dependent scripts (rollover, token bucket) take `now` as an ARGV and have
no other source of time, so elapsed time is driven by passing it — which is what
makes "wait exactly the `waitMs` the script quoted, then one ms less" expressible
as a boundary at all. TTL assertions are two-sided bands throughout; the one
place `-1` appears it is asserted NEGATIVELY (`not.toBe(-1)`, "no expiry"), never
as `> 0`.

**Population correction: CAD has ELEVEN sites, not ten.** The inventory in the
census omits `apps/api/src/claustrum/trigger-dedup-redis.ts:59`
(`TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT`). Total production Lua sites are 25,
not 20, once the CAD correction and the park-quota script
(`EVAL_INCR_CHECK_SCRIPT`, covered by `park-nx-release-failure-mode.test.ts`) are
counted. The census records this.

### M2 status — all 7 class-(i) doubles retired

**Zero eval emulations remain in census class (i).** Six files kept their
in-memory doubles for the non-atomic commands and replaced `eval` with unit
observation; the seventh moved to real Redis. No case was deleted; three were
renamed to what they now check.

| # | File | Disposition | Where the emulated invariant now lives |
|---|---|---|---|
| 1 | `subscribers/__tests__/defer-resolver.test.ts` | **(b)** unit observation | CAD suite; the release is observed at 3 sites via `expectResumingLockReleased()` |
| 2 | `jobs/__tests__/defer-timeout-sweeper.test.ts` | **(b)** unit observation | CAD suite; `expectSweeperMutexReleased()` |
| 3 | `escalation/__tests__/escalation-park-store.test.ts` | **(b)** unit observation | CONSUME suite |
| 4 | `__tests__/checkout-confirmation-store.test.ts` | **(b)** unit observation | CONSUME suite |
| 5 | `__tests__/order-cancel-confirm.test.ts` | **(b)** unit observation + declared postconditions | CONSUME suite |
| 6 | `__tests__/cart-routes.test.ts` | **(b)** unit observation + declared postconditions | CONSUME suite |
| 7 | `packages/journeys/.../journey-lock.test.ts` | **(c)** real Redis | its own cases, now container-backed; CAD + CAE suites hold the script shapes |

Disposition **(a)** (delete and let the call fail loudly) was considered and
REJECTED everywhere, for a measured reason: `releaseDeferResumingLock` swallows
release errors by design, so a throwing `eval` is absorbed and the case passes
having observed nothing. That is F-37's mechanism, and (a) would have
manufactured it at two more sites. **(d)** was never needed — Docker was
available for the one file that required real Redis.

**The seam: `__tests__/helpers/lua-call-observer.ts`.** Unit observation is only
worth anything if it names WHICH script the site issued. `expectLuaCall`
requires the observed script to be byte-identical to the production text at a
named site anchor — the SAME anchor the shape suite reads. The two halves are
complementary and neither is sufficient:

- the shape suite proves the bytes at the anchor obey the contract on real Redis;
- the observation proves the site actually hands the client the bytes at that
  anchor, with the right key and ARGV.

A consistent edit to a script constant moves both sides of the observation's
comparison and stays green there — deliberately, because that is exactly what
the shape suite catches (M1 measured it by corrupting production source).

**This closes the census's script-blindness hazard structurally.** Six of the
seven doubles ignored the `script` argument, which was safe only while each SUT
reached one script family. That was never a property anyone was checking, and
the population is larger than the census implies: **four production modules run
two or more distinct scripts through one client** —
`streaming/execution-queue.ts` (CAD + CAE), `adapters/park-redis-capabilities.ts`
(CAD + quota INCR), `journeys/journey-lock.ts` (CAD + CAE), and
`whatsapp/session.ts`, which runs **three** (rollover + CAD + CAE). journey-lock
was not an oddity for dispatching on script text; it was the one file whose SUT
forced the issue into the open.

**Revert-to-red — two of the five are control/treatment pairs against the
retired doubles, and both show the retirement STRENGTHENED coverage:**

| # | Production defect injected | Retired (M1) double | M2 observation |
|---|---|---|---|
| 1 | `defer-resuming-lock.ts` lock value → the constant `holder` (F-21's exact defect) | **35/35 GREEN** | **4 RED** |
| 2 | `escalation-park-store.ts` consume EVALs a CAD instead of its CONSUME (the census's script-blindness hazard) | **5/5 GREEN** | **1 RED** |
| 3 | `journey-lock.ts` CAD → `if true then` | — (file moved to real Redis) | 2 RED |
| 4 | `journey-lock.ts` CAE → `if false then` | — | 1 RED |
| 5 | `checkout-confirmation-store.ts` consume key drops `rk()` | — | 3 RED (both consuming files) |

Row 2 is the load-bearing one: that defect is invisible to the retired double
AND to the shape suite (which reads the anchor's constant, still correct, and
runs bytes nothing dispatches). The unit observation is the only thing in the
repo that catches it.

**Roll call.** `scripts/check-real-redis-suites.mjs` now walks a LIST OF
PACKAGES, not just `apps/api`. M2's move of `journey-lock.test.ts` put a
real-Redis suite in `packages/journeys`, and a suite that can skip in a
directory the gate never scans is the M0 hole reopened one package over. The
gate is 21 suites / ≥156 executing cases (146 container-backed) across two
packages.

### M3 status — the class (i-b) rows, and the container that proved nothing

**The enumerated class was already empty; the open row was the one the census
had filed somewhere else.** Items 8–13 were verified individually rather than
read off the table. Items 11 and 13 are genuinely discharged (Phase 5), and the
two F-22-deferred migrations they correspond to needed nothing. Items 8, 9, 10
and 12 still reach the release site and still have that release refused — the
mechanism is intact — but that is now the DESIGNED state, not a hole: the
adapter refuses `eval` by W4 RULE 3, and the invariant lives in M1's CAD shape
suite plus M2's `expectResumingLockReleased()` observation. Migrating them would
add three containers for zero new signal (Q2). Measured, not assumed: a
temporary probe in `releaseDeferResumingLock`'s catch counted 1 / 1 / 2 refused
releases across those three files.

| Row | Verified state | Disposition | Where the invariant lives |
|---|---|---|---|
| 8 `defer-roundtrip` | reaches Lua, refused | keep — already DECLARES the bound | CAD suite + M2 observation; the bound is its own case |
| 9 `defer-roundtrip-extensions` | reaches Lua ×1, refused | keep as-is | CAD suite + M2 observation |
| 10 `defer-resolver-resumedkey-redis-error` | reaches Lua ×1, refused | keep as-is | CAD suite + M2 observation |
| 12 `boot-window-race` | reaches Lua ×2, refused | keep as-is | CAD suite + M2 observation |
| 11 `defer-resume-integrity` | on the container, enrolled at 3 | already done (Phase 5) | its own cases |
| 13 `park-nx-hoist` | SUT never reaches Redis | already done (Phase 5) | `park-nx-hash` + `park-nx-release-failure-mode` |
| **F-37** `sweeper-resolver-race` | **enrolled, container real, Lua DEAD** | **fixed** | its own cases, now 6 |

**F-37, and what it was actually hiding.** The suite's `@ibatexas/tools` shim
forwarded eight commands to the container and omitted `eval`, so every
`defer:resuming:*` compare-and-delete threw and `releaseDeferResumingLock`
swallowed it. Proved before fixing: after a sweeper-won sweep the mutex was
still present, `ttl=60`. Fixed by forwarding `eval` verbatim to the container
the file already had — never an emulation, and the in-memory adapter still
refuses `eval`.

That fix then surfaced two defects the dead release had been masking, both of
which are worse than F-37 itself:

- **F-39 — a dead spy.** `mockAuditSinkEmit` was declared, cleared and asserted
  on three times, but no `vi.mock` ever connected it, so `auditEmits` was
  structurally always 0. Every `toBe(0)` was vacuous and the
  `park_missing_after_lock` arm's `toBe(1)` was unsatisfiable — green only
  because that arm was unreachable while the release was dead. Now wired to
  `getAuditSink().emit`.
- **F-40 — a live double-mutation window, ~0.8%.** With the release working, the
  100-iteration case immediately caught BOTH surfaces firing. The resolver has
  re-checked parkKey after its own SETNX since E2 Fix-b; **the sweeper never
  did**. In the gap between the sweeper's E3 blob GET and its SETNX, the
  resolver can complete a whole resume and release the shared mutex, after
  which the sweeper acquires it and publishes `intent.defer.timeout` for an
  envelope already resumed. The file's headline "hard zero" was an ARTIFACT of
  the broken release: while the mutex only ever ended by TTL, the window could
  not open. Measured 4 violations / 500 iterations before, 0 / 500 after the
  sweeper-side re-check landed in `jobs/defer-timeout-sweeper.ts`, and pinned
  deterministically by that file's F-40 case rather than left to a 1% rate.

**Gate strengthening — enrolment proves a file ran, not that its Lua ran.**
Two small changes, both general, neither a per-file mechanism:

1. `scripts/check-real-redis-suites.mjs` now fails on a **non-zero vitest exit**.
   It previously read only `assertionResults`, so a suite-level failure — a
   throwing `beforeAll`/`afterAll`, an unhandled rejection — left every case
   reading "passed" and the gate certified the run. `run.status` was already
   captured and used only inside an error string.
2. `setupRedisTestContainer({ expectLuaCalls: true })` counts EVAL/EVALSHA
   through the harness client and **fails teardown when zero scripts reached the
   container**. Deliberately a ZERO alarm, not a per-suite count: 21
   hand-maintained expected-call figures would each be a new way to red
   spuriously, to catch a failure mode that is always "the Lua stopped entirely".
   Like the completeness alarm, it can only ADD a failure, never satisfy a
   requirement. The six M1 shape suites do not need it — they assert their Lua's
   effects directly and red on their own; it is for suites where the Lua is a
   side effect of the path under test, which is exactly where it dies unnoticed.

Measured together, not assumed: with `eval` removed from the shim AND the two
F-37 cases neutered to trivial passes, vitest reports **6 passed / 0 failed**
and still exits 1 on the alarm. That state — every case green, Lua dead — is
what the pre-M3 gate certified, and it is what the two changes now catch.

The roll call is **21 suites / ≥159 executing cases (149 container-backed)**;
`sweeper-resolver-race` goes 3 → 6.

Estimated total: **8–11 slices** at the program's measured per-slice pace.
F-21's competing-clients regression tests do not wait on any of this — they
extend the existing harness today.
