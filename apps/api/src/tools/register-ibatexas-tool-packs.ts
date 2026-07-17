// Register ibatexas's domain tools as @claustrum/core ToolDefinitions.
//
// WS3 (claustrum-on-dev): the full LLM-callable MUTATING tool roster — every
// `@ibatexas/tools` handler whose intent kind is proposable by an installed
// pack's CapabilityPlanner. Each handler is wrapped with the capability/id
// split the runtime requires:
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
// Handler ⇄ ctx contract. The dev tool handlers live in `@ibatexas/tools` and
// expect an `AgentContext` (`@ibatexas/types`) — NOT a Capsule. The runtime
// hands each tool a per-turn `Capsule`; `agentCtxFromCapsule()` adapts it. Two
// handler shapes exist and the wrapper calls each correctly:
//   - `(input, ctx: AgentContext)` — orders / customer-onboarding / payments.
//   - `(input)` — the 4 reservation handlers. `createReservation`/`joinWaitlist`
//     take a single arg; `modify`/`cancelReservation` are wrapped by
//     `withReservationOwnership`, whose type is `(input) => Promise<R>`. They
//     carry `customerId` INSIDE the input payload and do their own ownership
//     check, so the adapter ctx is intentionally not threaded into them.

import {
  addOrderNote,
  addToCart,
  amendOrder,
  applyCoupon,
  cancelOrder,
  cancelReservation,
  createCheckout,
  createReservation,
  getOrCreateCart,
  handoffToHuman,
  joinWaitlist,
  medusaAdmin,
  modifyReservation,
  regeneratePix,
  removeFromCart,
  setPixDetails,
  submitReview,
  updateCart,
  updatePreferences,
} from "@ibatexas/tools";
import { createOrderService } from "@ibatexas/domain";
import {
  Channel,
  type AgentContext,
  type UserType,
} from "@ibatexas/types";
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import type {
  Capsule,
  CapabilityId as CapId,
  IntentKind as IntK,
  ToolDefinition as TD,
  ToolRegistry as TR,
} from "@claustrum/core";
// FE-4 CONTRACT (FE-T26): IBATEXAS_CAPABILITY_DESCRIPTIONS below is now
// COMPUTED from CAPABILITY_DEFINITIONS, not from IBATEXAS_TOOLS — see its
// own doc comment.
import {
  CAPABILITY_DEFINITIONS,
  generateCapabilityDescriptions,
} from "@ibatexas/packs-composed/capability-definitions";

function asCapability(s: string): CapId {
  return s as CapId;
}
function asIntentKind(s: string): IntK {
  return s as IntK;
}

// ── Capsule → AgentContext adapter ───────────────────────────────────────────
//
// The runtime's per-turn `Capsule` carries the authoritative actor; the
// `@ibatexas/tools` handlers read a flat `AgentContext` ({channel, sessionId,
// customerId?, userType}). Map between them here so a handler never sees a
// Capsule (and the cycle on Capsule stays inside this module).
//
// VERIFIED field shapes (installed .d.ts):
//   - Capsule: { customerId: string; actor: Actor; channel: "whatsapp"|"web";
//       conversationId; turnId; ... }   (capsule.d.ts — customerId is a REQUIRED
//       string; the adopter names a guest marker there, it is never absent).
//   - Actor:  { principal: "llm"|"user"|"system"; role?: "customer"|"staff"|
//       "admin"|"support"|"system"; sessionId: string; customerId?; staffId? }
//   - AgentContext: { channel: Channel; sessionId: string; customerId?: string;
//       userType: "guest"|"customer"|"staff" }   (agent.types.ts).
//
// Guest convention (mirrors apps/api/src/routes/chat.ts, where a guest turn is
// `{ customerId: undefined, userType: "guest" }`): a Capsule customerId that is
// empty or carries a `guest:`/`anon:` marker prefix is NOT a real customer id —
// drop it (undefined) and force userType "guest". A staff/admin/support actor
// role maps to userType "staff" (the only non-customer authenticated bucket
// AgentContext models); everything else with a real id is "customer".

// Exported as the single source of truth for the guest-marker convention:
// claustrum-bootstrap imports these instead of re-declaring them (A3), so the
// planner/read-executor identity derivation and the session-TTL selection can
// never drift from the Capsule adapter's notion of "is this a real customer".
export const GUEST_ID_PREFIXES = ["guest:", "anon:", "anonymous:"] as const;

export function isGuestCustomerId(id: string | undefined): boolean {
  if (id === undefined) return true;
  const trimmed = id.trim();
  if (trimmed === "") return true;
  return GUEST_ID_PREFIXES.some((p) => trimmed.startsWith(p));
}

/** Map a ChannelKind ("whatsapp"|"web") onto the `Channel` enum the handlers use.
 *  The enum VALUES are byte-identical to ChannelKind, so this is a value lookup
 *  that defaults to web for any unexpected kind (fail-safe, not fail-loud — the
 *  channel only scopes a cart redis key, never an authorization decision). */
export function channelFromKind(kind: string): Channel {
  return kind === "whatsapp" ? Channel.WhatsApp : Channel.Web;
}

/** Derive the AgentContext `userType` from the Capsule actor + customerId. */
function userTypeFromCapsule(capsule: Capsule): UserType {
  const role = capsule.actor.role;
  if (role === "staff" || role === "admin" || role === "support") {
    return "staff";
  }
  if (isGuestCustomerId(capsule.customerId)) {
    return "guest";
  }
  return "customer";
}

