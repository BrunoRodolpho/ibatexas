# WS-6 — Site migration: `cart.abandoned` tier-escalation

**Wave:** 2 (site migration; runs after WS-1, WS-2, WS-3; sequence with WS-4 and WS-7)
**Status:** GATED on stakeholder pick of open questions 1, 4.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Deferred sites inventory" #3 + §"Rollout sequencing" Phase 2.5.

---

## Objective

Migrate the cart-abandoned tier-escalation logic in `cart-intelligence.ts` (lines 124-254) so each fan-out tier publishes a `notification.send` event that flows through the kernel-gated path established by WS-4. The tier-3 message (fired ≥46h after the last customer message) will now correctly REFUSE with `window_expired` rather than silently failing at Twilio — this is the **intended** behaviour per the design, but document it explicitly so reviewers don't treat tier-3 REFUSEs as a regression.

## Blocking design-doc picks

- **Q1 (Join axis)** — recommended `customerId`; assumed.
- **Q4 (`proactive-engagement` and `reservation-reminder` → template-only?)** — recommended yes. **This site (cart-tiers) is partially affected**: tier-3 is by-construction outside the 24h window and should ideally route to `whatsapp.template.send`. **However**, full template-send routing for tier-3 is OUT OF SCOPE of this task — the design explicitly says "tier 3 must move to whatsapp.template.send (out of this design's scope)". This task only flips tier-3 to the kernel-gated path so REFUSEs are visible; the template-send re-route is a follow-up post-this-DAG.

## Impacted files

- [`apps/api/src/subscribers/cart-intelligence.ts`](../../../../../apps/api/src/subscribers/cart-intelligence.ts) — lines 124-254 (the cart-abandoned tier-escalation handler).
- [`apps/api/src/subscribers/__tests__/cart-intelligence-governance.test.ts`](../../../../../apps/api/src/subscribers/__tests__/) — extend the file created in WS-4 with tier-specific test cases.

## Dependencies

- **WS-1, WS-2, WS-3** required.
- **WS-4 (notification.send)** STRONGLY recommended to land first — tier-escalation publishes via `notification.send`, so if WS-4's flow is in place, this task's tiers automatically inherit the gating.
- **Note:** if tier-escalation's path actually bypasses `notification.send` (i.e., calls `sendText()` directly at lines 124-254), this becomes a direct migration of those callsites — verify before starting. The design assumes the relay-through-`notification.send` path.

## Acceptance criteria

- The tier-escalation handler at cart-intelligence.ts:124-254:
  - For tier 1 (4h post-abandonment): publishes `notification.send` (relayed through WS-4's kernel-gated handler) — customer is still inside window, ADMIT expected.
  - For tier 2 (22h post-abandonment): publishes `notification.send` — customer is borderline; ADMIT or REFUSE depending on actual last-message time.
  - For tier 3 (46h post-abandonment): publishes `notification.send` — REFUSE expected (window expired); DLQ entry generated.
- If tier-escalation currently calls `sendText()` directly (rather than via `notification.send`), refactor to publish `notification.send` and let WS-4 do the gating. This is the cleaner architecture.
- Document in code comments that tier-3 REFUSE is intended behaviour, not a regression. Reference the design doc.

## Test strategy

Extend `cart-intelligence-governance.test.ts` (created in WS-4) with:
- Tier 1 ADMIT: customer last-message 5h ago (just after cart-abandoned tier 1 fires) → ADMIT.
- Tier 2 ADMIT: customer last-message 23h ago (boundary case, just inside) → ADMIT.
- Tier 2 REFUSE: customer last-message 25h ago → REFUSE.
- Tier 3 REFUSE (expected): customer last-message 46h ago → REFUSE with `window_expired` → DLQ entry.
- Tier 3 with phantom inbound: `lastCustomerMessageAt: null` → REFUSE with `no_prior_customer_message`.

## Rollout notes

- After WS-4 ships, tiers automatically inherit the gating IF the tier-escalation handler publishes `notification.send` (vs. calling Twilio directly). Verify this assumption before starting.
- Expect tier-3 to REFUSE 100% of the time post-deploy. This is correct.
- A monitoring alert may need to be added for tier-3 REFUSE volume (it'll be high; that's signal, not noise).

## Rollback notes

- Reverting drops the tier-3 REFUSEs back to silent Twilio rejection (which is the production failure mode today).
- A more nuanced rollback would be a feature flag to opt tier-3 back into direct-send (not recommended; the silent rejection is worse than the visible REFUSE).

## Merge-conflict risk

- **HIGH.** `cart-intelligence.ts` is shared with WS-4 and WS-7. Sequence: WS-4 first, then this on top, then WS-7. Or merge to a single coordination branch.
- Conflict with H3 wave-a in-process anonymize if it touches tier-escalation.

## Ready-to-spawn sub-agent prompt

> You are the WS-6 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Update the cart-abandoned tier-escalation handler in `apps/api/src/subscribers/cart-intelligence.ts:124-254` so tier 1/2/3 fan-outs flow through the kernel-gated `notification.send` path established by WS-4. If the current handler calls `sendText()` directly, refactor to publish `notification.send` events instead.
>
> **Pre-reqs:** WS-1, WS-2, WS-3, WS-4 all merged. Verify via git log.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Deferred sites" #3 and §"Rollout sequencing" Phase 2.5.
> 2. Read `apps/api/src/subscribers/cart-intelligence.ts:124-254`. Determine: does the current code call `sendText` directly, or does it publish `notification.send` events?
> 3. If direct `sendText`: refactor to publish `notification.send`. The kernel gating now happens in WS-4's handler.
> 4. If already publishes `notification.send`: ensure the payload shape matches what WS-4 expects.
> 5. Add inline comments at the tier-3 branch documenting "REFUSE is intended; tier-3 routes to template-send in a future follow-up".
> 6. Extend `apps/api/src/subscribers/__tests__/cart-intelligence-governance.test.ts` with the 5 tier-specific cases.
> 7. Tests pass; TSC passes.
>
> **Hard stops:**
> - If WS-4 has not merged, STOP — this task assumes its handler does the gating.
> - Do NOT implement the tier-3 → template-send routing. That's a follow-up out of this DAG's scope (per Q4).
>
> **Commit:** `feat(api,whatsapp-state-builder): route cart-abandoned tiers through gated notification.send`
>
> **Out of scope:** tier-3 → `whatsapp.template.send` routing (separate follow-up).

## Estimated complexity

**M** — multi-tier handler + 5 test cases + sequencing with WS-4/WS-7. ~4-6 hours.
