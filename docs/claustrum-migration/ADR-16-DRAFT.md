# ADR-16-DRAFT.md

> **DRAFT — append to `docs/architecture/decisions.md` as `### 16` when
> ready. User has not yet incorporated this. Do not auto-merge.**
>
> This file lives in `docs/claustrum-migration/` as a holding area while
> the user reviews wording. Structure mirrors what would have been ADR #14
> (the `@adjudicate/*` extraction): Decision / Why / What was removed /
> What was added / Migration path / Consequences / Files affected /
> Cross-link / Related ADRs.
>
> Phase 7 agent (`ibatexas-doc-cleaner`) intentionally did NOT modify
> `decisions.md` because the user edited that file concurrently. When the
> user is ready, copy from `## DRAFT BEGINS BELOW` down to the end of file
> and paste under `### 16. Claustrum Cutover — Bot Runtime Extraction` in
> `decisions.md`.

---

## DRAFT BEGINS BELOW

### 16. Claustrum Cutover — Bot Runtime Extraction

The conversational-AI runtime (4-layer Hybrid State-Flow pipeline that
used to live in `packages/llm-provider/`) has been extracted into a
standalone repo, `BrunoRodolpho/claustrum`, and is now consumed by
ibatexas as `@claustrum/*` workspace dependencies — the same packaging
model as `@adjudicate/*` per ADR #14.

**Decision:** Three-pillar architecture with strict packaging boundaries:

1. **`@adjudicate/*` (kernel)** — slowest-evolving. Every mutation is
   gated here. Audit ledger lives here.
2. **`@claustrum/*` (runtime)** — medium-evolving. Cognitive loop, prompts,
   channels, memory, grounding. Domain-neutral.
3. **ibatexas (app)** — fastest-evolving. Commerce-specific entities,
   tools, business rules, HTTP surface, tenant policy.

ibatexas is now an **adopter** of claustrum. Adopters provide tools as
`ToolPack`s and a tenant policy; the runtime owns everything else.

**Why:**

- **Evolution rate separation.** Before the cutover, runtime and app were
  entangled inside ibatexas. The runtime was leaking into commerce
  concerns (`order-machine.ts`, cart guards, post-order amendments). A
  prompt tweak required a release of the whole bot.
- **Reusability.** Other adopters (healthcare, scheduling, support) need
  the same cognitive loop but have no `CART_UPDATED` event. The runtime
  has to be domain-neutral to be reusable.
