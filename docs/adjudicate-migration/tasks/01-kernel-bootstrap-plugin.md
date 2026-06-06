# Task 01 — Kernel Bootstrap Plugin

**Milestone:** M0 (Plumbing flip)
**Estimated effort:** S — 1 dev-day
**Blocks:** 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20
**Blocked by:** none (foundational)
**Owner:** unassigned

## Objective

Create the boot-time plug that wires `@adjudicate/core/kernel` into `apps/api`. After this lands, `installPack()` runs against IbateXas's PolicyBundle, `validateEnforceConfig()` warns on env-var typos, the `MetricsSink` slot has a stub installed (real implementation in Task 05), and the kernel becomes addressable from inside Fastify. This unblocks every downstream task: nothing else in the migration can run until the kernel is actually plumbed in at boot.

## Architecture context

Investigation 06 (Runtime Config & Governance Plumbing) identifies that the kernel is "dormant by accident, not by design" — every framework hook exists in `@adjudicate/core/kernel` but no IbateXas startup site calls `installPack()`, `validateEnforceConfig()`, `setMetricsSink()`, or `setLearningSink()`. The env vars (`IBX_KERNEL_SHADOW`, `IBX_KERNEL_ENFORCE`, `IBX_LEDGER_*`, `IBX_KILL_SWITCH`) are unset in every environment file. Cite: investigation 06 §"App boot sequences" and §"Plumbing gaps that block enforce mode (P0)".

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/index.ts` (current boot sequence)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/server.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/order-policy-bundle.ts` (the bundle to install)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/machine/types.ts:366-408` (TOOL_CLASSIFICATION → derive known intent kinds)
- `/Users/thaisrodolpho/projects/ibatexas/.env.example`

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/kernel-bootstrap.ts`
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/__tests__/kernel-bootstrap.test.ts`

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/index.ts` (add bootstrap call after Sentry init, before `buildServer()`)
- `/Users/thaisrodolpho/projects/ibatexas/.env.example` (add Adjudicate Kernel stanza)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/package.json` (verify `@adjudicate/core` dep present; already is)

## Constraints

- Must NOT break boot when env vars are unset — shadow/enforce both empty is the current safe default.
- Must surface `installPack`'s `PackConformanceError` as a fail-fast (process exit) before `server.listen()`.
- Must NOT yet replace the `MetricsSink` with the real implementation (that's Task 05). For now install a stub that logs to pino at debug level so we can verify wiring.
- Follow CLAUDE.md rule #3 (`process.env` only — no hardcoded values).
- Follow CLAUDE.md rule #6 (don't commit `.env`; only `.env.example` is updated).
- pt-BR only for user-facing strings (none in this task — log messages are operator-facing English is fine).

## Implementation requirements

1. **Add env-var stanza** to `.env.example`:
   ```
   # ─── Adjudicate Kernel ───
   IBX_KERNEL_SHADOW=                        # comma-separated intent kinds (or *) — shadow mode
   IBX_KERNEL_ENFORCE=                       # comma-separated intent kinds (or *) — authoritative mode
   IBX_LEDGER_ENABLED=false                  # shadow writes to Redis execution ledger
   IBX_LEDGER_ENFORCE=false                  # ledger short-circuits replays
   IBX_LEDGER_FAIL_OPEN=false                # fail-safe by default; flip to true only in non-financial paths
   IBX_KILL_SWITCH=                          # set to 1 to pre-seed global kill switch active
   ```

2. **Author `kernel-bootstrap.ts`** exporting:
   - `installPack(pack, options)` — call `installPack` from `@adjudicate/core/kernel` with `orderPolicyBundle`; pass `warn: server.log.warn.bind(server.log)` so pack conformance errors hit the structured log.
   - `validateEnforceConfig(knownIntents, env)` — pass the union of intent kinds from the LLM tool registry plus PIX pack intents. On unknown shadow/enforce tokens, emit `recordSinkFailure({reason: "enforce_config_typo"})` and log.
   - `setMetricsSink(stubSink)` — a stub `MetricsSink` whose methods log at debug level. Real implementation in Task 05.
   - Top-level export: `async function bootstrapKernel(server: FastifyInstance): Promise<void>` that orchestrates all of the above.

3. **Wire into `index.ts`** — call `await bootstrapKernel(server)` after Sentry init (so pack-conformance errors hit Sentry) but BEFORE `await server.listen()` so process exits if conformance fails. Place it after `buildServer()`.

4. **Known intent kinds** — derive from `TOOL_CLASSIFICATION.MUTATING` in `packages/llm-provider/src/machine/types.ts` plus the PIX pack constants. Build as `new Set<string>([...])`. Document in a comment that this set is the authoritative input to `validateEnforceConfig`.

5. **Tests** (`__tests__/kernel-bootstrap.test.ts`):
   - Asserts `installPack` is called exactly once with `orderPolicyBundle`.
   - Asserts `validateEnforceConfig` warns when a fake env sets `IBX_KERNEL_SHADOW=cart.ad,review.submit` (typo on `cart.add`).
   - Asserts `setMetricsSink` was called with a non-null sink.
   - Asserts conformance failure throws and prevents `server.listen()`.

## Acceptance criteria

- [ ] `apps/api/src/plugins/kernel-bootstrap.ts` exists and exports `bootstrapKernel(server)`.
- [ ] `apps/api/src/index.ts` calls `bootstrapKernel(server)` between Sentry init and `server.listen()`.
- [ ] `.env.example` contains the six new env vars under a clearly labelled Adjudicate Kernel stanza.
- [ ] Unit tests in `apps/api/src/plugins/__tests__/kernel-bootstrap.test.ts` all pass.
- [ ] Process exits non-zero if `installPack` throws `PackConformanceError`.
- [ ] When env vars unset (current dev default), boot still succeeds with two `[kernel-bootstrap]` info log lines: pack installed, validateEnforceConfig clean.
- [ ] `pnpm --filter @ibatexas/api typecheck` passes.

## Testing requirements

- **Unit:** the test file above. Mock `installPack`/`validateEnforceConfig`/`setMetricsSink` via `vi.mock("@adjudicate/core/kernel")`.
- **Integration:** verify `pnpm --filter @ibatexas/api dev` still starts cleanly with empty `.env` (no shadow/enforce values).
- **Bypass-detection:** N/A for this task (Task 20 covers the broader bypass test).

## Rollout notes

Direct merge to main. No feature flag. The kernel remains dormant in shadow/enforce terms (env vars empty) — this task only wires the plumbing, not any policy decisions. Zero customer-facing behaviour change.

## Rollback notes

Revert the PR. The only risk is if `installPack` throws on a malformed `orderPolicyBundle` — that would prevent boot, but reverting the import in `index.ts` immediately restores prior behaviour. Rollback ETA: <5 min via revert + redeploy. No data loss.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 01: kernel bootstrap plugin.

CONTEXT
The IbateXas monorepo at /Users/thaisrodolpho/projects/ibatexas integrates with the @adjudicate/* packages (sibling repo at /Users/thaisrodolpho/projects/adjudicate). The kernel is structurally wired but never boots — installPack, validateEnforceConfig, and setMetricsSink are never called from apps/api. Your job is to create the bootstrap module that wires them in.

REPO LAYOUT
- apps/api/src/index.ts — Fastify process entry, current boot order
- apps/api/src/server.ts — buildServer() factory
- packages/llm-provider/src/order-policy-bundle.ts — the PolicyBundle to install
- packages/llm-provider/src/machine/types.ts — TOOL_CLASSIFICATION (lines 366-408); derive known intent kinds from MUTATING set

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- apps/api/src/plugins/kernel-bootstrap.ts (CREATE)
- apps/api/src/plugins/__tests__/kernel-bootstrap.test.ts (CREATE)
- apps/api/src/index.ts (MODIFY — add one bootstrap call, no other changes)
- .env.example (MODIFY — add Adjudicate Kernel env stanza)

WHAT TO BUILD
1. apps/api/src/plugins/kernel-bootstrap.ts exports async function bootstrapKernel(server: FastifyInstance): Promise<void>
   - Calls installPack from @adjudicate/core/kernel against orderPolicyBundle from @ibatexas/llm-provider with warn: server.log.warn.bind(server.log)
   - Builds knownIntents Set<string> from TOOL_CLASSIFICATION.MUTATING tool names plus PIX pack intents (pix.charge.create, pix.charge.confirm, pix.charge.refund)
   - Calls validateEnforceConfig(knownIntents, process.env, msg => server.log.warn({msg}))
   - Calls setMetricsSink with a stub sink whose 5 methods (recordLedgerOp, recordDecision, recordRefusal, recordSinkFailure, recordShadowDivergence) log at server.log.debug level. Real MetricsSink lands in Task 05.
   - Logs two structured info lines: kernel.bootstrap.pack_installed and kernel.bootstrap.enforce_config_validated

2. Update apps/api/src/index.ts to call await bootstrapKernel(server) after Sentry.init() but before server.listen(). Sentry init is at lines 15-20 today; the new call slots between buildServer() and listen().

3. Append to .env.example (under a new "# ─── Adjudicate Kernel ───" header) exactly these six env vars with the comments shown above.

4. Tests in apps/api/src/plugins/__tests__/kernel-bootstrap.test.ts using vitest + vi.mock("@adjudicate/core/kernel"):
   - "installs the order policy bundle" — assert installPack called once with orderPolicyBundle
   - "warns on enforce-config typos" — set process.env.IBX_KERNEL_SHADOW = "cart.ad" (typo), assert warn callback receives the unknownShadow token
   - "installs a metrics sink" — assert setMetricsSink called with object having all 5 methods
   - "fails boot on conformance error" — make installPack throw PackConformanceError, assert bootstrapKernel rejects with that error

CONSTRAINTS
- TypeScript strict, ESM imports with .js extensions on local imports (CLAUDE.md note)
- Read CLAUDE.md hard rules 3, 6 first
- DO NOT modify any other file in the repo. DO NOT touch packages/llm-provider, packages/tools, or other apps/api files.

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] bootstrapKernel is exported and idempotent (calling twice does not double-install)
- [ ] index.ts wires it correctly between Sentry init and server.listen()
- [ ] .env.example has the six new vars under "# ─── Adjudicate Kernel ───"
- [ ] All 4 test cases pass via `pnpm --filter @ibatexas/api test kernel-bootstrap`
- [ ] `pnpm --filter @ibatexas/api typecheck` passes
- [ ] Boot still succeeds when env vars are empty (default dev state)

When complete, return: files created/modified, test output, and any deviations from the spec.
```