/**
 * Build the flat `AgentContext` an `@ibatexas/tools` handler expects from the
 * per-turn `Capsule`. Pure; no I/O. Exported for unit testing.
 */
export function agentCtxFromCapsule(capsule: Capsule): AgentContext {
  const guest = isGuestCustomerId(capsule.customerId);
  return {
    channel: channelFromKind(capsule.channel),
    // AgentContext.sessionId is the conversation handle the cart-key + ownership
    // helpers use. The Capsule's conversationId is that per-conversation key
    // (the actor.sessionId mirrors it for envelopes); prefer conversationId.
    sessionId: capsule.conversationId,
    // Drop guest/empty markers — a guest cart is unowned and the handlers treat
    // `customerId: undefined` as "guest" (assert-cart-ownership.ts allows an
    // unowned cart only when customerId is absent).
    ...(guest ? {} : { customerId: capsule.customerId }),
    userType: userTypeFromCapsule(capsule),
  };
}

/**
 * FE-T09 (D-a) — `order.amend.update_qty` / `order.amend.remove_item`'s
 * `itemId` is now a REAL Medusa line-item id (resolve-and-assemble.ts's
 * `resolveOrderLineItem`, resolved from the live order, never a title
 * stand-in). `amendOrder`'s `handleUpdateQty`/`handleRemoveItem` still match
 * by title (legacy `AmendOrderInput.itemTitle`, unchanged) — reversing the id
 * back to a title here is a cheap live re-fetch, cheaper and lower-risk than
 * teaching `amendOrder` an id-based path. Returns `undefined` when the id no
 * longer resolves on this order (e.g. a stale/tampered id) — the caller turns
 * that into an honest not-found response rather than passing an empty title
 * through to `amendOrder`.
 */
/**
 * FE-T09 review fix (post-#264) — order.amend.update_qty/remove_item: when
 * `resolve-and-assemble.ts`'s `resolveOrderLineItem` found MULTIPLE
 * same-titled lines on the order, it stamps `itemAmbiguousCount` on the
 * payload instead of forcing a confirm (see that file's docblock on
 * `resolveOrderLineItem` for why routing item-level ambiguity through the
 * order-level auto-resolve confirm mechanism was dishonest — it implies a
 * specific item was identified when none was, and confirming resumed into
 * a lookup with no itemId, a dead end). Surface that as a specific, honest
 * disambiguation reply BEFORE attempting the id→title reverse lookup below
 * — `itemId` is unset in this case, so that lookup would just return the
 * same generic not-found message this is avoiding.
 */
export function ambiguousItemReply(
  input: unknown,
): { success: false; message: string } | undefined {
  const p = input as { itemAmbiguousCount?: unknown; item?: unknown };
  if (typeof p.itemAmbiguousCount !== "number") return undefined;
  const named =
    typeof p.item === "string" && p.item.trim() !== "" ? ` "${p.item.trim()}"` : "";
  return {
    success: false,
    message:
      `Encontrei ${p.itemAmbiguousCount} itens${named} no pedido — qual deles? ` +
      "Pode descrever com mais detalhes (ex.: valor ou posição no pedido)?",
  };
}

async function resolveItemTitleForAmend(
  orderId: string,
  itemId: string,
  customerId: string | undefined,
): Promise<string | undefined> {
  try {
    const { order, ownershipValid } = await createOrderService(medusaAdmin).getOrder(
      orderId,
      customerId,
    );
    if (!ownershipValid) return undefined;
    return order.items?.find((i) => i.id === itemId)?.title;
  } catch {
    return undefined;
  }
}

/**
 * Wrap an existing ibatexas tool handler in the claustrum ToolDefinition shape.
 * The runtime hands `execute` the per-turn Capsule (typed `unknown` in the port
 * to avoid a cycle on Capsule); we narrow it here and pass the handler a derived
 * AgentContext — never the raw Capsule.
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
  execute: (input: unknown, ctx: AgentContext) => Promise<unknown>;
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
    execute: (input, ctx) => opts.execute(input, agentCtxFromCapsule(ctx as Capsule)),
  };
}

/**
 * Variant for the reservation handlers, which take ONLY `(input)` — the ctx is
 * not threaded (they carry `customerId` in the payload and assert ownership
 * themselves). Kept separate from `makeTool` so the single-arg call is explicit
 * and type-checked rather than hidden behind a discarded second argument.
 */
function makeReservationTool(opts: {
  id: string;
  capability: string;
  intentKind: string;
  description: string;
  riskLevel: TD<unknown, unknown>["riskLevel"];
  requiresConfirmation?: boolean;
  execute: (input: unknown) => Promise<unknown>;
}): TD<unknown, unknown> {
  return {
    id: opts.id,
    capability: asCapability(opts.capability),
    intentKind: asIntentKind(opts.intentKind),
    description: opts.description,
    inputSchema: {},
    outputSchema: {},
    riskLevel: opts.riskLevel,
    ...(opts.requiresConfirmation
      ? { requiresConfirmation: opts.requiresConfirmation }
      : {}),
    // ctx intentionally discarded — reservation handlers are single-arg.
    execute: (input) => opts.execute(input),
  };
}

