// The two DECISIONS inside the workflow runtime's composition (LE2-021).
//
// `buildWorkflowRuntime` in `claustrum-bootstrap.ts` is composition-root glue,
// and glue is the right place for it — but two of the things it did were not
// glue. They were decisions with a wrong answer:
//
//   1. WHICH IDENTITY an activity is adjudicated as. Get the channel wrong and
//      `requireCheckoutEligibility`'s `canCheckout` evaluates a WhatsApp order
//      against web rules; get `isAuthenticated` wrong and an activity runs with
//      an authority the same mutation would not have outside a workflow.
//   2. WHICH IMPLEMENTATION an activity dispatches to, when a capability has
//      more than one registration.
//
// Both were unreachable from a test while they lived inside the composition
// root, and both were RE-IMPLEMENTED in the e2e harness — which is the shape
// that let the `list().find(...)` bug survive into LE2-021 in the first place.
// Extracted here so each is a named function with its own tests and exactly one
// definition.

import type { IntentActor, IntentEnvelope } from "@adjudicate/core";
import type { ToolRegistry } from "@claustrum/core";

/** The identity fields an activity's `SystemState.ctx` is built on. */
export interface ActivityIdentityBase {
  readonly tenantId: string;
  readonly channel: string;
  readonly customerId: string | null;
  readonly staffId: null;
  readonly isAuthenticated: boolean;
}

/**
 * Project the identity an activity is adjudicated under, from the envelope's
 * actor and the turn's bound channel.
 *
 * ── THE CHANNEL IS NOT A DEFAULT ─────────────────────────────────────────────
 *
 * `adjudicateActivity` receives only an envelope, and an `IntentActor` carries
 * no channel, so without the per-turn binding this would have to guess. `"web"`
 * is the guess it would make, and it would silently adjudicate every WhatsApp
 * workflow activity against web rules — `canCheckout` reads the channel. The
 * fallback here therefore applies ONLY outside a bound turn, which no
 * conversational path is; it exists so a non-turn caller degrades to a
 * consistent identity rather than to `undefined`.
 *
 * ── AUTHENTICATION IS DERIVED, NEVER ASSERTED ────────────────────────────────
 *
 * `isAuthenticated` is `customerId !== null` and nothing else. The actor is part
 * of an envelope, so anything it *claimed* about its own authentication would be
 * a self-report; the presence of a resolved customer id is the only fact here
 * that an upstream stage established.
 *
 * `staffId` is permanently `null`: a workflow acts for the customer who
 * confirmed it, never for a broader principal.
 */
export function activityIdentityBase(
  envelope: IntentEnvelope,
  channel: string | undefined,
  tenantId: string | undefined,
): ActivityIdentityBase {
  return actorIdentityBase(envelope.actor as WorkflowActor | undefined, channel, tenantId);
}

/** The actor fields this layer reads. Structural — an `IntentActor` carries
 *  more, and none of the rest decides anything here. */
export interface WorkflowActor {
  readonly customerId?: string;
  readonly sessionId?: string;
}

/**
 * The same identity decision, taken from an ACTOR rather than an envelope —
 * LE2-022.
 *
 * A feasibility PRE-CHECK runs before any envelope exists (that is the whole
 * point of it: it fires before the anchor can park a confirm), so it needs the
 * identity from the only thing that does exist at that moment, the turn's actor.
 * Delegating rather than duplicating keeps ONE definition of "which identity is
 * this adjudicated as" — two would be two chances to get the channel wrong, and
 * a mis-read channel is a money-guard bug (see this module's header).
 */
export function actorIdentityBase(
  actor: WorkflowActor | undefined,
  channel: string | undefined,
  tenantId: string | undefined,
): ActivityIdentityBase {
  const customerId = actor?.customerId ?? null;
  return {
    tenantId: tenantId ?? "ibatexas",
    channel: channel ?? "web",
    customerId,
    staffId: null,
    isAuthenticated: customerId !== null,
  };
}

