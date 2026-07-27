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

import type { IntentEnvelope } from "@adjudicate/core";
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
}): Readonly<Record<string, unknown>> {
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