// ── The roster ────────────────────────────────────────────────────────────────
// INVARIANT (RC-A1 Phase A.3): `capability === intentKind` for every entry, and
// that kind is owned by an installed pack — enforced by `toolRosterDrift()` below
// (unit test + boot-time assertion). Every `capability` string here was verified
// against its pack's `intents` array (pack-{orders,reservations,customer-
// onboarding,payments}/src/index.ts) on the WS3 sweep.
//
// 20 LLM-callable mutating tools (FE-T09 (D-a) replaced `order.amend.request`
// with the three granular amend tools — net +2) = the union of every pack
// CapabilityPlanner's `allowedIntents` that has a `@ibatexas/tools` handler.
// The two payment kinds that ship no
// handler were DE-ADVERTISED in pack-payments (P0-7) — the
// context-aware leg of `toolRosterDrift()` below now fails the boot if a
// planner ever advertises a kind with no registered tool.
const IBATEXAS_TOOLS: ReadonlyArray<TD<unknown, unknown>> = [
  // ── pack-orders (12) ──────────────────────────────────────────────────────
  makeTool({
    id: "ibatexas.cart.ensure.v1",
    capability: "order.cart.ensure",
    intentKind: "order.cart.ensure",
    description: "Garantir um carrinho ativo para a sessão do cliente.",
    riskLevel: "low",
    execute: (input, ctx) => getOrCreateCart(input, ctx),
  }),
  makeTool({
    id: "ibatexas.cart.addItem.v1",
    capability: "order.item.add",
    intentKind: "order.item.add",
    description: "Adicionar um item ao carrinho do cliente.",
    riskLevel: "low",
    execute: (input, ctx) => addToCart(input as never, ctx),
  }),
  makeTool({
    id: "ibatexas.cart.updateItem.v1",
    capability: "order.item.update",
    intentKind: "order.item.update",
    description: "Atualizar a quantidade de um item no carrinho.",
    riskLevel: "low",
    // FE-T14 — order.item.update's extraction schema only ever gives the
    // model a loose NL `item` reference (identifiers are model-forbidden);
    // resolve-and-assemble.ts's `resolveCartLineItem` resolves it against
    // the live cart BEFORE this executor runs. Mirrors the granular amend
    // tools' `ambiguousItemReply` handling exactly (order.amend.update_qty
    // below) — an ambiguous or unresolved NL reference must surface an
    // honest reply, never call `updateCart` with a missing `itemId` (which
    // would otherwise throw a raw ZodError the customer never sees
    // explained).
    execute: (input, ctx) => {
      const ambiguous = ambiguousItemReply(input);
      if (ambiguous) return Promise.resolve(ambiguous);
      const p = input as { itemId?: string };
      if (typeof p.itemId !== "string") {
        return Promise.resolve({ success: false, message: "Item não encontrado no carrinho." });
      }
      return updateCart(input as never, ctx);
    },
  }),
  makeTool({
    id: "ibatexas.cart.removeItem.v1",
    capability: "order.item.remove",
    intentKind: "order.item.remove",
    description: "Remover um item do carrinho do cliente.",
    riskLevel: "low",
    // FE-T14 — same NL→itemId resolution posture as order.item.update above.
    execute: (input, ctx) => {
      const ambiguous = ambiguousItemReply(input);
      if (ambiguous) return Promise.resolve(ambiguous);
      const p = input as { itemId?: string };
      if (typeof p.itemId !== "string") {
        return Promise.resolve({ success: false, message: "Item não encontrado no carrinho." });
      }
      return removeFromCart(input as never, ctx);
    },
  }),
  makeTool({
    id: "ibatexas.cart.applyCoupon.v1",
    capability: "order.coupon.apply",
    intentKind: "order.coupon.apply",
    description: "Aplicar um cupom de desconto ao carrinho.",
    riskLevel: "low",
    execute: (input, ctx) => applyCoupon(input as never, ctx),
  }),
  makeTool({
    id: "ibatexas.cart.checkout.v1",
    capability: "order.checkout.create",
    intentKind: "order.checkout.create",
    description: "Criar checkout (sessão de pagamento) a partir do carrinho.",
    riskLevel: "high",
    requiresConfirmation: true,
    execute: (input, ctx) => createCheckout(input as never, ctx),
  }),
  makeTool({
    id: "ibatexas.order.cancel.v1",
    capability: "order.cancel",
    intentKind: "order.cancel",
    description: "Cancelar um pedido do cliente (irreversível).",
    riskLevel: "irreversible",
    requiresConfirmation: true,
    execute: (input, ctx) => cancelOrder(input as never, ctx),
  }),
  // FE-T09 (D-a, the amend inversion) — the three granular kinds became the
  // model targets; `order.amend.request`'s tool entry is REMOVED here (it is
  // no longer model-proposable per capabilities.ts). It stays a valid,
  // adjudicable pack intent (ordersPack.intents[] still lists it, and its
  // policy/guard entries are untouched) because the deterministic legacy HTTP
  // amend route (apps/api/src/routes/order-actions.ts) builds its own
  // envelope and calls `amendOrder()` via an inline `executor` callback,
  // bypassing the ToolRegistry / `resolveTool` dispatch entirely — so no live
  // caller ever resolves "order.amend.request" through this roster.
  //
  // Each granular executor maps its own narrow, resolver-hydrated payload
  // onto `AmendOrderInput` (`@ibatexas/types`) and calls the SAME `amendOrder`
  // the grouped kind already used — reusing its existing Medusa order-edit +
  // PONR + PIX-regeneration logic rather than duplicating it. update_qty/
  // remove_item's `itemId` is resolver-hydrated to a REAL Medusa line-item id
  // (resolve-and-assemble.ts's `resolveOrderLineItem`, a live order fetch —
  // never a catalog guess); `resolveItemTitleForAmend` below reverses that id
  // back to a title here (a second cheap live fetch) because `amendOrder`'s
  // `handleUpdateQty`/`handleRemoveItem` still match case-insensitively
  // against the live order's titles via `AmendOrderInput.itemTitle`.
  makeTool({
    id: "ibatexas.order.amend.addItem.v1",
    capability: "order.amend.add_item",
    intentKind: "order.amend.add_item",
    description: "Adicionar um item a um pedido já feito (pós-checkout).",
    riskLevel: "high",
    execute: (input, ctx) => {
      const p = input as { orderId: string; variantId: string; quantity: number };
      return amendOrder(
        { orderId: p.orderId, action: "add", variantId: p.variantId, quantity: p.quantity },
        ctx,
      );
    },
  }),
  makeTool({
    id: "ibatexas.order.amend.updateQty.v1",
    capability: "order.amend.update_qty",
    intentKind: "order.amend.update_qty",
    description: "Alterar a quantidade de um item em um pedido já feito (pós-checkout).",
    riskLevel: "high",
    execute: async (input, ctx) => {
      const ambiguous = ambiguousItemReply(input);
      if (ambiguous) return ambiguous;
      const p = input as { orderId: string; itemId: string; quantity: number };
      const itemTitle = await resolveItemTitleForAmend(p.orderId, p.itemId, ctx.customerId);
      if (itemTitle === undefined) {
        return { success: false, message: "Item não encontrado no pedido." };
      }
      return amendOrder(
        { orderId: p.orderId, action: "update_qty", itemTitle, quantity: p.quantity },
        ctx,
      );
    },
  }),
  makeTool({
    id: "ibatexas.order.amend.removeItem.v1",
    capability: "order.amend.remove_item",
    intentKind: "order.amend.remove_item",
    description: "Remover um item de um pedido já feito (pós-checkout).",
    riskLevel: "high",
    execute: async (input, ctx) => {
      const ambiguous = ambiguousItemReply(input);
      if (ambiguous) return ambiguous;
      const p = input as { orderId: string; itemId: string };
      const itemTitle = await resolveItemTitleForAmend(p.orderId, p.itemId, ctx.customerId);
      if (itemTitle === undefined) {
        return { success: false, message: "Item não encontrado no pedido." };
      }
      return amendOrder({ orderId: p.orderId, action: "remove", itemTitle }, ctx);
    },
  }),
  makeTool({
    id: "ibatexas.order.addNote.v1",
    capability: "order.note.add",
    intentKind: "order.note.add",
    description: "Adicionar uma observação a um pedido.",
    riskLevel: "low",
    execute: (input, ctx) => addOrderNote(input as never, ctx),
  }),
  makeTool({
    id: "ibatexas.order.submitReview.v1",
    capability: "order.review.submit",
    intentKind: "order.review.submit",
    description: "Enviar uma avaliação de um pedido concluído.",
    riskLevel: "low",
    execute: (input, ctx) => submitReview(input as never, ctx),
  }),

  // ── pack-reservations (4) — single-arg handlers ────────────────────────────
  makeReservationTool({
    id: "ibatexas.reservation.create.v1",
    capability: "reservation.create",
    intentKind: "reservation.create",
    description: "Criar uma reserva de mesa.",
    riskLevel: "medium",
    execute: (input) => createReservation(input as never),
  }),
  makeReservationTool({
    id: "ibatexas.reservation.modify.v1",
    capability: "reservation.modify",
    intentKind: "reservation.modify",
    description: "Modificar uma reserva existente.",
    riskLevel: "medium",
    execute: (input) => modifyReservation(input as never),
  }),
  makeReservationTool({
    id: "ibatexas.reservation.cancel.v1",
    capability: "reservation.cancel",
    intentKind: "reservation.cancel",
    description: "Cancelar uma reserva existente.",
    riskLevel: "medium",
    execute: (input) => cancelReservation(input as never),
  }),
  makeReservationTool({
    id: "ibatexas.reservation.joinWaitlist.v1",
    capability: "reservation.waitlist.join",
    intentKind: "reservation.waitlist.join",
    description: "Entrar na lista de espera de um horário lotado.",
    riskLevel: "low",
    execute: (input) => joinWaitlist(input as never),
  }),

  // ── pack-customer-onboarding (2) ────────────────────────────────────────────
  makeTool({
    id: "ibatexas.customer.updatePreferences.v1",
    capability: "customer.preferences.update",
    intentKind: "customer.preferences.update",
    description: "Atualizar as preferências do cliente.",
    riskLevel: "low",
    execute: (input, ctx) => updatePreferences(input as never, ctx),
  }),
  makeTool({
    id: "ibatexas.customer.setPixDetails.v1",
    capability: "customer.pix.details.save",
    intentKind: "customer.pix.details.save",
    description: "Salvar os dados PIX do cliente para reembolsos.",
    riskLevel: "medium",
    execute: (input, ctx) => setPixDetails(input as never, ctx),
  }),

  // ── pack-payments (1) ────────────────────────────────────────────────────────
  // NOTE: `payment.method.switch` and `payment.retry` have NO `@ibatexas/tools`
  // handler, so they are intentionally NOT registered AND no longer advertised
  // by paymentsCapabilityPlanner (de-advertised in P0-7; the WS4 backlog
  // restores both alongside their handlers). They remain valid pack-owned
  // intents reached by the explicit HTTP routes (order-actions.ts).
  makeTool({
    id: "ibatexas.payment.regeneratePix.v1",
    capability: "payment.pix.regenerate",
    intentKind: "payment.pix.regenerate",
    description: "Gerar um novo código PIX para um pagamento pendente.",
    riskLevel: "high",
    requiresConfirmation: true,
    execute: (input, ctx) => regeneratePix(input as never, ctx),
  }),
  // F5/L3 (BKL-030) — customer-side escalation on-ramp. sessionId is threaded
  // from the runtime ctx (identity), NOT the LLM payload; the LLM may extract
  // an optional reason. Executor publishes support.handoff_requested.
  makeTool({
    id: "ibatexas.support.handoffToHuman.v1",
    capability: "whatsapp.handoff.request",
    intentKind: "whatsapp.handoff.request",
    description: "Transferir o atendimento para um atendente humano quando o cliente pedir para falar com uma pessoa.",
    riskLevel: "low",
    execute: (input, ctx) =>
      handoffToHuman({
        sessionId: ctx.sessionId,
        reason: (input as { reason?: string }).reason,
      }),
  }),
];

