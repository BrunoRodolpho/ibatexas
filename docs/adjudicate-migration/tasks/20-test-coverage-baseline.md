# Task 20 — Test Coverage Baseline + Kernel CLIs

**Milestone:** M5/M6 (Testing & rollout)
**Estimated effort:** L — 6–9 dev-days
**Blocks:** all M7/M8 enforce flips (never enforce what isn't tested)
**Blocked by:** 01–19 (test the actual implementation, not stubs)
**Owner:** unassigned

## Objective

Author the ~60 missing kernel tests covering contract per intent kind, shadow vs enforce branching, DEFER round-trip, audit emission, bypass detection (CI gate). Build the `ibx kernel status`, `ibx kernel replay`, `ibx kernel divergence` CLIs referenced in runbooks. After this lands, the migration's enforce-mode rollouts have observable, verifiable safety nets.

## Architecture context

Cite: investigation 07 §"Test categories — coverage matrix" + §"Recommendations" P0 #1-#7.
> "171 tests total. Direct exercise of the kernel migration surface is essentially **two unit-shaped tests**. ... To bring kernel coverage to migration grade requires ~6–9 engineer-days for one person."

The 13 missing test categories (per investigation 07's matrix), prioritized:
1. **Kernel contract per intent kind** (~60 cases across ~20 intent kinds)
2. **Shadow-mode divergence classification**
3. **Enforce-mode REFUSE actually blocks onToolIntent**
4. **DEFER park + resume round trip**
5. **Audit emission contract**
6. **Pack PIX guard composition test**
7. **Replay determinism**
8. **Bypass detection (CI gate)** — Investigation 01 P2 #7
9. **Ledger fail-open vs fail-safe**
10. **Ledger duplicate-execution suppression**
11. **Audit sink backpressure**
12. **Webhook → DEFER → ledger SET-NX**
13. **Capability planner mutating-tool hiding**

Per investigation 07: missing CLIs (`ibx kernel status`, `replay`, `divergence`) blocked the existing runbooks; building them is part of this task.

## Files involved

**Read:**
- Every test file in `packages/llm-provider/src/__tests__/`
- `apps/api/src/__tests__/`
- `/Users/thaisrodolpho/projects/adjudicate/packages/cli/src/` (reference for `replay`, `divergence` CLI patterns)
- `/Users/thaisrodolpho/projects/ibatexas/packages/cli/src/commands/` (existing IbateXas CLI structure)

**Create (tests):**
- `packages/llm-provider/src/__tests__/kernel-contract.test.ts` (the 60+ cases)
- `packages/llm-provider/src/__tests__/shadow-mode.test.ts`
- `packages/llm-provider/src/__tests__/enforce-mode.test.ts`
- `apps/api/src/__tests__/defer-roundtrip.test.ts` (extends Task 03's smoke)
- `packages/llm-provider/src/__tests__/audit-emission-contract.test.ts`
- `packages/pack-orders/src/__tests__/pix-guard-composition.test.ts`
- `packages/llm-provider/src/__tests__/replay-determinism.test.ts`
- `apps/api/src/__tests__/bypass-detection.test.ts` (CI gate)
- `packages/llm-provider/src/__tests__/ledger-fail-modes.test.ts`
- `packages/llm-provider/src/__tests__/audit-sink-backpressure.test.ts`
- `apps/api/src/__tests__/webhook-defer-ledger.test.ts`

**Create (CLIs):**
- `packages/cli/src/commands/kernel.ts` (subcommands: status, replay, divergence)
- `packages/cli/src/commands/__tests__/kernel.test.ts`

**Modify:**
- `packages/cli/src/index.ts` — wire `kernel` subcommand

## Constraints

- Tests are AUTHORITATIVE — if a test reveals a bug in M0-M4 task output, raise an issue and BLOCK the rollout until fixed.
- CI gate: bypass-detection test MUST run on every PR; failure blocks merge. Document in `CONTRIBUTING.md` (or PR-template).
- CLIs use the existing `packages/cli/` infrastructure (yargs/clack/whatever IbateXas uses — check `packages/cli/src/index.ts`).
- `ibx kernel replay --since=24h` reads from the Postgres audit table (Task 19) and re-feeds each record through `adjudicate()`, classifying drift via `classifyReplayDrift`.
- Test fixtures must be deterministic — use seeded RNG, fixed timestamps.
- pt-BR for any user-facing CLI output text.

## Implementation requirements

1. **`kernel-contract.test.ts`** — one `describe` per intent kind in the union. For each, a table of `(envelope, state) → expected Decision` rows. At least 3 cases per kind (EXECUTE, REFUSE, edge-case like REWRITE/DEFER). Aim ≥60 cases.

2. **`shadow-mode.test.ts`:**
   - With `IBX_KERNEL_SHADOW=order.checkout.create`, drive an envelope where legacy says EXECUTE and kernel says REFUSE; assert legacy result is used AND `MetricsSink.recordShadowDivergence` fires with class `DECISION_KIND`.
   - Same for `BASIS_ONLY` and `PAYLOAD_REWRITE` divergence classes.

3. **`enforce-mode.test.ts`:**
   - With `IBX_KERNEL_ENFORCE=order.cancel`, drive an unauthenticated `order.cancel` envelope; assert decision is REFUSE; assert `onToolIntent` is NOT called; assert tool_result content includes `"status": "refused"`.

4. **`defer-roundtrip.test.ts`** — extends Task 03's roundtrip test:
   - Park envelope via responder.
   - Publish `payment.confirmed` NATS event.
   - Assert dispatcher receives identical envelope.
   - Duplicate-delivery: assert dispatcher called once.
   - Tampered-envelope: assert verifyParkedEnvelopeHash rejects.

5. **`audit-emission-contract.test.ts`:**
   - For each Decision kind (EXECUTE, REFUSE, DEFER, REWRITE, REQUEST_CONFIRMATION, ESCALATE), drive a real envelope, assert `getAuditSink().emit(record)` is called once with the expected record shape.
   - Assert `record.envelope.intentHash` is stable across two identical envelopes (replay safety).

6. **`pix-guard-composition.test.ts`** — feed `order.checkout.create` envelope with `paymentMethod: "pix" && paymentStatus: "pending"` through `ordersPack.policy`; assert `Decision.kind === "DEFER"` with `signal === "payment.confirmed"`.

7. **`replay-determinism.test.ts`** — re-feed 20+ stored audit records through `adjudicate()` with their recorded state; assert decision `kind` and `intentHash` match.

8. **`bypass-detection.test.ts`** (CI gate):
   - Static: grep `packages/tools/`, `apps/api/src/routes/`, `apps/api/src/subscribers/`, `apps/api/src/jobs/` for direct calls to `prisma.payment.update`, `prisma.orderProjection.update`, `prisma.reservation.create`, `medusaStore(POST...)`, `medusaAdmin(POST...)`. Assert: every such call is inside an `adjudicate() === EXECUTE | REWRITE` branch.
   - Runtime: a smoke test that asserts a mutating tool whose envelope is hand-stripped fails to execute (responder must refuse to dispatch).
   - Mark this file with a top-of-file comment: `// CI gate: this test MUST pass before merge`.

9. **`ledger-fail-modes.test.ts`:**
   - `IBX_LEDGER_FAIL_OPEN=true` + Redis circuit open → returns null + logs `recordLedgerOp({outcome: "error"})`.
   - `IBX_LEDGER_FAIL_OPEN=false` + Redis circuit open → throws `LedgerUnavailableError`.
   - Duplicate envelope: assert second `checkLedger()` returns hit; `onToolIntent` not called.

10. **`audit-sink-backpressure.test.ts`** — NATS publish fails: assert `recordSinkFailure({sink: "nats"})` fires; assert decision still completes (sink failure doesn't block).

11. **`webhook-defer-ledger.test.ts`** — Stripe webhook delivers same event twice: assert only one envelope adjudicated, one Postgres audit row, one PIX completion.

12. **`ibx kernel status` CLI:**
    - `packages/cli/src/commands/kernel.ts` exports a yargs/clack command.
    - Prints: current `IBX_KERNEL_SHADOW`, `IBX_KERNEL_ENFORCE`, parsed sets, kill switch state (`getKillSwitchState()`), last 100 decisions from Postgres audit, ledger size estimate.

13. **`ibx kernel replay` CLI:**
    - `ibx kernel replay --since=24h [--intent-kind=X] [--limit=1000]`
    - Reads audit records from Postgres via `readAuditWindow`.
    - Re-feeds each through `adjudicate()` with recorded state.
    - Reports via `replayWithIntegrity` + `explainReplayReport` (per investigation 05 Tier 1 #8).
    - Exits non-zero if drift > 0.

14. **`ibx kernel divergence` CLI:**
    - Reads shadow-divergence events from the metrics store (or directly from PostHog API).
    - Prints summary: per intent kind, count of `BASIS_ONLY`, `DECISION_KIND`, `PAYLOAD_REWRITE` divergences over a window.

## Acceptance criteria

- [ ] kernel-contract.test.ts has 60+ cases passing.
- [ ] shadow-mode.test.ts passes 3 divergence-class cases.
- [ ] enforce-mode.test.ts passes (REFUSE blocks dispatch).
- [ ] defer-roundtrip.test.ts passes 4 cases.
- [ ] audit-emission-contract.test.ts passes for all 6 decision kinds.
- [ ] pix-guard-composition.test.ts passes.
- [ ] replay-determinism.test.ts passes 20+ fixtures.
- [ ] bypass-detection.test.ts CI gate passes; CI integration confirmed.
- [ ] ledger-fail-modes.test.ts passes both branches + dup case.
- [ ] audit-sink-backpressure.test.ts passes.
- [ ] webhook-defer-ledger.test.ts passes.
- [ ] `ibx kernel status` prints expected info.
- [ ] `ibx kernel replay --since=24h` runs against the Postgres audit table.
- [ ] `ibx kernel divergence` prints summary.
- [ ] `packages/cli/src/index.ts` exposes `kernel` subcommand.

## Testing requirements

- This task IS the testing requirement for the migration.
- CI gate (`bypass-detection.test.ts`) integrated into the existing CI workflow.

## Rollout notes

Direct merge. The CI gate may catch regressions in M0–M4 PRs — coordinate with those task owners. The CLIs are operator tools; document usage in `docs/cli/reference.md` and `docs/ops/runbooks/`.

## Rollback notes

Revert individual test files if false-positive. Removing the CI gate is a security regression; only do so with explicit approval. CLI revert removes operator tools but doesn't affect runtime. ETA: per file <5 min. No data loss.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 20: test coverage baseline + kernel CLIs.

CONTEXT
Per investigation 07 in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/07-testing-observability.md, the kernel migration surface has essentially TWO direct tests today. The migration cannot safely flip enforce mode without ~60 contract tests + DEFER round-trip + shadow/enforce branch tests + bypass detection (CI gate) + replay CLI.

Your job: write the missing tests AND build the 3 CLI subcommands (status, replay, divergence) referenced in the runbooks.

REPO LAYOUT
- packages/llm-provider/src/__tests__/ (existing tests; add 9 new files)
- apps/api/src/__tests__/ (add 3 new files)
- packages/pack-orders/src/__tests__/ (1 new file)
- packages/cli/src/ (existing CLI; add kernel.ts subcommand)
- packages/cli/src/index.ts (yargs/clack root)
- @adjudicate/audit exports: replayWithIntegrity, classifyReplayDrift, explainReplayReport
- @adjudicate/audit-postgres exports: readAuditWindow

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/llm-provider/src/__tests__/kernel-contract.test.ts (CREATE)
- packages/llm-provider/src/__tests__/shadow-mode.test.ts (CREATE)
- packages/llm-provider/src/__tests__/enforce-mode.test.ts (CREATE)
- packages/llm-provider/src/__tests__/audit-emission-contract.test.ts (CREATE)
- packages/llm-provider/src/__tests__/replay-determinism.test.ts (CREATE)
- packages/llm-provider/src/__tests__/ledger-fail-modes.test.ts (CREATE)
- packages/llm-provider/src/__tests__/audit-sink-backpressure.test.ts (CREATE)
- packages/pack-orders/src/__tests__/pix-guard-composition.test.ts (CREATE)
- apps/api/src/__tests__/defer-roundtrip.test.ts (CREATE — supersedes Task 03's smoke)
- apps/api/src/__tests__/bypass-detection.test.ts (CREATE — CI gate)
- apps/api/src/__tests__/webhook-defer-ledger.test.ts (CREATE)
- packages/cli/src/commands/kernel.ts (CREATE — 3 subcommands)
- packages/cli/src/commands/__tests__/kernel.test.ts (CREATE)
- packages/cli/src/index.ts (MODIFY — wire kernel subcommand)
- docs/cli/reference.md (MODIFY — add kernel command docs)
- docs/ops/runbooks/*.md (MODIFY — replace placeholder CLI references with actual `ibx kernel ...` commands)

PHASES

Phase A — Kernel contract tests (3-4 days, ~60 cases):
1. kernel-contract.test.ts: describe block per intent kind. List intent kinds from packs:
   - From pack-orders: order.cart.add, order.cart.update, order.cart.remove, order.checkout.create, order.cancel, order.amend, order.pix.regenerate, order.note.add, order.admin.force_cancel, order.admin.refund, order.admin.waive_payment, order.admin.force_payment_status, account.delete, account.delete.cancel, order.placed_via_webhook, payment.reconcile_from_webhook, order.refund_from_webhook, order.dispute_from_webhook, order.cancel_from_webhook, order.auto_confirm_on_paid, order.auto_cancel_on_refund, order.cancel_stale, payment.expire_pix, payment.create_from_order_placed, medusa.* (13 kinds)
   - From pack-reservations: reservation.create, reservation.confirm, reservation.modify, reservation.cancel, reservation.no_show, reservation.waitlist.join, reservation.waitlist.release
   - From pack-whatsapp: whatsapp.message.send, whatsapp.template.send, whatsapp.session.handover
   - Per kind: at least 3 cases covering different decision outcomes (EXECUTE, REFUSE, REWRITE or DEFER as applicable)
2. Total: target 60+ cases.

Phase B — Shadow / enforce / DEFER / audit (2 days):
3. shadow-mode.test.ts: 3 divergence classes (BASIS_ONLY, DECISION_KIND, PAYLOAD_REWRITE). Mock metrics sink to assert recordShadowDivergence with the right class.
4. enforce-mode.test.ts: set process.env.IBX_KERNEL_ENFORCE = "order.cancel"; drive a refused envelope; assert no onToolIntent call.
5. defer-roundtrip.test.ts (4 cases): park, resume, duplicate-delivery dedup, tampered-envelope rejection.
6. audit-emission-contract.test.ts: 6 cases (one per Decision kind); also assert intentHash stable across re-build.

Phase C — Pack composition + replay determinism (1 day):
7. pix-guard-composition.test.ts: assert DEFER for paymentMethod=pix + paymentStatus=pending.
8. replay-determinism.test.ts: 20+ AuditRecord fixtures re-fed through adjudicate; assert decision.kind and envelope.intentHash match.

Phase D — Ledger + bypass + webhook (1-2 days):
9. ledger-fail-modes.test.ts: 3 cases (fail-open, fail-safe, dup suppression).
10. audit-sink-backpressure.test.ts: NATS sink throws; assert recordSinkFailure + decision still completes.
11. webhook-defer-ledger.test.ts: Stripe replay → one adjudication, one audit row.
12. bypass-detection.test.ts (CI gate):
    - Grep packages/tools/, apps/api/src/routes/, apps/api/src/subscribers/, apps/api/src/jobs/ for prisma.payment.update, prisma.orderProjection.update, prisma.reservation.create, medusaStore(POST..., medusaAdmin(POST...
    - Assert each match is inside an adjudicate()===EXECUTE|REWRITE branch
    - Runtime smoke: build an envelope with envelope = undefined; assert responder refuses dispatch
    - Top comment: // CI gate: this test MUST pass before merge

Phase E — CLIs (1-2 days):
13. kernel.ts subcommand with 3 sub-subcommands:
    - `ibx kernel status` — prints process.env.IBX_KERNEL_SHADOW + ENFORCE parsed sets, getKillSwitchState() from @adjudicate/core/kernel, last 100 IntentAudit rows from Postgres
    - `ibx kernel replay --since=<duration> [--intent-kind=X] [--limit=N]` — readAuditWindow from @adjudicate/audit-postgres, re-feed via adjudicate, run replayWithIntegrity + explainReplayReport, exit code 0 (clean) or 1 (drift)
    - `ibx kernel divergence --since=<duration>` — query PostHog or Postgres for audit_kernel_shadow_diverged_* events, summarize per kind
14. Wire into packages/cli/src/index.ts (follow existing subcommand pattern)
15. Tests in __tests__/kernel.test.ts: mock dependencies, assert correct output format
16. docs/cli/reference.md: add `ibx kernel` section with usage + examples in pt-BR
17. docs/ops/runbooks/*.md: replace placeholder "ibx kernel replay --intent-kind=X" / "ibx kernel status" references with the actual commands (they were aspirational per investigation 07; now real)

CONSTRAINTS
- Read CLAUDE.md rules 4, 9 first
- pt-BR for any CLI output text
- Tests deterministic: seeded RNG, fixed timestamps, no real network
- Use vitest + v8 coverage (existing config)
- CI gate: bypass-detection.test.ts MUST be wired into CI workflow — coordinate with .github/workflows or equivalent
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT modify @adjudicate/* source

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] kernel-contract.test.ts: 60+ cases across 30+ intent kinds passing
- [ ] shadow-mode.test.ts: 3 divergence classes passing
- [ ] enforce-mode.test.ts: REFUSE blocks dispatch
- [ ] defer-roundtrip.test.ts: 4 cases passing
- [ ] audit-emission-contract.test.ts: 6 decision kinds passing
- [ ] pix-guard-composition.test.ts: DEFER on pending PIX
- [ ] replay-determinism.test.ts: 20+ fixtures passing
- [ ] bypass-detection.test.ts: CI gate green; wired into CI workflow
- [ ] ledger-fail-modes.test.ts: 3 cases passing
- [ ] audit-sink-backpressure.test.ts: sink failure doesn't block decision
- [ ] webhook-defer-ledger.test.ts: idempotency verified
- [ ] `ibx kernel status` works against a local instance
- [ ] `ibx kernel replay --since=24h` works against the IntentAudit table (Task 19)
- [ ] `ibx kernel divergence` prints PostHog/Postgres summary
- [ ] docs/cli/reference.md updated
- [ ] docs/ops/runbooks/*.md updated with real CLI references
- [ ] `pnpm test` workspace-wide passes
- [ ] `pnpm typecheck` workspace-wide passes

When complete, return: total test case count, list of intent kinds covered in kernel-contract.test.ts, CI gate wiring confirmation, and any flaky-test risks (e.g. timing-sensitive shadow tests) for follow-up review.
```
