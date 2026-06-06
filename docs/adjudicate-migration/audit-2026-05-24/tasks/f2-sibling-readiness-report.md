# F2 sibling-repo readiness report

**Investigator:** f2-sibling-readiness agent (read-only Explore)
**Date:** 2026-05-24
**Scope:** verify readiness for the deferred F2 cross-repo PR + H3-Wave-A1 follow-up bundling
**Output of this report:** input to G4 decision

---

## Sibling state

- **Repo path:** `/Users/thaisrodolpho/projects/adjudicate/`
- **Branch:** `main` (clean — no uncommitted changes)
- **Last published version:** `1.0.0` (per `packages/core/package.json`)
- **Git tags:** `-local` build tags only (`v0.5.1-local`, …) — no published-version tags. Worth tagging on publish.
- **In-flight branches:** none beyond `origin/main`

## Proposed PR — bundled two-addition minor release

| File | Change |
|---|---|
| `packages/core/src/basis-codes.ts` | Add `KERNEL_INTENT_DISPATCHED: "kernel.intent_dispatched"` to the `kernel` category object (currently only has `GUARD_PANIC`). |
| `packages/core/src/audit.ts:42-46` | Extend `SupersessionReason` union with `\| "lgpd_scrub"`. Other values: `"confirmation_resolved" \| "defer_resumed" \| "rewrite_executed" \| "replay"`. |
| `packages/core/package.json` | Bump `1.0.0` → `1.1.0` (semver minor — backwards-compatible additions). |

Total diff: ~10 LOC across 3 files.

## Consumer-side state (ibatexas)

- **Literal-string usage of `"kernel.intent_dispatched"`:** **zero** sites in source. (Originally the F2 task file noted potential workarounds; none materialized — the code never used the literal.)
- **Literal-string usage of `"lgpd_scrub"`:** **zero** sites in source.
- **`SupersessionReason` usage:** one production site at `packages/domain/src/services/customer.service.ts` `emitScrubAuditRecords()` (~line 1042+ per current source), currently emits `reason: "replay"` (per H3-Wave-A1 agent's compromise — `"replay"` was the closest fit in the closed union; documented in CLOSEOUT-STATUS §"NEW (from H3 Wave A1)").
- **Test assertion:** `packages/domain/src/services/__tests__/anonymize-customer.test.ts` asserts `expect(record.supersedes?.reason).toBe("replay")`. Updates to `"lgpd_scrub"` on consumer migration.

## Package version pins

- **Current consumer pin:** `@adjudicate/core ^1.0.0` (caret) across 11 packages / apps in the ibatexas workspace.
- **Post-release pin:** `^1.1.0` — but caret pins will auto-pick `1.1.x` on next `pnpm install`. The version-pin bump in `package.json` is documentation-only; lockfile refresh suffices.

## Release sequencing (user-gated steps marked)

1. **Sibling PR** in `/Users/thaisrodolpho/projects/adjudicate/`:
   - Add `KERNEL_INTENT_DISPATCHED` to `BASIS_CODES.kernel`
   - Extend `SupersessionReason` union
   - Bump `packages/core/package.json` to `1.1.0`
   - Run sibling's own tests + conformance suites
   - Commit + PR + merge to `main`

2. **🛑 USER-GATED: `pnpm publish`** the new `@adjudicate/core@1.1.0` to npm.

3. **🛑 USER-GATED: `git tag v1.1.0 && git push --tags`** in sibling repo.

4. **Consumer-side migration** in ibatexas:
   - `pnpm install` at workspace root (picks up `1.1.0` via existing caret pin)
   - One-line edit in `customer.service.ts` `emitScrubAuditRecords()` — swap `reason: "replay"` to `reason: "lgpd_scrub"`
   - Update the test assertion in `anonymize-customer.test.ts`
   - Commit: `refactor(domain,audit-2026-05-24-F2): adopt @adjudicate/core 1.1.0 — supersedes.reason="lgpd_scrub" for H3 audit records`

## Risk assessment

- **API breakage:** none. Both additions are backwards-compatible enum extensions. Existing literals (e.g., `"replay"` in the consumer) still type-check after the union expansion.
- **Downstream impact:** ibatexas is the only known consumer of `@adjudicate/core`. Verified no other downstream repos in the readable surface.
- **Conformance tests:** sibling's `basis-vocabulary-purity` conformance suite will auto-include the new code (already iterates over the `BASIS_CODES` object).
- **ibatexas test coverage:** one assertion update; covered.

## Recommendation

**Land both additions in a single 1.0.0 → 1.1.0 minor release.** Bundling avoids two release events for two trivial additions and aligns with G4's default ("bundle with other near-term sibling work" — both items qualify).

Sequence:
- Spawn a single sibling-PR agent (would draft + push the PR + run sibling's conformance suites)
- User reviews + approves `pnpm publish` + `git tag`
- Spawn a small consumer-migration agent for the one-line ibatexas edit

Estimated total wall-clock if approved: ~30-45 min.

## Open questions for orchestrator / user

1. **Authorize sibling-PR agent now, or defer until other sibling work surfaces?** Other sibling work has NOT surfaced; deferring further has no clear benefit beyond saving the release event.
2. **Tag publishing posture** — should the sibling repo start tagging published versions in git going forward? Currently only `-local` tags exist. A clean `v1.1.0` git tag would close the "npm-only releases create traceability gap" item from the 2026-05-23 synthesis.
3. **Conformance test for "no hardcoded literal SupersessionReason strings in consumer"** — would prevent the original "use replay as fallback" pattern from recurring. Worth adding to the H3 conformance suite as a small follow-up.

## Files inspected (read-only)

- `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/basis-codes.ts`
- `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/audit.ts`
- `/Users/thaisrodolpho/projects/adjudicate/packages/core/package.json`
- `/Users/thaisrodolpho/projects/adjudicate/CHANGELOG.md` (if present — not load-bearing for this report)
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/customer.service.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/__tests__/anonymize-customer.test.ts`
- ibatexas `package.json` files across all 11 consumer workspaces
