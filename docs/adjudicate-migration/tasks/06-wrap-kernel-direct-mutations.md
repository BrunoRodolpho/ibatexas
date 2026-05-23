# Task 06 — Wrap Kernel-Direct Mutations in IntentEnvelopes

**Milestone:** M1 (LLM tool path completion)
**Estimated effort:** M — 3–5 dev-days
**Blocks:** 07 (capability planner adoption depends on these mutations being envelope-wrapped)
**Blocked by:** 01, 02, 03 (kernel must be bootable, dispatcher and DEFER must work)
**Owner:** unassigned

## Objective

Wrap the four kernel-direct mutation calls in `IntentEnvelope`s so they pass through `adjudicate()` instead of writing directly to Medusa/Stripe/Redis/NATS:
- `addItemToCart` (kernel-executor.ts:282)
- `processCheckout` (kernel-executor.ts:366)
- `cancelOrderAction` (kernel-executor.ts:425)
- `regeneratePixAction` (kernel-executor.ts:449)

After this lands, the deterministic XState kernel ALSO routes its mutations through the adjudicate kernel — closing the largest LLM-tool-path bypass identified in investigation 01 P0 #3. Also: remove the `executeToolDirect` export from `tool-registry.ts` to prevent future callers from bypassing the bridge.

## Architecture context

Cite: investigation 01 P0 #3 + P2 #5.
> "Deterministic kernel writes bypass `adjudicate()` entirely. `executeKernel` calls `addItemToCart`, `processCheckout`, `cancelOrderAction`, `regeneratePixAction`, etc. directly from `machine/actions.ts` ... These are real mutations on Medusa / Stripe / Redis / NATS, but they are never wrapped in an envelope, never adjudicated, never audited via `@adjudicate/audit`."
> "`executeToolDirect` ignores intent classification (`tool-registry.ts:414-431`). This exists for 'the kernel executor path' but the kernel never actually calls it; only tests do. Still, it is exported from the package index and any future caller will execute mutating tools without auditing."

