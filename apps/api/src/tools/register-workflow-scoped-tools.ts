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
import { loadPreviousOrder } from "../claustrum/previous-order.js";
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
  return reorder({ ...(input as object), orderId: previous.orderId } as never, ctx);
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
