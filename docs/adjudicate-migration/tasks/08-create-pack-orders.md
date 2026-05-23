# Task 08 — Create `@ibatexas/pack-orders`

**Milestone:** M2 (Pack architecture)
**Estimated effort:** M — 3–5 dev-days
**Blocks:** 12, 13, 14, 15 (mutation-entrypoint governance depends on pack existence)
**Blocked by:** 01 (kernel bootstrap installs the pack)
**Owner:** unassigned

## Objective

Migrate the in-package `order-policy-bundle.ts` into a first-class `@ibatexas/pack-orders` workspace package following the `@adjudicate/pack-payments-pix` Pack layout. After this lands, `installPack(ordersPack)` runs at boot, conformance is asserted, the policy bundle is composable, and the pack becomes the authoritative source of intent vocabulary for the orders domain. This is the first first-party Pack and the template for Tasks 09 and 10.

## Architecture context

Cite: investigation 05 §"Packs ibatexas should write (first-party)".
> "`@ibatexas/pack-orders` — checkout / order lifecycle, the closest analog to PIX in our world. Composes `createPixPendingDeferGuard` we already use. Adds `createConfirmGuard` / `createEscalateGuard` thresholds for large-ticket orders, REWRITE clamp for quantities exceeding stock."

Pack layout (from `pack-payments-pix`):
- `types.ts` — intent kinds, payload types, state, taint
- `policies.ts` — PolicyBundle composed from `@adjudicate/primitives` factories
- `capabilities.ts` — CapabilityPlanner + ToolClassification
- `handlers.ts` — optional side-effect handlers
- `refusals.ts` — typed refusal helpers (pt-BR)
- `index.ts` — `PackV0` satisfies + rehydrator

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/order-policy-bundle.ts` (source policy bundle)
- `/Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/*.ts` (reference layout)
- `/Users/thaisrodolpho/projects/ibatexas/pnpm-workspace.yaml` (workspace declaration)
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/machine/types.ts:366-408` (TOOL_CLASSIFICATION for order tools)

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/package.json`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/tsconfig.json`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/index.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/types.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/policies.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/capabilities.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/refusals.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/__tests__/orders-pack.test.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/src/__tests__/conformance.test.ts`

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/order-policy-bundle.ts` — delete the inline bundle; re-export `ordersPack.policy` from the new package
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/package.json` — depend on `@ibatexas/pack-orders` (workspace:*)
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/kernel-bootstrap.ts` — call `installPack(ordersPack)` (alongside any other packs)

## Constraints

- Must preserve the existing `orderPolicyBundle` behaviour bit-for-bit — write the conformance test FIRST and verify the new pack produces identical decisions for a corpus of test envelopes.
- Must use `@adjudicate/primitives` factories (`createConfirmGuard`, `createEscalateGuard`, `createRewriteGuard`, `createSystemTaintPolicy`) instead of hand-rolled guards where applicable.
- Must compose `createPixPendingDeferGuard` from `@adjudicate/pack-payments-pix` (CLAUDE.md rule #9 references this pattern).
- Must use `@adjudicate/locales-pt-BR.portugueseRefusalMessages` in refusals (CLAUDE.md rule #4).
- Follow the workspace convention: ESM, `"type": "module"`, `.js` extensions on local imports.
- pt-BR for all user-facing refusal text.

## Implementation requirements

1. **Package scaffold:**
   - `package.json` with name `@ibatexas/pack-orders`, exports field for ESM, peer dep on `@adjudicate/core`.
   - `tsconfig.json` extending root strict config.

2. **`types.ts`:**
   - Intent kinds: `order.cart.add`, `order.cart.update`, `order.cart.remove`, `order.cart.get_or_create`, `order.checkout.create`, `order.cancel`, `order.amend`, `order.pix.regenerate`, `order.note.add` (and any others currently handled by `order-policy-bundle.ts`).
   - `OrderIntentKind` discriminated union.
   - Payload types per kind.
   - `OrderState` (current state shape from `order-policy-bundle.ts` — kept identical).
   - `OrderContext` (auth state, customer id, cart id).

3. **`policies.ts`:**
   - `ordersPolicyBundle: PolicyBundle<OrderIntentKind, OrderPayload, OrderState>` composed from:
     - stateGuards (e.g. cart-must-be-open, checkout-eligibility) — extract from existing `order-policy-bundle.ts`.
     - authGuards (require authenticated customer for checkout/cancel).
     - taint policy via `createSystemTaintPolicy({systemOnlyKinds: ["order.cancel", "order.checkout.create"], userMinimum: "UNTRUSTED"})`.
     - business guards — most reused from existing file; use `@adjudicate/primitives.createConfirmGuard` for large-ticket REQUEST_CONFIRMATION (threshold: R$ 1.000 / 100000 centavos); `createEscalateGuard` for refund-equivalent flows.
     - default: `decisionRefuse(refuse("policy", "default_refuse", "Operação não permitida."), [basis("kernel", "default")])` — default-deny per master plan principle.

4. **`capabilities.ts`:**
   - `ordersCapabilityPlanner: CapabilityPlanner<OrderState, OrderContext>` (or import the existing one and re-export).
   - `ordersToolClassification: ToolClassification<...>` derived from `TOOL_CLASSIFICATION` for the order-related tools.

5. **`refusals.ts`:**
   - Typed helpers: `refuseCartLocked`, `refuseCheckoutMissingAddress`, `refuseAmountExceedsLimit`, etc. — pt-BR userFacing via `portugueseRefusalMessages` or inline.

6. **`index.ts`:**
   - `export const ordersPack: PackV0<OrderIntentKind, OrderPayload, OrderState, OrderContext> = { id: "ibatexas/pack-orders", version: "1.0.0", contract: "v0", intents, policy: ordersPolicyBundle, planner: ordersCapabilityPlanner, basisCodes, ... } satisfies PackV0<...>`.
   - Export `rehydrateOrderState(raw): OrderState` for replay safety.

7. **Conformance test (`__tests__/conformance.test.ts`):**
   - Build a corpus of ~30 envelope+state fixtures covering EXECUTE, REFUSE, DEFER, REWRITE, REQUEST_CONFIRMATION, ESCALATE outcomes for each intent kind.
   - For each fixture, assert: `adjudicate(envelope, state, ordersPack.policy)` produces the expected decision kind and basis codes.
   - Cross-check against the LEGACY `orderPolicyBundle` from `order-policy-bundle.ts` BEFORE the migration. They must produce identical decisions.
   - Use `runConformance(ordersPack)` from `@adjudicate/conformance` to assert kernel invariants (taint protection, replay safety, basis-vocabulary purity, default polarity).

8. **Update `llm-provider/order-policy-bundle.ts`** — replace the implementation with `export { ordersPolicyBundle as orderPolicyBundle } from "@ibatexas/pack-orders"`. Add `@deprecated` JSDoc. Keep the re-export for one release cycle, then remove in a follow-up.

9. **Update `kernel-bootstrap.ts`** — change `installPack(orderPolicyBundle, ...)` to `installPack(ordersPack, ...)`.

10. **Add to `pnpm-workspace.yaml`** — should be auto-included via `packages/*` wildcard; verify.

## Acceptance criteria

- [ ] `@ibatexas/pack-orders` package exists with all 6 source files and 2 test files.
- [ ] `ordersPack` satisfies `PackV0<...>` from `@adjudicate/core`.
- [ ] `installPack(ordersPack)` succeeds at boot without `PackConformanceError`.
- [ ] Conformance test corpus (~30 cases) passes; all decisions identical to legacy `orderPolicyBundle`.
- [ ] `runConformance(ordersPack)` returns zero failures.
- [ ] `order-policy-bundle.ts` is now a thin re-export.
- [ ] `pnpm --filter @ibatexas/pack-orders typecheck` and tests pass.
- [ ] `pnpm --filter @ibatexas/api typecheck` still passes (kernel-bootstrap.ts wires the new pack).

## Testing requirements

- **Unit:** `orders-pack.test.ts` (per-guard tests) + `conformance.test.ts` (the 30-case corpus + runConformance).
- **Integration:** existing kernel-executor tests should pass unchanged (since the pack's policy is byte-identical to the legacy bundle).
- **Bypass-detection:** add a test asserting `ordersPack.policy.default.kind === "REFUSE"` (default-deny invariant per master plan).

## Rollout notes

Direct merge. Behavioural change is zero by construction (conformance test gates the migration). The benefit is structural — the policy is now in a workspace package, conformance-asserted at boot, and ready for Tasks 09 and 10 to follow the same template.

## Rollback notes

Revert the PR. The re-export in `order-policy-bundle.ts` and the boot-time `installPack` change revert. The new package directory can be left in place or removed — no consumer depends on it after rollback. ETA: 10 min. No data loss.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 08: create @ibatexas/pack-orders workspace package.

CONTEXT
Per investigation 05 (§"Packs ibatexas should write") in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/investigation/05-adjudicate-capabilities.md:
- IbateXas should ship first-party Packs following the @adjudicate/pack-payments-pix template
- pack-orders is the first: migrates packages/llm-provider/src/order-policy-bundle.ts into a workspace package
- Must compose createPixPendingDeferGuard from @adjudicate/pack-payments-pix (already used in current bundle)
- Must use @adjudicate/primitives factories where applicable

REPO LAYOUT
- /Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/src/order-policy-bundle.ts — source policy
- /Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/*.ts — reference layout (types, policies, capabilities, refusals, index)
- /Users/thaisrodolpho/projects/ibatexas/pnpm-workspace.yaml — packages/* wildcard
- /Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/kernel-bootstrap.ts — installPack call site (Task 01)

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/pack-orders/package.json (CREATE)
- packages/pack-orders/tsconfig.json (CREATE)
- packages/pack-orders/src/index.ts (CREATE)
- packages/pack-orders/src/types.ts (CREATE)
- packages/pack-orders/src/policies.ts (CREATE)
- packages/pack-orders/src/capabilities.ts (CREATE)
- packages/pack-orders/src/refusals.ts (CREATE)
- packages/pack-orders/src/__tests__/orders-pack.test.ts (CREATE)
- packages/pack-orders/src/__tests__/conformance.test.ts (CREATE)
- packages/llm-provider/src/order-policy-bundle.ts (MODIFY — replace with re-export from new package)
- packages/llm-provider/package.json (MODIFY — add @ibatexas/pack-orders dep)
- apps/api/src/plugins/kernel-bootstrap.ts (MODIFY — call installPack(ordersPack))

WHAT TO BUILD

1. Read the reference Pack at /Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/ — every file. Follow the same layout exactly.

2. packages/pack-orders/package.json:
   - name: "@ibatexas/pack-orders"
   - version: "1.0.0"
   - type: "module"
   - main / exports point to src/index.ts (or dist/ if compiled — match pack-payments-pix)
   - peerDependencies: { "@adjudicate/core": "workspace:*" }
   - dependencies: { "@adjudicate/primitives": "workspace:*", "@adjudicate/pack-payments-pix": "workspace:*", "@adjudicate/locales-pt-BR": "workspace:*" }

3. types.ts: declare OrderIntentKind (union of order.cart.add, order.cart.update, order.cart.remove, order.cart.get_or_create, order.checkout.create, order.cancel, order.amend, order.pix.regenerate, order.note.add) and the payload type per kind. OrderState matches current shape in order-policy-bundle.ts.

4. policies.ts: build ordersPolicyBundle: PolicyBundle<OrderIntentKind, OrderPayload, OrderState>:
   - stateGuards from existing order-policy-bundle.ts logic
   - authGuards from existing
   - taint: createSystemTaintPolicy({systemOnlyKinds: ["order.cancel", "order.checkout.create"], userMinimum: "UNTRUSTED"})
   - business guards: include createPixPendingDeferGuard from @adjudicate/pack-payments-pix (composed identically to current); add createConfirmGuard for orders ≥ R$ 1.000 (100000 centavos); createEscalateGuard for refund-equivalent if any
   - default: decisionRefuse with code "default_refuse" and pt-BR userFacing "Operação não permitida."

5. capabilities.ts: re-export ordersCapabilityPlanner from llm-provider's existing planner (or move it here — your call; document the choice). Define ordersToolClassification: ToolClassification picking only order-related tool names from TOOL_CLASSIFICATION.

6. refusals.ts: typed helpers per refusal code, pt-BR userFacing strings. Import portugueseRefusalMessages from @adjudicate/locales-pt-BR and use as fallback.

7. index.ts:
   ```ts
   export const ordersPack: PackV0<OrderIntentKind, OrderPayload, OrderState, OrderContext> = {
     id: "ibatexas/pack-orders",
     version: "1.0.0",
     contract: "v0",
     intents: [...] as const,
     policy: ordersPolicyBundle,
     planner: ordersCapabilityPlanner,
     basisCodes: [...],
     rehydrateState: (raw) => raw as OrderState,
   } satisfies PackV0<...>;
   ```
   Also export OrderIntentKind, OrderPayload, OrderState types.

8. Conformance test (__tests__/conformance.test.ts):
   - Define ~30 envelope+state fixtures covering all 6 decision outcomes across all intent kinds
   - For each: assert adjudicate(envelope, state, ordersPack.policy) returns the expected decision
   - Cross-check via importing the CURRENT order-policy-bundle.ts (before your modification) — both must produce identical decisions for every fixture
   - Run runConformance(ordersPack) from @adjudicate/conformance; assert zero failures
   - Assert ordersPack.policy.default.kind === "REFUSE" (default-deny invariant)

9. Per-guard tests (__tests__/orders-pack.test.ts):
   - Each guard tested in isolation: input → expected decision
   - PIX-pending defer guard: assert DEFER decision with signal "payment.confirmed" for order.checkout.create when state has pending PIX

10. Update llm-provider/src/order-policy-bundle.ts:
    ```ts
    /** @deprecated Re-exported from @ibatexas/pack-orders for backwards compat. Will be removed in a future release. */
    export { ordersPolicyBundle as orderPolicyBundle } from "@ibatexas/pack-orders";
    ```

11. Update packages/llm-provider/package.json: add "@ibatexas/pack-orders": "workspace:*" to dependencies.

12. Update apps/api/src/plugins/kernel-bootstrap.ts:
    - import { ordersPack } from "@ibatexas/pack-orders"
    - installPack(ordersPack, {...}) (replace previous installPack(orderPolicyBundle))

CONSTRAINTS
- Read CLAUDE.md rules 2 (prices in centavos), 4 (pt-BR), 9 first
- TypeScript strict, ESM ("type": "module"), .js extensions on local imports
- Use @adjudicate/primitives factories where they apply (createConfirmGuard, createEscalateGuard, createRewriteGuard, createSystemTaintPolicy)
- pt-BR for ALL user-facing refusal text
- DO NOT modify @adjudicate/* source (sibling repo)
- DO NOT alter the LEGACY orderPolicyBundle behaviour — conformance test must verify byte-identical decisions

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] packages/pack-orders/ scaffold matches @adjudicate/pack-payments-pix layout
- [ ] ordersPack satisfies PackV0
- [ ] installPack(ordersPack) succeeds in kernel-bootstrap.ts
- [ ] Conformance test corpus (30+ cases) passes; identical decisions vs legacy bundle
- [ ] runConformance(ordersPack) returns zero failures
- [ ] ordersPack.policy.default.kind === "REFUSE"
- [ ] order-policy-bundle.ts is a thin re-export with @deprecated JSDoc
- [ ] All tests pass: `pnpm --filter @ibatexas/pack-orders test`
- [ ] `pnpm typecheck` (workspace-wide) passes

When complete, return: files created/modified, conformance test summary (corpus size + identical-decision confirmation), and the version of @adjudicate/pack-payments-pix you composed against.
```
