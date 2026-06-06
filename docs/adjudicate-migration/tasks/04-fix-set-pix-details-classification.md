# Task 04 — Fix `set_pix_details` Classification

**Milestone:** M0 (Plumbing flip)
**Estimated effort:** S — 0.5 dev-day
**Blocks:** 14 (the customer mutation routes for payment-method touch the same code path)
**Blocked by:** none (independent of 01 — can land in parallel)
**Owner:** unassigned

## Objective

Reclassify `set_pix_details` from MUTATING to READ_ONLY so the tool's structured `{event: "PIX_DETAILS_COLLECTED", payload}` return value is extracted via the existing `onToolEvent` path (currently only the `kind === "result"` branch extracts events; the intent branch does not). The tool does no mutation — it validates customer-supplied PIX details (name, email, CPF) and emits a state-machine event the kernel needs to inject. Today this is silently broken: MUTATING tools take the intent branch, intent is dropped, event is lost, PIX checkout cannot collect details via the LLM path.

## Architecture context

Cite: investigation 01 P0 #2.
> "**P0 — `set_pix_details` event lost** (`tool-registry.ts:372-401` + `llm-responder.ts:251-457`). The tool returns a structured `{event:"PIX_DETAILS_COLLECTED"}` payload that the agent expects to inject into the machine via `onToolEvent`. But MUTATING tools never reach the `kind==="result"` branch where event extraction happens... Either the tool needs to be reclassified as READ_ONLY (it does no mutation, only validates), or the intent branch needs to extract events too. **Recommended: reclassify**, because the tool's name implies mutation but the implementation is pure."

The relevant tool implementation at `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/cart/set-pix-details.ts` is validation-only — no DB write, no Redis write, no NATS event. It returns `{event: "PIX_DETAILS_COLLECTED", payload}`.

