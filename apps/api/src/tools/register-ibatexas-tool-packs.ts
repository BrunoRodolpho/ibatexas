// Register ibatexas's domain tools as @claustrum/core ToolDefinitions.
//
// First-pass registration of a few representative tools spanning cart, orders,
// and order lifecycle. Each existing @ibatexas/tools handler is wrapped with the
// capability/id split that the runtime requires:
//
//   - `id` is internal (e.g. "ibatexas.cart.addItem.v1") — NEVER LLM-facing.
//   - `intentKind` matches the kernel's IntentEnvelope.kind exactly so
//     adjudicate() routes to the right policy guard.
//   - `capability` is the ToolRegistry RESOLUTION key. RC-A1 Phase A reconciles
//     it to EQUAL `intentKind`: claustrum's dispatchDecision resolves a tool via
//     `capsule.tools.resolveTool(envelope.kind)`, and the registry keys by
//     `capability` (tool-registry.ts `byCapability`). A tool is therefore found
//     only when `capability === intentKind`; the prior `cart.add_item`-style
//     keys would have failed every EXECUTE with `tool_unresolved`.
//     (The LLM-facing surface is the planner's `express_intent` enum, built from
//     the packs' `allowedIntents` — NOT this field; see ibatexas-planner.ts. So
//     reconciling `capability` to the intent kind leaks nothing new to the LLM.)
//
// Adding more tools is mechanical: import the handler from `@ibatexas/tools`,
// set its intentKind, and add an entry to `IBATEXAS_TOOLS`. The full 25-tool
// roster is a separate task.
//
// ⚠️ CUTOVER NOT COMPLETE — DO NOT activate this registry until the handler
//    refactor lands (audit 2026-05-27 RC-A1 / P0-CUTOVER-1+2, D-REGHDR).
//
//    The wrapped handlers below (addToCart, createCheckout, cancelOrder) mutate
//    Prisma/Medusa/Stripe DIRECTLY — there is no `adjudicate()` call inside them
//    (`grep adjudicat packages/tools/src/` returns 0), and the legacy
//    `executeToolDirect()` kernel path is dead (imported by no live module). An
//    earlier version of this comment claimed the handlers "already" adjudicate;
//    that was false. `registerIbatexasToolPacks()` also has no caller yet, so
//    the conductor is intentionally inert (a full commerce regression, but SAFE
//    — no ungated mutations flow through chat).
//
//    Completing the cutover requires, as ONE coordinated change:
//      (1) call `bootstrapClaustrum()` at server start (server.ts);
//      (2) call `registerIbatexasToolPacks(registry)` + wire a real planner;
//      (3) route every mutation through adjudicate — the planner emits an
//          IntentEnvelope that represents the mutation, the runtime adjudicates
//          it exactly once per turn, the handler performs ONLY the adjudicated
//          mutation, and the 7 direct HTTP routes (order-actions, cart,
//          admin/{payments,orders,reservations,order-actions}, stripe-webhook)
//          route through the conductor instead of writing inline.
//    Doing (1)+(2) WITHOUT (3) activates the kernel-bypass at full volume.
//    Keep the runtime inert until (3) ships.

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

// First batch: 3 representative tools. Full registration is incremental.
// INVARIANT (RC-A1 Phase A.3): `capability === intentKind` for every entry, and
// that kind is owned by an installed pack — enforced by `toolRosterDrift()` below
// (unit test + boot-time assertion). Keep new entries compliant.
const IBATEXAS_TOOLS: ReadonlyArray<TD<unknown, unknown>> = [
  makeTool({
    id: "ibatexas.cart.addItem.v1",
    capability: "order.item.add", // RC-A1 Phase A: was "cart.add_item" (== intentKind)
    intentKind: "order.item.add",
    description: "Adicionar um item ao carrinho do cliente.",
    riskLevel: "low",
    async execute(input, capsule) {
      return addToCart(input as never, capsule as never);
    },
  }),
  makeTool({
    id: "ibatexas.cart.checkout.v1",
    capability: "order.checkout.create", // RC-A1 Phase A: was "cart.checkout" (== intentKind)
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
    capability: "order.cancel", // RC-A1 Phase A: already == intentKind
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

/**
 * Integrity gate (RC-A1 Phase A.3) — the drift detector that prevents the
 * capability-key blocker from ever silently returning.
 *
 * For every registered tool, two properties must hold or a kernel-approved
 * EXECUTE will fail to dispatch:
 *   1. `capability === intentKind` — the registry keys by `capability` but
 *      dispatchDecision resolves by `envelope.kind` (= `intentKind`); a mismatch
 *      is a `tool_unresolved` at dispatch time.
 *   2. `intentKind ∈ union(installed packs' intents)` — a tool whose kind no
 *      pack owns has no PolicyBundle, so the bridge fails closed (REFUSE) and the
 *      tool is unreachable anyway.
 *
 * Pure: the caller supplies the pack intent union (the registrar deliberately
 * does not import `@ibatexas/pack-*` to stay dependency-light). Returns a list of
 * human-readable problems; empty array means the roster is healthy.
 */
export function toolRosterDrift(
  tools: ReadonlyArray<TD<unknown, unknown>>,
  packIntentKinds: ReadonlyArray<string>,
): string[] {
  const union = new Set(packIntentKinds);
  const problems: string[] = [];
  for (const t of tools) {
    const cap = t.capability as unknown as string;
    const kind = t.intentKind as unknown as string;
    if (cap !== kind) {
      problems.push(
        `tool ${t.id}: capability "${cap}" !== intentKind "${kind}" — ` +
          `dispatchDecision resolves by intentKind, so this would be tool_unresolved`,
      );
    }
    if (!union.has(kind)) {
      problems.push(
        `tool ${t.id}: intentKind "${kind}" is not owned by any installed pack`,
      );
    }
  }
  return problems;
}

// Defensive re-export so the surface is import-friendly from routes.
export type { TD as ToolDefinition, TR as ToolRegistry };
