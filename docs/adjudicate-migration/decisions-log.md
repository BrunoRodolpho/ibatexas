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

## D6 — F2 DEFERRED to morning review
**Why:** F2 requires modifying `@adjudicate/core/basis-codes.ts` in the sibling repo at `/Users/thaisrodolpho/projects/adjudicate/`. That repo is currently dirty: branch `claude/unruffled-bassi-305034` has uncommitted modifications across multiple `packages/*/package.json` files (~5+ unstaged changes). Touching adjudicate framework code on top of in-progress framework work would mix concerns and risks an incident I can't ask the user about overnight.
**How to apply:** Mark F2 as DEFERRED in `current-state.md`. The audit-supersession-link consequence (task 02 deviation) remains unfixed — but task 02's existing audit emission still preserves traceability per its self-report. Add to morning review queue.

## D5 — F4 `Plan.forbiddenConcepts`: dropped from the framework Plan shape
**Why:** The framework `Plan` interface (`@adjudicate/core/src/llm/planner.ts`) is intentionally minimal — `visibleReadTools` and `allowedIntents` are the load-bearing security fields the bridge enforces. `forbiddenConcepts` was IbateXas-specific cosmetic prompt-rendering data; keeping it on `Plan` would mean every adopter has to think about it. The PromptRenderer already calls `getForbiddenConceptsFor(stateValue)` directly from `capability-planner.ts` — that's the canonical path.
**How to apply:** When adapting an IbateXas-specific concern to the framework `Plan` interface, keep cosmetic/rendering state out of `Plan` and expose it as a separate exported function the renderer can call.

## D7 — Task 07 STATE_TOOLS partition: mutating tools move to `allowedIntents`, union preserves LLM visibility
**Why:** The pre-task-07 `STATE_TOOLS` table mixed READ tools (e.g. `search_products`) with MUTATING tools (e.g. `handoff_to_human`, `schedule_follow_up`) in a single per-state visible list — both surfaces the LLM sees when planning a turn. The framework's `Plan` interface (`@adjudicate/core/src/llm/planner.ts`) splits these: `visibleReadTools` (READ tools callable directly) vs `allowedIntents` (mutating intent identities proposable via the bridge). `safePlan` (the runtime guard wired in this task) asserts `visibleReadTools ∩ TOOL_CLASSIFICATION.MUTATING = ∅` — so leaving the mixed list as-is would throw on every `.plan()` call.

Two options on the table:

  - **(A)** Strip mutating tools from each state's visible list entirely (smallest set — the LLM would no longer see `handoff_to_human` in `support`, breaking the human-handoff flow).
  - **(B)** Partition the mixed list at planner time: MUTATING entries become `allowedIntents`, READ entries become `visibleReadTools`. The PromptSynthesizer concatenates both into a `SynthesizedPrompt.availableTools` union — the LLM-visible surface stays identical to today, the framework split is satisfied, and `safePlan` does not throw.

