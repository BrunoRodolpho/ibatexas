# WS-11 — Site migration: `reservation-reminder` job

**Wave:** 2 (site migration; runs after WS-1, WS-2, WS-3)
**Status:** GATED on stakeholder pick of open questions 1, 4.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Deferred sites inventory" #8 + §"Rollout sequencing" Phase 2.6.

---

## Objective

Migrate `reservation-reminder.ts` (line 71, via `sendReservationReminder` in `packages/tools/src/reservation/notifications.ts:154`) to route through the kernel-gated path. Reservations are often made via web or walk-in — so the customer is **likely outside** the 24h WhatsApp window at reminder time. Per Q4, this site should route to `whatsapp.template.send` (not message-send) for the majority of customers, with message-send as a fall-back if the customer recently messaged in.

## Blocking design-doc picks

- **Q1 (Join axis)** — recommended `customerId`; assumed.
- **Q4 (`reservation-reminder` → template-only?)** — recommended yes for the common case; **this task implements a routing decision: state-builder returns timestamp → if inside-window, message-send; if outside-window or null, template-send**. Both paths gate through their respective Pack policies.
- **Soft dependency on Twilio Content Template registration** (same as WS-8).

## Impacted files

- [`apps/api/src/jobs/reservation-reminder.ts`](../../../../../apps/api/src/jobs/reservation-reminder.ts) — line 71.
- [`packages/tools/src/reservation/notifications.ts`](../../../../../packages/tools/src/reservation/notifications.ts) — line 154 (the `sendReservationReminder` helper).
- [`apps/api/src/jobs/__tests__/reservation-reminder.test.ts`](../../../../../apps/api/src/jobs/__tests__/) — extend or create.

## Dependencies

- **WS-1, WS-2, WS-3** required.
- **Soft dependency: Twilio Content Template registration** (out-of-DAG ops task) for template-send fallback path.
- Independent of other site migrations.

## Acceptance criteria

- The helper at `packages/tools/src/reservation/notifications.ts:154` and the job caller at `apps/api/src/jobs/reservation-reminder.ts:71` no longer call `sendText()` directly.
- New flow:
  1. Build `WhatsAppState` for the reservation's customer.
  2. Inspect `state.ctx.lastCustomerMessageAt`:
     - If non-null AND age < 24h: build `whatsapp.message.send` envelope.
     - Else (null or stale): build `whatsapp.template.send` envelope.
  3. Adjudicate; branch on outcome.
- The routing decision can also be moved INSIDE the helper (so callers don't need to make it) — preferred for centralization.
- Feature flag `RESERVATION_REMINDER_TEMPLATE_SEND_ENABLED` to disable the template-send fallback until Twilio templates are registered.

## Test strategy

`apps/api/src/jobs/__tests__/reservation-reminder.test.ts`:
- Inside-window: customer last-message 5h ago → message-send envelope → ADMIT → Twilio free-form called.
- Outside-window: customer last-message 30h ago → template-send envelope → ADMIT → Twilio Content Template called.
- Phantom customer: `lastCustomerMessageAt: null` → template-send → ADMIT.
- Template-send disabled by feature flag → out-of-window customers REFUSE-by-design → DLQ.
- Prisma error → DLQ entry.

## Rollout notes

- Land behind feature flag.
- Once templates are registered, flip flag and watch routing distribution. Expect ~70-80% template-send, ~20-30% message-send (rough estimate; depends on how many reservations are made by recently-engaged WhatsApp customers).

## Rollback notes

- Flip flag off → only message-send branch is exercised → many reservation reminders fail (REFUSE on out-of-window customers). At that point, revert the migration entirely or flip flag back on.

## Merge-conflict risk

- **LOW.** `reservation-reminder.ts` is single-job; `notifications.ts` helper is single-purpose. Coordination with any concurrent reservation feature work, but minimal.

## Ready-to-spawn sub-agent prompt

> You are the WS-11 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Migrate `apps/api/src/jobs/reservation-reminder.ts:71` and `packages/tools/src/reservation/notifications.ts:154` to the kernel-gated envelope flow. Add a routing decision: in-window → message-send, out-of-window → template-send (with feature flag).
>
> **Pre-reqs:** WS-1, WS-2, WS-3 merged.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Deferred sites" #8 and §"Open questions" Q4.
> 2. Read the two impacted files.
> 3. Centralize the routing decision in the helper (`notifications.ts`).
> 4. Add `RESERVATION_REMINDER_TEMPLATE_SEND_ENABLED` env var (default `false`).
> 5. Verify `whatsapp.template.send` envelope kind exists in the Pack (same as WS-8).
> 6. Extend tests with the 5 cases.
>
> **Hard stops:**
> - If `whatsapp.template.send` envelope kind is absent, STOP (same as WS-8).
>
> **Commit:** `feat(api,whatsapp-state-builder): wire reservation-reminder with template-send fallback`
>
> **Out of scope:** Twilio Content Template registration ceremony.

## Estimated complexity

**M** — dual-path routing + feature flag + helper centralization + 5 test cases. ~4-6 hours.
