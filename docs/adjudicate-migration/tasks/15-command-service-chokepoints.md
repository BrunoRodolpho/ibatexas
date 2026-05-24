# Task 15 — Command Service Chokepoints

**Milestone:** M3 (Mutation-entrypoint governance)
**Estimated effort:** XL — 10–14 dev-days
**Blocks:** 17 (medusa wrapper benefits from the chokepoint pattern), M3 enforce flips on persistence layer
**Blocked by:** 01, 08, 09, 10 (packs must exist), 18 (audit redactor)
**Owner:** unassigned

## Objective

Refactor the five domain command services to accept only `IntentEnvelope<*>` inputs at their method boundaries:
- `OrderCommandService`
- `PaymentCommandService`
- `ReservationCommandService`
- `CustomerCommandService`
- `MessageCommandService`

Also: consolidate the three rogue `packages/tools/src/cart/` writers (`add-order-note.ts`, `switch-order-type.ts`, `change-delivery-address.ts`) under `OrderCommandService`. After this lands, every Prisma mutation in the domain layer enters through an envelope, every method has adjudicate gating, and the projection `version` counter is bumped consistently.

## Architecture context

Cite: investigation 03 P0 #1, #2 + §"Recommended adjudication entry points".
> "**Bypass shape #1 — `packages/tools` cart utilities.** Three 'post-order' mutation tools (`add-order-note.ts`, `switch-order-type.ts`, `change-delivery-address.ts`) write directly to `prisma.orderNote` and `prisma.orderProjection` with no kernel envelope. ... These are particularly notable because they **side-step the OrderCommandService entirely** — they write OrderProjection rows that the service's optimistic-concurrency `version` field doesn't see."
> "Payment state transitions via `PaymentCommandService` ... Each call is locked and recorded in `PaymentStatusHistory`, but the kernel never validates the transition."

This is the largest task in the migration and the "single highest-leverage change" per investigation 03's effort estimate (consolidating 25 of the highest-risk mutation sites under one chokepoint).

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/order-command.service.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/payment-command.service.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/reservation.service.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/customer.service.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/conversation.service.ts` (Message-related)
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/cart/add-order-note.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/cart/switch-order-type.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/cart/change-delivery-address.ts`