/**
 * An actor carrying the customer identity a FEASIBILITY projection is grounded
 * under — LE2-023.
 *
 * ── THE BUG THIS EXISTS TO CLOSE ────────────────────────────────────────────
 *
 * `checkFeasibility` is called from the PLANNER, and the only actor the planner
 * has at that moment is `plannerEnvelopeActor`'s — `{principal: "llm",
 * sessionId: conversationId}`, with NO customerId, because an ENVELOPE's actor
 * describes who mechanically proposed the intent, not who is authenticated. The
 * customer identity reaches an envelope's guards a different way entirely: the
 * conductor's RESOLVE stage reads it off the Capsule.
 *
 * A feasibility projection has no resolver in front of it, so handing it that
 * actor made every AUTH-GATED fact unreachable: `loadPreviousOrder` is skipped
 * for a null customer, `customerHasPreviousOrder` reads FALSE, and the first
 * pre-check over it refuses — for EVERY customer, including one with a shelf of
 * orders. The workflow is then never offered to anybody, and it fails in the
 * quiet direction: the customer gets an authored, plausible sentence saying they
 * have no previous order.
 *
 * It was unreachable until this ticket only because reorder-last — the one
 * workflow that shipped before it — declares NO pre-checks, so
 * `checkFeasibility` returned early and the actor was never read. LE2-022 built
 * the gate and proved it against a fixture corpus with a synthetic actor; this
 * is the first definition to route a REAL turn through it.
 *
 * ── WHY IT WIDENS NOTHING ───────────────────────────────────────────────────
 *
 * The result is used for ONE thing — `projectFacts` — and never becomes an
 * envelope, so no adjudication, audit row or intentHash sees it. The identity it
 * carries is the one the planner ALREADY derived for its own capability roster
 * (`deriveIbatexasPlannerContext`, off the Capsule-sourced memory snapshot), and
 * it is the same identity the anchor envelope will be resolved under a moment
 * later. Passing anything else would let a workflow be OFFERED on one customer's
 * facts and CONFIRMED on another's.
 *
 * Absent or guest ⟹ the actor is returned UNCHANGED, so the projection stays
 * customer-less and every auth-gated fact stays absent. That is the fail-closed
 * direction and it is what a guest should get.
 */
export function feasibilityActor(
  envelopeActor: IntentActor,
  derivedPlannerState: unknown,
): IntentActor & { readonly customerId?: string } {
  const ctx = (derivedPlannerState as { ctx?: { customerId?: unknown } } | undefined)?.ctx;
  const raw = ctx?.customerId;
  const customerId = typeof raw === "string" ? raw.trim() : "";
  if (customerId === "") return envelopeActor;
  return { ...envelopeActor, customerId };
}

/** The session handle an activity's cart state is loaded under, if it has one. */
export function activitySessionArg(
  envelope: IntentEnvelope,
): { sessionId?: string } {
  const sessionId = (envelope.actor ?? ({} as { sessionId?: string })).sessionId;
  return sessionId === undefined ? {} : { sessionId };
}

/**
 * The activity kinds adjudicated against an ORDER, not against a cart — LE2-023.
 *
 * `buildWorkflowRuntime`'s `activityState` projected `loadCartCtx` for every
 * activity, which was right while the only routed mutations were cart-shaped.
 * `order.cancel` is not: `requireCancellable` reads `ctx.fulfillmentStatus` and
 * `gatePaidCancel` reads `ctx.paymentStatus` + `ctx.totalInCentavos`, and a cart
 * ctx carries none of them. An in-saga cancel adjudicated against cart state
 * would meet a money ladder with no money in it — every band silently
 * unreachable, the guards passing green over an empty projection. That is the
 * structural blind spot BKL-251 found in the conformance sampling, arriving
 * here by a different door.
 *
 * A NAMED SET rather than an `order.`-prefix test, mirroring
 * `ORDER_BY_ID_KINDS` in the resolver: `order.reorder` and `order.coupon.apply`
 * are both `order.`-prefixed and both genuinely want cart state, so a prefix
 * test would break the two activities this route depends on most.
 */
export const ORDER_CTX_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "order.cancel",
]);

/**
 * The activity kinds needing a HOST-RESOLVED `cartId` — LE2-023.
 *
 * `requireCartIdForCartOps` reads `envelope.payload.cartId`, and a cart id is an
 * IDENTIFIER, so it has no admissible `WorkflowParamSource` for exactly the
 * reason `orderId` does not: a claim cannot carry one and a slot would be
 * model-extracted. The swap-for-coupon route's `apply-coupon` activity therefore
 * arrives with `{code}` alone and is REFUSED unless the host stamps the target.
 *
 * WHICH cart is the whole question, and the answer is the SESSION's active cart
 * — but only because `order.reorder` now claims it (see `claimSessionCart`).
 * Before that, the session still pointed at the customer's pre-existing basket
 * and stamping from it would have discounted a cart they were not buying,
 * breaking the very total they approved a cancellation against. The ordering is
 * load-bearing: the rebuild runs BEFORE the coupon in the authored route, so by
 * the time this stamp is read the session cart IS the rebuilt one.
 *
 * A NAMED SET rather than a `cart`-ish prefix test, for the same reason
 * {@link ORDER_CTX_ACTIVITY_KINDS} is one: every other cart-shaped activity a
 * future workflow routes should have to opt in deliberately.
 */