- **Boundary enforcement.** The old `executeToolDirect()` bypass path
  (see ADR #9) was a convention, not a constraint — every new mutation
  could re-introduce the unauthenticated execution path by forgetting to
  register in `TOOL_CLASSIFICATION`. The packaging boundary makes that
  bypass impossible: there is no second entry point in `@claustrum/core`.
- **Reciprocal-imports invariant.** With `@adjudicate/*` and `@claustrum/*`
  both extracted, ibatexas never imports from kernel directly — only
  through the runtime's `Adjudicator` port. The dependency direction
  `apps → runtime → kernel` is strictly one-way and verifiable by
  ESLint rules.

**What was removed (deleted in this cutover, or queued for deletion
after C-07 in `docs/claustrum-migration/CUTOVER-STATUS.md` flips CLOSED):**

- `packages/llm-provider/` — entire package. Replaced by `@claustrum/core`
  + `@claustrum/anthropic`. The old 4-layer pipeline (router → kernel →
  synthesizer → LLM) is no longer code, only history (see
  `docs/claustrum-migration/lessons-learned.md`).
- `apps/api/src/plugins/kernel-bootstrap.ts` — already absent on main;
  replaced by `apps/api/src/claustrum-bootstrap.ts`.
- `apps/api/src/plugins/kernel-metrics-sink.ts` — already absent on main;
  replaced by the `TelemetryPort` provided to the Conductor.
- `apps/api/src/whatsapp/{session,client}.ts` — replaced by
  `@claustrum/channel-whatsapp`.
- `packages/domain/src/services/__shared__/with-adjudicate.ts` — the ad-hoc
  adjudicate wrapper. Replaced by `Capsule.adjudicator`.
- `apps/api/src/subscribers/__shared__/system-actor-envelope.ts` — the
  hand-rolled envelope builder. Claustrum's planner emits envelopes now.
- `@ibatexas/llm-provider` workspace dep in `apps/api/package.json`.

**What was added (Phase 6 commit `4b6cb68` on branch
`feat/claustrum-cutover`):**

- `apps/api/src/claustrum-bootstrap.ts` (~490 LOC) — composition root.
  Instantiates `Conductor` with all provider implementations, registers
  ToolPacks, resolves tenant policy. Runs once at process start.
- `apps/api/src/tools/register-ibatexas-tool-packs.ts` (~140 LOC) —
  first-pass registration of 3 domain tools (`cart.addItem`,
  `cart.checkout`, `order.cancel`) with the capability/id/intentKind
  triple shape. Full 25-tool roster is incremental work.
- `apps/api/src/routes/__shared__/customer-intent-gateway.ts` (~215 LOC) —
  preserves the `CustomerEnvelope` narrowing + `detectForgery()` +
  Decision-handling switch shape from PART X.1 §9, now routing through
  `conductor.adjudicator`.
- `apps/api/src/routes/chat.ts` rewritten (291 → ~210 LOC) — POST opens
  capsule, runs `handleTurn`, streams to SSE. GET unchanged.
- `apps/api/src/routes/whatsapp-webhook.ts` rewritten (586 → ~165 LOC) —
  preserves Twilio signature, idempotency, rate-limit guards; delegates
  conversational logic to `conductor.openCapsule + handleTurn + wa.render`.
- `pnpm-workspace.yaml` — adds `../claustrum/packages/*` so `@claustrum/*`
  resolves via workspace symlinks during cutover. Falls through to npm in
  CI/prod.
- `apps/api/package.json` deps — adds `@claustrum/core`,
  `@claustrum/anthropic`, `@claustrum/channel-whatsapp`,
  `@claustrum/channel-web`, `@claustrum/memory-postgres`,
  `@claustrum/grounding-pgvector` as `workspace:*`.

**Migration path (8-step recipe for future adopters):**

1. **Tag a recovery point.** `git tag pre-claustrum-cutover` before any
   destructive change. The tag is local-only; preserve it on disk.
2. **Add `@claustrum/*` deps.** Either as `workspace:*` (sibling repo) or
   as published versions from npm. Run `pnpm install`.
3. **Write a `claustrum-bootstrap.ts`.** Compose a Conductor from
   provider impls. See ibatexas's bootstrap (~490 LOC) as reference, or
   `examples/minimal-chat/` in the claustrum repo for the bare minimum.
4. **Register tool packs.** For each existing tool handler, decide its
   `id` (versioned), `capability` (LLM-facing string), and `intentKind`
   (kernel-facing envelope.kind). Wrap in `makeTool({...})` and add to
   the registry. See `apps/api/src/tools/register-ibatexas-tool-packs.ts`.
5. **Rewrite routes as thin delegates.** Every route opens a capsule,
   calls `handleTurn`, renders via the channel driver, closes the
   capsule. Domain-specific guards (Twilio signature, idempotency, rate
   limit) stay in the route; conversational logic does not.
6. **Smoke ONE end-to-end turn BEFORE deletion.** Drive a real channel
   message; verify the audit trail (envelope → Decision → mutation →
   AuditRecord → rendered reply). This is C-07 in CUTOVER-STATUS.md.
7. **Delete the old runtime ONLY after smoke green.** Order matters:
   delete the legacy provider package, glue files, and workspace dep
   entries in one commit; verify typecheck before pushing.
8. **Update docs.** Append an ADR (like this one) explaining the cutover;
   delete or annotate now-stale ADRs that describe runtime concerns
   (#7 Hybrid State-Flow, #8 Conversation Persistence, #9 Zero-Trust LLM,
   #15 if applicable). Update `CLAUDE.md` to point at `@claustrum/*` for
   bot logic.

**Consequences:**

- **Bot evolution decouples from app evolution.** A prompt tweak now
  ships via `pnpm changeset` in the claustrum repo; ibatexas picks it up
  via `pnpm up '@claustrum/*'` when ready. No more "release the bot to
  fix a typo."
- **Adopters get the runtime for free.** A new application reuses the
  cognitive loop, channel drivers, memory, and grounding adapters by
  registering its own tool packs and tenant policy. Estimated boot wiring
  for a new adopter: ~150 LOC.
- **Kernel boundary is now type-enforced.** `Capsule.adjudicator` is the
  only path. Direct `import "@adjudicate/core"` from routes or packs is
  flagged by claustrum's ESLint config.
- **Audit-trail completeness improves.** Every LLM call now records a
  prompt manifest (`{ fragmentIds, hashes, totalTokens }`) — the old
  pipeline had no such record. Property test in `@claustrum/core` asserts
  "prompt manifest recorded in every LLM trace."
- **Old anti-patterns are documented.** See
  `docs/claustrum-migration/lessons-learned.md` for 7 anti-patterns mined
  from `packages/llm-provider/` via the recovery tag. Future adopters
  reading this ADR can follow that link to understand what NOT to do.
- **One-time cutover cost.** ~1 week of agent work (Phases 1-7); ~1
  smoke-test day for the user; ~1 PR review pass. Compare to: indefinite
  pain of every adopter forking the runtime.

**Files affected (this ADR's commit):**

- See "What was added" and "What was removed" lists above.
- Branch: `feat/claustrum-cutover` (NOT pushed at time of writing).
- Cutover commit: `4b6cb68`.
- Recovery tag: `pre-claustrum-cutover` (local-only).
- Migration history folder: `docs/claustrum-migration/` (5 files: README,
  CUTOVER-STATUS, lessons-learned, ibatexas-as-adopter, this draft ADR).

**Cross-link:**

- Claustrum repo: `BrunoRodolpho/claustrum` (Crick-Koch 2005 citation in
  README explains the intellectual frame distinguishing this from
  LangChain/CrewAI/AutoGen).
- Claustrum ADRs corresponding to migrated content:
  `claustrum/docs/architecture/decisions/0002-*.md` through `0005-*.md`
  (formerly ibatexas ADRs #7, #8, #9, #15).
- Reference adopter (proves claustrum is not ibatexas-specific):
  `claustrum/examples/healthcare-stub/` or `scheduling-stub/`.
- Conformance suite: `claustrum/packages/conformance/` — invariant tests
  that adopters run against their wiring. Drives PART IX §14.

**Related ADRs:**

- **ADR #14 (Adjudicate Cutover)** — sibling decision; same packaging
  model and rationale applied to the kernel. This ADR is the runtime
  counterpart.
- **ADR #7 (Hybrid State-Flow)** — superseded. The XState-based 4-layer
  pipeline lived in `packages/llm-provider/` and was the negative
  reference for claustrum's cognitive loop. See
  `claustrum/docs/architecture/decisions/0002-hybrid-state-flow.md` for
  the migrated full text and `docs/claustrum-migration/lessons-learned.md`
  §2 for what we learned not to repeat.
- **ADR #8 (Conversation Persistence via CDC)** — superseded by
  `@claustrum/memory-postgres`'s observe write path. Full text migrated
  to claustrum.
- **ADR #9 (Zero-Trust LLM)** — superseded by claustrum's capability/id
  split + sealed `Adjudicator` port. The principle survives; the
  implementation (TOOL_CLASSIFICATION, executeToolDirect) is gone. Full
  text migrated to claustrum.
- **ADR #4 (Three-Layer customerId Defense Model)** — still applies at
  the app layer. `customerId` injection in the tool registry now happens
  inside ibatexas's `register-ibatexas-tool-packs.ts` handlers.

## DRAFT ENDS ABOVE

---

## Notes for the user (not part of the ADR)

When you append this to `decisions.md`:

1. Strip the "DRAFT BEGINS BELOW" / "DRAFT ENDS ABOVE" markers.
2. Add a redirect breadcrumb after ADR #14 (per IMPL-09 Step 3) explaining
   that ADRs #7/8/9/15 moved to claustrum:
   ```markdown
   > Note on missing ADRs #7, #8, #9, #15: these decisions describe the
   > conversational runtime layer, extracted to standalone @claustrum/* as
   > of ADR #16. Full text preserved in claustrum/docs/architecture/decisions/.
   ```
3. Decide whether to **delete** the old ADRs #7/8/9/15 from `decisions.md`
   or leave them in place with a `> Superseded by ADR #16. Full text moved
   to claustrum.` banner. The master plan IMPL-09 Step 3 recommends
   deletion; the operator should choose based on git-blame readability
   preference.
4. Renumber `### 16` if your local `decisions.md` has diverged from the
   numbering assumed here.
5. Once incorporated, you can delete this draft file:
   `rm docs/claustrum-migration/ADR-16-DRAFT.md`. The rest of the folder
   (README, CUTOVER-STATUS, lessons-learned, ibatexas-as-adopter) is
   intended to persist as migration history.
