# WS-12 — Site migration: `cart-recovery-messages` job helpers

**Wave:** 2 (site migration; runs after WS-1, WS-2, WS-3, WS-4)
**Status:** GATED on stakeholder pick of open question 1.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Deferred sites inventory" #9 + §"Rollout sequencing" Phase 2.8.

---

## Objective

Audit `cart-recovery-messages.ts` (the helpers that build per-tier cart recovery message bodies) and confirm its gating is inherited via the relay through `notification.send` (WS-4's handler). If the helpers call `sendText()` directly anywhere, refactor those paths to publish `notification.send` events so the gating works.

## Blocking design-doc picks

- **Q1 (Join axis)** — recommended `customerId`; assumed.

## Impacted files

- [`apps/api/src/jobs/cart-recovery-messages.ts`](../../../../../apps/api/src/jobs/cart-recovery-messages.ts) — full file audit.
- [`apps/api/src/jobs/__tests__/cart-recovery-messages.test.ts`](../../../../../apps/api/src/jobs/__tests__/) — extend or create.

## Dependencies

- **WS-1, WS-2, WS-3, WS-4** required (WS-4 establishes the notification.send gating that this site inherits).
- Possibly affected by WS-6's tier escalation behaviour.

## Acceptance criteria

- After audit:
  - **If** `cart-recovery-messages.ts` already publishes `notification.send` events only: this task is documentation-only — add a comment confirming inheritance from WS-4. No code change.
  - **If** it calls `sendText()` directly anywhere: refactor those callsites to publish `notification.send` instead. The kernel-gating will then flow through WS-4's handler.
- Tests assert that no direct-`sendText` call paths remain.

## Test strategy

`apps/api/src/jobs/__tests__/cart-recovery-messages.test.ts`:
- For each tier's recovery-message generation, assert: the result is a `notification.send` event payload (not a Twilio HTTP call).
- Grep-based test: assert the file does not import `sendText` from `@ibatexas/api/whatsapp/client`.

## Rollout notes

- This is largely a verification task with minor potential cleanup.
- Should be a near-no-op if the architecture already routes through notification.send.

## Rollback notes

- Trivial; the helpers are message-body builders, no behavior change.

## Merge-conflict risk

- **LOW.** Single helper file; unlikely to conflict with WS-4.

## Ready-to-spawn sub-agent prompt

> You are the WS-12 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Audit `apps/api/src/jobs/cart-recovery-messages.ts` for direct `sendText()` calls. If any exist, refactor to publish `notification.send` events so they inherit WS-4's gating. Otherwise, document the inheritance.
>
> **Pre-reqs:** WS-1, WS-2, WS-3, WS-4 merged.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Deferred sites" #9.
> 2. Read `apps/api/src/jobs/cart-recovery-messages.ts` fully.
> 3. `grep -n "sendText\|sendMedia\|twilioAdjudicated" apps/api/src/jobs/cart-recovery-messages.ts` — enumerate every send callsite.
> 4. For each: if it publishes `notification.send`, leave it. If it calls Twilio directly, refactor.
> 5. Extend tests to assert no direct-`sendText` paths remain.
>
> **Hard stops:**
> - If the helpers are pure builders (no send logic), this task is a no-op — close as docs-only.
>
> **Commit:** `chore(api,whatsapp-state-builder): audit cart-recovery-messages gating inheritance`

## Estimated complexity

**XS-S** — audit + possibly small refactor. ~1-3 hours.
