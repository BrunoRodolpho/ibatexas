# Task 02 — Wire `onToolIntent` Callback

**Milestone:** M0 (Plumbing flip)
**Estimated effort:** S — 0.5–1 dev-day
**Blocks:** 03, 06, 07, 20 (depends on this for end-to-end LLM intent dispatch)
**Blocked by:** 01 (kernel bootstrap must exist so the dispatch path is real)
**Owner:** unassigned

## Objective

The `onToolIntent` callback at `packages/llm-provider/src/agent.ts:329` is currently undefined when `runAgent` calls `generateResponse`. The responder builds an `IntentEnvelope`, runs it through (currently legacy-EXECUTE) `adjudicate()`, fires `onToolIntent?.(result.intent)` at `llm-responder.ts:365`, and the callback is a no-op. After this lands, the callback dispatches the intent to actual command-service / tool handler code, so adjudicated EXECUTEs no longer silently drop. This is the single P0 blocker for the LLM-tool path: without it, the kernel saying "yes, run this" leads to nothing happening.

## Architecture context

Cite: investigation 01 P0 #1 — "Wire `onToolIntent` through `runAgent` → `generateResponse`. Today `agent.ts:329` calls `generateResponse({...})` without it. Until a consumer exists, every adjudicated EXECUTE result for an LLM-proposed mutating tool is a silent drop, and the audit stream is polluted with EXECUTE records that have no counterpart in the production tools layer."

The 3 tools that need the callback to fire today (per investigation 01):
- `set_pix_details` (depends on event-extraction; Task 04 fixes the classification)
- `handoff_to_human` (no deterministic kernel fallback)
- `schedule_follow_up` (only partial kernel coverage for `OBJECTION subtype="thinking"`)

