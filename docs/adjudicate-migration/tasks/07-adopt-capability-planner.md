# Task 07 — Adopt `orderCapabilityPlanner` + Add `safePlan` Guard

**Milestone:** M1 (LLM tool path completion)
**Estimated effort:** S — 1 dev-day
**Blocks:** 20 (test coverage for capability planner)
**Blocked by:** 01, 02, 06 (kernel must be plumbed and tool path complete before tightening the gate)
**Owner:** unassigned

## Objective

`orderCapabilityPlanner` is exported from `packages/llm-provider/src/capability-planner.ts:78` and from the package index but is dead code — no caller in IbateXas imports it. The prompt synthesizer calls `resolveTools()` directly with raw string arrays. After this lands, the plan-then-execute contract becomes authoritative: the synthesizer builds a `Plan` (with `visibleReadTools` + `allowedIntents`), the responder consults `plan.allowedIntents` for intent dispatch, and `safePlan` runs as a compile/runtime guard against mutating-tool leak or allowed-intent leak.

## Architecture context

Cite: investigation 01 §"Capability planner status" + recommendation #3.
> "`packages/llm-provider/src/capability-planner.ts` exports two things that matter: `resolveTools(stateValue, ctx)` — used by the prompt synthesizer ... `orderCapabilityPlanner` — the framework-shaped adapter ... but **never imported anywhere in the codebase**. The plan-then-execute contract is fully scaffolded but unused."

> "[P0, M] Adopt `orderCapabilityPlanner` in the prompt synthesizer and responder. Have `synthesizePrompt` build a `Plan` via `orderCapabilityPlanner.plan(stateValue, ctx)` and store it on `SynthesizedPrompt`. Have the responder consult `plan.allowedIntents` in the intent dispatch branch (`llm-responder.ts:251-457`). This makes the plan-then-execute contract authoritative and surfaces the planner as the single security-sensitive gate. Today the planner is dead code."

`safePlan` from `@adjudicate/core/llm` (investigation 05): runtime guard against mutating-tool leak + allowed-intent leak. Belongs at every planner registration.

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/capability-planner.ts` (orderCapabilityPlanner export)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/prompt-synthesizer.ts` (current resolveTools caller)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/llm-responder.ts:251-457` (intent dispatch branch)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/machine/types.ts:366-408` (TOOL_CLASSIFICATION)
- `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/llm/safe-plan.ts` (or whatever the path is — investigation 05 confirms `safePlan(planner, classification, pack?)` exists)

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/prompt-synthesizer.ts` — replace `resolveTools` direct calls with `orderCapabilityPlanner.plan(...)` wrapped in `safePlan(...)`. Store the resulting `Plan` on `SynthesizedPrompt`.
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/llm-responder.ts` — consume `plan.allowedIntents` in the intent-dispatch branch; if proposed intent kind is not in `allowedIntents`, refuse with a planner-violation refusal code.
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/capability-planner.ts` — wire `safePlan` at the planner registration site.

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/__tests__/capability-planner-adoption.test.ts`

## Constraints

- Must preserve the existing `resolveTools` behaviour for backwards compatibility — the `Plan.visibleReadTools` field should match what `resolveTools` returned before. Verify via a property test.
- Must define `allowedIntents` per state — the planner needs a state→intent-kinds mapping. Derive from the existing STATE_TOOLS table in `capability-planner.ts` PLUS the kernel-executor coverage from Task 06 (states where the deterministic kernel acts on behalf of the LLM).
- `safePlan` must reject any `Plan` whose `visibleReadTools` includes a MUTATING tool — this is the entire point of the guard. Wire it at the call site so violations fail fast at planner registration, not at dispatch time.
- pt-BR for any new user-facing refusal strings (planner-violation refusal).
- Follow CLAUDE.md rule #9 — the planner is the "single security-sensitive gate" for what the LLM can see.

## Implementation requirements

1. **Define state→allowedIntents** in `capability-planner.ts`:
   - For each state, declare the set of intent kinds the LLM is allowed to propose (e.g. `support` state allows `support.handoff`; `objection` state allows `followup.schedule`; `checkout.collecting_pix_details` allows nothing now that `set_pix_details` is READ_ONLY per Task 04).
   - Document each entry with a comment citing the corresponding STATE_TOOLS row.

2. **Use `safePlan` at planner export**:
   ```ts
   import { safePlan } from "@adjudicate/core/llm";
   import { TOOL_CLASSIFICATION } from "./machine/types.js";
   
   export const orderCapabilityPlanner = safePlan(
     /* the raw planner */ rawOrderCapabilityPlanner,
     TOOL_CLASSIFICATION,
     /* pack: optional, pass undefined if not yet adopted */ undefined,
   );
   ```
   `safePlan` returns a wrapped planner whose `.plan(...)` calls assert no MUTATING tools leak into `visibleReadTools`.

