# WS-7 — Site migration: `review.prompt` subscriber (cart-intelligence)

**Wave:** 2 (site migration; runs after WS-1, WS-2, WS-3; sequence with WS-4 and WS-6)
**Status:** GATED on stakeholder pick of open questions 1, 6.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Deferred sites inventory" #4 + §"Rollout sequencing" Phase 2.3.

---

## Objective

Migrate the `review.prompt` subscriber in `cart-intelligence.ts` (lines 938-980) from direct-`sendText()` to the kernel-gated `whatsapp.message.send` envelope flow. The subscriber sends a review-request 30min after delivery. Customer is "warm" (just received the order) but may not have **messaged** in 24h — the state-builder gates on inbound messages, not order events, so edge cases at the 24h boundary will REFUSE correctly.

## Blocking design-doc picks

- **Q1 (Join axis)** — recommended `customerId`; assumed.
- **Q6 (Customer's `lastCustomerMessageAt`)** — recommended; assumed.

## Impacted files

- [`apps/api/src/subscribers/cart-intelligence.ts`](../../../../../apps/api/src/subscribers/cart-intelligence.ts) — lines 938-980.
- [`apps/api/src/subscribers/__tests__/cart-intelligence-governance.test.ts`](../../../../../apps/api/src/subscribers/__tests__/) — extend the file from WS-4 / WS-6.

## Dependencies

- **WS-1, WS-2, WS-3** required.
- Independent of WS-4 and WS-6 functionally, but shares the same file → coordinate the merges.

## Acceptance criteria

- The handler at cart-intelligence.ts:938-980 no longer calls `sendText()` directly.
- New flow:
  1. Resolve customer from the order's `customerId`.
  2. Call `buildWhatsAppState({ customerId, customerPhone, recipientType: "customer" })`.
  3. Build envelope `whatsapp.message.send` with the review-request body.
  4. Adjudicate; branch on outcome.
  5. EXECUTE → send; REFUSE → DLQ + log.
- For customers whose last inbound was >24h before delivery, REFUSE is the correct behaviour (the design notes this explicitly as an edge case).

## Test strategy

Extend `cart-intelligence-governance.test.ts`:
- ADMIT: customer last-message 5h ago, review prompt fires 30min after delivery → ADMIT.
- ADMIT: customer last-message 23h ago, prompt fires inside window → ADMIT (boundary case).
- REFUSE: customer last-message 25h ago (the order was placed by phone or web; customer never WhatsApp'd) → REFUSE.
- Prisma error → DLQ entry.

## Rollout notes

- Per the design's Phase 2.3 ordering, this is the 3rd site to migrate (after hesitation-nudge and pix-expiry, before notification.send). The risk is moderate — delivered orders mean recent customer engagement, but not always recent WhatsApp inbound.
- Watch for REFUSE volume; if elevated, audit whether order-channel correlates with inbound-message channel.

## Rollback notes

- Revert leaves the existing direct-`sendText()` path live.

## Merge-conflict risk

- **HIGH** with WS-4 and WS-6 (same file `cart-intelligence.ts`). Sequence carefully.
- See WS-4's "Merge-conflict risk" section for coordination strategy.

## Ready-to-spawn sub-agent prompt

> You are the WS-7 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Migrate the `review.prompt` handler in `apps/api/src/subscribers/cart-intelligence.ts:938-980` from direct `sendText()` to the kernel-gated envelope flow.
>
> **Pre-reqs:** WS-1, WS-2, WS-3 merged. WS-4 and WS-6 may or may not be — coordinate sequencing.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Deferred sites" #4 and §"Rollout sequencing" Phase 2.3.
> 2. Read `apps/api/src/subscribers/cart-intelligence.ts:938-980`.
> 3. Refactor per the WS-4 pattern.
> 4. Extend `apps/api/src/subscribers/__tests__/cart-intelligence-governance.test.ts` with the 4 test cases.
> 5. Tests pass; TSC passes.
>
> **Hard stops:**
> - If the review-prompt handler currently piggy-backs on `notification.send` (vs. calling `sendText` directly), then this task is a no-op — WS-4's handler already gates it.
> - Verify before refactoring.
>
> **Commit:** `feat(api,whatsapp-state-builder): wire review.prompt through kernel-gated envelope`

## Estimated complexity

**S** — single-handler refactor + 4 test cases. ~3-4 hours. Add 1-2 hours if merge conflicts with WS-4/WS-6.
