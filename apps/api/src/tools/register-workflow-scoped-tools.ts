// WORKFLOW-SCOPED tool handlers (LE2-020).
//
// A workflow-scoped capability is never advertised to the parser and never
// accepted from a parse, so it has no reason to be in the main roster
// (`register-ibatexas-tool-packs.ts`). Registering it there would create the
// exact thing that file's own comments warn about — a handler nothing can
// reach, the BKL-179 dead-handler class — and would put a permanent
// registered-but-unadvertised WARN in the boot log for a capability no
// composition uses.
//
// So the registration is DERIVED from the loaded workflow corpus instead: a
// workflow-scoped tool exists exactly when a workflow that invokes it exists.
// A composition loading no workflow (production, in v0) registers nothing here
// and is byte-identical to one built before this ticket; the day a real
// workflow lands, its anchor composition calls this and the handler becomes
// reachable — by that workflow's executor and by nothing else.
//
// ── WHY `order.reorder` HAS A HANDLER BUT NO REGISTRATION TODAY ──────────────
//
// `reorder` (`@ibatexas/tools`, `cart/reorder.ts`) is a real, ownership-guarded,
// adjudicated-egress handler that has existed for a long time. It was never
// registered because no planner advertises `order.reorder` — the de-facto state
// LE2 Implementation Decision 15 turns into a DECLARED one. This module is the
// other half of that decision: the handler is not dead, it is
// workflow-invocable.

import { reorder } from "@ibatexas/tools";
import type { ToolDefinition, ToolRegistry } from "@claustrum/core";
import type { CapabilityId, IntentKind } from "@claustrum/core";
import type { Capsule } from "@claustrum/core";
import { logger } from "../lib/logger.js";
import { loadPreviousOrder } from "../claustrum/previous-order.js";
// F-9 — the ONE owner of the session→active-cart key, reads AND this write.
import { claimActiveCart } from "../claustrum/active-cart-resolution.js";
import { agentCtxFromCapsule } from "./register-ibatexas-tool-packs.js";

/**
 * Run `reorder` against the customer's own last order.
 *
 * ── WHY THE ORDER ID IS RESOLVED HERE AND NOT PASSED IN ──────────────────────
 *
 * The activity's authored payload is `{}`, because the reorder-last workflow
 * declares no params — see its definition for the full argument, but the short
 * version is that `WorkflowParamSource` has two members and neither can carry an
 * identifier honestly (no registry claim type exposes an order id, and a slot is
 * model-EXTRACTED, which for an id is indistinguishable from model-invented).
 *
 * So the executor asks the database, through the SAME owner-scoped read that
 * grounded the confirm sentence the customer just approved
 * (`loadPreviousOrder`). Anything an upstream layer could have tampered with is
 * simply not in the path.
 *
 * ── WHY IT THROWS ────────────────────────────────────────────────────────────
 *
 * `installWorkflowRuntime`'s wrapper overwrites `message` with the outcome
 * template, so a soft `{ message: "não encontrei..." }` returned here would be
 * DISCARDED and the customer would read "Pronto! Montei um carrinho novo" over
 * a reorder that never happened. Throwing is what the runtime can actually see:
 * `submitActivity` catches it, marks the step un-executed, and the run reaches
 * the `failed` outcome with its honest template.
 *
 * Reaching the no-order branch at all means the projection changed between the
 * confirm and the customer's "sim" — `confirmReorderLast` REFUSEs before the
 * park otherwise — so it is a genuinely exceptional path, not the empty-history
 * case.
 */
async function executeReorder(input: unknown, capsule: Capsule): Promise<unknown> {
  const ctx = agentCtxFromCapsule(capsule);
  const customerId = ctx.customerId ?? "";
  const previous = await loadPreviousOrder(customerId);
  if (previous === null) {
    throw new Error(
      "[workflow] order.reorder: the customer has no readable previous order at " +
        "execution time. The confirm was authored from one, so this means the " +
        "projection changed between the confirm and the approval — failing the run " +
        "rather than reporting a success the customer would read as a rebuilt cart.",
    );
  }
  // The authored payload is `{}` and stays that way; the id is added here, at
  // the last possible moment, from first-party state.
  const result = await reorder(
    { ...(input as object), orderId: previous.orderId } as never,
    ctx,
  );
  await claimSessionCart(ctx, result);
  return result;
}

