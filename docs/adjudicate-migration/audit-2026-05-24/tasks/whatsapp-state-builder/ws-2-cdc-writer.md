# WS-2 — CDC writer: bump `Customer.lastCustomerMessageAt` from `conversation-archiver`

**Wave:** 2 (write side; runs after WS-1)
**Status:** GATED on stakeholder pick of open questions 1, 7.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Alternative B → Write path" + §"Audit-record obligations".

---

## Objective

Extend the existing `conversation-archiver.ts` subscriber so every `conversation.message.appended` event with `role: "user"` AND `channel: "whatsapp"` issues an additional Prisma `UPDATE customers SET last_customer_message_at = $sentAt WHERE id = $customerId` in the same transaction as the existing `conversation_messages` INSERT. This is a side effect of an already-kernel-gated envelope — no new envelope kind, no new audit row, no new write surface.

## Blocking design-doc picks

- **Q1 (Join axis: `phoneHash` or `customerId`?)** — recommended `customerId`; **this task assumes that pick**. The UPDATE WHERE-clause keys on `customerId` (resolved via `Conversation.customerId` lookup if not directly on the event payload).
- **Q7 (Audit-sink coverage for the column UPDATE itself: implicit vs. explicit)** — recommended **implicit**; **this task assumes that pick**. No new audit emission. If stakeholder picks "explicit", add an `audit.emit({ kind: "whatsapp.state.touch", payload: { customerId, lastCustomerMessageAt } })` call inside the handler — but the recommended default leaves the audit row of the parent `conversation.message.append` as the implicit trail.

## Impacted files

- [`apps/api/src/subscribers/conversation-archiver.ts`](../../../../../apps/api/src/subscribers/conversation-archiver.ts) — extend the handler body to do the extra UPDATE.
- [`apps/api/src/subscribers/__tests__/conversation-archiver.test.ts`](../../../../../apps/api/src/subscribers/__tests__/) — extend (or add) tests asserting the column write fires on the right conditions and is a no-op on the wrong conditions.
- [`apps/api/src/lib/metrics.ts`](../../../../../apps/api/src/lib/metrics.ts) (or wherever Prom-style counters live) — add `kernel_whatsapp_state_builder_writes_total{outcome="ok"|"skipped_non_user"|"skipped_non_whatsapp"|"prisma_error"}`. (Counter naming per design doc §"Audit-record obligations".)

## Dependencies

- **WS-1 (schema migration)** — the column must exist before this can compile and run.
- No other WS-N task blocks this. Sites (WS-4..12) consume the read path (WS-3); they do not depend on this writer landing first, but in practice no read will return a non-NULL value until WS-2 ships.

## Acceptance criteria

- On `conversation.message.appended` events where:
  - `event.role === "user"` AND
  - The associated `Conversation.channel === "whatsapp"` (lookup if not on the event payload directly) AND
  - `Conversation.customerId IS NOT NULL`
  → issue `UPDATE customers SET last_customer_message_at = $sentAt WHERE id = $customerId` inside the SAME transaction as the existing `conversation_messages` INSERT.
- On all other event shapes (assistant role, non-whatsapp channel, null customerId), the new code path is a no-op.
- Failure modes:
  - Prisma error during the UPDATE → bubbles up to the existing archiver error path (the message INSERT and the customer UPDATE share a transaction; both rollback together).
  - Customer row not found (e.g., race with delete) → UPDATE affects 0 rows; logged + metric `outcome="prisma_error"`; not a hard failure (the message itself is still archived).
- Metrics:
  - `kernel_whatsapp_state_builder_writes_total{outcome="ok"}` incremented on successful updates.
  - `kernel_whatsapp_state_builder_writes_total{outcome="skipped_non_user"}` and `{outcome="skipped_non_whatsapp"}` incremented on each event filter rejection (cheap; helps validate the trigger conditions are exercised in prod).
- No new NATS subjects, no new envelope kinds, no new audit-sink emission (per Q7 recommendation).

## Test strategy

- Unit tests in `apps/api/src/subscribers/__tests__/conversation-archiver.test.ts`:
  - GIVEN a `conversation.message.appended` event with `role=user`, `channel=whatsapp`, `customerId=X` → ASSERT Prisma UPDATE called once with the right args.
  - GIVEN `role=assistant` → ASSERT no UPDATE called.
  - GIVEN `role=user`, `channel=web` → ASSERT no UPDATE called.
  - GIVEN `role=user`, `channel=whatsapp`, `customerId=null` → ASSERT no UPDATE called.
  - GIVEN Prisma transaction throws → ASSERT the whole archiver-handler rolls back (no orphaned INSERT).
  - GIVEN the UPDATE matches 0 rows (customer deleted mid-flight) → ASSERT metrics bump and handler completes (does not throw).
