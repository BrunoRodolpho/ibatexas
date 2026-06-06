> **NOTE — load-bearing constitutional.** The `CapabilityPlanner<S,C>` + `safePlan()` + `ToolClassification<R,M>` contract below is still authoritative per `CLAUDE.md` rule #9. The migration-target framing ("currently dead code, the migration adopts it") is past tense — the planner is now live in `packages/llm-provider/src/capability-planner.ts`. See `README.md` in this directory for the full classification.

---

# 02 — Capability Model

> Companion to: [`01-intent-taxonomy.md`](./01-intent-taxonomy.md), [`03-trust-boundary-model.md`](./03-trust-boundary-model.md).
> Sources: investigations [01](../investigation/01-llm-tool-execution.md), [05](../investigation/05-adjudicate-capabilities.md).

## Executive summary

- The **`CapabilityPlanner<S, C>`** contract from `@adjudicate/core/llm` (per `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/llm/index.ts:5`) is the single authoritative gate for what the LLM may **see** and **propose** per turn. `orderCapabilityPlanner` is already exported from `packages/llm-provider/src/capability-planner.ts` but is **dead code** (per investigation 01 §"Capability planner status") — the migration adopts it as the live gate.
- **`safePlan(planner, classification, pack?)`** from `@adjudicate/core/llm` (per investigation 05 — exported at `core/src/llm/index.ts:27`) wraps a `CapabilityPlanner` and runtime-asserts that no MUTATING tool leaks into `plan.visibleReadTools` and no out-of-pack intent leaks into `plan.allowedIntents`. **Every planner registration must go through `safePlan`.**
- **`ToolClassification<R, M>`** with two slots `READ_ONLY: Set` and `MUTATING: Set` (per investigation 05) is the type-level partition. The existing `TOOL_CLASSIFICATION` in `packages/llm-provider/src/machine/types.ts:366-408` already implements this contract; it needs `set_pix_details` reclassified from MUTATING to READ_ONLY (per investigation 01 P0 #2) and `add_order_note` either removed from the MUTATING set or registered as a tool.
- The integration boundary is: **LLM → `safePlan(planner)` → `Plan {visibleReadTools, allowedIntents}` → individual `IntentEnvelope` envelopes → `adjudicateAndAudit()` per envelope → kernel decides**. The LLM never executes; per master plan §"Governance principles" #1. The `executeToolDirect` export from `tool-registry.ts:414-431` is removed (per investigation 01 P2 #5 + master plan WS2).
- Multi-step plans (e.g. add-item + checkout, cancel + refund per [`01-intent-taxonomy.md`](./01-intent-taxonomy.md) §"Composed intents") emit one envelope per step. Each envelope is adjudicated independently. The planner returns the union of all kinds that could be proposed this turn; the kernel decides which kinds actually execute.

## The `CapabilityPlanner` contract

From `@adjudicate/core/llm` (investigation 05 §"llm (`@adjudicate/core/llm`)"):

```ts
type Plan = {
  visibleReadTools: ReadonlyArray<string>;
  allowedIntents: ReadonlyArray<string>;
};

type CapabilityPlanner<S, C> = {
  plan(state: S, context: C): Plan;
};
```

For ibatexas, `S` is the XState `OrderState` snapshot (`packages/llm-provider/src/machine/order-machine.ts`) and `C` is the `OrderContext` (auth + cart + customer profile snapshot per `apps/api/src/lib/customer-context.ts`).

`plan(state, context)` runs **once per turn** in `synthesizePrompt` (per investigation 01 step 3.5 at `agent.ts:310`). The returned `Plan` is then:
1. The **visible** tool list given to the Anthropic SDK in `tools: synthesized.availableTools.map(toolDef)` (`llm-responder.ts:564-566`).
2. The **allowed-intent** filter in the kernel branch (`llm-responder.ts:251-457`) — any envelope whose `kind` is not in `plan.allowedIntents` REFUSEs deterministically with basis `auth/scope_insufficient` before even reaching `adjudicate()`.

This is the v2.0 evolution of the implicit gate that today exists as a flat string array in `synthesized.availableTools` (per investigation 01 §"Capability planner status").

## The `safePlan` wrapper

Per investigation 05 §"llm" — `safePlan(planner, classification, pack?)` from `@adjudicate/core/llm`:

```ts
import { safePlan } from "@adjudicate/core/llm";
import { TOOL_CLASSIFICATION } from "@ibatexas/llm-provider/machine/types";
import { ordersPack } from "@ibatexas/pack-orders";   // future first-party Pack

const guardedPlanner = safePlan(
  orderCapabilityPlanner,           // existing dead code per investigation 01
  TOOL_CLASSIFICATION,              // existing partition
  ordersPack,                       // future PackV0; optional today
);
```

`safePlan` runs both `assertPlanReadOnly(plan, classification)` and `assertPlanSubsetOfPack(plan, pack)` (per investigation 05 — same `core/src/llm/index.ts:24`) on every call. If a planner mistake exposes `add_to_cart` (a MUTATING tool) in `visibleReadTools`, the wrapper throws `PlanConformanceError` synchronously — before the LLM turn starts.

Per investigation 05 Tier 2 #13: "**`safePlan(planner, classification, pack)`** — runtime guard against mutating-tool leak + allowed-intent leak. Belongs at every planner registration."

## ToolClassification matrix

Defined in `packages/llm-provider/src/machine/types.ts:366-408`. Extends the framework `ToolClassification<R, M>` contract.

| Class | Semantics | Examples (current) | Examples (post-migration) |
|---|---|---|---|
| **READ_ONLY** | No state mutation. May publish a low-stakes analytics event (e.g. `product.viewed`). Tool handler runs directly; no envelope built. | `search_products`, `get_product_details`, `estimate_delivery`, `check_inventory`, `get_nutritional_info`, `check_table_availability`, `get_my_reservations`, `get_cart`, `get_order_history`, `check_order_status`, `get_customer_profile`, `get_recommendations`, `get_also_added`, `get_ordered_together`, `get_loyalty_balance`, `check_payment_status` | + `set_pix_details` (validation-only; reclassify per investigation 01 P0 #2) |
| **MUTATING** | Produces a state change. Tool handler is **never invoked**; the handler call site builds an `IntentEnvelope` and dispatches to `adjudicateAndAudit()`. | `add_to_cart`, `update_cart`, `remove_from_cart`, `apply_coupon`, `create_checkout`, `cancel_order`, `amend_order`, `reorder`, `regenerate_pix`, `submit_review`, `update_preferences`, `create_reservation`, `modify_reservation`, `cancel_reservation`, `join_waitlist`, `handoff_to_human`, `schedule_follow_up` | unchanged minus `set_pix_details`, minus dead `add_order_note` |
| **DEFERRED** (new — investigator 04) | Mutation that requires async wire confirmation (PIX pending, KYC vendor callback). Same dispatch as MUTATING; kernel may emit DEFER decision; resume via `resumeDeferredIntent`. | n/a (composed at kernel layer today via `createPixPendingDeferGuard`) | `order.checkout.create` with `paymentMethod=pix`, `payment.charge.confirm`, future KYC kinds |
| **EXTERNAL_SIDE_EFFECT** (new — investigator 02) | Outbound API call that mutates external state (Stripe, Twilio, Medusa HTTP). Same dispatch as MUTATING; kernel emits EXECUTE; the executor performs the HTTP call. Auditor records the wire latency. | n/a today (every external call is direct from a tool) | wraps `medusaStore`/`medusaAdmin` calls per investigation 03 §"Phase 6 — Medusa wrapper" |

DEFERRED and EXTERNAL_SIDE_EFFECT are **not** new framework primitives — they are documentation labels on top of MUTATING that drive guard composition. The kernel sees only READ_ONLY (handler runs) vs everything-else (envelope built). The labels matter for:
- Policy bundle composition (DEFER guards from `createStateDeferGuard` and `createPixPendingDeferGuard` per investigation 05).
- Audit redactor schema (EXTERNAL_SIDE_EFFECT records carry `wireDurationMs`).
- Replay (DEFERRED records require resume-signal correlation per [`06-deferred-execution-policy.md`](./06-deferred-execution-policy.md)).

## Plan production at runtime

```
HTTP request → runOrchestrator → runAgent → loadMachineState → routeMessage
                                                                    ↓
                                                                executeKernel (XState)
                                                                    ↓
                                                              persistMachineState
                                                                    ↓
                                                              synthesizePrompt
                                                                    ↓
                                                guardedPlanner.plan(state, ctx)  ← single capability gate
                                                                    ↓
                                              Plan {visibleReadTools, allowedIntents}
                                                                    ↓
                                                            generateResponse
                                                                    ↓
                                                Anthropic stream (tools = visibleReadTools)
                                                                    ↓
                                                          stop_reason: tool_use
                                                                    ↓
                                                              processToolCalls
                                                                    ↓
                                          per tool:
                                            if READ_ONLY → run handler → tool_result
                                            else → buildEnvelope → adjudicateAndAudit
                                                  if !plan.allowedIntents.includes(kind):
                                                      → makeOutOfPlanToolResult (deterministic refusal,
                                                        does NOT cross kernel; per adapter-core convention,
                                                        investigation 05 §"adapter-core")
                                                  else → adjudicate() → translateDecision
```

`makeOutOfPlanToolResult` and `translateDecision` come from `@adjudicate/adapter-core` (per investigation 05 §"adapter-core"). The minimum viable migration today **does not** require adopting the full adapter loop; we keep `llm-responder.ts` as the loop owner and call `safePlan`-wrapped planners explicitly. The full adapter migration is Tier 2 (investigation 05 — "when we adopt the LLM agent loop").

## Multi-step plans

Several user actions decompose into a sequence of envelopes the planner authorizes together but the kernel adjudicates independently. The planner does **not** chain them; each turn's LLM tool calls produce zero or more envelopes, and the planner refreshes between turns when state advances.

| User-perceived action | Plan emits (allowedIntents) | Per-turn sequence (in conversation) |
|---|---|---|
| Order checkout from cart | `[order.cart.ensure, order.item.add, order.item.update, order.item.remove, order.coupon.apply, order.checkout.create]` | Turn N: zero or more cart ops. Turn N+1 (state = `checkout.collecting_pix_details`): planner emits `[order.pix.details.set]` (now READ_ONLY) + `[order.checkout.create]`. Turn N+2 (state = `checkout.awaiting_payment`): planner removes mutations; emits read tools only. |
| Cancel paid PIX order + refund | `[order.cancel]` for the customer turn. After kernel says EXECUTE, the next turn's planner adds `[payment.refund.issue]` for staff actors. | Two separate turns; each its own envelope. Refund is staff-actor, planner gates by `ctx.role`. |
| Set PIX details + checkout | `[order.pix.details.set, order.checkout.create]` simultaneously | Single turn; LLM may emit both tool calls; each envelope adjudicated independently; checkout kernel may DEFER on pending PIX (per [`06-deferred-execution-policy.md`](./06-deferred-execution-policy.md)). |
| Reservation create + waitlist on full slot | `[reservation.create]`. If kernel REFUSEs with `business/rule_violated:slot_full`, **next turn** planner adds `[reservation.waitlist.join]`. | Same conversation; two turns; one envelope per turn. |
| LGPD anonymize | `[customer.anonymize]` only after `customer.session.issue` (fresh OTP) | Two HTTP requests; `customer.session.issue` is non-LLM (auth route) but flows through kernel for audit completeness. |

The kernel's `confirmationReceipt` slot in `adjudicateAndAudit` (per investigation 05 — `AdjudicateAndAuditDeps`) links the confirmation envelope to the subsequent EXECUTE envelope via `supersedes` chain. See [`04-decision-policy.md`](./04-decision-policy.md) §"Confirmation policy table" for the receipt protocol.

## Adopting `orderCapabilityPlanner` (the integration delta)

Today (per investigation 01 §"Capability planner status"):
- `orderCapabilityPlanner` is exported from `capability-planner.ts` line 41+ but never imported anywhere in the codebase.
- Live gating is via `resolveTools(stateValue, ctx)` returning a flat `string[]` consumed by `synthesizePrompt` and the `state-gate` check at `llm-responder.ts:235-243`.

Migration delta (per investigation 01 P0 #3):
1. `synthesizePrompt` accepts a `planner: CapabilityPlanner<S, C>` parameter (default `safePlan(orderCapabilityPlanner, TOOL_CLASSIFICATION, ordersPack)`).
2. It calls `planner.plan(stateValue, ctx)` and stores the `Plan` on `SynthesizedPrompt.plan` (new field).
3. `generateResponse` consumes `synthesized.plan.visibleReadTools` to build the Anthropic `tools` array.
4. `processToolCalls`/intent-dispatch consults `synthesized.plan.allowedIntents` **before** calling `adjudicateAndAudit`. Out-of-plan kinds return `makeOutOfPlanToolResult` without crossing the kernel.
5. `AuditPlanSnapshot` (per investigation 05 — `core` type) is built from `synthesized.plan` and passed in `AdjudicateAndAuditDeps.plan`. This snapshot lands in every `AuditRecord.plan` field for replay determinism.

The work is small (~60 LOC plus tests per investigation 01 §"Migration effort"). The blocking item is wiring `onToolIntent` (investigation 01 P0 #1) — without a consumer, the planner adopting is moot.

## Integration boundary

```
┌──────────────────────────────────────────────────────────────────────────┐
│ LLM (Anthropic API)                                                      │
│   • Sees only Plan.visibleReadTools                                      │
│   • Can propose tool_use blocks for any visible tool                     │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ safePlan(orderCapabilityPlanner, TOOL_CLASSIFICATION, ordersPack)        │
│   • Hard fail at compile + runtime if MUTATING leaks to visibleReadTools │
│   • Returns Plan {visibleReadTools, allowedIntents}                      │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Per tool_use:                                                            │
│   • If READ_ONLY → run handler → tool_result (no kernel)                 │
│   • Else (MUTATING/DEFERRED/EXTERNAL_SIDE_EFFECT) → buildEnvelope        │
│       • If kind NOT in Plan.allowedIntents → makeOutOfPlanToolResult     │
│         (deterministic refusal; no kernel call)                          │
│       • Else → adjudicateAndAudit(envelope, state, bundle, deps)         │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Kernel — adjudicate() evaluation order (per /Users/.../core/kernel):     │
│   kill → schema → state → taint → auth → business → default              │
│   Returns Decision (EXECUTE / REFUSE / DEFER / REWRITE /                 │
│                     REQUEST_CONFIRMATION / ESCALATE)                     │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Per Decision:                                                            │
│   EXECUTE → call domain command service (Order/Payment/Reservation/...)  │
│   REWRITE → execute the REWRITTEN envelope (never the original)          │
│   DEFER → park via parkDeferredIntent; await resume signal               │
│   REFUSE → emit user-facing pt-BR message via localizeDecision           │
│   REQUEST_CONFIRMATION → emit prompt; await user receipt                 │
│   ESCALATE → publish handoff intent; notify staff                        │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Audit sink fan-out — multiSink(console, nats, postgres)                  │
│ via persistentBufferedSink wrapper. Subject: audit.intent.decision.v1    │
└──────────────────────────────────────────────────────────────────────────┘
```

## Planner per domain

Each first-party Pack (per investigation 05 §"Packs ibatexas should write") ships its own `CapabilityPlanner`. The boot-time composition stitches them:

```ts
// apps/api/src/plugins/kernel-bootstrap.ts (new, per investigation 06)
import { ordersPack, ordersCapabilityPlanner } from "@ibatexas/pack-orders";
import { reservationsPack, reservationsPlanner } from "@ibatexas/pack-reservations";
import { whatsappPack, whatsappPlanner } from "@ibatexas/pack-whatsapp";
import { paymentsPixPack, pixCapabilityPlanner } from "@adjudicate/pack-payments-pix";

const combinedPlanner: CapabilityPlanner<OrderState, OrderContext> = {
  plan(state, ctx) {
    const o = ordersCapabilityPlanner.plan(state, ctx);
    const r = reservationsPlanner.plan(state, ctx);
    const w = whatsappPlanner.plan(state, ctx);
    const p = pixCapabilityPlanner.plan(state, ctx);
    return {
      visibleReadTools: [...o.visibleReadTools, ...r.visibleReadTools,
                         ...w.visibleReadTools, ...p.visibleReadTools],
      allowedIntents:   [...o.allowedIntents,   ...r.allowedIntents,
                         ...w.allowedIntents,   ...p.allowedIntents],
    };
  },
};

const safeCombined = safePlan(
  combinedPlanner,
  TOOL_CLASSIFICATION,
  // pack? — omitted when composing multiple packs; safePlan will only
  // assertPlanReadOnly if pack is undefined. Per-domain safePlan applied at
  // each pack's own boundary instead.
);
```

`pixCapabilityPlanner` is already shipped by `@adjudicate/pack-payments-pix` (per investigation 05 — exists but UNUSED by ibatexas).

## What this design does NOT do

- **Does not introduce a new framework primitive.** Every named export above is already in `@adjudicate/core/llm` and `@adjudicate/adapter-core` per investigation 05.
- **Does not migrate to `@adjudicate/anthropic.createAdjudicatedAgent`.** That is Tier 2 (investigation 05 §"Migration sequencing recommendation Phase 4"). The current `llm-responder.ts` loop stays; we adopt the planner contract without swapping the loop.
- **Does not gate non-LLM paths.** HTTP routes, webhooks, subscribers, and jobs do not run through the planner — they construct envelopes directly with an actor identity. The planner is the **LLM-specific** capability gate; other actors have their own trust boundaries per [`03-trust-boundary-model.md`](./03-trust-boundary-model.md).
- **Does not change tool classification at compile time.** `TOOL_CLASSIFICATION` stays the same shape; only the membership of `READ_ONLY` vs `MUTATING` shifts (`set_pix_details` moves; `add_order_note` is fixed).

## Cross-references

- Tool inventory and current classification gaps: investigation [01](../investigation/01-llm-tool-execution.md) §"Tool inventory".
- Framework `safePlan` / `assertPlanReadOnly` / `assertPlanSubsetOfPack`: `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/llm/index.ts`.
- Per-domain Pack outlines: investigation [05](../investigation/05-adjudicate-capabilities.md) §"Packs ibatexas should write".
- Decision outcomes the kernel can produce: [`04-decision-policy.md`](./04-decision-policy.md).
- Multi-step plan supersession chains: [`05-audit-replay-requirements.md`](./05-audit-replay-requirements.md) §"Supersession chains".
