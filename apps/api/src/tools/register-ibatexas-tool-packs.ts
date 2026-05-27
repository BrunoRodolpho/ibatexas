// Register ibatexas's domain tools as @claustrum/core ToolDefinitions.
//
// First-pass registration of 5 representative tools spanning cart, orders,
// schedule, and customer identity. Each existing @ibatexas/tools handler is
// wrapped with the capability/id split that the LLM-facing surface requires:
//
//   - `id` is internal (e.g. "ibatexas.cart.addItem.v1")
//   - `capability` is what the planner advertises to the LLM
//     (e.g. "cart.add_item")
//   - `intentKind` matches the kernel's IntentEnvelope.kind exactly so
//     adjudicate() can route to the right policy guard.
//
// Adding more tools is mechanical: import the handler from `@ibatexas/tools`
// (or `@ibatexas/llm-provider`), copy the existing intentKind from
// packages/llm-provider/src/machine/types.ts TOOL_CLASSIFICATION, and add an
// entry to `IBATEXAS_TOOLS`. The full 25-tool roster is a separate task.
//
// IMPORTANT — boundary discipline:
//   - These handlers must NOT mutate state directly. Every mutation goes
//     through `ctx.adjudicator.adjudicate(envelope, state, policy)` first
//     and runs ONLY when the kernel returns EXECUTE. The existing
//     handlers (e.g. addToCart, cancelOrder) already do that via
//     `executeToolDirect()` (kernel-only path); we keep them as-is here
//     because the cutover preserves their internal kernel handshake.

import { addToCart, cancelOrder, createCheckout } from "@ibatexas/tools";
import type {
  Capsule,
  CapabilityId as CapId,
  IntentKind as IntK,
  ToolDefinition as TD,
  ToolRegistry as TR,
} from "@claustrum/core";

// Re-export for callers; the inline `import { ... } from "@ibatexas/tools"`
// above is intentionally permissive — the existing handlers each export
// their schema as a side-export.

function asCapability(s: string): CapId {
  return s as CapId;
}
function asIntentKind(s: string): IntK {
  return s as IntK;
}

/**
 * Wrap an existing ibatexas tool handler in the claustrum ToolDefinition
 * shape. Defensive about missing schemas (some legacy tools don't ship a
 * Zod schema; passing the literal `unknown` is fine — the planner doesn't
 * read schemas, only the runtime validator does).
 */
function makeTool(opts: {
  id: string;
  capability: string;
  intentKind: string;
  description: string;
  riskLevel: TD<unknown, unknown>["riskLevel"];
  requiresConfirmation?: boolean;
  inputSchema?: unknown;
  outputSchema?: unknown;
  execute: (input: unknown, capsule: Capsule) => Promise<unknown>;
}): TD<unknown, unknown> {
  return {
    id: opts.id,
    capability: asCapability(opts.capability),
    intentKind: asIntentKind(opts.intentKind),
    description: opts.description,
    inputSchema: opts.inputSchema ?? {},
    outputSchema: opts.outputSchema ?? {},
    riskLevel: opts.riskLevel,
    ...(opts.requiresConfirmation
      ? { requiresConfirmation: opts.requiresConfirmation }
      : {}),
    // The port declares `ctx: unknown` to avoid a cycle on Capsule. The
    // runtime hands us a Capsule at call-time; we narrow inside each
    // tool wrapper.
    execute: (input, ctx) =>
      opts.execute(input, ctx as Capsule),
  };
}

// First batch: 5 representative tools. Full registration is incremental.
const IBATEXAS_TOOLS: ReadonlyArray<TD<unknown, unknown>> = [
  makeTool({
    id: "ibatexas.cart.addItem.v1",
    capability: "cart.add_item",
    intentKind: "order.item.add",
    description: "Adicionar um item ao carrinho do cliente.",
    riskLevel: "low",
    async execute(input, capsule) {
      return addToCart(input as never, capsule as never);
    },
  }),
  makeTool({
    id: "ibatexas.cart.checkout.v1",
    capability: "cart.checkout",
    intentKind: "order.checkout.create",
    description: "Criar checkout (sessão de pagamento) a partir do carrinho.",
    riskLevel: "high",
    requiresConfirmation: true,
    async execute(input, capsule) {
      return createCheckout(input as never, capsule as never);
    },
  }),
  makeTool({
    id: "ibatexas.order.cancel.v1",
    capability: "order.cancel",
    intentKind: "order.cancel",
    description: "Cancelar um pedido do cliente (irreversível).",
    riskLevel: "irreversible",
    requiresConfirmation: true,
    async execute(input, capsule) {
      return cancelOrder(input as never, capsule as never);
    },
  }),
  // TODO(post-cutover): wire up
  //   - "schedule.reserve"   -> ScheduleReservationTool (pack-reservations)
  //   - "customer.anonymize" -> CustomerAnonymizeTool (pack-customer-onboarding)
  // when their packages publish proper package.json files.
];

/**
 * Register all ibatexas tool packs onto the conductor's tool registry.
 * Idempotent — calling twice is safe (last write wins on the same `id`).
 */
export function registerIbatexasToolPacks(registry: TR): void {
  for (const tool of IBATEXAS_TOOLS) {
    registry.register(tool);
  }
}

/**
 * For tests / introspection.
 */
export function listIbatexasToolPacks(): ReadonlyArray<TD<unknown, unknown>> {
  return IBATEXAS_TOOLS;
}

// Defensive re-export so the surface is import-friendly from routes.
export type { TD as ToolDefinition, TR as ToolRegistry };
