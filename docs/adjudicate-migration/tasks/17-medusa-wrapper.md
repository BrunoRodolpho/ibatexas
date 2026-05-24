# Task 17 — `medusaAdjudicated()` Wrapper

**Milestone:** M3 (Mutation-entrypoint governance)
**Estimated effort:** M — 3–5 dev-days
**Blocks:** M3 enforce flips for commerce surface
**Blocked by:** 01, 08 (pack-orders), 15 (services use envelopes already), 18 (audit redactor)
**Owner:** unassigned

## Objective

Build a `medusaAdjudicated()` wrapper around `packages/tools/src/medusa/client.ts` so every cart/checkout/order-edit HTTP hop leaves IbateXas via the kernel. After this lands, every Medusa write (POST cart create, line-item add, cart complete, order edits, admin cancel) is preceded by an `adjudicate()` call with `actor.principal = "system"` and produces an audit record. This closes the Medusa-side bypass (investigation 03 §"Medusa HTTP mutation surface").

## Architecture context

Cite: investigation 03 §"Medusa HTTP mutation surface" + §"Gaps and recommendations" #5.
> "The actual commerce-mutation surface today. Auth: admin JWT (emailpass) cached in-memory, store publishable key resolved at runtime. ... **Every one of these is unadjudicated.** ... Recommendation: introduce a `medusaAdjudicated()` wrapper around `medusaStore`/`medusaAdmin` that emits an envelope before the HTTP call."

Medusa HTTP mutation surface (10+ endpoints):
- `POST /store/carts` (create cart)
- `POST /store/carts/:id/line-items` (add)
- `POST /store/carts/:id/line-items/:itemId` (update)
- `DELETE /store/carts/:id/line-items/:itemId` (remove)
- `POST /store/carts/:id/promotions` (coupon)
- `POST /store/carts/:id` (update cart)
- `POST /store/carts/:id/complete` (checkout)
- `POST /store/payment-collections` (payment session)
- `POST /admin/orders/:id` (admin order metadata)
- `POST /admin/orders/:id/edits[/items][/confirm]` (order edits)
- `POST /admin/orders/:id/cancel` (admin cancel)

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/medusa/client.ts` (current medusaStore + medusaAdmin)
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/cart/*.ts` (all cart tools — they call medusaStore/medusaAdmin directly)
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/policies.ts` (Task 08 — extend with Medusa-egress intent kinds)

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/medusa/client.ts` — add wrapper
- All cart tools — switch from `medusaStore`/`medusaAdmin` direct to `medusaAdjudicated`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/policies.ts` — add intent kinds for Medusa egress

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/medusa/__tests__/medusa-adjudicated.test.ts`

## Constraints

- Wrapper preserves the existing HTTP semantics — same response shape, same error handling.
- Mutating calls (POST/PATCH/DELETE) go through adjudicate; reads (GET) do not.
- Determine "is this a mutating call" by inspecting `method` parameter. GET → bypass adjudicate.
- `actor.principal = "system"`, `taint = "SYSTEM"`, `actor.sessionId = "medusa:" + endpoint`.
- Idempotency: many Medusa endpoints accept an `Idempotency-Key` header. Build envelope with `nonce = idempotencyKey` if provided.
- On REFUSE: throw a typed error `MedusaAdjudicateRefusedError` with the refusal text (pt-BR).
- On DEFER: throw `MedusaAdjudicateDeferredError`; caller may park if appropriate (LLM-driven flows already handle DEFER).
- Follow CLAUDE.md rule #9 — every cart/checkout/order-edit call leaves IbateXas through the kernel.

## Implementation requirements

1. **Wrapper signature** (in `client.ts`):
   ```ts
   export interface MedusaAdjudicatedArgs<P> {
     scope: "store" | "admin";
     method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
     path: string;
     payload?: P;
     intentKind?: OrderIntentKind; // optional override; auto-detected if omitted
     idempotencyKey?: string;
   }
   export async function medusaAdjudicated<P, R>(args: MedusaAdjudicatedArgs<P>): Promise<R>;
   ```

2. **Path-to-intent-kind mapping** — auto-detect intent kind from `path` + `method`. Examples:
   - `POST /store/carts` → `medusa.cart.create`
   - `POST /store/carts/:id/line-items` → `medusa.cart.line_items.add`
   - `POST /store/carts/:id/complete` → `medusa.cart.complete`
   - `POST /admin/orders/:id/cancel` → `medusa.admin.order.cancel`
   - etc.
   
   Define a `MEDUSA_PATH_INTENT_MAP` table.

3. **Wrapper body:**
   - For `method === "GET"`: pass through to `medusaStore`/`medusaAdmin`. No adjudicate.
   - For mutations: build envelope, adjudicate, branch, then call `medusaStore`/`medusaAdmin` on EXECUTE.

