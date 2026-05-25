# WS-8 — Site migration: `proactive-engagement` job

**Wave:** 2 (site migration; runs after WS-1, WS-2, WS-3)
**Status:** GATED on stakeholder pick of open questions 1, 4.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Deferred sites inventory" #5 + §"Rollout sequencing" Phase 2.7.

---

## Objective

Migrate the `proactive-engagement.ts` job (line 138) so it routes through the kernel-gated path. By construction, proactive engagement targets dormant (≥7d inactive) customers — they are **always outside the 24h window**, so the `whatsapp.message.send` path will REFUSE. The correct destination is `whatsapp.template.send` (Twilio Content Templates), which is governed by a separate Pack policy that does not require the 24h window. Per Q4, this site MUST route to template-send.

## Blocking design-doc picks

- **Q1 (Join axis)** — recommended `customerId`; assumed.
- **Q4 (`proactive-engagement` → template-only?)** — recommended yes; **this task assumes template-only**. **Critical dependency:** the Twilio Content Template ceremony must be complete before this task runs end-to-end. Per the design doc §"Out of scope": "The `whatsapp.template.send` operational ceremony (Twilio Content Template registration) — separate ops task." If templates aren't registered yet, this task implements the code path BUT cannot E2E-test it; the job is gated behind a feature flag until templates are registered.

## Impacted files

- [`apps/api/src/jobs/proactive-engagement.ts`](../../../../../apps/api/src/jobs/proactive-engagement.ts) — line 138 specifically; surrounding context too.
- [`apps/api/src/jobs/__tests__/proactive-engagement.test.ts`](../../../../../apps/api/src/jobs/__tests__/) — extend or create.
- Possibly: a new `whatsapp.template.send` envelope kind in `packages/pack-whatsapp/src/capabilities.ts` if not already present.

## Dependencies

- **WS-1, WS-2, WS-3** required.
- **Soft dependency: Twilio Content Template registration** (out-of-DAG ops task). Without it, the code lands but the job stays disabled.
- Independent of other site migrations.

## Acceptance criteria

- The job at proactive-engagement.ts:138 no longer calls `sendText()` directly.
- New flow:
  1. For each dormant customer: resolve `customerId` + `customerPhone`.
  2. Build state via `buildWhatsAppState()` — `lastCustomerMessageAt` is expected to be NULL or >7d old.
  3. Build envelope of kind `whatsapp.template.send` (not `whatsapp.message.send`).
  4. Adjudicate; the Pack's template-send policy does NOT enforce the 24h window.
  5. EXECUTE → call Twilio Content Templates API; REFUSE → DLQ (REFUSE here means template-send policy refused, e.g., per-day rate limit).
- If `whatsapp.template.send` envelope kind does not yet exist in the Pack, this task either:
  - (a) adds it (with stakeholder approval) — out of scope per design;
  - (b) STOPS and flags this as a blocker for orchestrator.
- Behind a feature flag (`PROACTIVE_ENGAGEMENT_TEMPLATE_SEND_ENABLED=false` initially) so the job can ship the code path before templates are registered.

## Test strategy

`apps/api/src/jobs/__tests__/proactive-engagement.test.ts`:
- Dormant customer with `lastCustomerMessageAt: null` → state-builder returns null → template-send envelope built → adjudicate ADMITs → Twilio Content Template API called.
- Dormant customer with `lastCustomerMessageAt: 10d ago` → state-builder returns 10d-old date → template-send still ADMITs (window doesn't apply to template-send).
- Template-send policy REFUSEs (e.g., per-day rate limit hit) → DLQ entry.
- Feature flag off → job exits early without firing any envelope.

## Rollout notes

- Code lands behind feature flag. Templates registered separately. Flag flips post-template-registration.
- Until flag flips: zero behaviour change (job is dormant).

## Rollback notes

- Flip feature flag off — job stops firing template-send. Legacy direct-`sendText()` path remains in git history if a full revert is needed.

## Merge-conflict risk

- **LOW.** Single job file; no other WS-N task touches it.
- Possible collision with the Pack if `whatsapp.template.send` envelope kind is being added concurrently — coordinate.

## Ready-to-spawn sub-agent prompt

> You are the WS-8 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Migrate `apps/api/src/jobs/proactive-engagement.ts` (~line 138) to route through `whatsapp.template.send` (not `whatsapp.message.send`) per Q4. Land behind a feature flag if Twilio Content Templates aren't registered yet.
>
> **Pre-reqs:** WS-1, WS-2, WS-3 merged.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Deferred sites" #5 and §"Open questions" Q4.
> 2. Read `apps/api/src/jobs/proactive-engagement.ts`.
> 3. Verify `whatsapp.template.send` envelope kind exists in `packages/pack-whatsapp/src/capabilities.ts`. If not, STOP and report.
> 4. Refactor the job to: build state → build template-send envelope → adjudicate → branch.
> 5. Add `PROACTIVE_ENGAGEMENT_TEMPLATE_SEND_ENABLED` env var (default `false`).
> 6. Add tests covering the 4 cases.
>
> **Hard stops:**
> - If `whatsapp.template.send` envelope kind does not exist in the Pack, STOP. The Pack must be extended first.
> - Do NOT call `sendText()` (free-form) — by-construction outside-window; would silent-fail at Twilio.
>
> **Commit:** `feat(api,whatsapp-state-builder): route proactive-engagement through template-send`
>
> **Out of scope:** Twilio Content Template registration ceremony (separate ops task).

## Estimated complexity

**M** — adds new envelope path + feature flag + 4 test cases + Pack dependency check. ~4-6 hours.