Picked (B) — the constraint in task 07 is "preserve existing visible-tool behavior" and "pick the safer (smaller visible set) option." Option (B) preserves behavior exactly while satisfying the framework invariant; option (A) would silently degrade the support and objection flows (removing `handoff_to_human` and `schedule_follow_up` from the LLM's tool-call surface), which is a regression dressed up as a security win.

**How to apply:** New mutating tools added to a state's tool list will surface in `Plan.allowedIntents` automatically via `partitionTools` (in `packages/llm-provider/src/capability-planner.ts`). The state-gate in `llm-responder.ts:processToolCalls` continues to ingress-filter against the `availableTools` union; the new planner-violation gate (also in `llm-responder.ts`) refuses any mutating proposal whose identity is not in `plan.allowedIntents`. When a future state adds a mutating tool to its STATE_TOOLS row, the LLM sees it AND the planner allows the proposal — no code change required.

## D8 — Task 15 command-service chokepoints: parallel envelope-typed surface (option A), not breaking replacement (option B)
**Why:** Task 15's full scope is breaking — replacing every service method signature with `IntentEnvelope<*>` requires migrating every caller (admin routes, customer routes, jobs, subscribers, the Medusa wrapper) in lockstep. Those callers are owned by separate M3 tasks (12 Stripe webhook, 13 admin routes, 14 customer routes, 16 NATS subscribers, 17 Medusa subscriber wrapper) — none of which are merged yet. A breaking-replacement landing would leave the workspace red until all those tasks land, which is exactly the all-or-nothing M3 risk the migration plan explicitly tries to avoid.

Two options on the table:

  - **(A)** Parallel surface — keep the bare-arg methods (marked `@deprecated`), add new `*FromEnvelope` methods that flow through `withAdjudicate`. Callers migrate one at a time.
  - **(B)** Breaking replacement — change every method signature to take an envelope only. Every caller must migrate before this PR can land.

Picked **(A)**. Each service method now has BOTH surfaces:

  - `orderCmdSvc.transitionStatus(id, input)` — legacy, `@deprecated`, unchanged behaviour.
  - `orderCmdSvc.transitionStatusFromEnvelope(envelope)` — envelope-typed, kernel-gated.

The `withAdjudicate` helper (`packages/domain/src/services/__shared__/with-adjudicate.ts`) wraps the existing imperative executor with adjudicate + audit emit, so the new path runs the SAME Prisma logic — only the entry surface changes.

**How to apply:** New callers built by tasks 12-14, 16, 17 use the `*FromEnvelope` surface exclusively. They build envelopes via `buildEnvelope({kind, payload, nonce: randomUUID(), actor, taint})` from `@adjudicate/core` and route through the new methods. After all M3 caller migrations land, a follow-up sweep removes the legacy bare-arg methods. The bypass-detection test at `packages/domain/src/services/__tests__/no-direct-prisma-bypass.test.ts` guards against future regressions of the 3 rogue cart-writer consolidations (investigation 03 P0 #2). 99 backwards-compat tests + 28 new envelope-targeted tests + 8 bypass-detection tests all pass at HEAD.

## D9 — W2/P1-F: REMOVE `slot.released` signal vs. IMPLEMENT publisher
**Why:** `@ibatexas/pack-reservations` declared a `slot.released` DEFER signal and a `deferOnSlotFull` state guard that parked `reservation.modify` envelopes when the new slot was at capacity. The intent was that a `reservation.cancel` or `reservation.no_show` event would later free covers on that slot, fire a `slot.released` wire event, and the kernel would re-adjudicate the parked envelope.

**No publisher existed anywhere in the codebase.** The reservation cancel route (`apps/api/src/routes/admin/reservations.ts`) and the (planned) no-show job never fired `slot.released`. No defer-resolver subscriber listened for it either. Parked envelopes silently TTL'd after 30 minutes (`RESERVATION_SLOT_RELEASED_TIMEOUT_MS`) — the customer who tried to modify their reservation got a "we'll let you know" response that never resolved.

Two options on the table:

  - **(A)** IMPLEMENT: write the publisher (NATS event on cancel + no-show carrying the freed slot id) AND the resolver subscriber (subscribe to `slot.released`, drain matching parked envelopes, re-adjudicate). Add end-to-end tests for the round-trip.
  - **(B)** REMOVE: delete the signal constant + DEFER guard. Replace the guard with a REFUSE so `reservation.modify` against a full new slot rejects immediately with a clear "slot full" message instead of a stuck wait.

Picked **(B) REMOVE.** Rationale:

  - W2 scope is correctness fixes, not feature implementation. Implementing the publisher + subscriber + tests would expand W2 by ~500 LOC of net-new infrastructure.
  - The pre-W2 behaviour was a silent loss after 30 minutes — the customer never knew their modify request had stalled. A REFUSE is strictly better UX: the customer gets a meaningful "slot esgotado" pt-BR rejection and can choose a different slot or join the waitlist immediately.
  - The feature can re-land cleanly when modify-on-slot-released is genuinely on the roadmap. Future work owns: publisher in reservation cancel + no-show handlers, resolver subscriber, end-to-end test for the round-trip.

**How to apply:** Removed `RESERVATION_SLOT_RELEASED_SIGNAL` + `RESERVATION_SLOT_RELEASED_TIMEOUT_MS` exports from `pack-reservations`. Removed `deferOnSlotFull` guard. Added `refuseModifyOnFullNewSlot` state guard that REFUSEs with code `reservation.slot.full` when `state.ctx.newSlot.reservedCovers >= newSlot.maxCovers`. `reservationsPack.signals` is now an empty array. Conformance fixtures + reservations-pack tests updated to expect REFUSE (with `reservation.slot.full` code) instead of DEFER. When the feature re-lands, this commit must be reverted before re-adding the guard.

## D10 — W5/W5-7: `medusa.*` namespace EXCLUDED from `KNOWN_INTENT_KINDS`
**Why:** `packages/tools/src/medusa/adjudicated.ts` declares 13 intent kinds (`medusa.admin.order.{edit.confirm,edit.items,edit.create,cancel,update_metadata}`, `medusa.cart.{line_items.update,line_items.remove,line_items.add,promotion.apply,complete,update,create}`, `medusa.payment_collection.create`). These are emitted by `medusaAdjudicated()` — the inline minimal-policy wrapper around the Medusa REST proxy, used by amend-order, reorder, and a handful of admin routes. They are NOT in the master taxonomy at `governance/01-intent-taxonomy.md`.

The audit 07 §"medusa.* namespace" classification labels them "NOT-IN-SCOPE — operates one layer below domain intents." The choice is whether to include them in `KNOWN_INTENT_KINDS`:

Two options on the table:

  - **(A) INCLUDE**: add the 13 kinds to `KNOWN_INTENT_KINDS` so `validateEnforceConfig` accepts them in `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE`. Treats them as first-class kinds in the typo gate.
  - **(B) EXCLUDE**: leave them out. The kernel boot does not validate them; their inline policy in `adjudicated.ts` is the sole gate.

Picked **(B) EXCLUDE.** Rationale:

  - The `medusa.*` kinds are not user-facing intents — they are an egress-translation contract (LLM tool intent → Medusa HTTP write) one layer below the customer-facing taxonomy. Surfacing them as flippable `IBX_KERNEL_ENFORCE` values would imply operators are expected to gradually enable enforcement per-kind for them, which is not the design intent: `medusaAdjudicated()` already enforces them unconditionally via the inline policy, independent of the kernel rollout.
  - Including them would inflate the typo-gate set without adding any safety. The typo gate exists to catch `IBX_KERNEL_ENFORCE=order.cart.adddd` (one-letter typo in a customer-facing kind). It does NOT exist to validate internal egress wrappers.
  - Future evolution: when amend-order / reorder migrate to typed envelopes against pack-orders' new `order.amend.{add_item,update_qty,remove_item}` kinds (W5-2), the `medusa.*` kinds become DEAD code and can be retired entirely. Until then, they remain governed inline.

**How to apply:** `packages/llm-provider/src/intent-kinds.ts` documents the exclusion at the top of the file. `KNOWN_INTENT_KINDS` is constructed from the 5 first-party + 1 platform Pack unions only. The `intent-kinds.test.ts` asserts the exclusion (3 sample `medusa.*` kinds → `KNOWN_INTENT_KINDS.has() === false`). If the `medusa.*` policy stops being self-contained — e.g., if `IBX_KERNEL_ENFORCE` rollout per-kind matters for them — revisit this decision; the typo gate is the natural place.