4. **Refactor cart tools** — every `medusaStore(...)`/`medusaAdmin(...)` call in `packages/tools/src/cart/` switches to `medusaAdjudicated(...)`. Pass the intent kind explicitly or let auto-detection handle it.

5. **Pack policy extensions** — add 11 Medusa-egress intent kinds to `pack-orders` with appropriate guards. Most are simple EXECUTE on system actor; the `medusa.cart.complete` (checkout) intent overlaps with `order.checkout.create` and should defer to that pack's existing guards (or be merged).

6. **Tests:**
   - "GET passes through without adjudicate"
   - "POST /store/carts builds envelope kind medusa.cart.create"
   - "Idempotency-Key sets envelope.nonce"
   - "REFUSE throws MedusaAdjudicateRefusedError"
   - "DEFER throws MedusaAdjudicateDeferredError"
   - "EXECUTE calls underlying medusaStore with same args"
   - "REWRITE calls underlying medusaStore with rewritten payload"

## Acceptance criteria

- [ ] `medusaAdjudicated` exported from `packages/tools/src/medusa/client.ts`.
- [ ] Path-to-intent-kind map covers all 10+ mutating Medusa endpoints.
- [ ] All cart tools use the wrapper; no direct `medusaStore`/`medusaAdmin` mutating calls.
- [ ] pack-orders has guards for the new intent kinds.
- [ ] All medusa-adjudicated tests pass.

## Testing requirements

- **Unit:** medusa-adjudicated.test.ts.
- **Integration:** existing cart-tool tests still pass with the wrapper substituted.
- **Bypass-detection:** grep-test asserting NO direct `medusaStore(...)`/`medusaAdmin(...)` POST/PATCH/DELETE calls outside `packages/tools/src/medusa/`.

## Rollout notes

Shadow-first per intent kind. Coordinate with Task 15 (PaymentCommandService refactor) — the wrapper's `medusa.cart.complete` intent overlaps with `order.checkout.create`. Decide one source of truth (likely: the checkout HTTP route adjudicates `order.checkout.create`, and inside its EXECUTE branch calls `createCheckout()` which calls `medusaAdjudicated` for `medusa.cart.complete` — two envelopes, two audit records, supersession-linked).

## Rollback notes

Revert. Direct medusaStore/medusaAdmin calls return. ETA: 30–60 min. No data loss.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 17: medusaAdjudicated() wrapper.

