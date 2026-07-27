// WORKFLOW ANCHOR tool handlers (LE2-021).
//
// A workflow's SELECTION capability — its governance anchor — is dispatched like
// any other capability once the kernel EXECUTEs it, so it must have a registered
// tool: `installWorkflowRuntime` throws for one that does not, because a
// workflow anchored on an undispatchable kind would confirm with the customer
// and then fail.
//
// Most anchors need nothing from this module. A workflow anchored on an
// ordinary chat capability (the LE2-020 fixture anchors on
// `order.checkout.create`) already has its tool in
// `register-ibatexas-tool-packs.ts`, and this module leaves it alone.
//
// ── WHY THE REORDER ANCHOR IS NOT IN THE MAIN ROSTER ─────────────────────────
//
// `IBATEXAS_TOOLS` is the LLM-CALLABLE roster: `CHAT_DRIVABLE_TOOL_KINDS`
// mirrors it, the journey gates consume that mirror, and
// `chat-drivable-roster-drift.test.ts` pins the two set-equal in both
// directions. Every member is a kind the model can name inside `express_intent`.
//
// `order.reorder.request` is not such a kind and must not become one. The model
// never names it: it calls `start_workflow`, and the runtime mints the anchor
// envelope. Putting it in the main roster would either (a) force it to chat tier
// so the mirror could contain it, which would publish conversation triggers, a
// description and a refusal code for a capability nothing can ever select, or
// (b) leave it identity-tier in the roster and break the mirror invariant
// outright. Both trade a true statement for a convenient one.
//
// So anchors follow the shape `register-workflow-scoped-tools.ts` already
// established for activity handlers: DERIVED FROM THE LOADED CORPUS. A
// workflow-anchor tool exists exactly when a loaded workflow anchors on it, a
// composition loading no workflow registers nothing, and the LLM-callable roster
// is untouched — which keeps "registered" and "chat-drivable" two different
// facts instead of one conflated one.

import type { ToolDefinition, ToolRegistry } from "@claustrum/core";
import type { CapabilityId, IntentKind } from "@claustrum/core";

/**
 * The reorder-last anchor.
 *
 * ── WHY IT DOES NOTHING ──────────────────────────────────────────────────────
 *
 * Reaching this executor MEANS the customer approved the reorder: the kernel
 * parked the envelope on `confirmReorderLast`'s REQUEST_CONFIRMATION and only
 * a resumed, receipt-bearing adjudication returns EXECUTE. The approval is the
 * whole content of the act. The rebuilding happens in the workflow's activity
 * sequence, which `installWorkflowRuntime`'s wrapper runs immediately after this
 * returns — each step adjudicated individually, writing its own audit row.
 *
 * Giving it work to do would be actively wrong, not merely redundant:
 * `order.reorder`'s handler POSTs a brand-new `/store/carts`, so any cart this
 * executor created would be abandoned one step later.
 *
 * ── AND WHY IT CANNOT FAIL SOFTLY ────────────────────────────────────────────
 *
 * The wrapper spreads this result and then overwrites `message` with the
 * outcome template, so a soft `{success: false, message}` returned here would be
 * SILENTLY DISCARDED and the customer would read "Pronto!" over a failed anchor.
 * A trivial executor has no failure mode to express, which is the safest way to
 * hold that property — but it is a property to hold deliberately, so any future
 * anchor work here must THROW rather than return a failure shape.
 */
const REORDER_REQUEST_ANCHOR: ToolDefinition<unknown, unknown> = {
  id: "ibatexas.order.reorderRequest.v1",
  capability: "order.reorder.request" as CapabilityId,
  intentKind: "order.reorder.request" as IntentKind,
  description: "Confirmar a repetição do último pedido do cliente.",
  inputSchema: {},
  outputSchema: {},
  // The anchor itself moves nothing. The risk of the ROUTE lives on
  // `order.reorder` (medium — it replaces the customer's cart), where the
  // kernel actually adjudicates it.
  riskLevel: "low",
  // The port is async and the anchor has nothing to await, so the promise is
  // constructed rather than awaited — `async () => …` would trip
  // `require-await` for describing a real property of this executor.
  execute: () => Promise.resolve({ approved: true }),
};