These four mutations form the primary cart/checkout/cancel/PIX-regen flow. Wrapping them is the single highest-leverage change for LLM-tool-path governance — it brings the deterministic XState kernel under the same adjudicate authority as the LLM-proposed path.

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/kernel-executor.ts` (lines 282, 366, 425, 449 — the 4 mutation call sites)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/machine/actions.ts` (the action implementations)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/order-policy-bundle.ts` (the policy bundle that must accept these intent kinds)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/tool-registry.ts:414-431` (executeToolDirect to remove)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/intent-dispatcher.ts` (from Task 02 — extend its DETERMINISTIC_KERNEL_COVERAGE allowlist for the audit trail)

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/kernel-executor.ts` — wrap each of the 4 call sites in `buildEnvelope() + adjudicate() + dispatch`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/order-policy-bundle.ts` — ensure the policy bundle has guards for the 4 intent kinds: `order.cart.add`, `order.checkout.create`, `order.cancel`, `order.pix.regenerate`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/tool-registry.ts` — remove `executeToolDirect` export (mark `@internal` if any tests need it, move to a non-exported module)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/index.ts` — remove `executeToolDirect` from the public re-exports

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/kernel-executor-envelopes.ts` (helper: builds the 4 envelopes given XState event payload)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/__tests__/kernel-executor-envelopes.test.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/__tests__/kernel-executor-adjudicate.test.ts`

## Constraints

- Must preserve XState semantics — the existing kernel-executor flow `routeMessage → executeKernel → persistMachineState` must continue to work. Wrapping is INSIDE the executor's action calls, NOT around them.
- Must handle non-EXECUTE outcomes:
  - **REFUSE:** kernel-executor must surface a refusal back into the XState context (e.g. set `context.lastError`) and SHORT-CIRCUIT — do NOT run the deterministic mutation.
  - **DEFER:** park the envelope via the same `parkDeferredIntent` path the responder uses (`llm-responder.ts:384-406`). Set `context.deferredIntentParked = true`.
  - **REWRITE:** execute the rewritten envelope (Decision.rewritten), not the original.
  - **EXECUTE / REQUEST_CONFIRMATION / ESCALATE:** as today (EXECUTE proceeds; CONFIRMATION/ESCALATE branches need new logic — short-circuit + audit).
- Must use the `system` taint when the actor is the kernel itself (route-driven, not LLM-proposed). `IntentActor.principal = "system"`, `taint = "SYSTEM"`.
- Must NOT double-execute when the LLM ALSO proposed the intent. The intent dispatcher's `DETERMINISTIC_KERNEL_COVERAGE` set (Task 02) already skips these kinds — confirm the audit-supersedes link makes the audit trail readable.
- Follow CLAUDE.md rule #9 — the kernel-executor's actor identity is `system`, not `llm`.
- pt-BR for any user-facing refusal text that surfaces back through the XState `context.lastError`.

## Implementation requirements

1. **Author `kernel-executor-envelopes.ts`** with four factory functions:
   - `buildAddItemEnvelope(payload, ctx): IntentEnvelope<"order.cart.add", AddItemPayload>`
   - `buildCheckoutEnvelope(payload, ctx): IntentEnvelope<"order.checkout.create", CheckoutPayload>`
   - `buildCancelOrderEnvelope(payload, ctx): IntentEnvelope<"order.cancel", CancelPayload>`
   - `buildRegeneratePixEnvelope(payload, ctx): IntentEnvelope<"order.pix.regenerate", RegenPayload>`
   Each calls `buildEnvelope` from `@adjudicate/core` with `actor.principal = "system"`, `taint = "SYSTEM"`, `sessionId` from XState ctx.

2. **Refactor `kernel-executor.ts`** — for each of the 4 call sites (lines 282, 366, 425, 449), replace:
   ```ts
   await addItemToCart(payload);
   ```
   with:
   ```ts
   const envelope = buildAddItemEnvelope(payload, ctx);
   const decision = await adjudicate(envelope, orderState, orderPolicyBundle);
   await emitAuditRecord(envelope, decision);
   switch (decision.kind) {
     case "EXECUTE": await addItemToCart(payload); break;
     case "REWRITE": await addItemToCart(extractRewrittenPayload(decision.rewritten)); break;
     case "REFUSE": ctx.lastError = decision.refusal.userFacing; return;
     case "DEFER": await parkDeferredIntent({...}); ctx.deferredIntentParked = true; return;
     case "REQUEST_CONFIRMATION":
     case "ESCALATE":
       ctx.lastError = "Esta operação requer confirmação adicional. Por favor, aguarde."; // pt-BR
       return;
   }
   ```

3. **Update `order-policy-bundle.ts`** — ensure each of the 4 intent kinds has a corresponding state/business guard. If guards exist for LLM-proposed equivalents (e.g. `order.tool.propose` payloads), refactor them to handle both LLM and system actors. Add a separate `taintPolicy` rule allowing `SYSTEM` taint for these four kinds.

4. **Remove `executeToolDirect`** — delete the export from `tool-registry.ts` and `index.ts`. If tests reference it, move the function to `packages/llm-provider/src/__tests__/helpers/test-only-executors.ts` (test-only, no production import). Verify with `grep -rn "executeToolDirect" packages/ apps/` returns zero hits outside the test helper.

5. **Audit-supersedes link** — when the kernel-executor adjudicates a mutation that the LLM ALSO proposed in the same turn (Task 02's dispatcher would have skipped it), emit the audit record with `supersedes: [llmIntentHash]` so the chain is reconstructable.

6. **Tests:**
   - **kernel-executor-envelopes.test.ts:** each factory produces the expected envelope shape (kind, actor.principal=system, taint=SYSTEM).
   - **kernel-executor-adjudicate.test.ts:** for each of the 4 call sites:
     - EXECUTE decision: mutation runs as before.
     - REFUSE decision: mutation does NOT run; `ctx.lastError` set.
     - DEFER decision: mutation does NOT run; parked envelope key written.
     - REWRITE decision: mutation runs with rewritten payload, not original.

## Acceptance criteria

- [ ] Four kernel-executor call sites are wrapped in `buildEnvelope() + adjudicate() + branch on decision`.
- [ ] On REFUSE, the deterministic mutation does NOT run.
- [ ] On DEFER, the envelope is parked via the same path the responder uses.
- [ ] On REWRITE, the rewritten payload is executed (not the original).
- [ ] `order-policy-bundle.ts` has guards covering all 4 intent kinds for both `llm` and `system` actors.
- [ ] `executeToolDirect` is no longer exported from `@ibatexas/llm-provider`.
- [ ] All new tests pass.
- [ ] Existing kernel-executor tests still pass (no regression in the deterministic flow when decisions are EXECUTE).
- [ ] `pnpm --filter @ibatexas/llm-provider typecheck` passes.

## Testing requirements

- **Unit:** the two new test files above.
- **Integration:** add an end-to-end test that runs the full ADD_ITEM → CHECKOUT → CANCEL → REGEN flow with envelope wrapping, asserts each emits one audit record, and asserts the resulting Medusa cart state is correct.
- **Bypass-detection:** add a test that asserts `executeToolDirect` is no longer in the public exports of `@ibatexas/llm-provider` — fails if someone re-exports it.

## Rollout notes

This is a behaviour change in shadow mode. Land BEHIND the `IBX_KERNEL_SHADOW` env var:
- First deploy with `IBX_KERNEL_SHADOW=order.cart.add,order.checkout.create,order.cancel,order.pix.regenerate` and `IBX_KERNEL_ENFORCE=` (empty).
- Shadow mode runs the kernel alongside the legacy direct-call and compares; divergences emit `audit_kernel_shadow_diverged_*` events (now wired up via Task 05).
- After 7+ days of clean shadow, flip `IBX_KERNEL_ENFORCE` to include the 4 kinds per runbook 02 (`02-stage-cart-mutations.md`).

## Rollback notes

If shadow-mode divergence is high or enforcement reveals a policy bug, rollback options:
1. **Soft rollback:** unset `IBX_KERNEL_ENFORCE` for the affected kinds (5-min env-var change + redeploy). Falls back to shadow-only — mutations execute legacy-direct.
2. **Hard rollback:** revert the PR. Restores direct mutation calls. ETA: 10–15 min. No data loss; in-flight envelopes are completed legacy-direct after rollback.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 06: wrap kernel-direct mutations in IntentEnvelopes.

CONTEXT
Per investigation 01 (P0 #3) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/01-llm-tool-execution.md:
- packages/llm-provider/src/kernel-executor.ts calls addItemToCart (line 282), processCheckout (line 366), cancelOrderAction (line 425), regeneratePixAction (line 449) DIRECTLY
- None pass through adjudicate() — they write to Medusa/Stripe/Redis/NATS without policy review or audit
- This bypasses the entire kernel for the primary cart/checkout/cancel/PIX-regen path

Also (P2 #5): executeToolDirect is exported from tool-registry.ts and lets future callers bypass the intent bridge. Remove it.

REPO LAYOUT
- packages/llm-provider/src/kernel-executor.ts — the 4 direct calls
- packages/llm-provider/src/machine/actions.ts — addItemToCart, processCheckout, cancelOrderAction, regeneratePixAction implementations
- packages/llm-provider/src/order-policy-bundle.ts — the policy bundle
- packages/llm-provider/src/tool-registry.ts:414-431 — executeToolDirect (to remove)
- packages/llm-provider/src/index.ts — public re-exports
- packages/llm-provider/src/intent-dispatcher.ts — from Task 02; DETERMINISTIC_KERNEL_COVERAGE already lists these 4 kinds
- @adjudicate/core exports: buildEnvelope, adjudicate, parkDeferredIntent
- @adjudicate/audit exports: buildAuditRecord

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/llm-provider/src/kernel-executor.ts (MODIFY — wrap 4 call sites)
- packages/llm-provider/src/kernel-executor-envelopes.ts (CREATE — envelope factories)
- packages/llm-provider/src/order-policy-bundle.ts (MODIFY — add guards for the 4 intent kinds covering both llm and system actors)
- packages/llm-provider/src/tool-registry.ts (MODIFY — remove executeToolDirect export)
- packages/llm-provider/src/index.ts (MODIFY — remove executeToolDirect from re-exports)
- packages/llm-provider/src/__tests__/helpers/test-only-executors.ts (CREATE — relocate executeToolDirect for tests that still need it)
- packages/llm-provider/src/__tests__/kernel-executor-envelopes.test.ts (CREATE)
- packages/llm-provider/src/__tests__/kernel-executor-adjudicate.test.ts (CREATE)

PHASES

Phase A — Envelope factories:
1. kernel-executor-envelopes.ts exports four functions: buildAddItemEnvelope, buildCheckoutEnvelope, buildCancelOrderEnvelope, buildRegeneratePixEnvelope. Each builds an IntentEnvelope with actor.principal="system", taint="SYSTEM", sessionId from XState ctx.
2. Intent kinds: order.cart.add, order.checkout.create, order.cancel, order.pix.regenerate
3. Tests in kernel-executor-envelopes.test.ts: assert each factory produces the expected kind/actor/taint shape.

Phase B — Policy bundle guards:
4. In order-policy-bundle.ts, ensure each of the 4 intent kinds has at minimum a state guard, business guard, and taint policy entry. The taint policy must allow SYSTEM taint for these 4 kinds (use createSystemTaintPolicy from @adjudicate/primitives or extend the existing taint policy).
5. If guards exist for LLM-proposed equivalents (TOOL_PROPOSE-shaped envelopes), refactor to accept both actor principals.

Phase C — Kernel-executor wrapping:
6. For each of the 4 sites in kernel-executor.ts:
   - Build envelope via the factory
   - Call adjudicate(envelope, orderState, orderPolicyBundle)
   - Emit audit record via getAuditSink().emit (use the same wiring intent-audit-wiring.ts already exposes)
   - Branch on decision.kind:
     * EXECUTE → call original mutation with payload
     * REWRITE → call original mutation with decision.rewritten payload (extract from envelope)
     * REFUSE → set ctx.lastError to decision.refusal.userFacing (pt-BR), short-circuit
     * DEFER → call parkDeferredIntent with the envelope; set ctx.deferredIntentParked = true; short-circuit
     * REQUEST_CONFIRMATION / ESCALATE → set ctx.lastError to pt-BR explanation, short-circuit
7. Audit supersession: if the LLM proposed this intent in the same turn (check ctx.llmProposedIntentHash if present), emit audit record with supersedes: [llmIntentHash].

Phase D — Remove executeToolDirect:
8. Delete executeToolDirect from tool-registry.ts. If any test imports it, move the function (renamed to executeToolForTest) into __tests__/helpers/test-only-executors.ts and update test imports.
9. Remove from packages/llm-provider/src/index.ts re-exports.
10. Verify: `grep -rn "executeToolDirect" packages/ apps/` returns ZERO hits outside __tests__/helpers/.

Phase E — Tests:
11. kernel-executor-adjudicate.test.ts: for each of the 4 call sites, four sub-tests covering EXECUTE / REFUSE / DEFER / REWRITE decisions. Use vi.mock to control adjudicate's return value; assert the underlying mutation function is called (or not) appropriately.
12. Add a bypass-detection test in __tests__/no-execute-tool-direct.test.ts that imports from "@ibatexas/llm-provider" and asserts executeToolDirect is NOT in the exports.

CONSTRAINTS
- Read CLAUDE.md rules 4, 9, 10 first
- pt-BR for user-facing refusal text (ctx.lastError values)
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT modify packages/tools/* (the underlying mutation functions stay unchanged)
- DO NOT modify the intent-dispatcher's DETERMINISTIC_KERNEL_COVERAGE — it already lists these 4 kinds
- Preserve existing kernel-executor public API surface (persistMachineState, executeKernel signatures unchanged)

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] 4 envelope factories in kernel-executor-envelopes.ts
- [ ] 4 kernel-executor call sites wrapped with adjudicate() + branching
- [ ] REFUSE/DEFER/REWRITE/CONFIRMATION/ESCALATE branches each handled
- [ ] order-policy-bundle.ts has guards for all 4 intent kinds, both llm and system actors
- [ ] executeToolDirect removed from public exports; bypass-detection test passes
- [ ] All new tests pass: `pnpm --filter @ibatexas/llm-provider test kernel-executor`
- [ ] Existing kernel-executor tests still pass
- [ ] `pnpm --filter @ibatexas/llm-provider typecheck` passes

When complete, return: files modified, test output, and confirmation that the 4 mutation paths now flow through adjudicate() with shadow-mode telemetry visible (assuming Task 05's metrics sink is installed).
```
