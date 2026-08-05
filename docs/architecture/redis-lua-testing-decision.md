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
| M2 | Class (i): the 7 eval-emulating doubles retired onto shape suites + unit observation | 2 |
| M3 | Class (i-b) bound cases + the two F-22-deferred migrations (after the F-22 ruling lands) | 1–2 |
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

Estimated total: **8–11 slices** at the program's measured per-slice pace.
F-21's competing-clients regression tests do not wait on any of this — they
extend the existing harness today.
