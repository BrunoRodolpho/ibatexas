// Installing the workflow runtime into a composition (LE2-020).
//
// Two seams, both deliberately thin, both no-ops when the loaded corpus is
// empty — which is the whole of v0 in production (see the catalog's
// `workflows/definitions.ts`). A composition that loads no workflow is
// byte-identical to one built before this ticket.
//
// ── SEAM 1: THE ANCHOR TOOL WRAPPER ──────────────────────────────────────────
//
// A workflow's SELECTION envelope is an ordinary capability envelope, so the
// conductor adjudicates it, parks it on CONFIRM, resumes it on the customer's
// "sim", and — on EXECUTE — dispatches its tool exactly as it would for a
// directly-parsed request. That is the property we want: the whole-workflow
// confirm is the anchor capability's REAL confirm, over its real guards, with
// its real grounded amounts, and there is no workflow-specific confirm path
// that could drift from it.
//
// What the workflow adds is what happens AFTER that EXECUTE. So the runtime
// wraps the anchor kind's registered tool: the inner tool runs first (the
// anchor act genuinely happens — the workflow does not suppress it), and then
// the activity sequence runs, each activity adjudicated individually. The
// registry is last-write-wins per capability, so registering the wrapper after
// `registerIbatexasToolPacks` is what installs it.
//
// The wrapper is a NO-OP for any turn without an instance: a plain checkout is
// still a plain checkout, because `runtime.run()` returns `undefined` when this
// turn's parser selected no workflow. That is what makes wrapping a live,
// customer-facing capability safe rather than a hijack.
//
// ── SEAM 2: THE ANCHOR DECISION OBSERVER ─────────────────────────────────────
//
// The confirm template quotes the KERNEL's own confirm sentence, so the
// workflow layer never re-derives money. To quote it, it has to see it — hence
// a decorator over the `Adjudicator` port that hands each decision to the
// runtime on its way past. It only observes; it never alters a decision, and
// returning the inner result unchanged is the only thing it can do.

import type { Adjudicator } from "@claustrum/core";
import type { Decision, IntentActor, IntentEnvelope } from "@adjudicate/core";
import type { ToolDefinition, ToolRegistry } from "@claustrum/core";
import { logger } from "../../lib/logger.js";
import type { WorkflowRuntime } from "./workflow-runtime.js";
import { workflowInstanceIdOf } from "./workflow-surface.js";

