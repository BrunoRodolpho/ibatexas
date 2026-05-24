# Always-on cutover consistency audit — 2026-05-23

**Branch:** feat/kernel-always-on-cutover
**Cutover commit:** f3bea43 ("feat(kernel): IBX-IGE v3.0 — always-on cutover, delete staged-rollout machinery")
**Reviewer:** investigation agent (read-only)

## TL;DR

The cutover is **substantially complete in production hot paths** — `customer-intent-gateway.ts`, `kernel-executor.ts`, `llm-responder.ts`, `intent-ledger.ts`, `intent-audit-wiring.ts`, `stripe-webhook.ts`, `medusa/adjudicated.ts`, `stripe/adjudicated.ts`, and `kernel-bootstrap.ts` are all clean (always-on, no env-var gating). However there is **one live-hot-path bug** — `apps/api/src/subscribers/audit-consumer.ts:68` still gates the audit-consumer NATS subscriber on `IBX_AUDIT_POSTGRES_ENABLED !== "true"`, which contradicts ADR #14's "audit-postgres sink: always in the multi-sink fan-out". Operator tooling has **drift**: the `ibx kernel status` CLI (`packages/cli/src/commands/kernel.ts`) still reads and displays shadow/enforce/ledger env vars and calls `getKillSwitchState()` (would always report inactive — misleading rather than wrong). The `kernel.test.ts` test file still has 8+ assertions for a deleted `ibx kernel kill-switch` subcommand — these tests will fail at runtime. A large slice of `docs/adjudicate-migration/` (`MASTER_PLAN.md`, `runbooks/SHADOW-ENFORCE-ROLLOUT.md`, `migration/04` + `migration/05`) is pre-cutover and would actively mislead a 3am operator into running CLI subcommands and endpoints that no longer exist.

## Section 1 — Residual env-var gating

