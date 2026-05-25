# E3 — Sweeper ghost-publish path (empty-intentHash NATS events)

**Status:** 🟡 Open, NOT urgent. Phase-5 evolutionary-forecasting item.
**Severity:** P3 (latent contract violation; harmless today, foot-gun for future consumers).
**Surfaced by:** E2 fix sub-agent (commit `4c82a22`) while instrumenting T6 to chase residual ~1% test-failure rate.
**Constitutional class:** Law 1 (Authority Must Be Explicit) + Law 2 (Governance Must Be Universal) — the sweeper's NATS event contract is not universally observed by the sweeper itself.

---

## What the agent found

When the **resolver wins the race** (resolver DELs the parkKey before the sweeper completes its work), the sweeper hits a malformed-blob fallback branch:

```
1. Sweeper SCAN finds parkKey (still alive)
2. Sweeper TTL-check passes (still alive)
3. Resolver SETNX-acquires defer:resuming:
4. Resolver dispatches the mutation
5. Resolver DELs parkKey
6. Sweeper GET parkKey  → returns null (key gone)
7. Sweeper falls through to a malformed-blob branch
8. Sweeper publishes intent.defer.timeout with:
     - intentHash: ""   ← empty
     - signal: ""        ← empty
   via a session-scoped fallback mutex
```

**Why it's harmless today:**
- All downstream consumers (`anonymize-grace-resolver`, `pix-defer-timeout-resolver`, …) key on `intentHash`. An event with `intentHash: ""` doesn't match any parked envelope; the consumer silently drops it.

**Why it's a latent footgun:**
- A future consumer added without awareness of this contract gap (e.g., a metrics consumer that counts all `intent.defer.timeout` events; or a forensic-replay consumer that doesn't filter on intentHash) will count the ghost as a real event.
- The sweeper's NATS event contract is *implicit* — the actual contract is "events have intentHash" but in practice "sometimes they don't, when the resolver wins the race." This is the kind of institutional-memory gap the civilization-kernel role flags as Phase-4 governance erosion.

## Fix options

### Option α — Suppress the ghost publish (recommended)

**Mechanism:** in the sweeper's malformed-blob branch (`apps/api/src/jobs/defer-timeout-sweeper.ts`, search for the post-`GET parkKey` null-check), DO NOT publish. Instead, log at debug level "sweeper found parkKey deleted between SCAN and GET — resolver won" and skip.

**Pros:**
- Single conditional. ~5-10 lines.
- Restores the implicit contract: every published `intent.defer.timeout` event has a non-empty intentHash.
- Future consumers can trust the contract without knowing the corner case.

**Cons:** none significant — the ghost event has zero downstream effect today, so suppressing it changes nothing observable.

### Option β — Document the contract gap

**Mechanism:** add a comment in the sweeper noting the empty-intentHash ghost-publish behavior + a comment in each consumer noting the filter requirement. No behavior change.

**Pros:** zero code change.
**Cons:** preserves the gap; future consumers still have to read the comment to know the contract is conditional.

### Option γ — Encode the contract in the consumer base

**Mechanism:** change all `intent.defer.timeout` consumers to assert `event.intentHash !== ""` (REFUSE on empty, with a forensic audit emit). Make the universal contract explicit at every consumer.

**Pros:** strong constitutional alignment — every consumer enforces the contract explicitly.
**Cons:** 4+ subscriber/job files to touch; redundant work to defend a contract that the sweeper could just honor.

## Recommended fix

**Option α** — suppress the ghost publish at the sweeper. Smallest blast radius, restores the implicit contract, future-proofs against new consumers.

## Acceptance criteria

- Sweeper's post-`GET parkKey` null-check branch: log at debug level (`"sweeper found parkKey deleted between SCAN and GET — resolver won race"`) and skip the publish.
- New unit test asserts: when the resolver wins the race, the sweeper does NOT publish an `intent.defer.timeout` event.
- T6 conformance test's `ghostOnly` predicate (added in `4c82a22`) becomes obsolete and can be replaced with a strict `publishedCount === 0` on resolver-won iterations.
- Existing sweeper tests still pass.

## Verification

- `pnpm -F @ibatexas/api typecheck`
- `pnpm -F @ibatexas/api vitest run audit-2026-05-24/sweeper-resolver-race` (T6 should still pass)
- `pnpm -F @ibatexas/api vitest run jobs/defer-timeout-sweeper` (existing sweeper tests)
- New focused test for the ghost-publish suppression.

## Commit message

`fix(api,audit-2026-05-24-E3): suppress sweeper ghost-publish when resolver wins race`

## Risk classification

- **Blast radius:** very low (sweeper job; non-critical path; only fires on race-win)
- **Reversibility:** trivial
- **Replay impact:** improves audit-trail cleanliness (no empty-intentHash events to filter)
- **Deployment risk:** very low

## Dependencies

- None. Independent of H3, E2 (already closed), and all other open work.

## Ready-to-spawn sub-agent prompt

> You are the E3 ghost-publish-suppression sub-agent. Working dir: a worktree branched from `feat/kernel-always-on-cutover` tip. Verify worktree base — if HEAD is not a descendant of `4c82a22`, self-correct via `git switch -c work/e3-ghost-publish <feat-tip>`. Read `docs/adjudicate-migration/audit-2026-05-24/tasks/e3-sweeper-ghost-publish.md` for full context. Implement **Option α**: suppress the sweeper's ghost-publish when `GET parkKey` returns null after the SCAN/TTL passed. Replace the publish call with a debug-level log. Update T6 to use a strict `publishedCount === 0` invariant (remove the `ghostOnly` predicate added in `4c82a22`). Add a new unit test in the sweeper test file directly asserting suppression. Single commit per the commit-message template. Repo conventions per CLAUDE.md. **Hard stops:** if the suppression cascades into >2 sweeper files OR breaks the sweeper's existing reliability/retry guarantees OR if the malformed-blob fallback branch turns out to have other callers that DO need the publish.

## Related artifacts

- E2 task file (parent): [`e2-sweeper-resolver-race-v2.md`](./e2-sweeper-resolver-race-v2.md)
- E2 commit (parent closure): `4c82a22`
- Sweeper code: `apps/api/src/jobs/defer-timeout-sweeper.ts` (search for the `GET parkKey` after SCAN)
- T6 conformance: `apps/api/src/__tests__/audit-2026-05-24/sweeper-resolver-race.test.ts` (search for `ghostOnly`)
