# Pre-existing apps/api test failures — investigation report

**Author:** pre-existing-test-failures sub-agent
**Date:** 2026-05-24
**Base:** `0ac676b` (`feat/kernel-always-on-cutover` post-cutover)
**Scope:** investigate the two clusters Polish-B documented at
`docs/adjudicate-migration/audit-2026-05-24/CLOSEOUT-STATUS.md:123`:
- `apps/api/src/__tests__/park-deferred-intent-nx.test.ts` (3 failures)
- `apps/api/src/__tests__/wave6-red-team/01-customerid-whitespace-bypass.test.ts` (3 failures)

Both clusters were **inline-fixed** in this work — neither was a production bug.

---

## Cluster 1 — `park-deferred-intent-nx.test.ts`

### Failure pattern

```
× P0-7-TRUE — parkDeferredIntentWithNxGuard > concurrent parks for the same sessionId — exactly one wins, the other gets collision
  → NOAUTH Authentication required.
× P0-7-TRUE — parkDeferredIntentWithNxGuard > sequential parks: second attempt for same sessionId returns collision, first envelope preserved
  → NOAUTH Authentication required.
× P0-7-TRUE — parkDeferredIntentWithNxGuard > after first park resolves (key deleted), a new park can claim the slot
  → NOAUTH Authentication required.
```

### Root cause

**Test-harness gating mismatch, not a production logic bug.**

