# WS-10 — Site migration: `pix-expiry-monitor` job

**Wave:** 2 (site migration; runs after WS-1, WS-2, WS-3)
**Status:** GATED on stakeholder pick of open questions 1, 6.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Deferred sites inventory" #7 + §"Rollout sequencing" Phase 2.2.

---

## Objective

Migrate `pix-expiry-monitor.ts` (lines 55, 72, 77) from direct-`sendText()` to the kernel-gated `whatsapp.message.send` flow. The job sends PIX reminders (25min after order) and expiry notices (30min after order). By construction the customer placed the PIX order recently — they're well inside the 24h window. Like WS-9, near-zero behavioural change expected.

## Blocking design-doc picks

- **Q1 (Join axis)** — recommended `customerId`; assumed.
- **Q6 (Customer's `lastCustomerMessageAt`)** — recommended; assumed.

## Impacted files

- [`apps/api/src/jobs/pix-expiry-monitor.ts`](../../../../../apps/api/src/jobs/pix-expiry-monitor.ts) — lines 55, 72, 77 (three send callsites).
- [`apps/api/src/jobs/__tests__/pix-expiry-monitor.test.ts`](../../../../../apps/api/src/jobs/__tests__/) — extend or create.

## Dependencies

- **WS-1, WS-2, WS-3** required.
- Independent of other site migrations.

## Acceptance criteria

- All three send callsites at lines 55, 72, 77 no longer call `sendText()` directly.
- Each follows the standard pattern (state → envelope → adjudicate → branch).
- Failure mode: if a customer placed a PIX order without ever WhatsApp'ing the brand (e.g., placed via web checkout), `lastCustomerMessageAt: null` → REFUSE. This is a legitimate edge case the design acknowledges — PIX reminders to web-only customers should not be sent via WhatsApp message-send. (Future scope: route to template-send for these.)

## Test strategy

`apps/api/src/jobs/__tests__/pix-expiry-monitor.test.ts`:
- ADMIT (reminder, 25min): customer last-message 30min ago → ADMIT → Twilio called.
- ADMIT (expiry, 30min): same scenario, different message → ADMIT → Twilio called.
- REFUSE (web customer): `lastCustomerMessageAt: null` → REFUSE → DLQ entry. (Acceptable.)
- Prisma error → DLQ entry.

## Rollout notes

- Second site to migrate per design Phase 2.2.
- Watch for REFUSE volume — if elevated for web customers, consider routing PIX reminders to template-send in a follow-up.

## Rollback notes

- Revert leaves the existing direct-`sendText()` path live.

## Merge-conflict risk

- **LOW.** Single job file; no other WS-N task touches it.

## Ready-to-spawn sub-agent prompt

> You are the WS-10 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Migrate the three send callsites in `apps/api/src/jobs/pix-expiry-monitor.ts` (lines 55, 72, 77) to the kernel-gated envelope flow.
>
> **Pre-reqs:** WS-1, WS-2, WS-3 merged.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Deferred sites" #7 and §"Rollout sequencing" Phase 2.2.
> 2. Read `apps/api/src/jobs/pix-expiry-monitor.ts`.
> 3. Refactor each of the three callsites per the standard pattern. Share a helper if the repetition is awkward.
> 4. Extend `apps/api/src/jobs/__tests__/pix-expiry-monitor.test.ts` with the 4 cases.
> 5. Tests pass; TSC passes.
>
> **Hard stops:**
> - The three callsites likely share a customer context — DO NOT call `buildWhatsAppState()` three times if one call suffices.
>
> **Commit:** `feat(api,whatsapp-state-builder): wire pix-expiry-monitor through kernel-gated envelope`

## Estimated complexity

**S** — three callsites + shared helper + 4 test cases. ~3-4 hours.