export const CART_ID_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "order.coupon.apply",
]);

/**
 * Stamp the HOST-RESOLVED payload fields an order activity needs — LE2-023.
 *
 * PURE, and separated from the read that feeds it for the reason this whole
 * module exists: which fields get stamped, on which kinds, from which source is a
 * decision with a wrong answer, and it was unreachable from a test while it lived
 * inside the composition root.
 *
 * ── WHAT IT STAMPS, AND WHY NEITHER COULD BE A PARAM ────────────────────────
 *
 *   `orderId` — from the OWNER-SCOPED previous-order projection, never from the
 *     model. See `WorkflowRuntimeDeps.resolveActivityPayload`.
 *   `actorId` — the authenticated customer id, and ONLY that. It is the BKL-103
 *     proposer stamp, and the conversational plane sets it the same way
 *     (`threadResolvedIdsIntoPayload`), from the Capsule's authenticated
 *     customerId rather than from anything on the wire.
 *
 * ── FAIL-SAFE, IN THE DIRECTION THAT LEAVES THE GUARDS ARMED ────────────────
 *
 * An absent order id or an unauthenticated identity stamps NOTHING. The activity
 * still runs, and `requireOrderIdForMutation` REFUSEs it — which stops the saga
 * with an honest render. The alternative, stamping a placeholder, would produce
 * an envelope that looks well-formed to every guard and names no real order.
 * Never overwrite an authored binding either: a workflow that declared its own
 * value said something deliberate, and silently replacing it would make the
 * definition a lie about what runs.
 */
export function stampOrderActivityPayload(args: {
  readonly capability: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly customerId: string | null;
  readonly orderId: string | undefined;
  /**
   * LE2-023 — the SESSION's active cart, for {@link CART_ID_ACTIVITY_KINDS}.
   * Absent stamps nothing, and `requireCartIdForCartOps` then REFUSEs — the
   * same fail-safe direction the two fields above take.
   */
  readonly cartId?: string | undefined;
}): Readonly<Record<string, unknown>> {
  if (CART_ID_ACTIVITY_KINDS.has(args.capability)) {
    if (args.payload["cartId"] !== undefined || args.cartId === undefined) {
      return args.payload;
    }
    return { ...args.payload, cartId: args.cartId };
  }
  if (!ORDER_CTX_ACTIVITY_KINDS.has(args.capability)) return args.payload;
  const stamped: Record<string, unknown> = { ...args.payload };
  if (stamped["orderId"] === undefined && args.orderId !== undefined) {
    stamped["orderId"] = args.orderId;
  }
  if (stamped["actorId"] === undefined && args.customerId !== null) {
    stamped["actorId"] = args.customerId;
  }
  return stamped;
}

/**
 * Resolve the tool an activity dispatches to, through the REAL registry.
 *
 * ── `resolveTool`, NOT `list().find(...)` ────────────────────────────────────
 *
 * The registry keeps EVERY registration for a capability and `list()` returns
 * them in insertion order, so a `find` takes the FIRST registration while the
 * conductor's own dispatch takes the last-write-wins winner. An activity must
 * run the same implementation a directly-parsed mutation would, so it has to ask
 * the same question the conductor asks. This was a real bug, found on the way
 * into LE2-021 and benign only by accident (activity tools happened to be
 * registered once).
 *
 * ── AND WHY A MISSING REGISTRY THROWS ────────────────────────────────────────
 *
 * Unreachable in a composed process — `registerWorkflowScopedTools` throws at
 * boot for an activity kind with no handler — but a silent no-op here would
 * report a successful step in the trace for a mutation that never ran, which is
 * the single most misleading row an operator could be shown.
 */
export function resolveActivityTool(
  registry: ToolRegistry | undefined,
  envelope: IntentEnvelope,
  ctx: unknown,
): ReturnType<ToolRegistry["resolveTool"]> {
  if (registry === undefined) {
    throw new Error(
      `[workflow] no tool registry for activity kind ${String(envelope.kind)}`,
    );
  }
  return registry.resolveTool(envelope.kind as never, ctx as never);
}