/**
 * Point the session's ACTIVE CART at the cart the reorder just built.
 *
 * ── WHY THIS IS A BUG FIX, NOT A NEW BEHAVIOUR ───────────────────────────────
 *
 * `reorder` POSTs a brand-new `/store/carts` and returns its id. Nothing wrote
 * that id anywhere the rest of the system reads, and the ONE place that decides
 * "which cart is this conversation working on" is `rk("cart:active:session:
 * <sessionId>")`. So before this, an accepted reorder-last told the customer
 * *"Montei um carrinho novo com os itens do seu último pedido. Quer finalizar?"*
 * while their session still pointed at the cart they had BEFORE — and
 * `threadResolvedIdsIntoPayload` threads that key onto a checkout payload, so
 * the follow-up "quero finalizar" would have created a checkout for the OLD
 * basket. The rebuilt cart was orphaned the moment it was built.
 *
 * Measured at the turn seam before the fix: after an accepted reorder the key,
 * the resolved checkout payload and the checkout ctx all still read the old
 * cart id. See the pinning test in `reorder-last-workflow.e2e.test.ts`.
 *
 * It is also the contract the swap-for-coupon route needs, and the reason that
 * route can bind a `cartId` at all: its `apply-coupon` activity must discount
 * THE CART THE CUSTOMER WILL CHECK OUT — the one the confirm quoted a new total
 * for — and after this the session cart IS that cart. Resolving the coupon's
 * target from the session would otherwise have discounted a basket the customer
 * is not buying, which is worse than failing.
 *
 * ── SCOPE, AND WHAT IT COSTS ─────────────────────────────────────────────────
 *
 * The key is session-scoped, keyed on the SAME `ctx.sessionId` `getOrCreateCart`
 * uses — this is the second writer of that key, and `cartRedisKey`'s doc in
 * `packages/tools/src/cart/get-or-create-cart.ts` records that. Since F-9 the
 * key itself is spelled in exactly one place on this plane
 * (`claustrum/active-cart-resolution.ts`), which this write now goes through.
 *
 * The previous cart is ABANDONED rather than deleted. That is what the cart
 * machinery already does for every superseded session cart — Medusa keeps it,
 * nothing points at it, and it ages out — and deleting it here would be a
 * destructive act the customer never approved.
 *
 * BEST-EFFORT and LOUD: a Redis failure must not fail a reorder that already
 * succeeded (the cart exists either way), but it leaves the customer pointed at
 * the old basket, so it logs at error rather than passing silently.
 */
async function claimSessionCart(
  ctx: { sessionId?: string },
  result: unknown,
): Promise<void> {
  const cartId = (result as { cartId?: unknown } | null)?.cartId;
  const sessionId = ctx.sessionId;
  // F-9 — the WRITE goes through `active-cart-resolution.ts` too, so ONE module
  // owns both ends of this key on the claustrum plane: the guards (a missing
  // session, a non-string or empty cart id) and the key's spelling live there
  // with the reads that must agree with them. What stays HERE is the only part
  // that is this caller's own: how loud a failed claim is.
  const claim = await claimActiveCart({ sessionId, cartId });
  if (claim.claimed || claim.error === undefined) return;
  logger.error(
    {
      component: "workflow",
      event: "workflow.reorder.session_cart_unclaimed",
      sessionId,
      cartId,
      error: claim.error instanceof Error ? claim.error.message : String(claim.error),
    },
    "workflow: order.reorder rebuilt a cart but could NOT point the session at it — the customer's next checkout would target their previous basket",
  );
}

/**
 * The workflow-scoped handlers, by capability kind.
 *
 * Keyed rather than listed so registration can be driven by which kinds a
 * loaded corpus actually invokes, and so a kind with no handler is a lookup
 * miss the caller can report rather than a silent absence.
 */
