# Task 13 — Admin Force-* Routes Governance

**Milestone:** M3 (Mutation-entrypoint governance)
**Estimated effort:** M — 3 dev-days
**Blocks:** none directly (admin routes are operationally independent)
**Blocked by:** 01, 08, 18
**Owner:** unassigned

## Objective

Wrap the four admin "force" routes that today bypass all order policy with `REQUEST_CONFIRMATION` flow via the `@adjudicate/pack-deployments-approval` confirmation pattern:
1. `POST /api/admin/orders/:id/force-cancel` (MANAGER+)
2. `POST /api/admin/orders/:id/payment/refund` (MANAGER+)
3. `POST /api/admin/orders/:id/waive` (OWNER)
4. `PATCH /api/admin/orders/:id/payment/status` (OWNER, force any payment status)

After this lands, every "force" admin action emits an `IntentEnvelope` with `actor.principal = "user"` (or `system` for API-key-only callers), goes through `adjudicate()`, and on threshold-crossing operations follows the `REQUEST_CONFIRMATION → receipt → kernel-substitutes-EXECUTE` pattern from `pack-deployments-approval` — a two-step confirmation flow with an audit-recorded receipt.

## Architecture context

Cite: investigation 02 P0 #2, #3, #4 + investigation 08 P0 #5.
> "Admin payment refund (`POST /api/admin/orders/:id/payment/refund`). Sends money out, no kernel review."
> "Admin force payment status / waive payment / force-cancel order (3 routes under `/api/admin/orders/:id/*`). Each can put the system in any terminal state without policy review."

Confirmation pattern from `@adjudicate/pack-deployments-approval` (investigation 05):
- Step 1: operator POSTs to `force-cancel` with body. Adjudicate returns `REQUEST_CONFIRMATION` with a prompt + `confirmationId`.
- Step 2: operator POSTs to `force-cancel/confirm` with the `confirmationId`. The kernel substitutes EXECUTE; the audit record links the receipt.

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/admin/order-actions.ts` (force-cancel, advance, waive, staff-notes)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/admin/payments.ts` (refund, force-status, confirm-cash)
- `/Users/thaisrodolpho/projects/adjudicate/packages/pack-deployments-approval/src/policies.ts` (reference pattern)
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/policies.ts` (Task 08 — extend with admin intent kinds)

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/admin/order-actions.ts` — wrap force-cancel + waive
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/admin/payments.ts` — wrap refund + force-status
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/policies.ts` — add 4 new intent kinds with confirmation guards

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/admin/admin-confirmation-store.ts` (Redis-backed ConfirmationStore — pattern from `@adjudicate/adapter-core.createRedisConfirmationStore`)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/routes/admin/__tests__/force-routes-governance.test.ts`

## Constraints