/**
 * The swap-for-coupon anchor — LE2-023.
 *
 * Does nothing, for the same reason `REORDER_REQUEST_ANCHOR` does nothing and
 * with more at stake. Reaching this executor MEANS the customer approved the
 * swap: `confirmSwapForCoupon` parked the envelope and only a resumed,
 * receipt-bearing adjudication returns EXECUTE. The approval IS the act.
 *
 * Here the "giving it work would be actively wrong" argument is not a nicety.
 * The route's first activity CANCELS THE ORDER, and it does so through the
 * kernel, individually adjudicated, with its own audit row and its own declared
 * compensator. Any cancelling this executor did would be an ungoverned mutation
 * riding the anchor's EXECUTE — a real money act with no adjudication of its
 * own, invisible to the per-activity trace, and unreachable by the compensation
 * machinery that exists to undo exactly it.
 *
 * The same no-soft-failure rule applies: the wrapper overwrites `message` with
 * the outcome template, so a `{success: false}` returned here would be silently
 * discarded. Future work in this executor must THROW.
 */
const COUPON_SWAP_REQUEST_ANCHOR: ToolDefinition<unknown, unknown> = {
  id: "ibatexas.order.couponSwapRequest.v1",
  capability: "order.coupon.swap.request" as CapabilityId,
  intentKind: "order.coupon.swap.request" as IntentKind,
  description: "Confirmar a troca de um pedido por um novo com cupom aplicado.",
  inputSchema: {},
  outputSchema: {},
  // The anchor itself moves nothing. The risk of the ROUTE lives on
  // `order.cancel` (irreversible) and is adjudicated there, by the kernel,
  // against the full money ladder.
  riskLevel: "low",
  execute: () => Promise.resolve({ approved: true }),
};

/** The anchor handlers this composition can supply, by capability kind. */
const WORKFLOW_ANCHOR_TOOLS: ReadonlyMap<string, ToolDefinition<unknown, unknown>> =
  new Map([
    ["order.reorder.request", REORDER_REQUEST_ANCHOR],
    ["order.coupon.swap.request", COUPON_SWAP_REQUEST_ANCHOR],
  ]);

/**
 * Register anchor handlers for the selection capabilities a loaded corpus uses
 * and the main roster does not already cover.
 *
 * Call BEFORE `installWorkflowRuntime`, which asserts every anchor is
 * dispatchable and throws otherwise. Registering an anchor the main roster
 * already owns is skipped rather than overwritten — the registry is
 * last-write-wins, so shadowing a real capability's real handler with a stub
 * would silently replace the anchor ACT with a no-op.
 *
 * Throws for an anchor with no handler on either side, for the same reason
 * `registerWorkflowScopedTools` does: composition time is the only cheap place
 * to catch a route that would confirm with a customer and then fail at dispatch.
 */
export function registerWorkflowAnchorTools(
  tools: ToolRegistry,
  capabilities: Iterable<string>,
): void {
  for (const capability of capabilities) {
    if (tools.hasCapability(capability)) continue;
    const tool = WORKFLOW_ANCHOR_TOOLS.get(capability);
    if (tool === undefined) {
      throw new Error(
        `[workflow] a loaded workflow is anchored on "${capability}", which has ` +
          "neither a registered tool nor a workflow-anchor handler. The anchor is " +
          "dispatched like any other capability, so an unregistered one would " +
          "confirm with the customer and then fail at dispatch. Register the tool, " +
          "add its anchor handler here, or anchor the workflow on a kind that has one.",
      );
    }
    tools.register(tool);
  }
}