3. **Refactor `prompt-synthesizer.ts`** — replace `resolveTools(stateValue, ctx)` with `orderCapabilityPlanner.plan(stateValue, ctx)` and surface the `Plan` on the `SynthesizedPrompt` return type. The `availableTools` field becomes `plan.visibleReadTools`.

4. **Consume `plan.allowedIntents` in `llm-responder.ts`** — in the intent dispatch branch (lines 251-457), reject any envelope whose `kind` is not in `plan.allowedIntents`. Produce a `Refusal {code: "planner_violation", userFacing: "Não posso processar esta solicitação no momento.", kind: "policy"}` in pt-BR.

5. **Audit plan snapshot** — when emitting an audit record from the dispatch branch, include the `AuditPlanSnapshot` (`{visibleReadTools, allowedIntents, planFingerprint}`) per investigation 05's `buildAuditRecord` shape. This is one line: `plan: {visibleReadTools: plan.visibleReadTools, allowedIntents: plan.allowedIntents, planFingerprint: sha256Canonical(plan)}`.

6. **Tests:**
   - **capability-planner-adoption.test.ts:**
     - "orderCapabilityPlanner returns a Plan with both visibleReadTools and allowedIntents."
     - "safePlan rejects a planner that leaks a MUTATING tool into visibleReadTools" (build a deliberately-broken raw planner; assert safePlan throws).
     - "responder refuses intent kinds not in plan.allowedIntents" — drive a `tool_use` with a kind not in the current state's allowed list; assert refusal with code `planner_violation`.
     - "audit record includes planFingerprint" — assert the emitted record has `plan.planFingerprint` non-empty.

## Acceptance criteria

- [ ] `orderCapabilityPlanner` is no longer dead code — `prompt-synthesizer.ts` imports and uses it.
- [ ] `safePlan` wraps the raw planner; assertions fire on MUTATING-tool leak.
- [ ] `Plan.allowedIntents` is consulted in the intent dispatch branch.
- [ ] Audit records include `AuditPlanSnapshot`.
- [ ] Planner-violation refusal uses pt-BR text.
- [ ] All capability-planner-adoption tests pass.
- [ ] `pnpm --filter @ibatexas/llm-provider typecheck` passes.

## Testing requirements

- **Unit:** capability-planner-adoption.test.ts above.
- **Integration:** an existing scenario test should be extended to assert that the `Plan` is propagated end-to-end and matches the state.
- **Bypass-detection:** the `safePlan`-throws test above doubles as bypass detection — adding any MUTATING tool to the visible list fails the build/test.

## Rollout notes

Direct merge. The planner becoming authoritative is a defense-in-depth change — today the state-gate at `llm-responder.ts:235-243` already rejects tools not in the allowlist, so this task tightens the equivalent gate for intent kinds. Watch for any spike in `planner_violation` refusals in the first 24h post-deploy: indicates a state→allowedIntents mapping that's too restrictive. Tune via a follow-up.

## Rollback notes

Revert the PR. The synthesizer reverts to `resolveTools` direct calls; the responder stops consulting `allowedIntents`. The system returns to current production posture. ETA: <10 min. No data loss.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 07: adopt orderCapabilityPlanner and wire safePlan.

