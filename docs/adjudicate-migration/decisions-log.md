# Decisions Log

Every non-trivial judgment call made during the overnight autonomous run.

## D1 — Sequential branches in main checkout (not worktrees)
**Why:** Worktree isolation defaulted to wrong base ref and `pnpm-workspace.yaml` cross-repo dep (`../adjudicate/packages/*`) can't resolve from worktree subdir paths. Established this earlier in the session.
**How to apply:** Each task gets its own branch off `feat/consume-adjudicate-from-platform-repo`. Switch between agents serially. Use parallel agents ONLY when the task scopes touch disjoint file sets (e.g., different packages, different routes).

## D2 — `pnpm-lock.yaml` after each merge: regenerate, don't conflict-resolve
**Why:** Lockfile is generated. Manual three-way merge is error-prone. `pnpm install` is idempotent and definitive.
**How to apply:** After each merge, run `pnpm install` to settle the lockfile against the merged manifests. Commit the regenerated lockfile as part of the merge resolution.

## D3 — Follow-up items sequenced before M1
**Why:** F4 (nonce migration) gates green baseline — must land first. F1 is integration glue from M0 cross-branch state. F2/F3-stub/F5/F6 are cleanup that becomes harder if M1 tasks edit the same surfaces.
**How to apply:** Run F4 first, then the rest of F* in parallel where they don't overlap, then M1.