| File:line | Reference | Classification | Severity | Recommendation |
|---|---|---|---|---|
| `apps/api/src/subscribers/audit-consumer.ts:68-72` | `if (process.env.IBX_AUDIT_POSTGRES_ENABLED !== "true") { … return }` — early-exits the consumer when env var is unset | **LIVE_HOT_PATH** | **HIGH** | Remove the env gate; NATS consumer must run unconditionally because the in-process Postgres sink (`intent-audit-wiring.ts`) is now always-on per ADR #14, and the consumer is the recovery path for in-process writer failures. Comment at line 8–14 explicitly says "subscriber catches up any record the in-process sink missed" — so it's load-bearing. |
| `apps/api/src/subscribers/audit-consumer.ts:10, 30` | Code comments asserting `IBX_AUDIT_POSTGRES_ENABLED=true` gates the in-process sink and the consumer "rolls out together" | DEAD_CODE (comment) | low | Comment is stale; the in-process sink is always-on. Rewrite alongside the line-68 fix. |
| `apps/api/src/index.ts:47` | Comment: "validate IBX_KERNEL_SHADOW/IBX_KERNEL_ENFORCE for typos" | DEAD_CODE (comment) | low | `bootstrapKernel` no longer does that — `kernel-bootstrap.ts:1-3` explicitly states "no env-var gating to validate". Update comment. |
| `apps/api/src/index.ts:117` | Comment: "No-op when IBX_AUDIT_POSTGRES_ENABLED is not 'true'" | DEAD_CODE (comment) | low | True today because of the line-68 gate; will become stale once that gate is fixed. |
| `packages/cli/src/commands/kernel.ts:88-104, 140-158, 174-184` | `ibx kernel status` reads + parses + displays IBX_KERNEL_SHADOW, IBX_KERNEL_ENFORCE, IBX_LEDGER_ENABLED, IBX_LEDGER_ENFORCE, IBX_LEDGER_FAIL_OPEN, IBX_AUDIT_POSTGRES_ENABLED; prints "Modo shadow" / "Modo enforce" / "fail-open" sections | LIVE_HOT_PATH (operator-facing) | MEDIUM | The CLI is the documented inspection surface (`docs/ops/runbooks/kernel-operations.md` directs operators to `ibx kernel status`). Reading/displaying env vars that no longer affect runtime gives a false impression. Strip the shadow/enforce/ledger sections; the runbook itself only mentions Packs/intent kinds/audit topology/ledger health — rewrite the CLI to match. |
| `packages/cli/src/commands/kernel.ts:110-111, 186-194` | Lazy-imports `getKillSwitchState` from `@adjudicate/core/kernel` and renders an "ATIVO/inativo" section | DEAD_CODE (lazy-import works but always reports inactive — no `setKillSwitch` call exists in production) | MEDIUM | Cutover commit removed the kill-switch surface but this status display still references it. Misleading. Remove. |
| `packages/cli/src/commands/kernel.ts:226-258` | `ibx kernel replay` returns early with a "habilitar IBX_AUDIT_POSTGRES_ENABLED=true" TODO when env unset | DEAD_CODE (env gate is moot — audit-postgres is now always-on) | MEDIUM | Per ADR #14, audit-postgres is always-on; this stub guidance is wrong post-cutover. Remove the gate; rely on `databaseUrl` check + `assertAuditPostgresReady` (boot preflight) for the missing-DB case. |
| `packages/llm-provider/src/index.ts:161` | Comment: "validateEnforceConfig from @adjudicate/core/kernel so typos in IBX_KERNEL_SHADOW/IBX_KERNEL_ENFORCE surface at boot" | DEAD_CODE (comment) | low | `validateEnforceConfig` not called anywhere; comment stale. Strip the env-var sentence. |
| `packages/llm-provider/src/kernel-executor-envelopes.ts:24-29` | Comment block describing the legacy shadow/enforce branching context | DEAD_CODE (comment) | low | The deterministic-kernel direct call sites all flow through `adjudicateKernelMutation` unconditionally now (kernel-executor.ts:1-14). Update the prose. |
| `packages/llm-provider/src/postgres-audit-writer.ts:40` | Comment referencing `IBX_AUDIT_POSTGRES_ENABLED=true` | DEAD_CODE (comment) | low | Stale; update. |
| `packages/llm-provider/src/parse-bool-env.ts:14` | Comment about `IBX_AUDIT_POSTGRES_ENABLED=TRUE` typo footgun | DEAD_CODE (comment) | low | The parser itself is generic and may still be useful for other env vars. Update the comment example. |
| `packages/tools/src/stripe/adjudicated.ts:47` | Comment: "...not flippable via IBX_KERNEL_SHADOW / IBX_KERNEL_ENFORCE" | DEAD_CODE (comment) | low | True (these env vars no longer exist) but phrasing implies they do exist; rewrite. |
| `packages/cli/src/commands/__tests__/kernel.test.ts:49-55, 71-72, 86-87, 99-117` | Test setup stubs and asserts on IBX_KERNEL_SHADOW / IBX_KERNEL_ENFORCE / IBX_LEDGER_*; expects JSON shape `{ shadow, enforce, ledger.{enabled,enforce,failOpen}, killSwitch }` | TEST_FIXTURE — but tests the now-stale CLI shape | MEDIUM | Tests are coupled to the stale CLI (Section 1 above). If the CLI is rewritten, these tests rewrite alongside it. |
| `packages/cli/src/commands/__tests__/kernel.test.ts:422-680` | Eight+ `describe("ibx kernel kill-switch")` tests, including W7-O3 two-person-bypass posture, mocking `@ibatexas/tools` Redis fake | TEST_FIXTURE — but the test subject (CLI subcommand) was DELETED in f3bea43 | **HIGH** | These tests will fail at runtime with "Unknown command 'kill-switch'" because `registerKernelCommands` no longer registers a kill-switch subcommand. Either re-run `pnpm --filter @ibatexas/cli test` to confirm (likely red) and delete the suite, or the verification claim in f3bea43's commit body ("367/367 passing" for `@ibatexas/llm-provider`) hides this because CLI tests were not part of that filter. |
| `apps/api/src/__tests__/cart-routes.test.ts:644-650` | `vi.stubEnv("IBX_KERNEL_SHADOW", "order.checkout.create")` + comment claiming "the gateway now default-REFUSES" without shadow mode | TEST_FIXTURE — pre-cutover assumption | MEDIUM | The customer-intent gateway (`customer-intent-gateway.ts:160-165`) is now unconditional. The env stub is a no-op. The "default-REFUSE without shadow" claim only holds when the underlying Pack policy lacks the kind. Tests likely still pass but assertion model is wrong; revisit. |
| `apps/api/src/__tests__/order-cancel-governance.test.ts:5-8, 203` | Comment "with IBX_KERNEL_ENFORCE=order.cancel… With pure-legacy mode…"; `vi.stubEnv("IBX_KERNEL_ENFORCE", "order.cancel")` | TEST_FIXTURE — pre-cutover three-way branch coverage | MEDIUM | "Pure-legacy mode" branch no longer exists in production. The stubEnv is no-op; tests likely still pass because of `mockAdjudicate.mockReturnValue(REFUSE)` not because of env. Rewrite the comment + drop the stub. |
| `apps/api/src/routes/__tests__/customer-mutation-governance.test.ts:14-17, 71, 261` | References ALWAYS_ENFORCE / "kind in ALWAYS_ENFORCE adjudicates even without env" | TEST_FIXTURE — pre-cutover semantics | MEDIUM | ALWAYS_ENFORCE was an artifact of the env-var-gated era; gateway is now unconditional. Rewrite. |
| `apps/api/src/__tests__/integration/audit-sink-fail-resilience.test.ts:99` | `vi.stubEnv("IBX_AUDIT_POSTGRES_ENABLED", "true")` | TEST_FIXTURE — turning on the now-default | LOW | No-op once line-68 of audit-consumer is fixed. Drop the stub then. |
| `apps/api/src/subscribers/__tests__/audit-consumer.test.ts:176-317` | Multiple tests asserting "does NOT subscribe when IBX_AUDIT_POSTGRES_ENABLED is unset/'false'" plus `vi.stubEnv(... , "true")` for happy paths | TEST_FIXTURE — directly tests the LIVE_HOT_PATH bug above | MEDIUM | Once line-68 is removed, the "does NOT subscribe when unset" assertions must be removed too (the consumer always subscribes now). |

