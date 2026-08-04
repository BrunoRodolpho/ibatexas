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
| M0 | Q1: CI Redis service + loud-skip gate | 1 |
| M1 | The 8 script-shape contract suites | 2–3 |
| M2 | Class (i): the 7 eval-emulating doubles retired onto shape suites + unit observation | 2 |
| M3 | Class (i-b) bound cases + the two F-22-deferred migrations (after the F-22 ruling lands) | 1–2 |
| M4 | The 12 `multi()` redisFake files, per-file disposition | 2–3 |

Estimated total: **8–11 slices** at the program's measured per-slice pace.
F-21's competing-clients regression tests do not wait on any of this — they
extend the existing harness today.