/**
 * The pt-BR capability descriptions, keyed by `capability` (=== intentKind).
 *
 * FE-4 CONTRACT (FE-T26): COMPUTED from `CAPABILITY_DEFINITIONS.description`
 * via `generateCapabilityDescriptions` (FE-T21) — no longer read off
 * {@link IBATEXAS_TOOLS}'s own `description` fields. Same keys, same
 * values (FE-T21's freshness test proved byte-identity before this
 * repoint; both sources described the same 18 tools). This is the prompt
 * CONTENT that, per Hard Rule #4, stays in ibatexas — the PromptComposer
 * (claustrum) owns only the SHAPE; see `claustrum/prompts/ibatexas-
 * prompts.ts`'s `ibatexasPromptFragments()`, still the surviving
 * independent check that this map correctly drives the real rendered
 * prompt fragments (`claustrum/prompts/__tests__/ibatexas-prompts.
 * capability-fragments.test.ts`).
 *
 * NOTE (accepted, recorded — see docs/architecture/design/fe4-drift-
 * gates.md): each `makeTool({...description: "..."})` call below STILL
 * carries its own inline `description` literal on the `TD` object (kept —
 * `@claustrum/core`'s `ToolDefinition` may consume it internally, and nothing
 * here proves it never will), but this map no longer reads from it. The two
 * are DECOUPLED as of this repoint — previously "single-sourced from
 * IBATEXAS_TOOLS" made them identical by construction; now a divergence
 * between a tool's inline `description` and `CAPABILITY_DEFINITIONS`'s
 * `description` for the same kind would go unnoticed by this file alone.
 */
