# WS-3 — State-builder helper: `buildWhatsAppState()`

**Wave:** 1 (foundation; can land in parallel with WS-1)
**Status:** GATED on stakeholder pick of open questions 1, 5, 6.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Alternative B → Read path" + §"Test fixtures + conformance".

---

## Objective

Create the `buildWhatsAppState()` helper module at `apps/api/src/subscribers/__shared__/whatsapp-state-builder.ts` (sibling to `system-actor-envelope.ts`). The helper takes the customer's resolved identity + recipient context, queries `Customer.lastCustomerMessageAt` from Postgres, projects the `perCustomerHandoffCount` from Redis (stub initially per Q5), and returns a fully-shaped `WhatsAppState` ready to pass to `adjudicate()` alongside an envelope. Single function; no I/O fan-out; deterministic given the same DB row + Redis state.

## Blocking design-doc picks

- **Q1 (Join axis: `phoneHash` or `customerId`?)** — recommended `customerId`; **this task assumes the helper takes `customerId` as the primary key and resolves the rest from there**.
- **Q5 (`handoff-subscriber` rate-limit projection — split out?)** — recommended split; **this task assumes the helper exposes a hook for `perCustomerHandoffCount` (returning `0` as a stub) but does NOT implement the rolling-window counter**. A sister design doc covers that projection.
- **Q6 (Per-staff `lastCustomerMessageAt`?)** — recommended "always project from the customer, never the staff"; **this task assumes that semantic**. The helper takes `customerId` (the recipient's customer or the customer associated with the staff handoff) and never reads a "staff-side last message".

## Impacted files

- **NEW** [`apps/api/src/subscribers/__shared__/whatsapp-state-builder.ts`](../../../../../apps/api/src/subscribers/__shared__/) — the helper module itself.
- **NEW** [`apps/api/src/subscribers/__shared__/__tests__/whatsapp-state-builder.test.ts`](../../../../../apps/api/src/subscribers/__shared__/) — unit tests for the helper.
- [`apps/api/src/lib/metrics.ts`](../../../../../apps/api/src/lib/metrics.ts) (or equivalent) — add `kernel_whatsapp_state_builder_invocations_total{outcome="ok"|"null_projection"|"prisma_error"|"redis_error"}` counter (per design doc §"Audit-record obligations").

## Dependencies

- **Soft dependency on WS-1** — the helper queries `Customer.lastCustomerMessageAt`; the field must exist in the Prisma client. The helper can be written and unit-tested with a mocked Prisma client before WS-1 lands, but integration tests need WS-1 merged.
- No dependency on WS-2 — the helper reads the column regardless of whether it's being written. (NULL is a valid return.)
- Sites (WS-4..12) depend on this helper landing.

## Acceptance criteria

- Module exports a single function `buildWhatsAppState(args: { customerId: string; customerPhone: string; recipientType: "customer" | "staff" | "system"; staffId?: string | null }): Promise<WhatsAppState>`.
- Implementation:
  - Looks up `customer.lastCustomerMessageAt` via `prisma.customer.findUnique({ where: { id }, select: { lastCustomerMessageAt: true } })`.
  - Hashes `customerPhone` via the existing `hashPhone()` utility and calls the stub `readHandoffCount(phoneHash)` which returns `0` (stub — full implementation in sister WS doc per Q5).
  - Returns `{ ctx: { channel: "whatsapp", customerId, staffId: staffId ?? null, now: new Date(), lastCustomerMessageAt: customer?.lastCustomerMessageAt ?? null, perCustomerHandoffCount: <stub>, recipientType } }`.
- The `WhatsAppState` shape matches `@ibatexas/pack-whatsapp` exports (verify via `import type { WhatsAppState } from "@ibatexas/pack-whatsapp"`).
- Failure semantics:
  - Prisma throws → helper re-throws (no swallow); metric `outcome="prisma_error"` incremented.
  - Redis throws (when handoff-count is wired beyond the stub) → helper re-throws; metric `outcome="redis_error"` incremented.
  - Customer row not found → returns state with `lastCustomerMessageAt: null`; metric `outcome="null_projection"` incremented.
  - Successful projection → metric `outcome="ok"`.
- Determinism contract: given the same Prisma row + Redis state, two invocations from the same wall-clock moment produce structurally-equivalent `WhatsAppState` (the `now` field is set per-call; everything else is data-driven). Asserted in conformance fixture.
- No `Date.now()` calls outside the `now` field assignment.

## Test strategy

Unit tests at `apps/api/src/subscribers/__shared__/__tests__/whatsapp-state-builder.test.ts`:
- Returns `lastCustomerMessageAt: Date` when Postgres row has a value.
- Returns `lastCustomerMessageAt: null` when the column is NULL.
- Returns `lastCustomerMessageAt: null` when the customer row is missing (treats as null projection, not error).
- Propagates Prisma error (does NOT swallow).
- Propagates Redis error from the handoff-count sub-helper (when wired).
- `recipientType` defaults correctly when `staffId === null` (returns `"customer"`).
- `staffId` is null-coalesced from `undefined` → `null`.
- `perCustomerHandoffCount` is `0` from the stub.
- Metric counters bump on each branch (ok / null_projection / prisma_error / redis_error).

## Rollout notes

- The helper is a pure read; it can ship at the same time as or after WS-1 with no risk to running traffic.
- Until WS-2 ships, every customer has `lastCustomerMessageAt: null` and the helper will return `null` for every call. That's the expected ramp-up state.
- Sites (WS-4..12) that adopt the helper but call it before WS-2 ships will see all WhatsApp egresses REFUSE with `no_prior_customer_message` — which is the conservative posture.

## Rollback notes

- The helper is read-only; removing it has no data-shape consequence. Sites that import it must be reverted together (the helper goes away → site code references break).
- If the `WhatsAppState` shape evolves (e.g., a new field is added in `@ibatexas/pack-whatsapp`), the helper must be updated; site code may also need to update if it constructs the state object inline anywhere.

## Merge-conflict risk

- **LOW.** Creates a new file in `__shared__/`; no existing file edits (except `lib/metrics.ts` which is a near-trivial counter add).
- No overlap with WS-1, WS-2, or any of WS-4..12 site migrations.
- Could collide with WS-14 (conformance) if the conformance helper imports a fixture from `whatsapp-state-builder.ts`; sequence WS-3 before WS-14.

## Ready-to-spawn sub-agent prompt

> You are the WS-3 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Create `apps/api/src/subscribers/__shared__/whatsapp-state-builder.ts` exporting a single function `buildWhatsAppState(args: { customerId: string; customerPhone: string; recipientType: "customer" | "staff" | "system"; staffId?: string | null }): Promise<WhatsAppState>` per the design doc §"Alternative B → Read path".
>
> **Pre-reqs:** WS-1 (Customer column) recommended merged first for type completeness, but the helper can be authored against a mocked Prisma in advance.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` fully — focus on §"Alternative B" and §"Test fixtures + conformance" and §"Open questions" Q5/Q6.
> 2. Read `apps/api/src/subscribers/__shared__/system-actor-envelope.ts` for the sibling-helper conventions.
> 3. Read `packages/pack-whatsapp/src/types.ts` (or wherever `WhatsAppState` is defined) for the exact shape.
> 4. Create the new file. Import the `WhatsAppState` type from `@ibatexas/pack-whatsapp`.
> 5. Implement `buildWhatsAppState()` per the design pseudo-code at lines 258-282 of the design doc.
> 6. Stub `readHandoffCount(phoneHash)` to return `0` — leave a TODO comment referencing Q5's sister design.
> 7. Add the `kernel_whatsapp_state_builder_invocations_total` counter (4 outcome labels).
> 8. Create unit tests at `__shared__/__tests__/whatsapp-state-builder.test.ts` covering the 9 cases in the task file.
> 9. Run `pnpm --filter @ibatexas/api test whatsapp-state-builder` and confirm green.
> 10. Run `pnpm --filter @ibatexas/api tsc --noEmit`.
>
> **Hard stops:**
> - If `WhatsAppState` does not have a `recipientType` field on its `ctx`, STOP and report. The Pack must be updated first, or this design is misaligned.
> - Do NOT implement the real `perCustomerHandoffCount` rolling-window counter — that's a sister project (Q5).
> - Do NOT call `Date.now()` outside the `now` field assignment in the returned state.
> - Do NOT swallow Prisma or Redis errors.
>
> **Commit:** `feat(api,whatsapp-state-builder): add buildWhatsAppState read helper`
>
> **Out of scope:** site adoption (WS-4..12), conformance test wiring (WS-14), the handoff-counter projection (sister doc).

## Estimated complexity

**S** — one new module + 9 test cases + 1 metric. ~3-5 hours.