PII concern: the tool input contains `{name, email, cpf}`. After reclassification, the responder logs the result for the LLM via `sanitizeToolResultForLLM` which masks CPF/email — that protection is preserved. The kernel audit pipeline is not on this path (READ_ONLY tools don't produce IntentEnvelopes), but Task 18 will land the global `AuditRedactor` for any envelope-bearing intents that include PII.

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/cart/set-pix-details.ts` (the tool — confirm it's pure)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/machine/types.ts:366-408` (TOOL_CLASSIFICATION)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/llm-responder.ts:466-469` (where READ_ONLY tool events get extracted via `onToolEvent`)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/agent.ts` (search for `onToolEvent` consumer that injects events into XState)

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/machine/types.ts` — move `set_pix_details` from `TOOL_CLASSIFICATION.MUTATING` to `TOOL_CLASSIFICATION.READ_ONLY`

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/__tests__/set-pix-details-classification.test.ts`

## Constraints

- Must preserve PII protection — confirm `sanitizeToolResultForLLM` still masks CPF/email when the tool returns from READ_ONLY branch.
- Must NOT actually move the tool's implementation; only the classification.
- Verify the tool truly performs no mutation by reading `set-pix-details.ts` start-to-finish. If it does write to Redis/Postgres anywhere, ABORT and reclassify back to MUTATING with a different fix (mirror event-extraction into the intent branch in `llm-responder.ts`).
- pt-BR strings in tool descriptions/refusals already exist; no change.
- Follow CLAUDE.md rule #9 — the LLM still doesn't mutate. After this fix, the tool is correctly READ_ONLY: it returns a state-machine event, and the deterministic kernel-executor consumes that event (which DOES mutate, but the kernel-executor is the authority, not the LLM).

## Implementation requirements

1. **Verify the tool is pure** — read `set-pix-details.ts` and confirm: no `prisma.*`, no `redis.set` (only reads OK), no `publishNatsEvent`, no `medusaStore`/`medusaAdmin` calls. Document the audit trail in the PR description.

2. **Move classification** — in `packages/llm-provider/src/machine/types.ts`, remove `"set_pix_details"` from `MUTATING` and add to `READ_ONLY`. The literal types `ReadOnlyToolName` / `MutatingToolName` need to be updated accordingly.

3. **Verify event extraction** — `llm-responder.ts:466-469` already handles `{event, payload}` shapes in the `kind === "result"` branch. Confirm `onToolEvent` is called with the extracted event and that `agent.ts` injects it into XState via `actor.send(event)`.

4. **Sanitize PII surface** — confirm `sanitizeToolResultForLLM` in `llm-responder.ts:178` masks CPF/email when the tool returns. If not (unlikely — it's currently applied to all results), update it to mask the `payload.cpf` and `payload.email` fields specifically.

5. **Tests** (`__tests__/set-pix-details-classification.test.ts`):
   - "set_pix_details is in READ_ONLY classification" — assert membership.
   - "set_pix_details is NOT in MUTATING classification" — assert non-membership.
   - "tool result event reaches onToolEvent" — run a minimal `executeTool` invocation with a fake handler returning `{event: "PIX_DETAILS_COLLECTED", payload}`, assert the responder's `kind === "result"` branch fires and `onToolEvent` is invoked.
   - "PII is masked in LLM-facing result string" — assert that `sanitizeToolResultForLLM` does not leak CPF or email into the LLM's tool_result text.

## Acceptance criteria

- [ ] `set_pix_details` is in `TOOL_CLASSIFICATION.READ_ONLY` in `machine/types.ts`.
- [ ] `set_pix_details` is NOT in `TOOL_CLASSIFICATION.MUTATING`.
- [ ] Existing tool implementation in `packages/tools/src/cart/set-pix-details.ts` is unchanged.
- [ ] When the LLM invokes `set_pix_details`, the returned event `PIX_DETAILS_COLLECTED` is injected into the XState machine via `onToolEvent`.
- [ ] CPF and email are masked in the LLM's view of the tool result.
- [ ] All four classification tests pass.
- [ ] `pnpm --filter @ibatexas/llm-provider typecheck` passes.

## Testing requirements

- **Unit:** classification test file above.
- **Integration:** add a scenario fixture under `packages/llm-provider/src/__tests__/scenarios/` named `pix-details-collection.json` that drives a full PIX checkout flow through the LLM and asserts the event reaches the state machine. (Or extend an existing scenario.)
- **Bypass-detection:** add an assertion that `TOOL_CLASSIFICATION.MUTATING.size + TOOL_CLASSIFICATION.READ_ONLY.size === TOTAL_TOOL_COUNT` (catches accidental drops).

## Rollout notes

Direct merge. Behavioural change: PIX checkout via LLM now actually collects customer details. Investigation 01 notes the deterministic kernel partially covers this today via cached PIX details + router fast-paths; reclassification is purely additive (restores the missing LLM path). No feature flag needed.

## Rollback notes

Revert the classification change. PIX checkout via LLM returns to silent-event-loss state — no worse than current production. Rollback ETA: <5 min. No data loss.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 04: reclassify set_pix_details as READ_ONLY.

CONTEXT
Per investigation 01 (P0 #2) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/01-llm-tool-execution.md:
- set_pix_details is currently in TOOL_CLASSIFICATION.MUTATING (packages/llm-provider/src/machine/types.ts)
- But the tool implementation (packages/tools/src/cart/set-pix-details.ts) does NO mutation — it validates and returns {event: "PIX_DETAILS_COLLECTED", payload}
- MUTATING tools take the intent branch in llm-responder.ts (lines 251-457) which never extracts events
- READ_ONLY tools take the result branch (lines 466-469) which DOES extract events via onToolEvent
- Net effect today: PIX_DETAILS_COLLECTED event is lost, breaking PIX checkout via LLM

REPO LAYOUT
- packages/tools/src/cart/set-pix-details.ts — the pure tool (read first to verify)
- packages/llm-provider/src/machine/types.ts:366-408 — TOOL_CLASSIFICATION
- packages/llm-provider/src/llm-responder.ts:178 — sanitizeToolResultForLLM (PII mask)
- packages/llm-provider/src/llm-responder.ts:466-469 — event-extraction for READ_ONLY results
- packages/llm-provider/src/agent.ts — onToolEvent consumer that calls actor.send(event)

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/llm-provider/src/machine/types.ts (MODIFY — move classification)
- packages/llm-provider/src/__tests__/set-pix-details-classification.test.ts (CREATE)
- packages/llm-provider/src/__tests__/scenarios/pix-details-collection.json (CREATE — optional integration fixture)
- packages/llm-provider/src/llm-responder.ts (MODIFY only if sanitizeToolResultForLLM doesn't already mask cpf/email — confirm by reading)

WHAT TO BUILD

1. Read packages/tools/src/cart/set-pix-details.ts start-to-finish. Confirm NO prisma.*, NO redis.set, NO publishNatsEvent, NO medusaStore/medusaAdmin writes. If you find ANY mutation, STOP and surface this in the PR description — reclassification is unsafe; choose alternate fix.

2. In packages/llm-provider/src/machine/types.ts:
   - Remove "set_pix_details" from TOOL_CLASSIFICATION.MUTATING Set
   - Add "set_pix_details" to TOOL_CLASSIFICATION.READ_ONLY Set
   - Update type literals ReadOnlyToolName / MutatingToolName if they exist as string unions

3. Confirm sanitizeToolResultForLLM in llm-responder.ts:178 masks CPF and email in tool result strings. If it doesn't, add masking for payload.cpf and payload.email fields. Use existing pattern from apps/api/src/utils/sanitize-analytics.ts as reference.

4. Tests (vitest) in __tests__/set-pix-details-classification.test.ts:
   - "set_pix_details is READ_ONLY" — assert TOOL_CLASSIFICATION.READ_ONLY.has("set_pix_details")
   - "set_pix_details is NOT MUTATING" — assert !TOOL_CLASSIFICATION.MUTATING.has("set_pix_details")
   - "tool event reaches onToolEvent" — mock executeTool to return {kind: "result", data: {event: "PIX_DETAILS_COLLECTED", payload: {name, email, cpf}}}, invoke the responder's branch, assert onToolEvent called with the event object
   - "PII masked in LLM-facing string" — pass tool result through sanitizeToolResultForLLM, assert CPF and email substrings are not present in the output

5. (Optional but recommended) Scenario fixture pix-details-collection.json in __tests__/scenarios/: a full conversation flow where the LLM collects PIX details and the machine transitions to processing. Asserts via scenario-runner.test.ts.

CONSTRAINTS
- DO NOT touch packages/tools/src/cart/set-pix-details.ts — its current implementation is correct
- TypeScript strict, ESM
- pt-BR for any user-facing strings (CLAUDE.md rule #4)
- The total tool count assertion: TOTAL_TOOL_COUNT must remain unchanged (one tool moved between sets)

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] set_pix_details moved from MUTATING to READ_ONLY in machine/types.ts
- [ ] Verified by reading set-pix-details.ts that the tool is pure (no mutation calls)
- [ ] sanitizeToolResultForLLM masks CPF and email (confirmed or added)
- [ ] All 4 classification tests pass: `pnpm --filter @ibatexas/llm-provider test set-pix-details-classification`
- [ ] `pnpm --filter @ibatexas/llm-provider typecheck` passes
- [ ] No changes to tool registry handlers or executeTool logic

When complete, return: confirmation that the tool is pure (or the abort if not), files modified, test output.
```
