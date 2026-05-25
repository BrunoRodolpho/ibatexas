# F2 — `kernel.intent_dispatched` basis code (sibling repo)

**Status:** 🚧 GATED on G4 release cadence — defer until bundled with other sibling work, OR if user prefers, land alone.
**Cross-repo:** primary change is in [BrunoRodolpho/adjudicate](https://github.com/BrunoRodolpho/adjudicate), with follow-on pin bump in ibatexas.
**Effort:** ~15min sibling-repo PR + release event + ~2min ibatexas pin bump.

---

## Objective

Add the `kernel.intent_dispatched` basis code to `@adjudicate/core`'s `BASIS_CODES` so the in-repo `buildAuditRecord` calls that thread `basis: BASIS_CODES.KERNEL_INTENT_DISPATCHED` (or similar) at resume time can resolve without a `// TODO: basis code` workaround.

## Live state (verified 2026-05-24 in memory)

- Sibling `adjudicate/main` is clean and ready for the PR.
- Ibatexas-side consumers of the basis code thread the literal string `"kernel.intent_dispatched"` today (workaround) — confirm via `grep -rn "kernel.intent_dispatched" packages/ apps/` before declaring the basis code lands.

## Steps

1. **In sibling repo** (`/Users/thaisrodolpho/projects/adjudicate/`):
   - Branch off `main`.
   - Edit `packages/core/src/basis-codes.ts` — add `KERNEL_INTENT_DISPATCHED: "kernel.intent_dispatched"` to the `BASIS_CODES` const.
   - Add an export from the package barrel.
   - Bump `@adjudicate/core` version (minor: e.g. `1.0.x` → `1.1.0`).
   - Commit + PR + merge.
   - Publish to npm: `pnpm publish` (or whatever the sibling repo's release workflow is — confirm).
   - Tag the release in git: `git tag v1.1.0 && git push --tags`.

2. **In ibatexas:**
   - Bump pin in `package.json`: `"@adjudicate/core": "^1.1.0"`.
   - `pnpm install`.
   - Replace any literal `"kernel.intent_dispatched"` strings with `BASIS_CODES.KERNEL_INTENT_DISPATCHED`.
   - Commit: `chore(deps,audit-2026-05-24-F2): bump @adjudicate/core to ^1.1.0 + adopt KERNEL_INTENT_DISPATCHED basis code`.

## Acceptance criteria

- Sibling repo has the basis code published to npm with a git tag.
- Ibatexas consumes the new pin via standard `pnpm install`.
- All literal-string callers in ibatexas migrated to `BASIS_CODES.KERNEL_INTENT_DISPATCHED`.
- Existing audit-trail tests still pass; the new basis code shows up in audit records replayed via `ibx kernel replay`.

## Dependencies / gates

- G4: release-cadence decision. If user bundles with other sibling work, queue this; if user lands alone, proceed.

## Ready-to-spawn sub-agent prompt

> You are the F2 sibling-repo basis-code agent. Per `docs/adjudicate-migration/audit-2026-05-24/tasks/f2-sibling-basis-code.md`. Two repos: `/Users/thaisrodolpho/projects/adjudicate/` (sibling) and `/Users/thaisrodolpho/projects/ibatexas/` (consumer). Sibling: add `KERNEL_INTENT_DISPATCHED` to `packages/core/src/basis-codes.ts`, export from barrel, bump minor, commit, PR — **stop and report for human approval before `pnpm publish` and `git push --tags`**. Once user confirms publish, return to ibatexas: bump pin, `pnpm install`, replace literal strings with `BASIS_CODES.KERNEL_INTENT_DISPATCHED`, commit. **Do NOT run `pnpm publish` autonomously; that is a user-gated action (G4).**

## Risk classification

- **Blast radius:** medium (cross-repo + npm release event)
- **Reversibility:** semver bump can be deprecated; in-repo callers can revert to literal strings
- **Replay impact:** improves basis-code clarity in audit records
- **Deployment risk:** low (no schema, no runtime behavior change)
