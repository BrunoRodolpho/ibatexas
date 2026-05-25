# WS-4 — Site migration: `notification.send` subscriber (cart-intelligence)

**Wave:** 2 (site migration; runs after WS-1, WS-2, WS-3)
**Status:** GATED on stakeholder pick of open questions 1, 5, 6.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Deferred sites inventory" #1 + §"Rollout sequencing" Phase 2.4.

---

## Objective

Migrate the `notification.send` subscriber in `cart-intelligence.ts` (lines 822-873) from the legacy direct-`sendText()` path to the kernel-gated `whatsapp.message.send` envelope flow. Reads `WhatsAppState` via `buildWhatsAppState()`, builds the envelope via `buildSystemEnvelope()`, calls `adjudicate()`, and dispatches the Twilio send only on EXECUTE. On REFUSE, logs and DLQ-routes. Per the design's "highest-fanin site" classification — this is the cart-recovery, dispute-alerts, review-prompts core relay.

## Blocking design-doc picks

- **Q1 (Join axis)** — recommended `customerId`; assumed.
- **Q5 (`perCustomerHandoffCount` stub OK?)** — recommended yes; assumed. This site doesn't exercise the handoff counter; the stub is fine.
- **Q6 (Customer's `lastCustomerMessageAt`, never staff's)** — recommended; assumed. The recipient is always a customer here.

## Impacted files

- [`apps/api/src/subscribers/cart-intelligence.ts`](../../../../../apps/api/src/subscribers/cart-intelligence.ts) — lines 822-873 (the `notification.send` handler body). Refactor to construct envelope + state, call kernel, branch on outcome.
- [`apps/api/src/subscribers/__tests__/cart-intelligence-governance.test.ts`](../../../../../apps/api/src/subscribers/__tests__/) — NEW file (matches the post-Task-16 `*-governance.test.ts` pattern). Tests for ADMIT and REFUSE paths.
- DLQ surface: confirm `apps/api/src/subscribers/dlq.ts` accepts the kind/payload shape used here (should already, post-Task-16).

## Dependencies

- **WS-1** (column exists) — required for the helper to compile.
- **WS-2** (writer ships) — soft-required; if writer hasn't shipped, every read returns NULL and every send REFUSEs with `no_prior_customer_message`. Acceptable for the first deploy if backfill is also pending (per Q2's "elevated REFUSE during ramp-up" posture).
- **WS-3** (helper exists) — required.
- Independent of all other WS-4..12 sites.

## Acceptance criteria

- The handler at cart-intelligence.ts:822-873 no longer calls `sendText()` (or any direct Twilio HTTP wrapper) directly.
- New flow:
  1. Resolve `customerId` and `customerPhone` from the inbound `notification.send` event payload.
  2. Call `await buildWhatsAppState({ customerId, customerPhone, recipientType: "customer" })`.
  3. Call `buildSystemEnvelope({ kind: "whatsapp.message.send", payload: { to: customerPhone, body, senderRole: "system" }, sourceSubject: "notification.send", eventId: <stable-id> })`.
  4. Call `adjudicate(envelope, state)` (or the equivalent per-Pack command service).
  5. On EXECUTE → proceed to Twilio send (via existing `twilioAdjudicated` HTTP wrapper) → log success.
  6. On REFUSE → log basis, push to DLQ (via existing `dlqPush()`), increment refusal metric, return.
- The existing notification types covered (cart abandoned tier 1/2/3, order placed, status changes, dispute alerts, review prompts — per the inventory) all flow through this same handler with the same gating.
- No silent failure mode — every refusal must have a DLQ entry + basis log.

## Test strategy

