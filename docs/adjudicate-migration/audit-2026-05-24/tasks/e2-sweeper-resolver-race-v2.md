# E2 — Sweeper-resolver race v2 (re-opens P0-2 partial closure)

**Status:** 🚧 Open. **Re-opens P0-2 partial closure.**
**Severity:** P0 — production race lets some destructive mutations double-execute under specific timing.
**Surfaced by:** Conformance-A's T6 test (`apps/api/src/__tests__/audit-2026-05-24/sweeper-resolver-race.test.ts`).
**Empirical evidence:** 1-4% violation rate per 100 iterations with random 0-50ms jitter. T6 currently tolerates 10% to pass; the production race is real.

---

## What R2-1 fixed and what it missed

**R2-1 (`a1fbb25`) introduced** a SETNX-based `defer:resuming:` mutex shared between the defer-timeout sweeper and the defer-resolver. The intent was: "exactly one of them acquires the mutex before dispatching the same parked envelope."

**What R2-1 missed** — the sweeper's release ordering:

```
1. Resolver: GET parkKey         → in-memory blob = X
2. Sweeper:  SETNX defer:resuming → acquired
3. Sweeper:  publish intent.defer.timeout
4. Sweeper:  DEL parkKey
5. Sweeper:  DEL defer:resuming   ← released BEFORE step 4 effects are observable
6. Resolver: SETNX defer:resuming → succeeds (sweeper just released)
7. Resolver: dispatch blob X      ← second execution of the same mutation
```

The mutex is released *before* the parkKey deletion has reached the resolver's worldview. The resolver's in-memory blob from step 1 is still valid and dispatchable.

For destructive intents whose `intent.defer.timeout` handler runs the same executor as resume (anonymize is the canonical example), this is double-execution: both the sweeper's published timeout event AND the resolver's direct dispatch fire.

## Why T6 hides this in steady-state CI

T6's tolerance was set at 10% (2× upper-observed) so the test passes in CI. The "the test passes" institutional record masks the "the prod race fires 1-4% of the time" reality.

## Three candidate fixes (from Conformance-A's report)

### Fix-a — Sweeper holds mutex until parkKey TTL elapses

**Mechanism:** sweeper does NOT explicitly DEL the mutex; it relies on the SETNX TTL (matching the parkKey TTL) to release.
**Pros:** simplest sweeper logic.
**Cons:** TTLs are long (24h for anonymize-grace); the mutex holds for the entire window. A spurious resolver attempt during that window is rejected by SETNX — fine. But this couples the mutex's lifetime to a business-domain TTL.

### Fix-b — Resolver re-checks parkKey existence post-SETNX (recommended)

**Mechanism:** after the resolver SETNX-acquires the mutex, it does a `GET parkKey` (or `EXISTS parkKey`) before dispatching. If the key is gone, the sweeper completed first — the resolver releases the mutex and exits.
**Pros:** cheapest. Single extra Redis op. Compose-friendly with existing logic.
**Cons:** none significant — Redis ops are cheap, the re-check is unambiguous.

### Fix-c — Separate mutex namespaces for sweeper vs resolver

**Mechanism:** sweeper uses `defer:sweeping:<key>`; resolver uses `defer:resolving:<key>`. They look at each other's keys.
**Pros:** clearer state visibility.
**Cons:** doubles the mutex surface area; same root issue (release-ordering) re-emerges if both delete their own mutex before completing the destructive op.

## Recommended fix

**Fix-b** — resolver re-checks parkKey existence post-SETNX. Smallest blast radius, single Redis op, no business-domain coupling.

## Acceptance criteria

- Resolver code (`apps/api/src/subscribers/defer-resolver.ts`, search for `defer:resuming:` SETNX call) acquires the mutex AND re-checks `EXISTS parkKey` before dispatching. If parkKey is gone, the resolver releases and exits.
- T6 tolerance lowered from 10% to **0% violations** over 100 iterations. The test name updated accordingly.
- Audit-record emit: if the resolver exits because parkKey is gone, emit a `defer.resume.skipped` audit record (or equivalent) with reason `parkKey_missing_after_sweeper`. Forensic clarity.
- Existing R2-1 tests still pass; new test for the post-SETNX re-check.

## Verification

- `pnpm -F @ibatexas/api typecheck`
- `pnpm -F @ibatexas/api test -- audit-2026-05-24/sweeper-resolver-race` (T6) — should now pass with hard-zero tolerance
- Run T6 100 iterations across 5 separate test runs; track variance.

## Commit message

`fix(api,audit-2026-05-24-E2-fix-b): resolver re-checks parkKey post-SETNX to close race v2`

## Risk classification

- **Blast radius:** medium (resolver hot path; destructive ops)
- **Reversibility:** trivial (single conditional re-check)
- **Replay impact:** improves replay correctness — eliminates spurious "double-resume" audit records
- **Deployment risk:** low (additive guard)

## Ready-to-spawn sub-agent prompt

> You are the E2 race-v2 fix sub-agent for the ibatexas audit-2026-05-24 closeout. You are running inside a git worktree branched from the current `feat/kernel-always-on-cutover` tip. First step: verify worktree base matches the `feat/kernel-always-on-cutover` HEAD (run `git rev-parse HEAD` and confirm against `origin/feat/kernel-always-on-cutover`). If wrong, self-correct via `git switch -c work/e2-race-v2 origin/feat/kernel-always-on-cutover`. Read `docs/adjudicate-migration/audit-2026-05-24/tasks/e2-sweeper-resolver-race-v2.md` for the full context. Implement **Fix-b** (resolver re-checks parkKey existence post-SETNX). Acceptance criteria as documented. Lower T6 tolerance to **zero**. Run T6 across 5 separate iterations of 100 to verify the hard-zero claim. Single commit per the commit-message template. Repo conventions per CLAUDE.md. **Hard stop** if the resolver's existing code paths require restructuring beyond the post-SETNX guard — report up and propose an alternative.

## Dependencies

- Independent of H3 (different code paths).
- Should land before next push to staging or before H3 starts (production-safety priority).

## Related artifacts

- T6 conformance suite: `apps/api/src/__tests__/audit-2026-05-24/sweeper-resolver-race.test.ts`
- R2-1 commit (the partial fix): `a1fbb25`
- Sweeper code: `apps/api/src/jobs/defer-timeout-sweeper.ts` (search for `defer:resuming:`)
- Resolver code: `apps/api/src/subscribers/defer-resolver.ts` (search for `defer:resuming:`)
