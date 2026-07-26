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
import { agentCtxFromCapsule } from "./register-ibatexas-tool-packs.js";

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
          reorder(input as never, agentCtxFromCapsule(ctx as Capsule)),
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