const WORKFLOW_SCOPED_TOOLS: ReadonlyMap<string, ToolDefinition<unknown, unknown>> =
  new Map([
    [
      "order.reorder",
      {
        id: "ibatexas.cart.reorder.v1",
        capability: "order.reorder" as CapabilityId,
        intentKind: "order.reorder" as IntentKind,
        description: "Recriar um carrinho com os itens de um pedido anterior.",
        inputSchema: {},
        outputSchema: {},
        // The customer's cart is replaced with a copy of an old order — high
        // enough that it should never have been a free verb, which is the whole
        // reason it is workflow-scoped.
        riskLevel: "medium",
        execute: (input: unknown, ctx: unknown) =>
          executeReorder(input, ctx as Capsule),
      } satisfies ToolDefinition<unknown, unknown>,
    ],
    [
      // LE2-023 — THE HANDLER THAT THROWS, and it is the honest implementation
      // of "no execution path exists" rather than a placeholder.
      //
      // `order.coupon.adjust` is the target of the swap-for-coupon workflow's
      // CLOSED `coupon_on_placed_order` branch. `registerWorkflowScopedTools`
      // throws at composition time for a scoped kind with no handler, so the
      // kind needs one to exist at all — and the question is what it should do.
      //
      // A no-op returning `{success: true}` would be the dangerous answer: the
      // step would record as EXECUTED in the trace, the run would reach
      // `completed`, and a customer would be told their placed order was
      // repriced when nothing happened. A THROW records the step as not
      // executed, stops the run and fires the compensators — the same shape any
      // other failed activity takes.
      //
      // It is also UNREACHABLE, twice over, which is the point: the route
      // branch is closed by the absent policy switch, and even forced open the
      // kernel REFUSEs this kind (no EXECUTE guard), so dispatch is never
      // reached. This throw is the third line of defence, and if it ever fires
      // it means both locks failed and the message says so.
      "order.coupon.adjust",
      {
        id: "ibatexas.order.couponAdjust.v1",
        capability: "order.coupon.adjust" as CapabilityId,
        intentKind: "order.coupon.adjust" as IntentKind,
        description:
          "Aplicar um cupom a um pedido já feito ajustando o preço (não implementado).",
        inputSchema: {},
        outputSchema: {},
        riskLevel: "high",
        execute: () => {
          throw new Error(
            "[workflow] order.coupon.adjust has no execution path. This kind is " +
              "declared so the swap-for-coupon workflow's coupon_on_placed_order " +
              "branch can name it while shipping CLOSED; it is workflow-scoped and " +
              "no guard in ordersPolicyBundle produces EXECUTE for it, so reaching " +
              "dispatch means BOTH locks failed. Implement the price-adjust path " +
              "and its policy before opening the switch.",
          );
        },
      } satisfies ToolDefinition<unknown, unknown>,
    ],
    [
      // LE2-024 — `order.cancel`'s REGISTRY ENTRY, and it exists to THROW.
      //
      // ── WHY THIS KIND NEEDS AN ENTRY AT ALL NOW ───────────────────────────
      //
      // Until the retirement, `order.cancel` had a registered LLM-callable tool
      // (`ibatexas.order.cancel.v1` → `cancelOrder`), so this composition-time
      // assert found one and moved on. Retiring the ad-hoc path removed that
      // registration, and `order.cancel` is still a paid-cancel workflow
      // ACTIVITY — so without an entry here the api no longer BOOTS.
      //
      // ── WHY IT THROWS INSTEAD OF CANCELLING ───────────────────────────────
      //
      // Because reaching it would be a bug, and a specific one. The workflow
      // runtime dispatches this kind through `buildWorkflowRuntime`'s own
      // `dispatchOrderCancel` → `executeOrderCancel`, which is refund-first:
      // it adjudicates a `payment.refund.issue` BEFORE any order transition and
      // throws if that does not settle. The registry is deliberately NOT that
      // path.
      //
      // The tempting entry — wire `cancelOrder` here so the kind "has a tool" —
      // is the one thing that must not happen. `cancelOrder` has NO PAID BRANCH:
      // `cancelActivePaymentForOrder` returns early for a settled payment, so it
      // cancels the order and silently leaves the money. That is parity
      // divergence 2, the defect this whole retirement exists to close, and
      // wiring it here would reintroduce it through the back door — reachable
      // only if someone later drops the `dispatchActivity` special-case, i.e.
      // exactly when nobody is looking.
      //
      // So this handler makes the "never through the registry" contract
      // EXECUTABLE: satisfy the boot assert, and if the special-case is ever
      // removed, fail loudly at dispatch instead of quietly not refunding.
      "order.cancel",
      {
        id: "ibatexas.order.cancel.workflowGuard.v1",
        capability: "order.cancel" as CapabilityId,
        intentKind: "order.cancel" as IntentKind,
        description:
          "Cancelar um pedido do cliente (roteado pelo runtime de workflow, não por este registro).",
        inputSchema: {},
        outputSchema: {},
        riskLevel: "irreversible",
        execute: () => {
          throw new Error(
            "[workflow] order.cancel reached the TOOL REGISTRY. It must not: the " +
              "workflow runtime dispatches this kind through dispatchOrderCancel " +
              "-> executeOrderCancel, which settles the implied refund BEFORE the " +
              "order transition. Reaching here means buildWorkflowRuntime's " +
              "dispatchActivity special-case was removed, and the fallback " +
              "(`cancelOrder`) has no paid path — it would cancel the order and " +
              "leave the customer's money. Restore the special-case.",
          );
        },
      } satisfies ToolDefinition<unknown, unknown>,
    ],
  ]);

/**
 * Register the handlers for the workflow-scoped kinds a loaded corpus invokes.
 *
 * Throws for a kind with no handler: a workflow that names a workflow-scoped
 * activity nothing can execute would confirm with the customer and then fail
 * mid-run, and composition time is the only place to catch that cheaply. The
 * compiler catches the neighbouring mistake (an activity naming a kind the
 * catalog does not declare); this catches the one it structurally cannot — that
 * a declared kind has no handler wired in THIS composition.
 */
export function registerWorkflowScopedTools(
  tools: ToolRegistry,
  kinds: Iterable<string>,
): void {
  for (const kind of kinds) {
    if (tools.hasCapability(kind)) continue;
    const tool = WORKFLOW_SCOPED_TOOLS.get(kind);
    if (tool === undefined) {
      throw new Error(
        `[workflow] a loaded workflow invokes "${kind}", which has no registered ` +
          "tool and no workflow-scoped handler. Add its handler to " +
          "register-workflow-scoped-tools.ts, or the run would confirm with the " +
          "customer and then fail at dispatch.",
      );
    }
    tools.register(tool);
  }
}