export const IBATEXAS_CAPABILITY_DESCRIPTIONS: Readonly<Record<string, string>> =
  generateCapabilityDescriptions(CAPABILITY_DEFINITIONS);

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
 * This is the `registered ⊆ pack-owned` direction (every registered tool is
 * valid). It deliberately does NOT assert the reverse (pack-owned ⊆ registered):
 * most pack-owned kinds are webhook / cron / staff-route-only by design and
 * never get a chat tool.
 *
 * Context-aware leg (P0-7): when `options.planners` is supplied, the pack
 * CapabilityPlanners are additionally evaluated under each named context in
 * `ROSTER_DRIFT_CONTEXTS` and `advertised ⊆ registered` is asserted per
 * context — a kind the planner advertises with no registered tool is a
 * dangling allowlist entry the LLM could propose but no tool can dispatch
 * (the planner would emit the envelope, the kernel would adjudicate it, and
 * dispatchDecision would `tool_unresolved` on EXECUTE). This is exactly the
 * dangle `payment.method.switch` / `payment.retry` shipped before P0-7
 * de-advertised them. The documented staff-chat exception (`reservation.
 * checkin`/`.complete`, the 9 ops-plane verbs) is now SURFACE-DERIVED
 * (FE-T22) — see `options.chatSurfacedKinds` — rather than a hand-maintained
 * per-`(context, kind)` whitelist: a kind advertised-but-unregistered under a
 * `chatSurfaceExempt` probe (today just `"staff"` — see `RosterDriftContext.
 * chatSurfaceExempt`) is EXPECTED (not drift) precisely when it is not meant
 * to be chat-surfaced at all, and `CapabilityDefinition.surfaces` is the
 * data that already says so. Every OTHER probe (`"authed-customer"` today)
 * stays STRICT regardless of `chatSurfacedKinds` — this is the P0-7
 * fail-closed floor the leg exists to enforce, and it must not be silently
 * widened by an exemption meant only for the staff/ops plane. Registered-
 * but-unadvertised kinds are WARN-only via `options.onWarn` — unreachable
 * via chat is dead weight, never a dispatch failure (`order.review.submit`
 * is the known case: the orders planner never advertises it; reviews arrive
 * via the web flow).
 *
 * Pure: the caller supplies the pack intent union, the planners, AND the
 * chat-surfaced-kinds set (the registrar deliberately does not import
 * `@ibatexas/pack-*` / `@ibatexas/packs-composed` to stay dependency-light —
 * `apps/api/src/claustrum-bootstrap.ts` builds `chatSurfacedKinds` from
 * `@ibatexas/packs-composed/capability-definitions` and passes it in, exactly
 * like it already does for `planners`). Returns a list of human-readable
 * problems; empty array means the roster is healthy.
 */