## Section 2 — Kill switch state

**Production wiring:** None. The cutover commit deleted:
- `packages/tools/src/redis/kill-switch-store.ts` (193 lines) and its tests
- `apps/api/src/routes/admin/kernel.ts` (311 lines — HTTP admin kill-switch route)
- The `ibx kernel kill-switch enable/disable/status` CLI subcommand (kernel.ts dropped 799→~smaller)
- Tests `apps/api/src/routes/admin/__tests__/kernel-kill-switch.test.ts` (387 lines)

Verified:
- `grep -rn "setKillSwitch" apps/ packages/ --include="*.ts"` returns zero hits in production code.
- `packages/tools/src/redis/` directory no longer contains `kill-switch-store.ts` (verified).
- `apps/api/src/routes/admin/index.ts` does not import or wire any kernel route.

**Residual references (not live):**
- `packages/cli/src/commands/kernel.ts:110-111, 186-194` — `getKillSwitchState()` call + status display. The framework primitive in `@adjudicate/core/kernel` still exists, but with no `setKillSwitch` call in production, it permanently reports inactive. **Misleading operator surface.**
- `apps/api/src/plugins/kernel-metrics-sink.ts:139, 282-285, 657-658, 723-726` — Prometheus `kernel_kill_switch_state` gauge and `recordKillSwitchState()` method are defined in the recorder API. `grep -rn recordKillSwitchState` shows only the recorder definition + the test file (`kernel-metrics-sink.test.ts:604,607`); **no production caller**. Dead recorder method emitting a perpetually-0 gauge.
- `packages/cli/src/commands/__tests__/kernel.test.ts:422-680` — eight tests against a CLI subcommand that no longer exists (covered in Section 1).
- Stale `dist/` build outputs (`packages/tools/dist/redis/kill-switch-store.d.ts`) — would be regenerated/cleared on next build.