- Must preserve existing role-based auth (MANAGER+ / OWNER) — adjudicate is layered ON TOP, not replacing.
- Must require explicit confirmation for: refunds ≥ R$ 200 (20000 centavos), all force-cancels, all waives, all force-status changes. Below thresholds (e.g. small refunds) may EXECUTE directly with audit only.
- Confirmation receipts (`ConfirmationStore`) live in Redis with TTL of 10 minutes; after expiry, operator must re-request.
- Use the existing `Redis lock` pattern for the actual mutation step (Lua-conditional release, CLAUDE.md rule #10).
- `actor.principal = "user"` when authenticated via staff JWT; `"system"` when authenticated only via `x-admin-key`. `actor.sessionId` includes staff role.
- `taint = "TRUSTED"` for staff JWT; `"SYSTEM"` for API key.
- Audit record includes `staffId`, `staffRole`, requestor IP, and the confirmation receipt id.
- pt-BR for any user-facing confirmation prompts surfaced via the admin UI.

## Implementation requirements

1. **ConfirmationStore** (`admin-confirmation-store.ts`):
   - Pattern from `@adjudicate/adapter-core.createRedisConfirmationStore`.
   - Methods: `create(intent, prompt): Promise<{confirmationId, ttlSeconds}>`, `consume(confirmationId): Promise<PendingConfirmation | null>`.
   - Keys: `rk('admin:confirmation:{id}')` with 600s TTL.
   - Atomic consume via Lua: GET + DEL.

2. **Pack policy extensions** (`pack-orders/policies.ts`):
   - 4 new intent kinds:
     - `order.admin.force_cancel`
     - `order.admin.refund`
     - `order.admin.waive_payment`
     - `order.admin.force_payment_status`
   - Each gets `createConfirmGuard` for the threshold above (refund ≥ R$200, all force-cancels/waives/status changes regardless of amount).
   - Add corresponding entries to `pack-orders/types.ts` and conformance fixtures.

3. **Two-step route flow** — for each of the 4 routes:
   - **Step 1: `POST /api/admin/orders/:id/force-cancel`**:
     - Build envelope.
     - Call `adjudicate()`.
     - If REQUEST_CONFIRMATION: call `confirmationStore.create(intent, decision.prompt)`. Return 202 with body `{confirmationId, prompt, ttlSeconds, intent}`. Audit-record this step.
     - If EXECUTE (below threshold — e.g. small refund): run mutation directly. Audit. Return 200.
     - If REFUSE: 403 with refusal text. Audit.
   - **Step 2: `POST /api/admin/orders/:id/force-cancel/confirm`** body `{confirmationId}`:
     - `confirmationStore.consume(confirmationId)` → fetch pending intent.
     - Re-call `adjudicate()` with the same envelope (idempotency via nonce); kernel substitutes EXECUTE on valid receipt. Audit with `supersedes: [step1.intentHash]`.
     - Run mutation under existing Redis lock.
     - Return 200.

4. **Audit content** — every record includes `actor.staffId`, `actor.staffRole`, `actor.principal`, decision basis, optional confirmation receipt id.

5. **Tests:**
   - For each of the 4 routes:
     - Step 1 returns 202 + confirmationId for above-threshold ops.
     - Step 2 with valid receipt executes the mutation.
     - Step 2 with expired/invalid receipt returns 410 Gone.
     - Direct mutation (below threshold) returns 200 immediately.
     - REFUSE path returns 403.
   - Replay: same confirmationId used twice → 410 (consumed once).

## Acceptance criteria

- [ ] 4 force-* routes have step1/step2 confirmation flow with adjudicate gating.
- [ ] `pack-orders` has 4 new intent kinds with `createConfirmGuard` thresholds.
- [ ] Confirmation receipts stored in Redis with 10-min TTL, atomic consume via Lua.
- [ ] Audit records capture staff identity + receipt id + decision basis.
- [ ] All force-routes-governance tests pass.

## Testing requirements

- **Unit:** `force-routes-governance.test.ts` per the table above.
- **Integration:** end-to-end with a Fastify test instance — step 1 then step 2 then mutation verified in DB.
- **Bypass-detection:** assert that ALL calls to `prisma.payment.update` (refund-related) and `OrderCommandService.transitionStatus` from these routes happen INSIDE an `adjudicate() === EXECUTE` branch.

## Rollout notes

Shadow-first not applicable for confirmation flows (the UX changes). Land DIRECTLY in enforce mode for these admin routes — they're operator-controlled, blast radius is contained, and the confirmation UX is the goal of the change. Coordinate with the admin UI team to add the "confirm prompt" widget BEFORE merging the API change.

## Rollback notes

Revert the PR. Admin routes return to direct mutation (current production behaviour). Pending confirmation receipts in Redis expire naturally within 10 min. ETA: 15 min. No data loss.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 13: admin force-* routes governance via confirmation flow.

CONTEXT
Per investigation 02 (P0 #2-#4) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/02-api-webhook-mutations.md, 4 admin routes can put the system in any terminal state without policy review:
- POST /api/admin/orders/:id/force-cancel (MANAGER+)
- POST /api/admin/orders/:id/payment/refund (MANAGER+) 
- POST /api/admin/orders/:id/waive (OWNER)
- PATCH /api/admin/orders/:id/payment/status (OWNER)

Per investigation 05 (Tier 2 #11), the pack-deployments-approval pattern (REQUEST_CONFIRMATION → receipt → kernel substitutes EXECUTE) is reusable for any destructive operator action.

REPO LAYOUT
- apps/api/src/routes/admin/order-actions.ts — force-cancel, waive (read carefully)
- apps/api/src/routes/admin/payments.ts — refund, force-status, confirm-cash (read carefully)
- packages/pack-orders/ — Task 08 (extend with 4 admin intent kinds)
- /Users/thaisrodolpho/projects/adjudicate/packages/pack-deployments-approval/src/policies.ts — reference confirmation pattern
- @adjudicate/adapter-core.createRedisConfirmationStore — reference Redis-backed ConfirmationStore
- @adjudicate/primitives.createConfirmGuard — threshold-based REQUEST_CONFIRMATION factory

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- apps/api/src/routes/admin/order-actions.ts (MODIFY — wrap force-cancel + waive)
- apps/api/src/routes/admin/payments.ts (MODIFY — wrap refund + force-status)
- apps/api/src/routes/admin/admin-confirmation-store.ts (CREATE — Redis-backed store)
- apps/api/src/routes/admin/__tests__/force-routes-governance.test.ts (CREATE)
- packages/pack-orders/src/types.ts (MODIFY — extend OrderIntentKind with 4 admin kinds)
- packages/pack-orders/src/policies.ts (MODIFY — add guards for 4 admin kinds)
- packages/pack-orders/src/__tests__/conformance.test.ts (MODIFY — add fixtures)

PHASES

Phase A — Confirmation store (admin-confirmation-store.ts):
1. Pattern from @adjudicate/adapter-core.createRedisConfirmationStore but tailored for IbateXas:
   ```
   interface AdminConfirmationStore {
     create(intent: IntentEnvelope, prompt: string): Promise<{confirmationId: string, ttlSeconds: number}>
     consume(confirmationId: string): Promise<PendingConfirmation | null>
   }
   ```
2. Use rk('admin:confirmation:{uuid}') with 600s TTL
3. Atomic consume via Lua script (GET + DEL together), similar to UUID Lua lock-release pattern in apps/api/src/whatsapp/session.ts

Phase B — Pack extensions:
4. Extend OrderIntentKind in pack-orders/types.ts with: "order.admin.force_cancel", "order.admin.refund", "order.admin.waive_payment", "order.admin.force_payment_status"
5. Payload types per kind (e.g. RefundPayload {orderId, paymentId, refundAmountCentavos, reason})
6. In pack-orders/policies.ts:
   - order.admin.force_cancel: createConfirmGuard with extract = () => 1 (always >= 1), threshold = 1, comparator = ">=" — always REQUEST_CONFIRMATION. Refusal/prompt: "Cancelar este pedido força. Confirma?"
   - order.admin.refund: createConfirmGuard with extract = p => p.refundAmountCentavos, threshold = 20000 (R$ 200), comparator = ">=" — REQUEST_CONFIRMATION only for ≥ R$ 200; below threshold → EXECUTE directly
   - order.admin.waive_payment: createConfirmGuard always (threshold = 1)
   - order.admin.force_payment_status: createConfirmGuard always (threshold = 1)
   - All have createSystemTaintPolicy entry allowing TRUSTED taint (staff JWT) and SYSTEM (API key)

Phase C — Route wrapping (4 routes):
7. For each route, refactor to two endpoints:
   - POST /api/admin/orders/:id/force-cancel — step 1
     * Build envelope: actor.principal = staffJwt ? "user" : "system", taint = staffJwt ? "TRUSTED" : "SYSTEM", sessionId = staffId or "api-key", nonce = generated UUID for idempotency
     * adjudicate → branch:
       - REQUEST_CONFIRMATION → confirmationStore.create(envelope, decision.prompt) → return 202 {confirmationId, prompt, ttlSeconds}; audit-record
       - EXECUTE (below threshold) → run existing mutation under withLock + audit; return 200
       - REFUSE → 403 with refusal text; audit
   - POST /api/admin/orders/:id/force-cancel/confirm body {confirmationId}
     * confirmationStore.consume(confirmationId) → if null, 410 Gone
     * Re-adjudicate the stored envelope; kernel substitutes EXECUTE on valid receipt (or use the deployments-approval pattern directly — read /Users/thaisrodolpho/projects/adjudicate/packages/pack-deployments-approval/src/policies.ts for the canonical receipt handling)
     * Run mutation under withLock + audit-record with supersedes: [step1.intentHash]
     * Return 200
8. Repeat for refund, waive, force-status. Refund's step 2 path also performs the Stripe API call (already in existing handler — preserve).

Phase D — Tests (force-routes-governance.test.ts):
9. For each of the 4 routes, test:
   - "step 1 returns 202 + confirmationId for above-threshold"
   - "step 2 with valid receipt executes mutation"
   - "step 2 with expired receipt returns 410"
   - "step 2 with invalid receipt returns 410"
   - "direct mutation below threshold returns 200" (refund only — others always require confirmation)
   - "REFUSE path returns 403"
   - "consumed receipt cannot be replayed"
10. Update conformance.test.ts: add 6 fixtures for the 4 new intent kinds (covering REQUEST_CONFIRMATION + EXECUTE + REFUSE).

CONSTRAINTS
- Read CLAUDE.md rules 2, 4, 9, 10 first
- pt-BR for any user-facing confirmation prompt text
- Prices/refunds in centavos (rule #2)
- Use rk() for Redis keys (rule #7)
- Use UUID + Lua release pattern for confirmation atomic-consume (rule #10)
- Preserve existing role-based auth (requireManagerRole / requireOwner) — adjudicate is additive
- TypeScript strict, ESM, .js extensions on local imports

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] admin-confirmation-store.ts with create/consume + Lua atomic consume
- [ ] 4 admin intent kinds in pack-orders/types.ts + policies.ts with createConfirmGuard
- [ ] 4 routes refactored to step1 + step2 confirmation flow
- [ ] Audit records capture staffId, staffRole, receipt id
- [ ] All 7 governance tests per route pass (28 cases total) plus conformance updates
- [ ] `pnpm --filter @ibatexas/api typecheck` passes
- [ ] Below-threshold refunds (< R$ 200) execute directly without confirmation step

When complete, return: files modified, test output, and confirmation that role-based auth (MANAGER+/OWNER) is preserved.
```
