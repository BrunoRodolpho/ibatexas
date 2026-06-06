# Task 09 — Create `@ibatexas/pack-reservations`

**Milestone:** M2 (Pack architecture)
**Estimated effort:** M — 2–3 dev-days
**Blocks:** 15 (command-service chokepoints — ReservationCommandService needs the pack's policy)
**Blocked by:** 08 (pack-orders is the template; need its conformance pattern proven first)
**Owner:** unassigned

## Objective

Author the first-party `@ibatexas/pack-reservations` package covering the booking lifecycle: create, confirm, modify, cancel, no-show. Today there is no policy bundle covering reservations — they're handled inline in `packages/domain/src/services/reservation.service.ts`. After this lands, every reservation mutation in IbateXas adjudicates against this pack.

## Architecture context

Cite: investigation 05 §"Packs ibatexas should write".
> "`@ibatexas/pack-reservations` — appointment / booking lifecycle. Intents: `reservation.create`, `reservation.confirm`, `reservation.cancel`, `reservation.reschedule`, `reservation.no_show`. DEFER on `payment.confirmed` and `slot.released`; REQUEST_CONFIRMATION for destructive cancels within N hours of the slot; ESCALATE no-shows over a configurable rate."

Existing entity model (per investigation 03):
- `Reservation` — bookings, FK to Customer + TimeSlot
- `TimeSlot.reservedCovers` — atomic counter under `FOR UPDATE` lock
- `ReservationTable` — join table
- `Waitlist` — slot-full overflow

Existing tools (per investigation 01):
- `create_reservation`, `modify_reservation`, `cancel_reservation`, `join_waitlist` — all MUTATING but currently dropped (no kernel coverage, no deterministic path).

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/reservation.service.ts` (existing reservation logic — extract policy)
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/reservation/*.ts` (the 4 tools)
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/` (Task 08's pack — use as template)
- `/Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/*.ts` (canonical reference)

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-reservations/package.json`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-reservations/tsconfig.json`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-reservations/src/index.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-reservations/src/types.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-reservations/src/policies.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-reservations/src/capabilities.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-reservations/src/refusals.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-reservations/src/__tests__/reservations-pack.test.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-reservations/src/__tests__/conformance.test.ts`

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/kernel-bootstrap.ts` — `installPack(reservationsPack)` alongside ordersPack
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/package.json` — depend on `@ibatexas/pack-reservations`

## Constraints

- Must follow the `@ibatexas/pack-orders` layout (Task 08) and the `@adjudicate/pack-payments-pix` reference.
- Must use `@adjudicate/primitives.createConfirmGuard` for destructive cancels within configurable threshold hours of the slot start (default 2 hours, env override `RESERVATION_CANCEL_CONFIRM_HOURS`).
- Must use `@adjudicate/primitives.createEscalateGuard` for customers with no-show rate above threshold (default 30%, env override `RESERVATION_NO_SHOW_ESCALATE_RATE`).
- Must use `@adjudicate/primitives.createStateDeferGuard` for the `slot.released` signal (when a reservation modification waits for the previous slot to release capacity).
- pt-BR for all user-facing refusal text.
- Prices and capacity in correct units (party size = integer covers; no centavos in this domain).
- Follow CLAUDE.md rule #9 — reservation tools are LLM-callable; this pack defines authority.

## Implementation requirements

1. **Package scaffold** — identical to Task 08's structure.

2. **`types.ts`:**
   - `ReservationIntentKind`: `reservation.create | reservation.confirm | reservation.modify | reservation.cancel | reservation.no_show | reservation.waitlist.join | reservation.waitlist.release`
   - Per-kind payload types referencing `Reservation` schema fields.
   - `ReservationState`: `{ slotCapacity: number, currentReservations: number, customer: { noShowRate?: number, ... }, slotStartAt: Date, ... }`
   - `ReservationContext` (auth, customerId).
   - `RESERVATION_SLOT_RELEASED_SIGNAL = "slot.released"`.

3. **`policies.ts`:**
   - **stateGuards:** slot-must-have-capacity, slot-must-be-in-future, reservation-must-be-modifiable.
   - **authGuards:** require customerId for non-staff reservation mutations; allow `system` actor for `reservation.no_show` (driven by no-show-checker job).
   - **taint:** `createSystemTaintPolicy({systemOnlyKinds: ["reservation.no_show", "reservation.waitlist.release"], userMinimum: "UNTRUSTED"})`.
   - **business guards:**
     - `createConfirmGuard` for `reservation.cancel` within `RESERVATION_CANCEL_CONFIRM_HOURS` of the slot (REQUEST_CONFIRMATION).
     - `createEscalateGuard` for `reservation.create` from a customer with `noShowRate > RESERVATION_NO_SHOW_ESCALATE_RATE` (ESCALATE to human staff).
     - `createStateDeferGuard` for `reservation.modify` when the previous slot has reservedCovers at capacity (DEFER on `slot.released`).
   - **default:** `decisionRefuse(refuse("policy", "default_refuse", "Operação não permitida."), [...])`.

4. **`capabilities.ts`:**
   - `reservationsCapabilityPlanner` covering states like `reservation.browsing`, `reservation.creating`, `reservation.confirming`.
   - `reservationsToolClassification: ToolClassification` listing the 4 reservation tools.

5. **`refusals.ts`:**
   - Typed helpers: `refuseSlotFull`, `refuseSlotInPast`, `refuseCustomerBlocked`, etc.

6. **`index.ts`:**
   - `reservationsPack: PackV0<...>` satisfies signature.
   - Export rehydrator.

7. **Tests:**
   - **conformance.test.ts:** ~25 fixtures covering all 6 decision outcomes per intent kind.
   - **reservations-pack.test.ts:**
     - Slot at capacity → REFUSE on create.
     - Slot in past → REFUSE on create.
     - Cancel ≥3h before slot → EXECUTE.
     - Cancel <2h before slot → REQUEST_CONFIRMATION.
     - Customer with 50% no-show rate creates → ESCALATE.
     - Modify with prev slot at capacity → DEFER on `slot.released`.
     - `system` actor `reservation.no_show` → EXECUTE (taint policy allows).
     - `user` actor `reservation.no_show` → REFUSE (taint policy blocks).
   - `runConformance(reservationsPack)` zero failures.

8. **Wire at boot** — add `installPack(reservationsPack)` to `kernel-bootstrap.ts`.

## Acceptance criteria

- [ ] `@ibatexas/pack-reservations` package exists with all 6 source files and 2 test files.
- [ ] `reservationsPack` satisfies `PackV0`.
- [ ] `installPack(reservationsPack)` succeeds at boot.
- [ ] Conformance corpus passes.
- [ ] `runConformance(reservationsPack)` returns zero failures.
- [ ] `reservationsPack.policy.default.kind === "REFUSE"`.
- [ ] Two new env vars documented in `.env.example`: `RESERVATION_CANCEL_CONFIRM_HOURS=2`, `RESERVATION_NO_SHOW_ESCALATE_RATE=0.3`.

## Testing requirements

- **Unit:** the two new test files above.
- **Integration:** N/A at this stage — Task 15 wires the pack into `ReservationCommandService`.
- **Bypass-detection:** the default-deny assertion above.

## Rollout notes

Direct merge. The pack is installed but not yet enforced (no env-var changes). Behavioural change = zero. Tasks 15 and the rollout milestones M5/M7 flip enforce.

## Rollback notes

Revert the PR. The pack disappears, `installPack` call is removed, no consumer breaks. ETA: 5 min. No data loss.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 09: create @ibatexas/pack-reservations.

CONTEXT
Per investigation 05 (§"Packs ibatexas should write") in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/05-adjudicate-capabilities.md, IbateXas needs first-party Packs. Task 08 created @ibatexas/pack-orders following the @adjudicate/pack-payments-pix template. Your job: follow the same template to create pack-reservations.

REPO LAYOUT
- packages/pack-orders/ — Task 08's reference (follow its structure exactly)
- /Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/*.ts — canonical reference
- packages/domain/src/services/reservation.service.ts — source of existing reservation logic to extract policy from
- packages/tools/src/reservation/*.ts — the 4 LLM tools (create, modify, cancel, join_waitlist)
- @adjudicate/primitives exports: createConfirmGuard, createEscalateGuard, createStateDeferGuard, createSystemTaintPolicy

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/pack-reservations/package.json (CREATE)
- packages/pack-reservations/tsconfig.json (CREATE)
- packages/pack-reservations/src/index.ts (CREATE)
- packages/pack-reservations/src/types.ts (CREATE)
- packages/pack-reservations/src/policies.ts (CREATE)
- packages/pack-reservations/src/capabilities.ts (CREATE)
- packages/pack-reservations/src/refusals.ts (CREATE)
- packages/pack-reservations/src/__tests__/reservations-pack.test.ts (CREATE)
- packages/pack-reservations/src/__tests__/conformance.test.ts (CREATE)
- apps/api/src/plugins/kernel-bootstrap.ts (MODIFY — installPack(reservationsPack))
- packages/llm-provider/package.json (MODIFY — add @ibatexas/pack-reservations dep)
- .env.example (MODIFY — add 2 reservation env vars)

WHAT TO BUILD

1. package.json mirrors pack-orders structure with name "@ibatexas/pack-reservations"

2. types.ts:
   - ReservationIntentKind = "reservation.create" | "reservation.confirm" | "reservation.modify" | "reservation.cancel" | "reservation.no_show" | "reservation.waitlist.join" | "reservation.waitlist.release"
   - Per-kind payload types
   - ReservationState: { slotCapacity: number, currentReservations: number, slotStartAt: Date, customer?: { noShowRate?: number }, ... }
   - RESERVATION_SLOT_RELEASED_SIGNAL = "slot.released"

3. policies.ts — build reservationsPolicyBundle:
   - State guards: slot-has-capacity, slot-in-future, reservation-modifiable
   - Auth guards: require customerId for user-actor mutations
   - Taint: createSystemTaintPolicy({systemOnlyKinds: ["reservation.no_show", "reservation.waitlist.release"], userMinimum: "UNTRUSTED"})
   - Business guards:
     * createConfirmGuard for cancel within env-configured hours (RESERVATION_CANCEL_CONFIRM_HOURS, default 2). REQUEST_CONFIRMATION outcome.
     * createEscalateGuard for create when customer.noShowRate > RESERVATION_NO_SHOW_ESCALATE_RATE (default 0.3). ESCALATE to "human".
     * createStateDeferGuard for modify when prev slot is at capacity — DEFER on signal "slot.released".
   - Default: decisionRefuse with pt-BR userFacing

4. capabilities.ts: reservationsCapabilityPlanner + reservationsToolClassification listing the 4 reservation tools

5. refusals.ts: refuseSlotFull, refuseSlotInPast, refuseCustomerBlocked, refuseReservationNotFound — all pt-BR userFacing

6. index.ts: export reservationsPack: PackV0<ReservationIntentKind, ReservationPayload, ReservationState, ReservationContext>

7. Conformance test corpus (~25 fixtures covering all 6 decision outcomes across all 7 intent kinds)

8. Per-guard test (reservations-pack.test.ts):
   - Slot at capacity + reservation.create → REFUSE
   - Slot in past + reservation.create → REFUSE
   - Cancel >2h before slot → EXECUTE
   - Cancel <2h before slot → REQUEST_CONFIRMATION
   - Customer 50% no-show rate + reservation.create → ESCALATE
   - reservation.modify when prev slot full → DEFER on "slot.released"
   - actor=system + reservation.no_show → EXECUTE
   - actor=user + reservation.no_show → REFUSE

9. kernel-bootstrap.ts: import reservationsPack, call installPack(reservationsPack, {warn: ...})

10. .env.example: append under existing Adjudicate Kernel stanza:
    RESERVATION_CANCEL_CONFIRM_HOURS=2
    RESERVATION_NO_SHOW_ESCALATE_RATE=0.3

CONSTRAINTS
- Read CLAUDE.md rules 4, 9 first
- pt-BR for all user-facing refusal text
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT modify packages/domain or packages/tools — Task 15 owns command-service refactor
- DO NOT modify @adjudicate/* source

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] Package scaffold matches pack-orders layout
- [ ] reservationsPack satisfies PackV0
- [ ] installPack(reservationsPack) succeeds at boot
- [ ] Conformance corpus (25+ cases) passes
- [ ] runConformance(reservationsPack) returns zero failures
- [ ] All 8 per-guard tests pass
- [ ] Default decision is REFUSE
- [ ] Two new env vars in .env.example
- [ ] `pnpm typecheck` workspace-wide passes

When complete, return: files created/modified, conformance corpus size, and any deviations from pack-orders structure.
```