**Verdict:** the kill-switch surface is **fully decommissioned in production**, but **two leftover artifacts (CLI status display, recorder method) still reference it**. There is no "deliberate emergency override" preserved — the brief's "may have been retained as an emergency override" hypothesis does not hold; ADR #14 (`docs/architecture/decisions.md:335`) explicitly notes the framework's internal kill-switch check "still exists inside `adjudicate()` but the Redis key it consults is never written, so it's a constant no-op". No CLI / HTTP / runtime surface to engage it.

## Section 3 — adjudicate() call site spot-checks

| File | Verdict | Evidence |
|---|---|---|
| `packages/llm-provider/src/llm-responder.ts` | **CLEAN — unconditional** | `grep -n "shadow\|enforce\|IBX_KERNEL\|kill"` returns 2 hits: line 450 (per-session DEFER quota comment) and line 536 (pt-BR refusal mention of "kill_switch" code — a string for the framework's internal refusal taxonomy). No env-var branching. |
| `packages/llm-provider/src/kernel-executor.ts` | **CLEAN — unconditional** | Header (lines 1-14) explicitly states "IBX-IGE v3.0: …flow through `adjudicateKernelMutation` — the kernel is always authoritative." `grep -n "IBX_KERNEL\|shadow\|enforce\|kill"` returns zero hits in the file. |
| `apps/api/src/subscribers/__shared__/system-actor-envelope.ts` | **CLEAN** | Structural envelope builder, no policy/env logic. |
| `apps/api/src/routes/__shared__/customer-intent-gateway.ts` | **CLEAN — unconditional** | Line 160-165 comment block: "Kernel adjudication (always-on) … The kernel's policy bundle is authoritative — no env-var gating." `adjudicate()` invoked unconditionally at line 166. |
| `apps/api/src/routes/stripe-webhook.ts` | **CLEAN** | Webhook handler builds a `payment.status.reconcile` envelope and adjudicates it via the service-layer chokepoint. No env-var or kill-switch references in the file. |
| `apps/api/src/routes/admin/admin-confirmation-store.ts` | **CLEAN** | Two-person rule layer ON TOP of the kernel (header comment lines 1-30). Receipt store atomically consumes a Lua-GET+DEL. No env-var or kill-switch refs. |
| `packages/tools/src/stripe/adjudicated.ts` | **CLEAN (modulo stale comment)** | Line 387 `adjudicate(envelope, wrapperState, stripeWrapperPolicyBundle)` runs unconditionally. Header comment line 47 has stale `IBX_KERNEL_SHADOW`/`ENFORCE` reference (covered in Section 1) but no runtime gate. |
| `packages/tools/src/medusa/adjudicated.ts` | **CLEAN** | Wrapper governs HTTP egress unconditionally. No env-var or kill-switch refs. |
| `apps/api/src/plugins/kernel-bootstrap.ts` | **CLEAN — explicit "no env-var gating"** | Lines 1-3 state "The kernel is always-on; there is no env-var gating to validate." Composes Pack install → coverage assertion → audit-postgres preflight. |
| `packages/llm-provider/src/intent-ledger.ts` | **CLEAN — always-on, fail-closed** | Header (lines 6-9): "always-on and fail-closed: every adjudication consults the ledger for dedup; if Redis is unavailable, the operation throws `LedgerUnavailableError`." |
| `packages/llm-provider/src/intent-audit-wiring.ts` | **CLEAN — postgres always-on** | Lines 21-27: "audit-postgres is added to the multi-sink fan-out unconditionally." `multiSink(console_, nats, postgresSink)` at line 293 — no env conditional. |

**One exception (not a call site, but in the audit fan-out path):** the NATS audit-consumer (Section 1 LIVE_HOT_PATH bug) gates whether records get archived from NATS to Postgres. The in-process sink IS unconditional and writes directly; the consumer is the redundancy path. So mutation correctness is intact; durability redundancy is degraded.

## Section 4 — Stale documentation

**Authoritative-but-stale (rewrite-needed):**

| File | Severity | Why |
|---|---|---|
| `docs/adjudicate-migration/MASTER_PLAN.md` | **HIGH (mislead-risk)** | Dated 2026-05-22 ("Draft v0.1"). TL;DR (line 13) says "the kernel … resolves to a hardcoded `EXECUTE` because no env vars are set" and "Failsafe. Distributed kill switch …; `IBX_KILL_SWITCH` checked in fast path" (line 66). Both contradict ADR #14. Either rewrite as a historical "v0.1 — superseded by always-on cutover" record with a banner at the top, or replace with a new MASTER_PLAN aligned to post-cutover state. |
| `docs/adjudicate-migration/current-state.md` | MEDIUM | Currently has zero `shadow/enforce/kill-switch` hits (clean by that grep), but the legend / task table mention M0–M6 milestones that are now obsolete given the cutover. Worth rewriting to reflect the post-cutover state explicitly. |
| `docs/adjudicate-migration/open-blockers.md` | MEDIUM | Lines 49 and 75 describe "pure-legacy posture" and "M3 enforce flip happens incrementally per intent class with 7-14 days of clean shadow each" — both invalid post-cutover. Pure-legacy doesn't exist; M3 enforce flip isn't a thing now. Rewrite or strip those sections. |
| `docs/adjudicate-migration/decisions-log.md` | LOW | A few historical references to `IBX_KERNEL_SHADOW`/`ENFORCE` are appropriate as decision history. Mark as historical. |

**Operational runbooks (high mislead-risk for a 3am operator):**

| File | Severity | Why |
|---|---|---|
| `docs/adjudicate-migration/runbooks/SHADOW-ENFORCE-ROLLOUT.md` | **CRITICAL** | 50 hits on shadow/enforce/kill-switch. The runbook IS the staged-rollout playbook the cutover deleted. Now actively misleads — directs operators to flip env vars and engage kill switches that don't exist. **Delete or archive with a prominent "SUPERSEDED — see `docs/ops/runbooks/kernel-operations.md`" banner.** |
| `docs/adjudicate-migration/migration/04-shadow-enforce-sequencing.md` | **CRITICAL** | 43 hits. Documents the per-intent enforce sequencing that no longer applies. Same fix. |
| `docs/adjudicate-migration/migration/05-kill-switch-strategy.md` | **CRITICAL** | 62 hits. Advertises `POST /api/admin/kernel/kill-switch` HTTP endpoint and `ibx kernel kill-switch enable/disable/status` CLI subcommands — **both deleted by the cutover**. Already flagged as GHOST by `deep-audit/06-docs-vs-reality.md` pre-cutover; now confirmed deleted. Same fix. |
| `docs/adjudicate-migration/migration/01-rollout-strategy.md` through `migration/07-production-safety-checklist.md` | MEDIUM-HIGH | These are the staged-rollout migration playbook. The framework around them assumes shadow→enforce→kill-switch. Either move under a `superseded/` directory or add per-file banners. |

**Historical (keep as-is, archive cleanly):**

| File | Severity | Why |
|---|---|---|
| `docs/adjudicate-migration/deep-audit/*.md` | LOW | Pre-cutover investigation reports. These accurately describe the *prior* state and informed the cutover decision. Should remain as historical record; one-line preamble noting "investigation snapshot prior to cutover (commit f3bea43)" would suffice. |
| `docs/adjudicate-migration/correctness-remediation/*.md` | LOW | W6/W7 wave notes; historical. |
| `docs/adjudicate-migration/tasks/*.md` | LOW | Per-task briefs that informed the implementation pre-cutover. Historical. |
| `docs/adjudicate-migration/OVERNIGHT-RUN-SUMMARY.md` | LOW | Run log; historical. |
| `docs/adjudicate-migration/threat-model/THREAT-MODEL.md` | LOW–MEDIUM | Worth a quick re-read to verify threat model still aligns with always-on posture; likely OK. |

**Already-clean / authoritative post-cutover:**

| File | Notes |
|---|---|
| `docs/ops/runbooks/kernel-operations.md` | New post-cutover runbook. Accurately reflects always-on. **The canonical operator surface.** |
| `docs/architecture/decisions.md` (ADR #14) | Documents the cutover. Authoritative. |
| `CLAUDE.md` Hard Rule #9 | Rewritten as IBX-IGE v3.0. Authoritative. |

## Section 5 — Open questions for orchestrator

1. **Audit-consumer env gate (Section 1, HIGH).** Was the line-68 env gate intentionally left in place as a "stop the NATS consumer if you must" knob, or was it overlooked in the f3bea43 sweep? ADR #14 line 333 explicitly says "Audit-postgres sink: always in the multi-sink fan-out (no env flag)" — so the in-process side was de-flagged. The consumer side (which the brief acknowledges is "decoupled-archiver" redundancy) was apparently missed. Decision needed: **remove the gate (consistent with ADR #14)** or **keep and document as a deliberate per-process disable (e.g., for multi-replica deployments where only one process should run the consumer)**.

2. **CLI status display (Section 1, MEDIUM).** Should `ibx kernel status` still attempt to display `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` / ledger env vars and kill-switch state? The runbook (`docs/ops/runbooks/kernel-operations.md:12-17`) says status should report "installed Packs, known intent kinds, audit sink topology, and ledger health" — implying the kernel/audit env-var sections should be **stripped**, leaving Packs + intent kinds + sink topology + ledger health (no env vars). Confirm and rewrite `runStatus` + the corresponding tests.

3. **Stale `ibx kernel kill-switch` test suite (Section 1, HIGH).** `packages/cli/src/commands/__tests__/kernel.test.ts:422-680` will fail at runtime — verified via grep that `kernel.ts` no longer registers the subcommand. The cutover commit body claims "367/367 passing" for `@ibatexas/llm-provider` only; it does NOT claim the CLI package tests pass. Action: **run `pnpm --filter @ibatexas/cli test` to confirm**, then delete the kill-switch test block.

4. **Dead `recordKillSwitchState` recorder method + `kernel_kill_switch_state` gauge (Section 2).** Should the recorder method be removed entirely, or kept as a no-op surface for future operational tooling? Per ADR #14 the gauge is reported as deleted, but the recorder method survives. Recommend: **remove the method, the gauge, and the test (`kernel-metrics-sink.test.ts:604-607`)** to keep the surface clean.

5. **Pre-cutover `runbooks/SHADOW-ENFORCE-ROLLOUT.md` + `migration/05-kill-switch-strategy.md` (Section 4, CRITICAL).** Decision: **delete**, **archive under `docs/adjudicate-migration/superseded/`**, or **add prominent banners pointing to `docs/ops/runbooks/kernel-operations.md`**? Strong recommendation for either delete or `superseded/` move, because the `deep-audit/06-docs-vs-reality.md` already flagged these as referencing GHOST CLI/HTTP surfaces pre-cutover, and post-cutover they are *guaranteed* to mislead.

6. **MASTER_PLAN.md (Section 4, HIGH).** The plan was the multi-month roadmap toward governance coverage. Most milestones are now realized; the milestone framing (M0–M6) is itself superseded by the always-on cutover. Should MASTER_PLAN.md be:
   - (a) replaced with a brief "history" file pointing to ADR #14, or
   - (b) rewritten to capture the residual post-cutover work (e.g., the audit-consumer fix from Section 1 + the cleanup items)?

7. **Test fixtures that stubEnv legacy vars (Section 1, MEDIUM cluster).** The `vi.stubEnv` calls in cart-routes / order-cancel / customer-mutation-governance tests are no-ops post-cutover. They confuse readers and risk masking a future regression where someone re-adds env-var branching and the tests *appear* to cover it. Recommend a sweep to remove all stubs of the deleted env vars across the test corpus.

8. **`parseBoolEnv` retention.** `packages/llm-provider/src/parse-bool-env.ts` was introduced to fix the `=TRUE` typo footgun for the now-removed flags. It still has consumers (`IBX_DEFER_PENDING_POLL_SECONDS` etc.). Keep, but update the file's doc comment to point at the surviving consumers rather than the removed ones.