export interface RosterDriftContext {
  /** Stable name used in problem messages. */
  readonly name: string;
  /** The (state, context) pair fed to each CapabilityPlanner.plan(). */
  readonly state: unknown;
  readonly context: unknown;
  /**
   * FE-T22 (post-review fix) — whether `options.chatSurfacedKinds` may
   * exempt an advertised-but-unregistered kind under THIS probe. The retired
   * `ADVERTISED_NOT_REGISTERED_WHITELIST` was keyed `<context>:<kind>`, and
   * ALL 10 of its entries were `staff:<kind>` — the customer-facing probe
   * never had an exemption. `chatSurfacedKinds` on its own is
   * context-independent (it is just "the set of kinds meant to be
   * chat-surfaced"), so without this flag it would ALSO exempt a
   * non-chat-surfaced kind advertised under a customer-facing probe —
   * silently defeating the P0-7 floor this gate exists to enforce (e.g. a
   * future re-advertisement of `payment.method.switch` to authed customers,
   * exactly the class of dangle P0-7 de-advertised, would go unflagged).
   * Defaults to `false` (unset) — strict by default; only `ROSTER_DRIFT_
   * CONTEXTS`'s `"staff"` entry opts in, mirroring the old whitelist's
   * exclusively-staff coverage exactly.
   */
  readonly chatSurfaceExempt?: boolean;
}

/** Mirror of the union ctx shape `deriveIbatexasPlannerContext` builds. */
function driftProbeState(over: {
  customerId: string | null;
  staffId: string | null;
  isAuthenticated: boolean;
}): unknown {
  return {
    ctx: {
      tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
      channel: "web",
      cartId: null,
      orderId: null,
      ...over,
    },
  };
}

/**
 * The named contexts the drift gate probes. Each pack planner gates
 * `allowedIntents` on the union ctx (customerId / staffId / isAuthenticated),
 * so the advertised surface is context-dependent — a single probe would miss
 * kinds advertised only to an authenticated customer or only to staff.
 */
export const ROSTER_DRIFT_CONTEXTS: ReadonlyArray<RosterDriftContext> = [
  {
    // The live chat planner's authenticated-customer shape
    // (deriveIbatexasPlannerContext with a real recalled customerId).
    name: "authed-customer",
    state: driftProbeState({
      customerId: "drift-probe-customer",
      staffId: null,
      isAuthenticated: true,
    }),
    context: {},
  },
  {
    // Hypothetical staff chat surface. The live chat planner pins
    // staffId:null (CognitiveState carries no staff actor), but the pack
    // planners DO advertise staff kinds when staffId is set — probe that
    // surface so wiring a staff chat later cannot silently dangle.
    name: "staff",
    state: driftProbeState({
      customerId: null,
      staffId: "drift-probe-staff",
      isAuthenticated: false,
    }),
    context: {},
    // FE-T22: the ONLY context the chatSurfacedKinds exemption applies
    // under — matches the retired whitelist, whose 10 entries were ALL
    // staff:<kind> pairs. See RosterDriftContext.chatSurfaceExempt's doc.
    chatSurfaceExempt: true,
  },
];

// FE-T22 — ADVERTISED_NOT_REGISTERED_WHITELIST RETIRED. It used to hand-list
// 10 `<context>:<kind>` pairs (reservation.checkin/.complete under "staff", +
// 8 ops-plane verbs under "staff") that are advertised-but-unregistered BY
// DESIGN — every one of them a STAFF/OPS-plane verb never meant to be
// chat-surfaced at all (`product.availability.set` etc. are "Chat-INVISIBLE
// by construction", per pack-ops's own module doc). `CapabilityDefinition.
// surfaces` (FE-4.1 — "surfaces is modeled as data") already says so for
// every one of those 10 kinds: none of them is `tier: "chat"`, so none
// carries `"chat"` in `surfaces`. `checkAdvertisedAgainstRegistered` below
// now takes that as an explicit `chatSurfacedKinds` input (see
// `ToolRosterDriftOptions`), CONTEXT-SCOPED to `chatSurfaceExempt` probes
// (post-review fix — `chatSurfacedKinds` alone is context-independent, and
// ALL 10 retired pairs were `staff:<kind>`; a customer-facing probe must
// stay strict, never gaining an exemption it never had) instead of the
// hand-maintained per-pair enumeration. Verified byte-for-byte equivalent to
// the retired whitelist (all 10 pre-deletion pairs pinned as literals and
// proven still-exempt UNDER STAFF, still-flagged under authed-customer) in
// apps/api/src/__tests__/tool-roster-integrity.test.ts.

