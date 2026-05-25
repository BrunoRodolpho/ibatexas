# WS-5 — Site migration: `handoff-subscriber`

**Wave:** 2 (site migration; runs after WS-1, WS-2, WS-3)
**Status:** GATED on stakeholder pick of open questions 1, 5, 6.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Deferred sites inventory" #2 + §"Rollout sequencing" Phase 2.9.

---

## Objective

Migrate `handoff-subscriber.ts` (lines 14-61) from direct-`sendText()` to the kernel-gated `whatsapp.message.send` flow. The subscriber sends a staff-recipient WhatsApp alert when the LLM requests human handoff. Per the design's clarification (Q6), even though the recipient is staff, the `lastCustomerMessageAt` projection IS the **customer's** timestamp — the policy gates on whether the customer-initiated window is open, not on any staff-side timestamp. The handoff site also depends on `perCustomerHandoffCount` for rate-limiting; per Q5 this stays stubbed (returning `0`) — the rate-limit will NOT fire in this task's scope, only the 24h window will.

## Blocking design-doc picks

- **Q1 (Join axis)** — recommended `customerId`; assumed.
- **Q5 (`perCustomerHandoffCount` stub OK?)** — recommended split into a sister design; **this task accepts the stub semantics**. The rate-limit will not actually fire until the sister project lands. Per the design doc §"Deferred sites inventory" #2 footnote, this is acknowledged as a known gap.
- **Q6 (Per-staff `lastCustomerMessageAt`?)** — recommended "always project from customer". **This task implements that semantic.**

## Impacted files

- [`apps/api/src/subscribers/handoff-subscriber.ts`](../../../../../apps/api/src/subscribers/handoff-subscriber.ts) — lines 14-61.
- [`apps/api/src/subscribers/__tests__/handoff-subscriber-governance.test.ts`](../../../../../apps/api/src/subscribers/__tests__/) — NEW file.

## Dependencies

- **WS-1, WS-2, WS-3** required.
- Independent of WS-4..12 sites.

## Acceptance criteria

- The handler at handoff-subscriber.ts:14-61 no longer calls `sendText()` directly.
- New flow:
  1. Resolve customer's `customerId` and `customerPhone` from the handoff event payload.
  2. Resolve staff's `staffId` and recipient phone (the egress target).
  3. Call `await buildWhatsAppState({ customerId, customerPhone, recipientType: "staff", staffId })` — note `customerPhone` is the **customer's** phone (whose window matters), not the staff phone.
  4. Build envelope: `whatsapp.message.send` with `to: <staff-phone>`, `senderRole: "system"`.
  5. `adjudicate(envelope, state)` → branch on outcome.
  6. EXECUTE → send → log success.
  7. REFUSE (window expired / no prior message) → DLQ + log.
- The `recipientType: "staff"` value is set even though the projection's `lastCustomerMessageAt` field is the **customer's**. This is consistent with the Pack policy contract (the policy decides "is the recipient inside the customer-initiated window") — `recipientType` is metadata, not the source of the projection.
- Rate-limit (`perCustomerHandoffCount`) stays at the stubbed `0` — the policy's 3rd+/10min REFUSE will not actually fire. This is the known gap per Q5.

## Test strategy

`apps/api/src/subscribers/__tests__/handoff-subscriber-governance.test.ts`:
- ADMIT: customer last-message 1h ago → state-builder returns 1h → adjudicate ADMITs → staff WhatsApp alert sent.
- REFUSE (window expired): customer last-message 25h ago → REFUSE with `window_expired` → DLQ entry → staff NOT alerted via WhatsApp. (Edge case: in production, an expired window for an LLM-initiated handoff is unusual since the LLM only runs after a customer message — but the policy correctly enforces the contract.)
- REFUSE (no prior message): customer phantom (no DB row) → null projection → REFUSE → DLQ.
- Postgres error in state-builder → handler catches → DLQ entry.
- `staffId` correctly forwarded into state.ctx.staffId.
- `recipientType: "staff"` correctly set in state.ctx.recipientType.

## Rollout notes

- Lowest-frequency site (handoffs are rare); deploy last per the design's phase-2.9 ordering.
- Watch for false REFUSEs in the first 24h — the customer who triggered handoff just messaged in, so the state-builder SHOULD return a fresh timestamp. If WS-2 isn't deployed in time, the projection is NULL → REFUSE → no staff alert → silent escalation failure. Therefore: WS-5 must NOT deploy ahead of WS-2.

## Rollback notes

- Revert leaves the existing direct-`sendText()` path live.

## Merge-conflict risk

- **LOW.** `handoff-subscriber.ts` is a single-handler file; no other WS-N task touches it.
- No overlap with WS-4, WS-6, WS-7.

## Ready-to-spawn sub-agent prompt

> You are the WS-5 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Migrate `apps/api/src/subscribers/handoff-subscriber.ts` (lines ~14-61) from direct `sendText()` to the kernel-gated `whatsapp.message.send` envelope flow. The recipient is **staff** but the `lastCustomerMessageAt` projection is the **customer's** — per design Q6.
>
> **Pre-reqs:** WS-1, WS-2, WS-3 merged.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Deferred sites" #2 fully — note the staff-recipient + customer-projection semantics.
> 2. Read `apps/api/src/subscribers/handoff-subscriber.ts`.
> 3. Refactor: resolve customer + staff identities → call `buildWhatsAppState({ customerId, customerPhone, recipientType: "staff", staffId })` → build envelope (note `to:` is the staff phone) → adjudicate → branch.
> 4. Create `apps/api/src/subscribers/__tests__/handoff-subscriber-governance.test.ts` with the 6 test cases above.
> 5. Tests pass; TSC passes.
>
> **Hard stops:**
> - Do NOT call `buildWhatsAppState` with the staff's phone. The customer's `lastCustomerMessageAt` is what matters per Q6.
> - Do NOT implement the real `perCustomerHandoffCount` rate-limit — it stays stubbed per Q5.
>
> **Commit:** `feat(api,whatsapp-state-builder): wire handoff-subscriber through kernel-gated envelope`
>
> **Out of scope:** the `perCustomerHandoffCount` rate-limit logic (sister design per Q5).

## Estimated complexity

**S** — single-handler refactor + 6 test cases. ~3-4 hours.
