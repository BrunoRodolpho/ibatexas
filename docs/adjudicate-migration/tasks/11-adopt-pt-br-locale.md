# Task 11 — Adopt `@adjudicate/locales-pt-BR`

**Milestone:** M2 (Pack architecture)
**Estimated effort:** S — 0.5 dev-day
**Blocks:** none (cross-cutting cleanup)
**Blocked by:** 01 (kernel must be plumbed)
**Owner:** unassigned

## Objective

Adopt `@adjudicate/locales-pt-BR.portugueseRefusalMessages` and `localizeDecision` from `@adjudicate/core` at the presentation boundary so every kernel-emitted refusal is localized to pt-BR. Replace any inline Portuguese strings in IbateXas refusal handling with the canonical dictionary. After this lands, refusal text is consistent across the kernel boundary and IbateXas no longer carries its own copy of the translations.

## Architecture context

Cite: investigation 05 §"Capabilities ibatexas should adopt" Tier 0 #1.
> "`@adjudicate/locales-pt-BR.portugueseRefusalMessages` + `localizeDecision` — one-line change at the presentation boundary so all kernel-emitted refusals are localized. We're a pt-BR product. (CLAUDE.md hard rule #4.)"

The framework provides:
- `localizeDecision(decision, messages): Decision` — substitutes `REFUSE.userFacing` from the dictionary by `code`.
- `portugueseRefusalMessages: RefusalMessages = {fallback, byCode: {...}}` — the pt-BR dictionary.

Current state: IbateXas's `refusal-taxonomy.ts` and the order policy bundle's refuse helpers (in tools, in `order-policy-bundle.ts`) have inline pt-BR strings. After this task, kernel-emitted refusals (from `adjudicate()`) are localized at the responder boundary; pack-emitted refusals (which already use pt-BR) keep their text.

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/refusal-taxonomy.ts` (current inline pt-BR strings)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/llm-responder.ts:426-457` (refusal surfacing branch)
- `/Users/thaisrodolpho/projects/adjudicate/packages/locales-pt-BR/src/index.ts` (the dictionary)

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/llm-responder.ts` — wrap kernel-decisions in `localizeDecision(decision, portugueseRefusalMessages)` before surfacing refusal text.
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/refusal-taxonomy.ts` — audit inline pt-BR strings; if they exactly match the canonical dictionary entry by code, delete the inline string and rely on `localizeDecision`. If they differ, file a follow-up to reconcile.
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/package.json` — depend on `@adjudicate/locales-pt-BR`.

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/__tests__/localize-decision.test.ts`

## Constraints

- Must NOT alter user-facing text — the dictionary content must match what customers see today, byte-for-byte, for the refusal codes already in use.
- If a refusal code in IbateXas's `GUARD_REFUSAL_MAP` is missing from the canonical dictionary, file an upstream PR to `@adjudicate/locales-pt-BR` to add it (or document in the PR as a known gap). DO NOT add inline pt-BR fallback in IbateXas.
- Must preserve the existing `refuse(...)` factory from `refusal-taxonomy.ts` — IbateXas-specific refusals still build via that helper; the localization happens at the kernel boundary, not at refusal construction.
- Follow CLAUDE.md rule #4 — pt-BR for user-facing text.

## Implementation requirements

1. **Add dep** — `@adjudicate/locales-pt-BR` in `packages/llm-provider/package.json`.

2. **Wrap kernel decisions** — in `llm-responder.ts:426-457` (the refusal branch), before surfacing the tool_result text, apply:
   ```ts
   import { localizeDecision } from "@adjudicate/core";
   import { portugueseRefusalMessages } from "@adjudicate/locales-pt-BR";
   
   const localized = localizeDecision(decision, portugueseRefusalMessages);
   // use localized.refusal.userFacing for the tool_result text
   ```

3. **Audit `refusal-taxonomy.ts`** — for each entry in `GUARD_REFUSAL_MAP`, look up the corresponding code in `portugueseRefusalMessages.byCode`. If the entries match, delete the inline `userFacing` string from the local helper (rely on localization). If they differ:
   - The canonical dictionary is the source of truth; treat the IbateXas string as "drift to upstream."
   - Document the divergence in a comment: `// TODO(adjudicate-migration): canonical dictionary differs; reconcile via upstream PR`.

4. **Coverage** — verify every refusal code emitted by the order policy bundle and any other policy bundle in IbateXas is present in the canonical dictionary. If missing, log them in the PR description for follow-up.

5. **Tests** (`__tests__/localize-decision.test.ts`):
   - "localizes a kernel REFUSE decision" — build a `Decision {kind: REFUSE, refusal: {code: "default_refuse", userFacing: "fallback"}}`, pass through `localizeDecision`, assert `refusal.userFacing === portugueseRefusalMessages.byCode["default_refuse"]`.
   - "uses fallback for unknown codes" — refusal with code `unknown_code_xyz` should fall back to `portugueseRefusalMessages.fallback`.
   - "does not modify EXECUTE / DEFER / REWRITE decisions" — pass an EXECUTE through; assert unchanged.

## Acceptance criteria