export interface ToolRosterDriftOptions {
  /**
   * The composed pack CapabilityPlanners (boot passes
   * IBATEXAS_COMPOSED_CAPABILITY_PLANNERS). When present, enables the
   * context-aware `advertised ⊆ registered` leg.
   */
  readonly planners?: ReadonlyArray<CapabilityPlanner<unknown, unknown>>;
  /** Named contexts to probe; defaults to ROSTER_DRIFT_CONTEXTS. */
  readonly contexts?: ReadonlyArray<RosterDriftContext>;
  /**
   * WARN-only sink for registered-but-unadvertised kinds. Never contributes
   * to the returned problems. Defaults to console.warn.
   */
  readonly onWarn?: (message: string) => void;
  /**
   * FE-T22 — the kinds meant to be chat-surfaced (i.e. `CapabilityDefinition.
   * surfaces` includes `"chat"` for a `tier: "chat"` instance — in practice
   * this is `CHAT_DRIVABLE_TOOL_KINDS`'s membership). Replaces the retired
   * `ADVERTISED_NOT_REGISTERED_WHITELIST`: a kind advertised-but-unregistered
   * under a `chatSurfaceExempt` probe (see `RosterDriftContext.
   * chatSurfaceExempt` — today just `"staff"`, matching every one of the
   * retired whitelist's 10 entries) is EXPECTED (not a problem) precisely
   * when it is NOT in this set. This set is, by itself, CONTEXT-INDEPENDENT
   * (just "the kinds meant to be chat-surfaced") — it is `RosterDriftContext.
   * chatSurfaceExempt` that scopes WHERE the exemption is allowed to apply.
   * Under a non-exempt probe (`"authed-customer"` today) this set is
   * ignored entirely — every advertised-but-unregistered kind there is
   * ALWAYS a problem (post-review fix: an earlier version of this option
   * exempted by kind alone, regardless of probe, which would have silently
   * widened the customer-facing P0-7 floor the leg exists to enforce).
   *
   * `undefined` (the default) means NO exemption is granted under ANY probe
   * — every advertised-but-unregistered kind is a problem, matching this
   * leg's pre-FE-T22 behavior for any caller that does not opt in (e.g.
   * `opsPlaneDriftProblems` in `ops/ops-conductor.ts`, which never needs the
   * exemption: every kind its `opsCapabilityPlanner` advertises IS registered
   * in the OPS tool registry by construction — see `opsPlaneDriftProblems`'s
   * own doc). The real chat-registry boot call
   * (`apps/api/src/claustrum-bootstrap.ts`) supplies it, built from
   * `@ibatexas/packs-composed/capability-definitions`'s
   * `generateChatDrivableToolKinds(CAPABILITY_DEFINITIONS)` — the registrar
   * itself still does not import packs-composed (stays dependency-light);
   * the caller computes and injects the set, exactly like `planners`.
   */
  readonly chatSurfacedKinds?: ReadonlySet<string>;
}

/**
 * Check 1 (`registered ⊆ pack-owned`): for every registered tool,
 * `capability === intentKind` and that kind is owned by an installed pack.
 * Returns one problem string per violation, in tool order.
 */