CONTEXT
Per investigation 01 (Capability planner status + recommendation #3) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/01-llm-tool-execution.md:
- orderCapabilityPlanner exists in packages/llm-provider/src/capability-planner.ts but is never imported anywhere
- The synthesizer calls resolveTools() directly — bypassing the framework's Plan {visibleReadTools, allowedIntents} contract
- Per investigation 05 (Tier 2 #13): safePlan(planner, classification, pack?) is a runtime guard against mutating-tool leak; belongs at every planner registration

Your job: make orderCapabilityPlanner authoritative, wire safePlan, and consume Plan.allowedIntents in the responder.

REPO LAYOUT
- packages/llm-provider/src/capability-planner.ts — orderCapabilityPlanner + resolveTools
- packages/llm-provider/src/prompt-synthesizer.ts — current resolveTools caller
- packages/llm-provider/src/llm-responder.ts — intent dispatch branch (lines 251-457)
- packages/llm-provider/src/machine/types.ts:366-408 — TOOL_CLASSIFICATION
- @adjudicate/core/llm exports: Plan, CapabilityPlanner, safePlan, assertPlanReadOnly, assertPlanSubsetOfPack, ToolClassification
- @adjudicate/core exports: sha256Canonical, AuditPlanSnapshot

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/llm-provider/src/capability-planner.ts (MODIFY — wire safePlan, define state→allowedIntents)
- packages/llm-provider/src/prompt-synthesizer.ts (MODIFY — call orderCapabilityPlanner.plan instead of resolveTools)
- packages/llm-provider/src/llm-responder.ts (MODIFY — consume plan.allowedIntents in intent dispatch)
- packages/llm-provider/src/__tests__/capability-planner-adoption.test.ts (CREATE)

WHAT TO BUILD

1. In capability-planner.ts:
   a) Define a STATE_ALLOWED_INTENTS map: Record<StateValue, ReadonlySet<string>>. For each state, list which intent kinds the LLM may propose. Examples (derive precise list from STATE_TOOLS):
      - support state → new Set(["support.handoff"])
      - objection state → new Set(["followup.schedule"])
      - checkout.collecting_pix_details → new Set() (set_pix_details is READ_ONLY per Task 04)
      - cart/browsing states → new Set() (deterministic kernel handles order.cart.* and order.checkout.create per Task 06)
   b) Rename the existing orderCapabilityPlanner export to rawOrderCapabilityPlanner (internal); have its .plan(stateValue, ctx) return {visibleReadTools: resolveTools(stateValue, ctx), allowedIntents: Array.from(STATE_ALLOWED_INTENTS[stateValue] ?? [])}.
   c) Re-export orderCapabilityPlanner = safePlan(rawOrderCapabilityPlanner, TOOL_CLASSIFICATION) from @adjudicate/core/llm. safePlan throws if any planner output's visibleReadTools intersects TOOL_CLASSIFICATION.MUTATING.

2. In prompt-synthesizer.ts:
   - Replace resolveTools(stateValue, ctx) with orderCapabilityPlanner.plan(stateValue, ctx)
   - Store the full Plan on SynthesizedPrompt (add a plan: Plan field to the type)
   - availableTools field continues to derive from plan.visibleReadTools (no change to downstream consumers)

3. In llm-responder.ts:
   - In the intent dispatch branch (lines 251-457), before calling adjudicate, check: if envelope.kind is not in synthesized.plan.allowedIntents, emit a refusal with code "planner_violation" (use refuse(...) factory; userFacing: "Não posso processar esta solicitação no momento." in pt-BR; kind: "policy")
   - When building the audit record (around lines 335-354), include a plan field: {visibleReadTools: synthesized.plan.visibleReadTools, allowedIntents: synthesized.plan.allowedIntents, planFingerprint: sha256Canonical(synthesized.plan)}

4. Tests in __tests__/capability-planner-adoption.test.ts:
   a) "orderCapabilityPlanner returns Plan with both fields" — invoke .plan("support", fakeCtx), assert result has visibleReadTools (array) AND allowedIntents (array including "support.handoff")
   b) "safePlan rejects MUTATING tool in visibleReadTools" — build a broken planner whose .plan returns {visibleReadTools: ["add_to_cart"], allowedIntents: []}, wrap with safePlan, assert calling .plan() throws PlanConformanceError
   c) "responder refuses intent kinds not in plan.allowedIntents" — drive a tool_use event for handoff_to_human while state is "browsing" (where support.handoff is NOT allowed); assert refusal with code planner_violation
   d) "audit record includes planFingerprint" — drive a normal flow; assert getAuditSink mock received a record with record.plan.planFingerprint as non-empty hex string

CONSTRAINTS
- Read CLAUDE.md rules 4, 9 first
- pt-BR for the refusal text
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT modify TOOL_CLASSIFICATION (Task 04 owns that)
- DO NOT modify @adjudicate/* source — only consume its exports

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] STATE_ALLOWED_INTENTS map defined and exported (or used internally) in capability-planner.ts
- [ ] orderCapabilityPlanner is wrapped in safePlan
- [ ] prompt-synthesizer.ts uses .plan(...) instead of resolveTools direct
- [ ] SynthesizedPrompt type includes plan: Plan field
- [ ] llm-responder.ts checks plan.allowedIntents before adjudicate
- [ ] Audit record includes plan.planFingerprint
- [ ] All 4 capability-planner-adoption tests pass
- [ ] `pnpm --filter @ibatexas/llm-provider typecheck` passes
- [ ] Existing tests (tool-registry.test.ts, scenario-runner.test.ts) still pass

When complete, return: files modified, test output, and the STATE_ALLOWED_INTENTS table you defined.
```