The suite connects to a real Redis (the framework's `parkDeferredIntentWithNxGuard`
issues `SET … NX` against a containerised Redis to exercise concurrency
semantics that an in-memory mock can't reproduce). It read `process.env.REDIS_URL`
and **fell back to `redis://localhost:6379`** if unset. On a dev machine running a
system Redis with auth, that fallback connects but every command fails with
`NOAUTH Authentication required.`

Every other Redis-backed suite in the same directory uses the established convention:

```typescript
const REDIS_URL = process.env.REDIS_TEST_URL
const RUN_REAL_REDIS = REDIS_URL !== undefined && REDIS_URL.length > 0
…
describe.skipIf(!RUN_REAL_REDIS)("…", () => { … })
```

Examples: `otp-brute-force-atomic.test.ts:19-20`, `refund-drip-cap-atomic.test.ts:24-25`,
`otp-brute-force-before.test.ts:14-15`, `refund-drip-cap-before.test.ts:18-19`.

`park-deferred-intent-nx.test.ts` was the lone outlier — same intent, different
env-var name, no skipIf guard.

### Reproduction

```
cd apps/api
npx vitest run src/__tests__/park-deferred-intent-nx.test.ts
# Before fix: 3 failed (NOAUTH …)
# After fix:  3 skipped + 1 synthetic-guard pass (when REDIS_TEST_URL unset)
```

To actually exercise the concurrency tests (matches the rest of the suite):
```
docker run --rm -d -p 6380:6379 --name w1c-redis redis:7-alpine
REDIS_TEST_URL=redis://localhost:6380 pnpm vitest run src/__tests__/park-deferred-intent-nx.test.ts
```

### Fix recommendation

**Applied inline.** `apps/api/src/__tests__/park-deferred-intent-nx.test.ts`:

1. Switched env var from `REDIS_URL` to `REDIS_TEST_URL` (matches the
   established `apps/api` convention).
2. Removed the `localhost:6379` fallback that surfaced misleading NOAUTH errors.
3. Added `describe.skipIf(!RUN_REAL_REDIS)` so the suite gracefully skips when
   no testcontainer URL is set.
4. Added a synthetic-guard `describe("P0-7-TRUE — synthetic guard")` block
   that emits a `console.warn` pointing at the docker / env-var setup
   (mirrors the pattern in `otp-brute-force-atomic.test.ts:175-187` and
   `refund-drip-cap-atomic.test.ts:155-168`).

Production code (`parkDeferredIntentWithNxGuard` in
`apps/api/src/adapters/park-deferred-intent-nx.ts`) was not touched.

---

## Cluster 2 — `wave6-red-team/01-customerid-whitespace-bypass.test.ts`

### Failure pattern

```
× EXPLOIT: '   ' (whitespace only) bypasses assertCustomerId — writes to Redis
  → promise rejected "InvalidCustomerIdError: Invalid customerI…" instead of resolving
× EXPLOIT: '\n' (newline only) bypasses assertCustomerId
  → promise rejected "InvalidCustomerIdError: Invalid customerI…" instead of resolving
× EXPLOIT: '\tabc\t' (padded with tabs) passes through unchanged
  → expected 'ibatexas:anonymize:otp:abc' to be 'ibatexas:anonymize:otp:\tabc\t'
```

### Tests' intent (red-team documenting vs regression)

**RED-TEAM documenting an EXPLOIT against a now-CLOSED gap.**

The test header explicitly describes them as exploit reproductions: each `it`
case asserts that `markOtpFresh("   ")` **resolves** (i.e., that the bypass
"succeeds"). Those are positive-bypass assertions that pre-date the fix.

The W7-G1 commit (`b9575bc`) that closed the bypass said it explicitly:

> The Wave 6 exploit tests in `01-customerid-whitespace-bypass.test.ts` now
> correctly fail (semantics flipped — the bypass is closed), proving the fix
> landed end-to-end.

So these "failures" are the *intended* outcome of the W7-G1 fix landing. The
problem is not that the tests are wrong — it's that they were left as live
assertions instead of being marked `.skip` or rewritten as positive regressions
after the fix landed.

A separate file — `apps/api/src/__tests__/wave6-red-team/05-whitespace-rejected.test.ts`
(also landed at `b9575bc`) — pins the post-fix contract as a positive regression
test (8/8 pass). That file is the actual regression canary.

### R1-4 coverage analysis (what `fae8dc5` fixed; what these tests assert)

| Layer | File | Pre-fix check | Post-fix check | Landed at |
|---|---|---|---|---|
| Helper (anonymize OTP gate) | `apps/api/src/routes/me/anonymize-otp-gate.ts:113-120` | `customerId === ""` | `customerId.trim().length === 0` + new `canonicalizeCustomerId(customerId.trim())` | W7-G1 (`b9575bc`) |
| Middleware (JWT customer extract) | `apps/api/src/middleware/auth.ts:64` | `payload.sub === ""` | `payload.sub.trim().length === 0` | R1-4 (`fae8dc5`) |
| Middleware (JWT staff extract) | `apps/api/src/middleware/auth.ts:95` | `payload.sub === ""` | `payload.sub.trim().length === 0` | R1-4 (`fae8dc5`) |
| `requireAuth` (defense-in-depth) | `apps/api/src/middleware/auth.ts:127` | `request.customerId === ""` | `request.customerId.trim().length === 0` | R1-4 (`fae8dc5`) |

The red-team test file's mocks intercept at the `markOtpFresh` (helper) layer,
which means it specifically exercises the **W7-G1** surface. R1-4 closed the
**middleware** surface that was its sibling site.

Net result: the EXPLOIT cases against `markOtpFresh("   ")`, `markOtpFresh("\n")`,
and `markOtpFresh("\tabc\t")` all assert behaviour that W7-G1 deliberately
removed. They cannot pass without reverting W7-G1.

### Root cause

**Mis-classified red-team tests** that were never converted to expected-fail
or marked `.skip` after the bypass closed. CLOSEOUT-STATUS's tentative phrasing
("might be a regression") is conservative; the actual answer is that the W7-G1
commit message explicitly predicted these would fail and intended for them
to be tidied up.

### Fix recommendation

**Applied inline.** `apps/api/src/__tests__/wave6-red-team/01-customerid-whitespace-bypass.test.ts`:

1. File-header prose rewritten to describe these as HISTORIC bypass docs, with
   pointers to W7-G1 / R1-4 / `05-whitespace-rejected.test.ts`.
2. The three failing cases marked `.skip` (renamed `EXPLOIT (CLOSED): …`) with
   inline comments pointing at the positive regression file. The two passing
   cases — `EXPLOIT: 'null' (literal string) bypasses assertCustomerId` and
   `CONTRAST: empty string IS correctly rejected` — kept live; they describe
   current behaviour. The "null" case has an explanatory comment quoting
   `05-whitespace-rejected.test.ts:25-29`: requireAuth upstream rejects
   the literal four-character `"null"` token before any call reaches the helper.
3. Trailing recommendation block updated to describe the landed fix instead
   of the recommendation (which has been implemented).

Production code untouched.

---

## Summary

| Cluster | Verdict | Production logic bug? | Inline-fix applied? |
|---|---|---|---|
| 1 — park-deferred-intent-nx | test-harness gating mismatch | No | Yes — `REDIS_TEST_URL` + `skipIf` |
| 2 — wave6-red-team/01-customerid-whitespace-bypass | mis-classified historic red-team docs | No | Yes — `.skip` the 3 expected-fail cases + prose updates |

`apps/api` test count delta: **+6 net pass** (was 6 failing → 0 failing + 6 deferred).
The deferred 3 in Cluster 1 require a testcontainer; the deferred 3 in Cluster 2
are HISTORIC exploit documentation, with the post-fix contract pinned at
`05-whitespace-rejected.test.ts`.