function checkRegisteredAgainstPacks(
  tools: ReadonlyArray<TD<unknown, unknown>>,
  union: ReadonlySet<string>,
): string[] {
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

/** Collect every intent kind the planners advertise under a single probe context. */
function advertisedKindsForProbe(
  planners: ReadonlyArray<CapabilityPlanner<unknown, unknown>>,
  probe: RosterDriftContext,
): Set<string> {
  const advertised = new Set<string>();
  for (const planner of planners) {
    for (const kind of planner.plan(probe.state, probe.context).allowedIntents) {
      advertised.add(kind);
    }
  }
  return advertised;
}

/**
 * Context-aware leg (P0-7): `advertised ⊆ registered` per named context. Returns
 * a problem per dangling advertised kind; emits WARN (never a problem) for
 * registered-but-unadvertised kinds via `onWarn`. `chatSurfacedKinds`
 * (FE-T22) replaces the retired `ADVERTISED_NOT_REGISTERED_WHITELIST` — see
 * `ToolRosterDriftOptions.chatSurfacedKinds`'s doc for the full contract.
 */
function checkAdvertisedAgainstRegistered(
  tools: ReadonlyArray<TD<unknown, unknown>>,
  planners: ReadonlyArray<CapabilityPlanner<unknown, unknown>>,
  contexts: ReadonlyArray<RosterDriftContext>,
  onWarn: (message: string) => void,
  chatSurfacedKinds: ReadonlySet<string> | undefined,
): string[] {
  const problems: string[] = [];
  // Registration is keyed by `capability` (resolveTool matches it against
  // envelope.kind; check 1 pins capability === intentKind).
  const registered = new Set(
    tools.map((t) => t.capability as unknown as string),
  );
  const advertisedAnywhere = new Set<string>();
  for (const probe of contexts) {
    const advertised = advertisedKindsForProbe(planners, probe);
    for (const kind of advertised) {
      advertisedAnywhere.add(kind);
      if (registered.has(kind)) continue;
      // FE-T22 (post-review fix): exempt ONLY when (a) this probe opts into
      // the exemption (probe.chatSurfaceExempt — today just "staff", see its
      // doc) AND (b) the kind is not meant to be chat-surfaced at all
      // (surface-derived). Every OTHER probe (authed-customer today) stays
      // STRICT regardless of chatSurfacedKinds — an advertised-but-
      // unregistered kind there is ALWAYS a problem, which is the P0-7
      // fail-closed floor this gate exists to enforce.
      if (
        probe.chatSurfaceExempt === true &&
        chatSurfacedKinds !== undefined &&
        !chatSurfacedKinds.has(kind)
      ) {
        continue;
      }
      problems.push(
        `context "${probe.name}": planner-advertised kind "${kind}" has no registered tool — ` +
          `express_intent could propose it but dispatchDecision would be tool_unresolved`,
      );
    }
  }
  // Registered-but-unadvertised: unreachable via chat under every probed
  // context — dead weight, never a dispatch failure. WARN, never fail.
  for (const kind of registered) {
    if (!advertisedAnywhere.has(kind)) {
      onWarn(
        `toolRosterDrift: registered kind "${kind}" is not advertised by any planner under ` +
          `the probed contexts (${contexts.map((c) => c.name).join(", ")}) — ` +
          `unreachable via chat (WARN only)`,
      );
    }
  }
  return problems;
}

export function toolRosterDrift(
  tools: ReadonlyArray<TD<unknown, unknown>>,
  packIntentKinds: ReadonlyArray<string>,
  options?: ToolRosterDriftOptions,
): string[] {
  const union = new Set(packIntentKinds);
  const problems: string[] = checkRegisteredAgainstPacks(tools, union);

  // ── Context-aware leg (P0-7): advertised ⊆ registered per named context ──
  const planners = options?.planners;
  if (planners !== undefined && planners.length > 0) {
    const contexts = options?.contexts ?? ROSTER_DRIFT_CONTEXTS;
    const onWarn = options?.onWarn ?? ((m: string) => console.warn(m));
    problems.push(
      ...checkAdvertisedAgainstRegistered(
        tools,
        planners,
        contexts,
        onWarn,
        options?.chatSurfacedKinds,
      ),
    );
  }

  return problems;
}

export interface ReadToolRosterDriftOptions {
  /** Named contexts to probe; defaults to ROSTER_DRIFT_CONTEXTS. */
  readonly contexts?: ReadonlyArray<RosterDriftContext>;
  /**
   * WARN-only sink for executors keyed to an unadvertised read. Never
   * contributes to the returned problems. Defaults to console.warn.
   */
  readonly onWarn?: (message: string) => void;
}

/**
 * Read-side roster drift (BKL-071) — the READ twin of {@link toolRosterDrift}.
 *
 * The mutation gate keeps `express_intent` from proposing a kind with no
 * registered tool; this keeps the one-hop enrichment loop from advertising a
 * READ the runtime cannot execute. Reads are context-gated exactly like intents
 * (order history / profile / reservation reads appear only for an authenticated
 * customer), so both legs probe the same named `contexts`.
 *
 * Fail-closed leg (`advertised ⊆ executor keys`): for every read a planner puts
 * in `Plan.visibleReadTools` under any probed context, that name MUST be an
 * executor key. A dangling advertised read → one problem per (context, read).
 *
 * WARN leg (`executor keyed to an unadvertised read`): an executor no planner
 * advertises under any probed context is unreachable via chat — dead weight,
 * never a dispatch failure. Emitted via `onWarn`, never a returned problem
 * (mirrors toolRosterDrift's registered-but-unadvertised WARN).
 *
 * Pure: the caller supplies the planners AND the executor key set — the
 * registrar stays dependency-light and never imports the bootstrap module where
 * IBATEXAS_READ_TOOL_EXECUTORS lives. Returns human-readable problems; an empty
 * array means the read roster is healthy.
 */
export function readToolRosterDrift(
  planners: ReadonlyArray<CapabilityPlanner<unknown, unknown>>,
  executorKeys: ReadonlyArray<string>,
  options?: ReadToolRosterDriftOptions,
): string[] {
  const contexts = options?.contexts ?? ROSTER_DRIFT_CONTEXTS;
  const onWarn = options?.onWarn ?? ((m: string) => console.warn(m));
  const registered = new Set(executorKeys);

  const problems: string[] = [];
  const advertisedAnywhere = new Set<string>();
  for (const probe of contexts) {
    // Union the visible reads per context first (dedup), so a read two planners
    // both advertise under one context yields at most one problem for it.
    const advertised = new Set<string>();
    for (const planner of planners) {
      for (const read of planner.plan(probe.state, probe.context).visibleReadTools) {
        advertised.add(read);
      }
    }
    for (const read of advertised) {
      advertisedAnywhere.add(read);
      if (registered.has(read)) continue;
      problems.push(
        `context "${probe.name}": planner-advertised read "${read}" has no registered executor — ` +
          `the one-hop enrichment loop would offer a read the runtime cannot execute`,
      );
    }
  }
  // Executor keyed to a read no planner advertises under any probed context —
  // unreachable via chat, never a dispatch failure. WARN, never fail.
  for (const key of registered) {
    if (!advertisedAnywhere.has(key)) {
      onWarn(
        `readToolRosterDrift: executor "${key}" is not advertised by any planner under ` +
          `the probed contexts (${contexts.map((c) => c.name).join(", ")}) — ` +
          `unreachable via chat (WARN only)`,
      );
    }
  }
  return problems;
}

// Defensive re-export so the surface is import-friendly from routes.
export type { TD as ToolDefinition, TR as ToolRegistry };