/** Read the turn id off the per-turn Capsule the runtime hands an executor. */
function turnIdOf(ctx: unknown): string | undefined {
  const id = (ctx as { turnId?: unknown } | undefined)?.turnId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** Read the Capsule's actor — the principal a workflow acts for. */
function actorOf(ctx: unknown): IntentActor | undefined {
  const actor = (ctx as { actor?: unknown } | undefined)?.actor;
  if (actor === null || typeof actor !== "object") return undefined;
  return actor as IntentActor;
}

/**
 * Wrap every loaded workflow's ANCHOR tool so a confirmed workflow runs its
 * activities after the anchor executes.
 *
 * Call AFTER `registerIbatexasToolPacks(tools)` — the registry is
 * last-write-wins per capability, so order is the installation mechanism.
 * Registering an anchor with no underlying tool is a composition error and
 * throws: a workflow anchored on a kind nothing can execute would confirm with
 * the customer and then fail at dispatch, which is the worst place to discover
 * it.
 */
export function installWorkflowRuntime(
  tools: ToolRegistry,
  runtime: WorkflowRuntime,
): void {
  for (const capability of runtime.selectionCapabilities()) {
    const inner = tools
      .list()
      .find((tool) => String(tool.capability) === capability);
    if (inner === undefined) {
      throw new Error(
        `[workflow] a loaded workflow is anchored on "${capability}", which has no ` +
          "registered tool. The anchor is dispatched like any other capability, so " +
          "an unregistered one would confirm with the customer and then fail at " +
          "dispatch. Register the tool, or anchor the workflow on a kind that has one.",
      );
    }

    const wrapped: ToolDefinition<unknown, unknown> = {
      ...inner,
      id: `${inner.id}+workflow`,
      execute: async (input: unknown, ctx: unknown): Promise<unknown> => {
        // The anchor act happens first and unconditionally — the workflow adds
        // steps after it, it does not replace it.
        const anchor = await inner.execute(input, ctx);

        const turnId = turnIdOf(ctx);
        const actor = actorOf(ctx);
        if (turnId === undefined || actor === undefined) return anchor;
        // The instance id comes off the ANCHOR PAYLOAD, not off the turn: this
        // executor runs on the CONFIRMING turn, whose id differs from the
        // selecting turn's. The payload is what crossed the park.
        const instanceId = workflowInstanceIdOf(input);
        const instance =
          instanceId === undefined ? undefined : runtime.instanceById(instanceId);
        // NO INSTANCE ⟹ this was a plain, directly-parsed request for the
        // anchor capability. Byte-identical to the unwrapped tool.
        if (instance === undefined) return anchor;

        const trace = await runtime.run({ instanceId: instance.instanceId, turnId, actor, ctx });
        if (trace === undefined) return anchor;

        return {
          ...(anchor === null || typeof anchor !== "object" ? { anchor } : anchor),
          // The reply the customer reads comes from the AUTHORED template for
          // the outcome reached — never from model prose, and never assembled
          // here from step details.
          message: runtime.renderOutcome(instance, trace.run.outcome),
          workflow: {
            instanceId: trace.run.instanceId,
            workflowId: trace.run.workflowId,
            catalogVersion: trace.run.catalogVersion,
            outcome: trace.run.outcome,
            activitiesExecuted: trace.run.activitiesExecuted,
            activitiesTotal: trace.run.activitiesTotal,
          },
        };
      },
    };

    tools.register(wrapped);
    logger.info(
      {
        component: "workflow",
        event: "workflow.anchor.installed",
        capability,
        innerToolId: inner.id,
      },
      `workflow: anchored on ${capability} (wrapping ${inner.id})`,
    );
  }
}

/**
 * Decorate an `Adjudicator` so the runtime observes each decision.
 *
 * OBSERVE-ONLY by construction: every method returns the inner result
 * unchanged, and there is no branch in which a decision is substituted. The
 * runtime needs this to quote the kernel's own confirm sentence in the
 * whole-workflow confirm prompt (`renderConfirm`) rather than computing a
 * second, potentially disagreeing, total of its own.
 *
 * `resume` is decorated too, not just `adjudicate`: the customer's "sim"
 * re-adjudicates the parked anchor WITH a receipt, and that is the decision the
 * turn actually acts on.
 */
export function observeWorkflowDecisions(
  inner: Adjudicator,
  runtime: WorkflowRuntime,
  turnIdFor: () => string | undefined,
): Adjudicator {
  const observe = (decision: Decision): Decision => {
    const turnId = turnIdFor();
    if (turnId !== undefined) runtime.recordSelectionDecision(turnId, decision);
    return decision;
  };
  return {
    ...inner,
    adjudicate: async (envelope, state, policy) =>
      observe(await inner.adjudicate(envelope as IntentEnvelope, state, policy)),
    adjudicatePlan: async (envelopes, state, policy, perStates) =>
      observe(await inner.adjudicatePlan(envelopes, state, policy, perStates)),
    // `resume` is optional on the port; a composition without one has no park
    // to resume, so there is nothing to observe and nothing to substitute.
    ...(inner.resume === undefined
      ? {}
      : {
          resume: async (
            envelope: Parameters<NonNullable<Adjudicator["resume"]>>[0],
            state: Parameters<NonNullable<Adjudicator["resume"]>>[1],
            policy: Parameters<NonNullable<Adjudicator["resume"]>>[2],
            receipt: Parameters<NonNullable<Adjudicator["resume"]>>[3],
          ) =>
            observe(
              await (inner.resume as NonNullable<Adjudicator["resume"]>)(
                envelope,
                state,
                policy,
                receipt,
              ),
            ),
        }),
  };
}
