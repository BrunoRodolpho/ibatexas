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

## D4 — F4 nonce: `randomUUID()` for first attempts, callers own retry-reuse
**Why:** The v2 envelope spec (`@adjudicate/core/src/envelope.ts:67`) prescribes `crypto.randomUUID()` for first-attempt nonces and same-value reuse for retries. The three IbateXas call sites — `tool-registry.ts` (`order.tool.propose`), `llm-responder.ts` (`validation.text.rewrite` and `validation.text.refuse`) — are all first-attempt construction points; validation events are post-hoc audit emits that aren't retried, and tool proposals are kept whole by the caller across kernel retries (not rebuilt). So `randomUUID()` at every construction site is correct. Import is `node:crypto.randomUUID` rather than the global `crypto`, matching the project's preferred explicit-import style.
**How to apply:** New `buildEnvelope` call sites: import `randomUUID` from `node:crypto`, pass `nonce: randomUUID()` unless the call site is a retry path (in which case it reuses the envelope wholesale via `executeKernel`, not rebuilds it).

## D5 — F4 `Plan.forbiddenConcepts`: dropped from the framework Plan shape
**Why:** The framework `Plan` interface (`@adjudicate/core/src/llm/planner.ts`) is intentionally minimal — `visibleReadTools` and `allowedIntents` are the load-bearing security fields the bridge enforces. `forbiddenConcepts` was IbateXas-specific cosmetic prompt-rendering data; keeping it on `Plan` would mean every adopter has to think about it. The PromptRenderer already calls `getForbiddenConceptsFor(stateValue)` directly from `capability-planner.ts` — that's the canonical path.
**How to apply:** When adapting an IbateXas-specific concern to the framework `Plan` interface, keep cosmetic/rendering state out of `Plan` and expose it as a separate exported function the renderer can call.