The deterministic kernel-executor in `kernel-executor.ts` already covers cart/checkout/cancel/regenerate-pix paths via direct mutation calls (Task 06 wraps those in envelopes), so the immediate `onToolIntent` consumers are the 3 above.

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/agent.ts:56-377` (runAgent body)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/llm-responder.ts:553-751` (generateResponse signature + onToolIntent consumer)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/tool-registry.ts:354-431` (executeTool + executeToolDirect)

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/agent.ts` (lines 329-338: pass `onToolIntent` to `generateResponse`)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/llm-responder.ts` (only if the signature needs a Required<> tightening; otherwise no change)

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/intent-dispatcher.ts` (the new module that owns post-adjudication dispatch)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/__tests__/intent-dispatcher.test.ts`

## Constraints

- Must preserve current behaviour for tools the deterministic kernel already covers — do NOT double-execute. The dispatcher must skip dispatch for any intent kind that the kernel-executor handles deterministically (cart/checkout/cancel/regenerate-pix). Track this as an explicit allowlist of "needs LLM dispatch" intent kinds.
- Must follow CLAUDE.md rule #9 — the LLM never executes directly; the dispatcher runs the tool handler only after `adjudicate()` returned EXECUTE (or REWRITE with rewritten envelope).
- Must NOT use `executeToolDirect` from `tool-registry.ts` directly in the dispatcher — that export will be removed in Task 06. Use the underlying handler binding instead.
- pt-BR for any user-facing strings (none added in this task; the dispatcher returns programmatic results to the responder).

## Implementation requirements

1. **Create `intent-dispatcher.ts`** exporting:
   ```ts
   export type IntentDispatcher = (intent: ToolIntent, ctx: AgentContext) => Promise<DispatchResult>
   export type DispatchResult = { kind: "executed"; result: unknown } | { kind: "skipped"; reason: "deterministic_kernel_covers" } | { kind: "failed"; error: Error }
   export function createIntentDispatcher(deps: DispatcherDeps): IntentDispatcher
   ```
   - `deps` includes the tool handler registry (from `tool-registry.ts`'s `handlers` map), a logger, and the deterministic-coverage allowlist.
   - The allowlist of intent kinds the deterministic kernel already covers (skip dispatch):
     - `order.cart.add` / `order.cart.update` / `order.cart.remove` / `order.cart.get_or_create`
     - `order.checkout.create`
     - `order.cancel`
     - `order.pix.regenerate`
   - The allowlist of intent kinds the LLM dispatcher MUST handle (real dispatch):
     - `support.handoff` (handoff_to_human)
     - `followup.schedule` (schedule_follow_up — restore for non-OBJECTION reasons)
     - `pix.details.set` (after Task 04 reclassifies, this may be removed)
     - Any other intent kind classified MUTATING in `TOOL_CLASSIFICATION` but not in the deterministic allowlist.

2. **Modify `agent.ts:329`** to pass `onToolIntent`:
   ```ts
   const dispatcher = createIntentDispatcher({...});
   // existing call becomes:
   yield* generateResponse({
     ...,
     onToolIntent: async (intent) => {
       return dispatcher(intent, agentContext);
     },
   });
   ```

3. **Modify `llm-responder.ts`** at line 365 (`onToolIntent?.(result.intent)`) — change to await the dispatcher's result and incorporate any error into the synthetic `intent_registered` tool_result. If dispatch fails, surface a refusal-style tool_result so the LLM doesn't keep claiming success.

4. **Audit log integration** — after dispatch succeeds, emit an audit record with a `supersedes` link to the original decision's audit record, kind `EXECUTE`, basis `[basis("kernel", "intent_dispatched")]`. The `getAuditSink()` is already available in `llm-responder.ts`.

5. **Tests** (`__tests__/intent-dispatcher.test.ts`):
   - Dispatcher skips `order.cart.add` with reason `deterministic_kernel_covers`.
   - Dispatcher executes `support.handoff` and the handler in the registry is called.
   - Dispatch failure surfaces as `{kind: "failed", error}`.
   - End-to-end via `runAgent` mock: `onToolIntent` is passed and is invoked exactly once per EXECUTE decision.

## Acceptance criteria

- [ ] `intent-dispatcher.ts` exists with the API above.
- [ ] `agent.ts:329` constructs the dispatcher and passes it as `onToolIntent`.
- [ ] `llm-responder.ts:365` awaits the dispatch result and incorporates errors.
- [ ] When the deterministic kernel already covers an intent kind, dispatcher returns `{kind: "skipped"}` and does NOT call the handler twice.
- [ ] When the dispatcher executes `support.handoff`, the NATS event `support.handoff_requested` fires.
- [ ] Unit tests in `__tests__/intent-dispatcher.test.ts` pass.
- [ ] `pnpm --filter @ibatexas/llm-provider test` passes.

## Testing requirements

- **Unit:** dispatcher.test.ts above.
- **Integration:** add a test to `agent.test.ts` (or a new file `__tests__/agent-intent-dispatch.test.ts`) that runs `runAgent` end-to-end with a mocked Anthropic stream emitting a `handoff_to_human` tool_use, asserts the dispatcher fires, asserts the NATS publish stub captures `support.handoff_requested`.
- **Bypass-detection:** add a test that asserts: if a MUTATING tool intent is built but `onToolIntent` is missing, an audit record with `decision.kind === "EXECUTE"` is NEVER emitted. (Catches future regressions where someone unwires the callback.)

## Rollout notes

Shadow-first NOT applicable — this is plumbing. Direct merge to main. Behavioural change is enabling the 3 tools that today silently drop. Watch staff WhatsApp volume for the day of deploy (handoff_to_human flooding is investigation 08 P1 #4 — Task 14 adds the rate limit).

## Rollback notes

Revert the PR. The dispatcher disappears, `onToolIntent` reverts to undefined, and the 3 affected tools return to silent-drop behaviour (no regression vs current production). Rollback ETA: <5 min. No data loss — failed dispatches before rollback may have left half-completed handoff requests but the NATS subscriber dedups by sessionId.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 02: wire the onToolIntent callback.

CONTEXT
Per investigation 01 (P0 #1) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/01-llm-tool-execution.md, the LLM tool path is broken: packages/llm-provider/src/agent.ts:329 calls generateResponse() without passing onToolIntent, so adjudicated EXECUTE decisions vanish into a no-op. Your job is to author a real dispatcher and wire it.

REPO LAYOUT
- packages/llm-provider/src/agent.ts — runAgent (lines 56-377)
- packages/llm-provider/src/llm-responder.ts — generateResponse + intent dispatch branch (lines 251-457, 553-751)
- packages/llm-provider/src/tool-registry.ts — executeTool, handlers map (line 354-431)
- packages/llm-provider/src/machine/types.ts — TOOL_CLASSIFICATION
- packages/llm-provider/src/kernel-executor.ts — deterministic kernel that already covers cart/checkout/cancel paths

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/llm-provider/src/intent-dispatcher.ts (CREATE)
- packages/llm-provider/src/__tests__/intent-dispatcher.test.ts (CREATE)
- packages/llm-provider/src/agent.ts (MODIFY — wire dispatcher into generateResponse call at line 329)
- packages/llm-provider/src/llm-responder.ts (MODIFY — await dispatch result at line 365 and surface errors)
- packages/llm-provider/src/__tests__/agent.test.ts (MODIFY — add 1-2 cases for dispatcher wiring)

WHAT TO BUILD

1. intent-dispatcher.ts exports:
   - type DispatcherDeps = { handlers: Map<string, ToolHandler>, ctxBuilder: (intent) => ToolContext, log: Logger }
   - type DispatchResult = { kind: "executed", result: unknown } | { kind: "skipped", reason: "deterministic_kernel_covers" } | { kind: "failed", error: Error }
   - function createIntentDispatcher(deps: DispatcherDeps): (intent: ToolIntent, agentCtx: AgentContext) => Promise<DispatchResult>
   - const DETERMINISTIC_KERNEL_COVERAGE = new Set([
       "order.cart.add", "order.cart.update", "order.cart.remove", "order.cart.get_or_create",
       "order.checkout.create", "order.cancel", "order.pix.regenerate"
     ]) — see investigation 01 §"Bypass paths discovered" #3
   - Dispatcher logic:
     a) if intent.kind in DETERMINISTIC_KERNEL_COVERAGE → return {kind: "skipped"}
     b) else: look up handler, call it with intent.payload + ctx, return {kind: "executed", result} on success or {kind: "failed", error} on throw

2. agent.ts line 329: build the dispatcher inside runAgent (use the runtime ctx) and pass it as onToolIntent: async (intent) => dispatcher(intent, agentContext).

3. llm-responder.ts line 365: change `onToolIntent?.(result.intent)` to:
   ```
   const dispatchResult = await opts.onToolIntent?.(result.intent);
   if (dispatchResult?.kind === "failed") {
     // emit refusal-style synthetic tool_result; do NOT keep "intent_registered" optimism
   }
   ```
   Emit a supersession-linked audit record after successful dispatch (use getAuditSink().emit with supersedes: [originalRecord.intentHash]).

4. Tests in __tests__/intent-dispatcher.test.ts (vitest):
   - "skips intents the deterministic kernel covers" — assert order.cart.add returns skipped
   - "dispatches support.handoff" — mock handler, assert it's called with payload
   - "wraps handler errors" — handler throws, dispatcher returns {kind: "failed"}
   - "passes ctx through" — handler receives the ctx from ctxBuilder

5. agent.test.ts addition: end-to-end with mocked Anthropic stream emitting handoff_to_human tool_use; assert dispatcher invoked with intent kind support.handoff; assert NATS publish stub captures support.handoff_requested.

CONSTRAINTS
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT use executeToolDirect from tool-registry.ts (it's being removed in Task 06); use handlers map directly
- DO NOT modify TOOL_CLASSIFICATION, kernel-executor.ts, tool-registry.ts, or any file under packages/tools
- Read CLAUDE.md rules 3 and 9 first

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] intent-dispatcher.ts exists and exports createIntentDispatcher + DispatchResult
- [ ] DETERMINISTIC_KERNEL_COVERAGE contains the 7 kinds listed above
- [ ] agent.ts:329 passes onToolIntent as a real (non-undefined) callback
- [ ] llm-responder.ts:365 awaits dispatch result and degrades to refusal on failure
- [ ] Unit tests pass: `pnpm --filter @ibatexas/llm-provider test intent-dispatcher`
- [ ] agent.test.ts dispatch case passes
- [ ] `pnpm --filter @ibatexas/llm-provider typecheck` passes
- [ ] No call sites of executeToolDirect added

When complete, return: files created/modified, test output, and confirmation that the deterministic kernel path is NOT double-executed for cart/checkout/cancel intents.
```
