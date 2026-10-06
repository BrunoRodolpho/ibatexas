// THE WORKFLOW TURN BINDING — which turn a decision belongs to (LE2-021).
//
// `observeWorkflowDecisions` (workflow-install.ts) has to hand each kernel
// decision to the runtime UNDER THE TURN IT BELONGS TO, so the confirm template
// can quote that turn's own grounded sentence. The decorator sits on the
// `Adjudicator` port, which carries no turn id — the envelope does not have one
// and the port's signature cannot grow one without changing a published
// contract. So the turn identity has to travel out of band.
//
// ── WHY NOT A MODULE-SCOPE `let` ─────────────────────────────────────────────
//
// LE2-020 shipped exactly that, in the test harness, and said so in its own
// comment: *"sound HERE because this harness drives exactly one turn at a
// time"*. Production is the opposite case. One api process serves many
// conversations at once — two web SSE turns, or a web turn and a WhatsApp
// webhook, are ordinary — and every one of them is `await`ing inside
// `handleTurn`. A single module-scope binding would be overwritten by whichever
// turn started most recently, so a decision would be recorded against a
// STRANGER'S turn id.
//
// That failure is worse than losing the confirm sentence. `renderConfirm` reads
// the anchor decision for a turn and interpolates its prompt into a
// customer-facing template, so a cross-bound decision could quote one
// customer's grounded amount into another customer's confirmation prompt. It
// would also be invisible under any single-turn test, and would only bite under
// concurrency — the shape that reaches production and not CI.
//
// ── THE PRECEDENT ────────────────────────────────────────────────────────────
//
// `beginWireTurn` (wire-capture.ts) solves the identical problem for the same
// reason: a value that belongs to one turn, needed by code the turn cannot pass
// an argument to. It uses `AsyncLocalStorage`, which binds the value to the
// async call tree rather than to the module, so concurrent turns each read
// their own. This is the same seam with the same lifetime, wrapped at the same
// place — the `handleTurn` call at every ingress.
//
// ── FAIL-CLOSED OUTSIDE A TURN ───────────────────────────────────────────────
//
// `currentWorkflowTurnId()` returns `undefined` for any caller not inside a
// binding — a subscriber, a job, a webhook that never wrapped, the ops plane.
// The observer then records nothing, which is the correct degrade: no confirm
// sentence is quoted, so the workflow renders its template without one. An
// unbound caller loses a quote; it never inherits someone else's.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The per-turn facts a workflow seam needs and cannot be handed as an argument.
 *
 * `channel` is here for the same reason `turnId` is, and it is not cosmetic: the
 * runtime's `adjudicateActivity` port takes ONLY an envelope, and an
 * `IntentActor` carries no channel — so the composition root projecting an
 * activity's SystemState would otherwise have to hardcode one. It feeds real
 * guards (`requireCheckoutEligibility`'s `canCheckout` treats the WhatsApp
 * channel differently from web), so a hardcoded `"web"` would silently adjudicate
 * every WhatsApp workflow activity against the wrong channel.
 */
export interface WorkflowTurnBinding {
  readonly turnId: string;
  readonly channel: string;
}

const workflowTurnContext = new AsyncLocalStorage<WorkflowTurnBinding>();

/**
 * Run one conversational turn bound to its identity.
 *
 * INGRESS SEAM — wrap the `handleTurn` invocation, exactly as `beginWireTurn`
 * and `openFunnelTurn` are placed. Call AFTER `openCapsule` (both fields come
 * from the capsule) so the binding covers the whole turn including the
 * adjudications the conductor performs inside it.
 */
export function beginWorkflowTurn<T>(
  binding: WorkflowTurnBinding,
  fn: () => Promise<T>,
): Promise<T> {
  return workflowTurnContext.run(binding, fn);
}

/**
 * The turn the calling async context belongs to, or `undefined` outside any
 * binding. See the module doc on why `undefined` is the safe answer.
 */
export function currentWorkflowTurnId(): string | undefined {
  return workflowTurnContext.getStore()?.turnId;
}

/**
 * The channel the calling turn arrived on, or `undefined` outside a binding.
 *
 * `undefined` is deliberately NOT defaulted to `"web"` here: a caller that must
 * name a channel should decide what an unbound context means for its own guards
 * rather than inherit a guess made in this module.
 */
export function currentWorkflowChannel(): string | undefined {
  return workflowTurnContext.getStore()?.channel;
}