- Integration test (with the existing testcontainer harness in `apps/api/src/__tests__/integration/`):
  - End-to-end: publish `conversation.message.appended` via the test bus → assert `conversation_messages` row exists AND `customers.last_customer_message_at` matches the event's `sentAt`.

## Rollout notes

- Land in same deploy as WS-1 (schema migration) OR strictly after, with the column-presence check in CI ensuring WS-2 cannot compile against a schema lacking the column.
- The added UPDATE is one extra round-trip per inbound WhatsApp message — measurable but tiny (the inbound webhook is already ~50-100ms; this adds ~5-10ms).
- Watch the `kernel_whatsapp_state_builder_writes_total` counter post-deploy to confirm writes are firing for live traffic.

## Rollback notes

- Reverting WS-2 leaves the column in place but unwritten — every read returns NULL → every WhatsApp egress at a deferred site REFUSEs (`no_prior_customer_message`).
- That's the conservative posture, so a roll-back of the writer is **safe** (failure mode is "we refuse more often", not "we send out of policy").
- If sites have already migrated (WS-4..12 shipped), an unconditional WS-2 rollback creates a 24h elevated-REFUSE period until customers re-message. Consider rolling back the sites simultaneously.

## Merge-conflict risk

- **MEDIUM.** Touches `conversation-archiver.ts` which is a hot subscriber file — concurrent edits from any other CDC-touching task would conflict.
- The H3 wave-a in-process anonymize touches `Customer` rows; if H3 lands first, the merge is mechanical (different fields).
- No overlap with WS-3..14.

## Ready-to-spawn sub-agent prompt

> You are the WS-2 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Extend `apps/api/src/subscribers/conversation-archiver.ts` so the existing `conversation.message.appended` handler also issues `UPDATE customers SET last_customer_message_at = $sentAt WHERE id = $customerId` when the event has `role="user"` AND the conversation's `channel="whatsapp"` AND a non-null `customerId`. The UPDATE must run in the SAME Prisma transaction as the existing `conversation_messages` INSERT.
>
> **Pre-reqs:** WS-1 (column added) MUST be merged first. Confirm via `git log --oneline | grep "lastCustomerMessageAt"` before starting.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Alternative B → Write path" and §"Audit-record obligations" fully.
> 2. Read `apps/api/src/subscribers/conversation-archiver.ts` fully — locate the `conversation.message.appended` handler and the existing Prisma transaction wrapper.
> 3. Inside the same transaction, after the INSERT, branch on `role === "user" && channel === "whatsapp" && customerId != null` → issue the UPDATE.
> 4. Add `kernel_whatsapp_state_builder_writes_total{outcome}` counter (name and label set per design doc). Increment on each branch (ok / skipped_non_user / skipped_non_whatsapp / prisma_error).
> 5. Write/extend `apps/api/src/subscribers/__tests__/conversation-archiver.test.ts` with the 6 test cases enumerated in the task file.
> 6. Run `pnpm --filter @ibatexas/api test conversation-archiver` and confirm green.
> 7. Run `pnpm --filter @ibatexas/api tsc --noEmit`.
>
> **Hard stops:**
> - If the existing archiver does NOT use a Prisma transaction (i.e., the INSERT is a bare `prisma.conversationMessage.create()` not wrapped), STOP and report — the task requires a transaction so both writes commit-or-rollback together. Decision point for orchestrator.
> - Do NOT add a new audit-sink emission. The parent envelope's audit row is the implicit trail (per Q7 recommendation). If stakeholder wants explicit, this prompt will be updated.
> - Do NOT add a new envelope kind. Do NOT add a new NATS subject.
>
> **Commit:** `feat(api,whatsapp-state-builder): wire Customer.lastCustomerMessageAt write into conversation-archiver`
>
> **Out of scope:** the state-builder read helper (WS-3), site migrations (WS-4..12), backfill (WS-13).

## Estimated complexity

**S** — single subscriber edit + 6 test cases + 1 metric. ~2-4 hours.