**Modify (per phase):**
- Each of the 5 services
- Each of the 3 rogue cart writers
- All callers (routes, subscribers, jobs, tools)

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/__shared__/with-adjudicate.ts` (helper wrapping a service method in envelope+adjudicate)
- Per-service test files asserting only-envelope-accepted

## Constraints

- Breaking API change: every caller of these services updates. Coordinate across PRs.
- Must preserve transactional semantics — adjudicate runs OUTSIDE the `prisma.$transaction` block; the transaction runs INSIDE the EXECUTE branch.
- Must preserve optimistic concurrency (`OrderProjection.version`). The 3 rogue writers must use the same version-bump pattern as `OrderCommandService.transitionStatus`.
- Must preserve idempotency keys (`OrderEventLog.idempotencyKey`).
- Must preserve Redis locks (`withLock` for payment serialization).
- Authority taint: `actor.principal = "system"` for subscriber/job callers; `"user"` for HTTP route callers; `"llm"` for kernel-executor callers.
- Follow CLAUDE.md rules #2 (centavos), #7 (rk), #10 (UUID locks).
- pt-BR for any user-facing refusal text surfaced back through the service.

## Implementation requirements

### Phase A: Helper + first service (OrderCommandService)

1. **`with-adjudicate.ts`** helper:
   ```ts
   export function withAdjudicate<P, R>(
     packPolicy: PolicyBundle,
     fn: (payload: P) => Promise<R>,
   ): (envelope: IntentEnvelope<string, P>, state: unknown) => Promise<{decision: Decision; result?: R}>
   ```
   - Calls `adjudicate(envelope, state, packPolicy)`.
   - Emits audit record.
   - On EXECUTE: calls `fn(envelope.payload)`.
   - On REWRITE: calls `fn(decision.rewritten.payload)`.
   - On REFUSE/DEFER/CONFIRMATION/ESCALATE: returns the decision; caller handles.

2. **OrderCommandService** refactor:
   - Methods: `create`, `transitionStatus`, `reconcileStatus`.
   - Each accepts `IntentEnvelope<OrderIntentKind, ...>` now (not raw arguments).
   - Wrap internals in `withAdjudicate(ordersPack.policy, doActualWrite)`.
   - Audit record per call.

3. **All callers of OrderCommandService update** — subscribers, jobs, admin routes (most touched by Tasks 12, 13, 14 already). Audit any remaining direct callers in `packages/tools/src/`, `apps/api/`.

### Phase B: Consolidate rogue cart writers

4. **`add-order-note.ts`** — replace its `prisma.orderNote.create` with `OrderCommandService.addNote(envelope)`. Add `addNote` method to the service.

5. **`switch-order-type.ts`** — replace its `prisma.orderProjection.update` with `OrderCommandService.switchType(envelope)`. Bumps `version`.

6. **`change-delivery-address.ts`** — replace its `prisma.orderProjection.update` with `OrderCommandService.changeAddress(envelope)`. Bumps `version`.

7. Each of these three tools now exclusively talks to the service; no direct Prisma access.

### Phase C: PaymentCommandService

8. Methods: `create`, `transitionStatus`, `switchMethod`, `reconcileFromWebhook`.
9. Same pattern: accept envelope; adjudicate via `ordersPack` or a future `pack-payments` (use `ordersPack` for now — Phase D of master plan splits this).

### Phase D: ReservationCommandService

10. Methods: `create`, `modify`, `cancel`, `transition` (for no_show, checkin, complete).
11. Use `pack-reservations` (Task 09) policy.

### Phase E: CustomerCommandService

12. Methods: `findOrCreate`, `update`, `anonymize`, `updatePixDetails`.
13. Use a new pack-customer-onboarding (out of scope here — use `ordersPack` for `anonymize` and `findOrCreate` for now; mark TODO).

### Phase F: MessageCommandService (ConversationService)

14. Methods: `append`, `clearSession`, `clearAll`.
15. Use `pack-whatsapp` policy (Task 10).

### Phase G: Tests

16. Per-service test asserting:
    - Non-envelope inputs throw a `TypeError` at compile time (TypeScript strict catches this).
    - Audit emitted per call.
    - REFUSE/DEFER/REWRITE branches handled.
    - Idempotency keys preserved.
    - Version counter bumped consistently.

## Acceptance criteria

- [ ] All 5 services accept ONLY `IntentEnvelope<*>` inputs.
- [ ] 3 rogue cart writers removed; they call OrderCommandService instead.
- [ ] All callers updated.
- [ ] `OrderProjection.version` is bumped consistently across all writes.
- [ ] Audit records emitted per service method call.
- [ ] All per-service tests pass.
- [ ] `pnpm --filter @ibatexas/domain typecheck` and `pnpm --filter @ibatexas/tools typecheck` and `pnpm --filter @ibatexas/api typecheck` all pass.

## Testing requirements

- **Unit:** per-service test files (5 files).
- **Integration:** end-to-end smoke per service — create an order via OrderCommandService, transition via PaymentCommandService, anonymize via CustomerCommandService.
- **Bypass-detection:** grep-test asserting NO `prisma.orderNote.create`, `prisma.payment.update`, `prisma.reservation.create` outside of `packages/domain/src/services/`. (Catches future regressions.)

## Rollout notes

This is the longest pole. Recommended approach:
- One PR per phase (A–F) merged in sequence.
- Each phase land BEHIND `IBX_KERNEL_SHADOW=*` for the affected intent kinds.
- 7 days shadow per service before enforce-flip per intent kind.
- Coordinate with Task 12 (Stripe webhook) and Task 14 (customer routes) — they overlap heavily on `OrderCommandService` and `PaymentCommandService` callers.

## Rollback notes

Per-phase revert is possible. The service method-signature change is breaking, so reverts must include all callers. ETA: 1–2 hours per phase. No data loss — the underlying Prisma operations don't change, only the entry point shape.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 15: command-service chokepoints (refactor 5 services to accept only IntentEnvelope inputs).

CONTEXT
This is an XL task — break into 7 phases (A-G). You may need multiple agent runs; complete one or two phases per run and report progress.

Per investigation 03 (P0 #1, #2) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/03-db-commerce-mutations.md:
- 5 domain command services have ~50 Prisma mutation sites with ZERO adjudication
- 3 rogue writers in packages/tools/src/cart/ bypass OrderCommandService entirely, breaking the version counter
- Per §"Recommended adjudication entry points": consolidate writers into the corresponding service; gate at the service method boundary

REPO LAYOUT
- packages/domain/src/services/order-command.service.ts
- packages/domain/src/services/payment-command.service.ts
- packages/domain/src/services/reservation.service.ts
- packages/domain/src/services/customer.service.ts
- packages/domain/src/services/conversation.service.ts
- packages/tools/src/cart/add-order-note.ts
- packages/tools/src/cart/switch-order-type.ts
- packages/tools/src/cart/change-delivery-address.ts
- packages/pack-orders, packages/pack-reservations, packages/pack-whatsapp (from Tasks 08, 09, 10)
- @adjudicate/core, @adjudicate/audit, @adjudicate/runtime

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/domain/src/services/*.ts (the 5 services)
- packages/domain/src/services/__shared__/with-adjudicate.ts (CREATE — helper)
- packages/domain/src/services/__tests__/*.test.ts (CREATE per service, ~5 files)
- packages/tools/src/cart/add-order-note.ts (REWRITE — call OrderCommandService instead of prisma direct)
- packages/tools/src/cart/switch-order-type.ts (REWRITE)
- packages/tools/src/cart/change-delivery-address.ts (REWRITE)
- All callers of these services across apps/api/src/* and packages/tools/src/* — coordinate with existing Tasks 12, 13, 14 PRs
- packages/pack-orders/src/policies.ts (MODIFY — add intent kinds for orderNote.add, orderProjection.switchType, orderProjection.changeAddress, payment.create, payment.transitionStatus if not yet present)

PHASES

Phase A — Helper + OrderCommandService (1-2 days):
1. Create with-adjudicate.ts:
   ```ts
   export async function withAdjudicate<K extends string, P, R>(
     envelope: IntentEnvelope<K, P>,
     state: unknown,
     policy: PolicyBundle,
     executor: (payload: P) => Promise<R>,
   ): Promise<{decision: Decision; result?: R}>
   ```
   - Calls adjudicate(envelope, state, policy)
   - Emits audit via getAuditSink().emit(buildAuditRecord(...))
   - On EXECUTE: result = await executor(envelope.payload); return {decision, result}
   - On REWRITE: result = await executor(decision.rewritten.payload); return {decision, result}
   - On REFUSE/DEFER/REQUEST_CONFIRMATION/ESCALATE: return {decision} (no result)
2. Refactor OrderCommandService:
   - create(envelope: IntentEnvelope<"order.create", CreatePayload>) — was create(input: CreateInput)
   - transitionStatus(envelope: IntentEnvelope<"order.status.transition", TransitionPayload>)
   - reconcileStatus(envelope: IntentEnvelope<"order.status.reconcile", ReconcilePayload>)
   - Add: addNote(envelope: IntentEnvelope<"order.note.add", NotePayload>), switchType(envelope), changeAddress(envelope)
3. Each method wraps in withAdjudicate(envelope, currentState, ordersPack.policy, async (payload) => {/* existing prisma logic */})
4. Update all callers of OrderCommandService — they must build envelopes. Tasks 12, 13, 14 already do this for their routes; check apps/api/src/subscribers/* and packages/tools for remaining callers.

Phase B — Consolidate rogue cart writers (1 day):
5. add-order-note.ts: replace prisma.orderNote.create with orderCmdSvc.addNote(envelope). Builds envelope with actor.principal="llm" (since it's called from LLM tool path).
6. switch-order-type.ts: replace prisma.orderProjection.update with orderCmdSvc.switchType(envelope). Bumps version via the service.
7. change-delivery-address.ts: same — orderCmdSvc.changeAddress(envelope). Bumps version.

Phase C — PaymentCommandService (2 days):
8. Methods: create, transitionStatus, switchMethod, reconcileFromWebhook all accept envelopes
9. Use ordersPack.policy (will migrate to a dedicated pack-payments later — out of scope)
10. Update callers in stripe-webhook.ts (Task 12 should already do this — coordinate), admin routes, jobs

Phase D — ReservationCommandService (2 days):
11. create, modify, cancel, transition (for no_show/checkin/complete) accept envelopes
12. Use reservationsPack.policy (Task 09)
13. Update callers in apps/api/src/routes/reservations.ts, apps/api/src/routes/admin/reservations.ts, packages/tools/src/reservation/*

Phase E — CustomerCommandService (1 day):
14. findOrCreate, update, anonymize, updatePixDetails accept envelopes
15. Use ordersPack.policy for anonymize/customer mutations (mark TODO to move to pack-customer-onboarding later)

Phase F — MessageCommandService / ConversationService (1 day):
16. append, clearSession, clearAll accept envelopes
17. Use whatsappPack.policy (Task 10)

Phase G — Tests (2 days):
18. Per service, create __tests__/{service}-envelope.test.ts:
    - "accepts only IntentEnvelope inputs" — TypeScript catches; assert via tsc --noEmit
    - "emits audit per call"
    - "EXECUTE branch runs prisma logic; REFUSE branch does not"
    - "DEFER parks envelope"
    - "REWRITE runs with rewritten payload"
    - "version counter bumped on order projection writes"
    - "idempotency keys preserved on OrderEventLog appends"
19. Bypass detection test in __tests__/no-direct-prisma.test.ts: grep packages/tools and apps/api for direct prisma.*.create/update of (OrderNote, Payment, Reservation) — assert zero matches outside packages/domain/src/services/.

CONSTRAINTS
- Read CLAUDE.md rules 2, 4, 7, 9, 10 first
- Prices in centavos
- pt-BR for refusals
- rk() for Redis keys
- UUID + Lua release for locks
- Preserve all existing transactional semantics (prisma.$transaction blocks unchanged INSIDE the executor)
- Preserve all existing optimistic concurrency (OrderProjection.version)
- Preserve all existing idempotency keys (OrderEventLog.idempotencyKey)
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT modify @adjudicate/* source
- COORDINATE with PRs from Tasks 12, 13, 14, 16 — they update callers of these services. Communicate via PR description which phases have landed.

ACCEPTANCE CHECKLIST (verify per phase before returning)
- [ ] All 5 services accept only IntentEnvelope inputs
- [ ] 3 rogue cart writers consolidated under OrderCommandService
- [ ] All callers updated
- [ ] OrderProjection.version bumped consistently
- [ ] Audit records emitted per method call
- [ ] Per-service tests pass (5 test files)
- [ ] Bypass-detection test passes (no direct prisma.*.create/update of OrderNote/Payment/Reservation outside services)
- [ ] `pnpm typecheck` workspace-wide passes
- [ ] PR description states which phase(s) this run covers and remaining phases for follow-up

When complete, return: phases completed, files modified per phase, test output, and remaining phase work for follow-up agent runs.
```