CONTEXT
Per investigation 03 (§"Medusa HTTP mutation surface" + §"Gaps and recommendations" #5) in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/03-db-commerce-mutations.md:
- Every Medusa cart/checkout/order-edit call from IbateXas leaves the process via medusaStore/medusaAdmin without kernel review
- Recommendation: introduce medusaAdjudicated() wrapper that emits an envelope before the HTTP call
- All cart tools in packages/tools/src/cart/ call medusaStore/medusaAdmin directly; switch them to the wrapper

REPO LAYOUT
- packages/tools/src/medusa/client.ts (medusaStore, medusaAdmin)
- packages/tools/src/cart/*.ts (all cart tools)
- packages/tools/src/cart/_shared.ts (helper re-exports)
- packages/pack-orders/src/policies.ts + types.ts (extend with Medusa intent kinds)

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/tools/src/medusa/client.ts (MODIFY — add medusaAdjudicated)
- packages/tools/src/medusa/__tests__/medusa-adjudicated.test.ts (CREATE)
- packages/tools/src/cart/*.ts (MODIFY — switch direct medusaStore/medusaAdmin calls to medusaAdjudicated)
- packages/pack-orders/src/types.ts (MODIFY — add 10+ medusa.* intent kinds)
- packages/pack-orders/src/policies.ts (MODIFY — add guards for medusa.* kinds)
- packages/pack-orders/src/__tests__/conformance.test.ts (MODIFY — add fixtures)

WHAT TO BUILD

1. medusaAdjudicated function in client.ts:
   ```ts
   export interface MedusaAdjudicatedArgs<P> {
     scope: "store" | "admin";
     method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
     path: string;
     payload?: P;
     intentKind?: OrderIntentKind;
     idempotencyKey?: string;
     headers?: Record<string, string>;
   }
   export async function medusaAdjudicated<P, R>(args: MedusaAdjudicatedArgs<P>): Promise<R>;
   ```
   - GET method: pass through to medusaStore/medusaAdmin directly, no adjudicate
   - Other methods: build envelope via buildEnvelope({kind: detectIntentKind(args), payload, actor: {principal: "system", sessionId: `medusa:${args.path}`}, taint: "SYSTEM", nonce: args.idempotencyKey ?? generateUUID()})
   - Call adjudicate(envelope, currentState, ordersPack.policy)
   - audit-emit
   - Switch on decision.kind:
     * EXECUTE: return await (args.scope === "store" ? medusaStore : medusaAdmin)(args)
     * REWRITE: return await medusaXyz(rewrittenArgs)
     * REFUSE: throw MedusaAdjudicateRefusedError(decision.refusal.userFacing)
     * DEFER: throw MedusaAdjudicateDeferredError(decision.signal)
     * REQUEST_CONFIRMATION / ESCALATE: throw MedusaAdjudicateNeedsConfirmationError

2. detectIntentKind(args): OrderIntentKind table. Map paths/methods to kinds:
   - POST /store/carts → "medusa.cart.create"
   - POST /store/carts/:id/line-items → "medusa.cart.line_items.add"
   - POST /store/carts/:id/line-items/:itemId → "medusa.cart.line_items.update"
   - DELETE /store/carts/:id/line-items/:itemId → "medusa.cart.line_items.remove"
   - POST /store/carts/:id/promotions → "medusa.cart.promotion.apply"
   - POST /store/carts/:id (cart update) → "medusa.cart.update"
   - POST /store/carts/:id/complete → "medusa.cart.complete"
   - POST /store/payment-collections → "medusa.payment_collection.create"
   - POST /admin/orders/:id → "medusa.admin.order.update_metadata"
   - POST /admin/orders/:id/edits → "medusa.admin.order.edit.create"
   - POST /admin/orders/:id/edits/items → "medusa.admin.order.edit.items"
   - POST /admin/orders/:id/edits/confirm → "medusa.admin.order.edit.confirm"
   - POST /admin/orders/:id/cancel → "medusa.admin.order.cancel"

3. Refactor all cart tools in packages/tools/src/cart/:
   - get-or-create-cart.ts: medusaStore(POST /store/carts) → medusaAdjudicated({scope: "store", method: "POST", path: "/store/carts", payload})
   - add-to-cart.ts, update-cart.ts, remove-from-cart.ts, apply-coupon.ts, create-checkout.ts, amend-order.ts, cancel-order.ts (admin /cancel), regenerate-pix.ts (payment collection)
   - All read-only GET calls stay as medusaStore (no wrapping needed)

4. pack-orders extensions:
   - types.ts: union the 13 medusa.* intent kinds
   - policies.ts: add per-kind guards. Most are simple state guards (e.g. medusa.cart.line_items.add requires cart in "open" state). Use createSystemTaintPolicy({systemOnlyKinds: ["medusa.admin.*"]}) to restrict admin endpoints to system actor.
   - For medusa.cart.complete: defer to existing order.checkout.create guards (composition); document the relationship.

5. Tests (medusa-adjudicated.test.ts):
   - "GET passes through without adjudicate" — assert no audit emit
   - "POST /store/carts builds envelope kind medusa.cart.create" — assert envelope shape
   - "Idempotency-Key sets envelope.nonce" — supply idempotencyKey, assert envelope.nonce === provided
   - "REFUSE throws MedusaAdjudicateRefusedError" — mock adjudicate REFUSE, assert throw
   - "DEFER throws MedusaAdjudicateDeferredError" — mock adjudicate DEFER, assert throw
   - "EXECUTE calls underlying medusaStore with same args" — mock adjudicate EXECUTE, assert pass-through
   - "REWRITE calls underlying medusaStore with rewritten payload" — mock REWRITE
   - "Audit record emitted with kind from path map" — assert getAuditSink mock received correct kind

6. Update conformance.test.ts in pack-orders: add 13 fixtures (one per medusa.* kind covering EXECUTE happy path) and 3-4 negative cases.

CONSTRAINTS
- Read CLAUDE.md rules 2, 9 first
- Prices in centavos
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT change Medusa response shapes — wrapper is transparent
- GET methods bypass adjudicate (reads aren't governed)
- Use ordersPack.policy (Task 08 must be merged)
- pt-BR for any refusal text surfaced via thrown errors

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] medusaAdjudicated exported from packages/tools/src/medusa/client.ts
- [ ] detectIntentKind table covers all 13 mutating endpoints
- [ ] All cart tools use medusaAdjudicated (no direct medusaStore POST/PATCH/DELETE calls)
- [ ] pack-orders extended with 13 medusa.* intent kinds + guards
- [ ] GET passes through without adjudicate
- [ ] All medusa-adjudicated tests pass
- [ ] Conformance test corpus extended
- [ ] `pnpm --filter @ibatexas/tools typecheck` passes
- [ ] `pnpm --filter @ibatexas/pack-orders test` passes

When complete, return: files modified, full path-to-intent-kind table, test output, and confirmation that medusa.cart.complete intent supersession against order.checkout.create is documented in the pack.
```
