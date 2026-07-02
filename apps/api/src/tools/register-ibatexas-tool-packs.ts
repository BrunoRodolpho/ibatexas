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
  modifyReservation,
  regeneratePix,
  removeFromCart,
  setPixDetails,
  submitReview,
  updateCart,
  updatePreferences,
} from "@ibatexas/tools";
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

const GUEST_ID_PREFIXES = ["guest:", "anon:", "anonymous:"] as const;

function isGuestCustomerId(id: string | undefined): boolean {
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
// 18 LLM-callable mutating tools = the union of every pack CapabilityPlanner's
// `allowedIntents` that has a `@ibatexas/tools` handler. The two payment kinds
// that ship no handler were DE-ADVERTISED in pack-payments (P0-7) — the
// context-aware leg of `toolRosterDrift()` below now fails the boot if a
// planner ever advertises a kind with no registered tool.
const IBATEXAS_TOOLS: ReadonlyArray<TD<unknown, unknown>> = [
  // ── pack-orders (10) ──────────────────────────────────────────────────────
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
    execute: (input, ctx) => updateCart(input as never, ctx),
  }),
  makeTool({
    id: "ibatexas.cart.removeItem.v1",
    capability: "order.item.remove",
    intentKind: "order.item.remove",
    description: "Remover um item do carrinho do cliente.",
    riskLevel: "low",
    execute: (input, ctx) => removeFromCart(input as never, ctx),
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
  makeTool({
    id: "ibatexas.order.amend.v1",
    capability: "order.amend.request",
    intentKind: "order.amend.request",
    description: "Solicitar alteração em um pedido já realizado.",
    riskLevel: "medium",
    execute: (input, ctx) => amendOrder(input as never, ctx),
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
 * Single-sourced from {@link IBATEXAS_TOOLS} so the prompt-fragment registry
 * (claustrum/prompts/ibatexas-prompts.ts) and the tool roster never drift.
 * This is the prompt CONTENT that, per Hard Rule #4, stays in ibatexas — the
 * PromptComposer (claustrum) owns only the SHAPE.
 */
export const IBATEXAS_CAPABILITY_DESCRIPTIONS: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      IBATEXAS_TOOLS.map((t) => [String(t.capability), t.description]),
    ),
  );

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
 * de-advertised them. The documented staff-chat exception is whitelisted
 * (see ADVERTISED_NOT_REGISTERED_WHITELIST); registered-but-unadvertised
 * kinds are WARN-only via `options.onWarn` — unreachable via chat is dead
 * weight, never a dispatch failure (`order.review.submit` is the known case:
 * the orders planner never advertises it; reviews arrive via the web flow).
 *
 * Pure: the caller supplies the pack intent union AND the planners (the
 * registrar deliberately does not import `@ibatexas/pack-*` /
 * `@ibatexas/packs-composed` to stay dependency-light). Returns a list of
 * human-readable problems; empty array means the roster is healthy.
 */
export interface RosterDriftContext {
  /** Stable name used in problem messages and the whitelist keys. */
  readonly name: string;
  /** The (state, context) pair fed to each CapabilityPlanner.plan(). */
  readonly state: unknown;
  readonly context: unknown;
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
  },
];

// Documented staff-chat exception, keyed `<context>:<kind>`:
// `reservation.checkin` / `reservation.complete` are STAFF-ROUTE-ONLY BY
// DESIGN — the live chat planner pins staffId:null so neither is ever
// proposable via chat, and the admin routes build their envelopes directly
// (never through this tool registry). The reservations pack still advertises
// them for a staff session (the pack ships the capability for adopters with
// a staff chat surface), so under the synthetic "staff" probe they are
// advertised-but-unregistered — EXPECTED, not drift.
const ADVERTISED_NOT_REGISTERED_WHITELIST: ReadonlySet<string> = new Set([
  "staff:reservation.checkin",
  "staff:reservation.complete",
]);

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
 * registered-but-unadvertised kinds via `onWarn`.
 */
function checkAdvertisedAgainstRegistered(
  tools: ReadonlyArray<TD<unknown, unknown>>,
  planners: ReadonlyArray<CapabilityPlanner<unknown, unknown>>,
  contexts: ReadonlyArray<RosterDriftContext>,
  onWarn: (message: string) => void,
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
      if (ADVERTISED_NOT_REGISTERED_WHITELIST.has(`${probe.name}:${kind}`)) {
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
      ...checkAdvertisedAgainstRegistered(tools, planners, contexts, onWarn),
    );
  }

  return problems;
}

// Defensive re-export so the surface is import-friendly from routes.
export type { TD as ToolDefinition, TR as ToolRegistry };
