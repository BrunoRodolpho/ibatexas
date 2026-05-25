# WS-9 — Site migration: `hesitation-nudge` job

**Wave:** 2 (site migration; runs after WS-1, WS-2, WS-3) — **first** site to migrate per design ordering.
**Status:** GATED on stakeholder pick of open questions 1, 6.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Deferred sites inventory" #6 + §"Rollout sequencing" Phase 2.1.

---

## Objective

Migrate `hesitation-nudge.ts` (line 52) from direct-`sendText()` to the kernel-gated `whatsapp.message.send` flow. The job fires 45s after first contact — by construction inside the 24h window — so it's the **lowest-risk** site to migrate first. Behavioural change should be near-zero: every nudge that fires today should ADMIT post-migration.

## Blocking design-doc picks

- **Q1 (Join axis)** — recommended `customerId`; assumed.
- **Q6 (Customer's `lastCustomerMessageAt`)** — recommended; assumed.

## Impacted files

- [`apps/api/src/jobs/hesitation-nudge.ts`](../../../../../apps/api/src/jobs/hesitation-nudge.ts) — line 52.
- [`apps/api/src/jobs/__tests__/hesitation-nudge.test.ts`](../../../../../apps/api/src/jobs/__tests__/) — extend or create.

## Dependencies

- **WS-1, WS-2, WS-3** required.
- Independent of other site migrations.

## Acceptance criteria

- The job at hesitation-nudge.ts:52 no longer calls `sendText()` directly.
- New flow follows the standard pattern (state → envelope → adjudicate → branch).
- Since the job fires 45s after first contact, `lastCustomerMessageAt` is expected to be very recent (<1min); REFUSEs would indicate a bug elsewhere (e.g., WS-2 writer not firing) and should be loud in dashboards.

## Test strategy

`apps/api/src/jobs/__tests__/hesitation-nudge.test.ts`:
- ADMIT: customer last-message 45s ago → state-builder returns 45s-old timestamp → ADMIT → Twilio called.
- REFUSE (data anomaly): `lastCustomerMessageAt: null` (writer skipped/failed) → REFUSE → DLQ entry. Log loudly.
- REFUSE (synthetic stale): `lastCustomerMessageAt: 25h ago` → REFUSE. (Shouldn't happen in practice; tests the guard.)
- Prisma error → DLQ entry.

## Rollout notes

- **First site to migrate per design ordering** (Phase 2.1, lowest blast radius).
- Run for ~48h to confirm zero anomalous REFUSEs before proceeding to WS-10 (pix-expiry).
- Add a Prom alert on `kernel_message_send_refuse_total{site="hesitation-nudge",basis!="ok"}` — any non-zero rate is a signal that WS-2 has issues.

## Rollback notes

- Revert leaves the existing direct-`sendText()` path live.

## Merge-conflict risk

- **LOW.** Single job file; no other WS-N task touches it.

## Ready-to-spawn sub-agent prompt

> You are the WS-9 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Migrate `apps/api/src/jobs/hesitation-nudge.ts:52` to the kernel-gated envelope flow. This is the lowest-risk site to migrate first per the design's rollout ordering.
>
> **Pre-reqs:** WS-1, WS-2, WS-3 merged.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Deferred sites" #6 and §"Rollout sequencing" Phase 2.1.
> 2. Read `apps/api/src/jobs/hesitation-nudge.ts`.
> 3. Refactor per the standard pattern.
> 4. Extend `apps/api/src/jobs/__tests__/hesitation-nudge.test.ts` with the 4 cases.
> 5. Tests pass; TSC passes.
>
> **Hard stops:**
> - Any REFUSE in the happy-path test means the state-builder isn't returning the expected timestamp; STOP and debug WS-2 or WS-3.
>
> **Commit:** `feat(api,whatsapp-state-builder): wire hesitation-nudge through kernel-gated envelope`

## Estimated complexity

**XS** — straightforward single-job migration. ~2-3 hours.
