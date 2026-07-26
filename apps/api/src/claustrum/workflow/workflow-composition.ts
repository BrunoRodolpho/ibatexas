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
  const actor = (envelope.actor ?? {}) as {
    customerId?: string;
    sessionId?: string;
  };
  const customerId = actor.customerId ?? null;
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