`apps/api/src/subscribers/__tests__/cart-intelligence-governance.test.ts`:
- ADMIT: inbound `notification.send` with customer last-message 2h ago → state-builder returns 2h-old timestamp → adjudicate ADMITs → Twilio called once.
- REFUSE (window expired): last-message 25h ago → adjudicate REFUSEs with `window_expired` → Twilio NOT called → DLQ entry created.
- REFUSE (no prior message): customer has `lastCustomerMessageAt = null` → adjudicate REFUSEs with `no_prior_customer_message` → DLQ entry.
- Prisma error in state-builder → handler catches → DLQ entry → no Twilio call.
- Tier-3 cart-abandoned (46h post-inbound): state-builder returns 46h-old timestamp → adjudicate REFUSEs → DLQ entry, no Twilio call. (This is the "correct behaviour" the design calls out — tier 3 must move to template-send in a future iteration, but is not part of this task's scope.)

## Rollout notes

- Largest-fanin site; deploy in its own PR (per design Phase 2.4 — biggest unlock for cart-recovery + dispute alerts).
- Monitor `kernel_whatsapp_state_builder_invocations_total{outcome="null_projection"}` and `kernel_message_send_refuse_total{basis="no_prior_customer_message"}` for the first 48h post-deploy. Elevated rates are expected and acceptable for un-backfilled customers (per Q2).

## Rollback notes

- If REFUSE rate is unacceptably high during the elevated-REFUSE window, the rollback option is to revert this PR — the legacy direct-`sendText()` path remains in git history.
- After several days of stable operation (and either backfill via WS-13 lands or customers naturally re-message), the rate normalizes.

## Merge-conflict risk

- **HIGH.** `cart-intelligence.ts` is a hot multi-handler subscriber. WS-6 (cart.abandoned tier escalation) and WS-7 (review.prompt) also touch this file. Sequence carefully or batch all three sites into a single coordinated PR.
- Suggested batching: WS-4 + WS-6 + WS-7 land in three sequential PRs each rebased on the prior. Or merge to a coordination branch and squash.
- Watch for conflict with the H3 wave-a in-process anonymize if it touches `notification.send` handler.

## Ready-to-spawn sub-agent prompt

> You are the WS-4 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Migrate the `notification.send` handler in `apps/api/src/subscribers/cart-intelligence.ts` (lines ~822-873) from direct `sendText()` to the kernel-gated `whatsapp.message.send` envelope flow.
>
> **Pre-reqs:** WS-1, WS-2, WS-3 must be merged. Verify via `git log --oneline | grep -E "lastCustomerMessageAt|buildWhatsAppState"`.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Deferred sites inventory" #1 and §"Rollout sequencing" Phase 2.4.
> 2. Read `apps/api/src/subscribers/cart-intelligence.ts:822-873`.
> 3. Read `apps/api/src/subscribers/__shared__/whatsapp-state-builder.ts` and `system-actor-envelope.ts` for the helper signatures.
> 4. Read any existing `*-governance.test.ts` (e.g., for payment-lifecycle or handoff) for the test pattern.
> 5. Refactor the handler to: resolve customer → build state → build envelope → adjudicate → branch on outcome → Twilio (EXECUTE) or DLQ (REFUSE).
> 6. Create `apps/api/src/subscribers/__tests__/cart-intelligence-governance.test.ts` with the 5 test cases enumerated in the task file.
> 7. Run `pnpm --filter @ibatexas/api test cart-intelligence-governance` and confirm green.
> 8. Run `pnpm --filter @ibatexas/api tsc --noEmit`.
>
> **Hard stops:**
> - If WS-1/WS-2/WS-3 are not merged, STOP.
> - If the existing `notification.send` handler also handles non-WhatsApp channels (email, SMS), DO NOT change those branches — only the WhatsApp branch flips.
> - Do NOT call `sendText()` directly after the refactor. If you find a code path that still does, STOP and report.
>
> **Commit:** `feat(api,whatsapp-state-builder): wire notification.send through kernel-gated envelope`
>
> **Out of scope:** the tier-3 escalation REFUSE-handling (that's WS-6 — when tier-3 REFUSEs here, the DLQ entry IS the correct behaviour per the design).

## Estimated complexity

**M** — multi-channel handler refactor + 5 test cases + careful conflict management with WS-6/WS-7. ~4-8 hours.