- [ ] `@adjudicate/locales-pt-BR` in `packages/llm-provider/package.json` dependencies.
- [ ] `llm-responder.ts` wraps kernel-emitted decisions in `localizeDecision`.
- [ ] Inline pt-BR strings in `refusal-taxonomy.ts` are either deleted (matched canonical) or annotated with a TODO comment (divergent).
- [ ] All localize-decision tests pass.
- [ ] `pnpm --filter @ibatexas/llm-provider typecheck` passes.
- [ ] PR description lists any refusal codes missing from the canonical dictionary (for upstream follow-up).

## Testing requirements

- **Unit:** the test file above.
- **Integration:** existing scenario tests should produce byte-identical refusal text post-migration.
- **Bypass-detection:** assert that NO call site in `llm-responder.ts` constructs refusal text bypassing `localizeDecision`. (Grep-based test: zero matches of inline Portuguese strings in the refusal branches.)

## Rollout notes

Direct merge. Behavioural change: text continuity. Watch customer support for "wrong wording" reports in the 48h post-deploy; revert if the canonical dictionary differs unfavorably for a high-volume refusal.

## Rollback notes

Revert. Inline pt-BR returns. ETA: 5 min. No data loss.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 11: adopt @adjudicate/locales-pt-BR.

CONTEXT
Per investigation 05 (Tier 0 #1) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/05-adjudicate-capabilities.md:
- @adjudicate/locales-pt-BR exports portugueseRefusalMessages: RefusalMessages
- @adjudicate/core exports localizeDecision(decision, messages): Decision
- IbateXas is a pt-BR product but currently maintains its own inline strings
- One-line adoption at the presentation boundary localizes all kernel-emitted refusals

REPO LAYOUT
- packages/llm-provider/src/refusal-taxonomy.ts (current inline strings + GUARD_REFUSAL_MAP)
- packages/llm-provider/src/llm-responder.ts:426-457 (refusal surfacing branch)
- /Users/thaisrodolpho/projects/adjudicate/packages/locales-pt-BR/src/index.ts (the dictionary)
- packages/llm-provider/package.json (add dep)

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/llm-provider/src/llm-responder.ts (MODIFY — wrap decisions in localizeDecision)
- packages/llm-provider/src/refusal-taxonomy.ts (MODIFY — audit/delete inline strings matching canonical)
- packages/llm-provider/package.json (MODIFY — add dep)
- packages/llm-provider/src/__tests__/localize-decision.test.ts (CREATE)

WHAT TO BUILD

1. Add @adjudicate/locales-pt-BR to packages/llm-provider/package.json dependencies (workspace:*)

2. In llm-responder.ts:
   - Import: `import { localizeDecision } from "@adjudicate/core";` and `import { portugueseRefusalMessages } from "@adjudicate/locales-pt-BR";`
   - At the refusal branch (lines 426-457), before extracting userFacing for the tool_result, wrap:
     ```
     const localized = localizeDecision(decision, portugueseRefusalMessages);
     const userFacingText = localized.refusal.userFacing;
     ```
   - Use userFacingText in the tool_result instead of decision.refusal.userFacing
   - Apply to all branches that emit refusal text (REFUSE / REQUEST_CONFIRMATION / ESCALATE)

3. Audit refusal-taxonomy.ts:
   - Read every entry in GUARD_REFUSAL_MAP and any other refusal-construction helpers
   - For each refusal code, compare the inline pt-BR string vs portugueseRefusalMessages.byCode[code]
   - If identical (byte-for-byte): delete the inline string from the helper; the helper's refuse() factory should still receive a code argument, and localization happens at the boundary
   - If different: leave the inline string AND add a comment: // TODO(adjudicate-migration): canonical dictionary differs ("<canonical text>"); reconcile via upstream PR
   - If a code in GUARD_REFUSAL_MAP is missing from portugueseRefusalMessages.byCode: list it in the PR description as a known gap for upstream follow-up

4. Tests in __tests__/localize-decision.test.ts (vitest):
   - "localizes REFUSE decision" — build Decision {kind: "REFUSE", refusal: {code: "default_refuse", userFacing: "stub"}, basis: []}, pass through localizeDecision(d, portugueseRefusalMessages), assert refusal.userFacing equals portugueseRefusalMessages.byCode["default_refuse"]
   - "falls back for unknown codes" — refusal code = "nonexistent_xyz", assert userFacing === portugueseRefusalMessages.fallback
   - "leaves EXECUTE unchanged" — pass EXECUTE decision through, assert deep-equal to input
   - "leaves DEFER unchanged" — same
   - "leaves REWRITE unchanged" — same

CONSTRAINTS
- Read CLAUDE.md rule 4 first
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT modify @adjudicate/* source
- DO NOT add new inline pt-BR strings — rely on the canonical dictionary
- DO NOT alter refusal codes — only the userFacing text via localization

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] @adjudicate/locales-pt-BR in dependencies
- [ ] llm-responder.ts uses localizeDecision before surfacing refusal text
- [ ] refusal-taxonomy.ts audit complete; matched codes have inline strings deleted; divergent codes have TODO comments
- [ ] All 5 localize-decision tests pass
- [ ] `pnpm --filter @ibatexas/llm-provider typecheck` passes
- [ ] PR description lists any missing canonical codes for upstream follow-up

When complete, return: files modified, list of audit findings (matched/divergent/missing per code), test output.
```
