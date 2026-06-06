# WS-13 — Backfill posture: implement backfill OR document the deferral

**Wave:** 3 (post-foundation, post-site-migration)
**Status:** GATED on stakeholder pick of open question 2.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Schema migration" + §"Open questions" Q2 + §"Rollout sequencing" Phase 1.

---

## Objective

Address the "what about already-existing customers whose `lastCustomerMessageAt` is NULL" question. Two possible postures:

1. **Backfill (recommended for clean deploys):** ship a one-shot CLI command `ibx whatsapp-state backfill` that walks `conversation_messages` and sets `customers.last_customer_message_at = MAX(sentAt) WHERE role = 'user' AND conversation.channel = 'whatsapp'` for every customer.
2. **Accept elevated REFUSE during ramp-up (acceptable per Q2):** document that the first 24h post-deploy sees elevated `no_prior_customer_message` REFUSEs for dormant customers, and that the rate normalizes as customers organically re-message. No code; pure ops doc.

The stakeholder pick on Q2 selects which posture this task implements.

## Blocking design-doc picks

- **Q2 (Backfill or no?)** — **THIS IS THE LOAD-BEARING QUESTION FOR THIS TASK**. The recommended default is "acceptable to skip backfill" with elevated-REFUSE during ramp-up. Stakeholder explicit confirmation needed.

## Impacted files

**If backfill is selected:**
- **NEW** [`packages/cli/src/commands/whatsapp-state.ts`](../../../../../packages/cli/src/commands/) — new CLI command `ibx whatsapp-state backfill`.
- [`packages/cli/src/index.ts`](../../../../../packages/cli/src/index.ts) — register the new subcommand.
- **NEW** [`packages/cli/src/commands/__tests__/whatsapp-state.test.ts`](../../../../../packages/cli/src/commands/__tests__/) — tests.

**If deferral is selected:**
- **NEW** [`docs/ops/runbooks/whatsapp-state-rampup.md`](../../../../../docs/ops/runbooks/) — runbook documenting the elevated-REFUSE 24h window post-deploy and how to monitor it.

## Dependencies

- **WS-1, WS-2** required (the column must exist and writes must be flowing before backfill is useful).
- Independent of WS-3..12 (backfill is an independent ops task).

## Acceptance criteria (backfill path)

- New CLI command `ibx whatsapp-state backfill` that:
  - Reads `conversation_messages` joined with `conversations` joined with `customers`.
  - Aggregates `MAX(sentAt)` per `(customerId)` where `role='user'` AND `conversation.channel='whatsapp'`.
  - Batches the UPDATE in chunks of 1000 with progress reporting.
  - Is idempotent — re-running picks up where left off based on the existing column value.
  - Has a `--dry-run` flag that reports counts without writing.
  - Emits a structured-log JSON summary at end: `{ scanned: N, updated: M, skipped: K }`.
- Tests cover:
  - Empty `conversation_messages` → 0 updates.
  - Mixed channels → only `channel='whatsapp'` rows considered.
  - Re-run after partial completion → idempotent.
  - `--dry-run` does not write.

## Acceptance criteria (deferral path)

- New runbook documents:
  - The expected elevated-REFUSE rate window (~24h-48h post-deploy).
  - Metrics to watch: `kernel_whatsapp_state_builder_invocations_total{outcome="null_projection"}`, `kernel_message_send_refuse_total{basis="no_prior_customer_message"}`.
  - Pager threshold (or explicit non-pager) for the elevated rate.
  - Confirmation that the rate normalizes as customers re-message; if it does not normalize within 7d, escalate to backfill.

## Test strategy

(Backfill path only — deferral is docs-only.)
- Unit tests on the aggregation SQL / Prisma query.
- Integration test with a seeded `conversation_messages` fixture.
- Idempotency test.
- `--dry-run` test.

## Rollout notes

(Backfill path)
- Run `ibx whatsapp-state backfill --dry-run` first in production to estimate update count.
- Run the live backfill during low-traffic hours.
- Monitor `customers` table write contention if the count is very high.

(Deferral path)
- Watch the metrics dashboards.
- Document who's on-call for the first 48h post-deploy.

## Rollback notes

(Backfill path)
- Backfill is forward-only; reverting the column update isn't meaningful since the value would be re-derived on next inbound anyway.

## Merge-conflict risk

- **LOW.** New CLI file or new doc file. No overlap with other WS-N tasks.

## Ready-to-spawn sub-agent prompt (backfill path)

> You are the WS-13 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Implement the one-shot backfill CLI command `ibx whatsapp-state backfill` that populates `Customer.lastCustomerMessageAt` from existing `conversation_messages` rows. Per Q2's "backfill" pick.
>
> **Pre-reqs:** WS-1, WS-2 merged.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Schema migration" backfill section.
> 2. Add a new CLI command file under `packages/cli/src/commands/whatsapp-state.ts`.
> 3. Implement the batched-update Prisma query.
> 4. Add `--dry-run` flag.
> 5. Register the command in `packages/cli/src/index.ts`.
> 6. Write tests in `packages/cli/src/commands/__tests__/whatsapp-state.test.ts`.
> 7. Tests pass; TSC passes.
>
> **Hard stops:**
> - If the join can't resolve `customerId` (because `Conversation.customerId` is NULL for some rows), skip those — don't fail the backfill.
>
> **Commit:** `feat(cli,whatsapp-state-builder): add backfill command for lastCustomerMessageAt`

## Ready-to-spawn sub-agent prompt (deferral path)

> You are the WS-13 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Document the elevated-REFUSE ramp-up posture in a new runbook. Per Q2's "no backfill" pick.
>
> **Pre-reqs:** WS-1, WS-2 merged.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Open questions" Q2.
> 2. Create `docs/ops/runbooks/whatsapp-state-rampup.md`.
> 3. Document the metrics to watch, expected rate window, escalation criteria.
> 4. Cross-reference from the kernel-operations runbook.
>
> **Commit:** `docs(ops,whatsapp-state-builder): runbook for ramp-up REFUSE window`

## Estimated complexity

- **Backfill path: M** — new CLI command + batched query + idempotency + tests. ~4-8 hours.
- **Deferral path: XS** — new runbook only. ~1-2 hours.
