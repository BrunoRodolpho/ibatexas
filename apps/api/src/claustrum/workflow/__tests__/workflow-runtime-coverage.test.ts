// Unit tests for LE2-023's three runtime mechanisms: DECLARED CONFIRM COVERAGE,
// the `escalated` outcome, and the STAFF-VISIBILITY handoff.
//
// The kernel is stubbed here and only here — these are statements about what the
// runtime does with a decision, not about which decision the kernel gives. What
// makes them meaningful is that every case has a directional twin: the coverage
// cases are each paired with the same run minus one precondition, so a test can
// never pass because coverage silently became the default.

import { describe, expect, it } from "vitest";
import type { Decision } from "@adjudicate/core";
import type { WorkflowDefinition } from "@ibatexas/catalog";
import { FIXTURE_LINEAR_WORKFLOW } from "@ibatexas/catalog";
import { createWorkflowRuntime, type WorkflowRuntime } from "../workflow-runtime.js";

const ANCHOR = "order.checkout.create";
const STEP = "order.cart.ensure";
const ACTOR = { principal: "llm", role: "customer" } as never;
const SELECT_TURN = "turn_select";
const CONFIRM_TURN = "turn_confirm";
const COVERED_REASON = "paid_cancel_requires_confirmation";

/** The kernel's own witness that a customer affirmatively confirmed. */
const AFFIRMED_ANCHOR = {
  kind: "EXECUTE",
  basis: [
    { kind: "business", code: "rule_satisfied" },
    { kind: "confirmation", code: "received" },
  ],
} as unknown as Decision;

/** An anchor EXECUTE with NO confirmation basis — the un-affirmed twin. */
const UNAFFIRMED_ANCHOR = {
  kind: "EXECUTE",
  basis: [{ kind: "business", code: "rule_satisfied" }],
} as unknown as Decision;

/** A REQUEST_CONFIRMATION carrying a business basis whose detail names `reason`. */
function confirmWithReason(reason: string): Decision {
  return {
    kind: "REQUEST_CONFIRMATION",
    prompt: "Confirma?",
    basis: [{ kind: "business", code: "rule_satisfied", detail: { reason } }],
  } as unknown as Decision;
}

/**
 * An ESCALATE whose basis states the COVERED reason.
 *
 * The `detail.reason` is deliberately the same string the coverage declares —
 * without it, this decision would be rejected by the reason check and the
 * "never coverable" test below would pass for the wrong reason, proving nothing
 * about the decision-kind gate it is named after. Verified by neutering that
 * gate: with a reason-less basis the test stayed green.
 */
const ESCALATE: Decision = {
  kind: "ESCALATE",
  reason: "paid_cancel_refund_above_escalate_threshold",
  basis: [
    { kind: "business", code: "rule_violated", detail: { reason: COVERED_REASON } },
  ],
} as unknown as Decision;

/** A one-activity workflow whose single step MAY declare coverage. */
function workflow(coverage?: Record<string, unknown>): WorkflowDefinition {
  return {
    ...FIXTURE_LINEAR_WORKFLOW,
    id: "workflow.unit.coverage",
    params: [],
    prechecks: [],
    activities: [
      {
        id: "step",
        capability: STEP,
        payload: {},
        compensation: { terminal: "harmless", why: "unit" },
        ...(coverage === undefined ? {} : { confirmCoveredBy: coverage }),
      },
    ],
    route: [{ activity: "step" }],
    confirm: { template: "confirm", statesFacts: ["orderAmount", "refundConsequence"] },
  } as unknown as WorkflowDefinition;
}

interface Harness {
  readonly runtime: WorkflowRuntime;
  /** One entry per adjudication, recording whether a receipt rode with it. */
  readonly submissions: { kind: string; withReceipt: boolean }[];
  readonly queued: { kind: string; reason: string }[];
}

/**
 * A runtime whose kernel answers per call. `decisions` is consumed in submission
 * order — including the SECOND submission a resolved coverage makes, which is
 * what lets a test say "confirm, then execute" and read back what happened.
 */
function harnessOver(
  definition: WorkflowDefinition,
  opts: {
    readonly decisions?: readonly Decision[];
    readonly anchor?: Decision;
    readonly withHandoff?: boolean;
    readonly handoffThrows?: boolean;
  } = {},
): Harness {
  const submissions: { kind: string; withReceipt: boolean }[] = [];
  const queued: { kind: string; reason: string }[] = [];
  const decisions = [...(opts.decisions ?? [])];
  let index = 0;

  const runtime = createWorkflowRuntime({
    workflows: [definition],
    adjudicateActivity: async (envelope, callOpts) => {
      submissions.push({
        kind: String(envelope.kind),
        withReceipt: callOpts?.confirmationReceipt !== undefined,
      });
      const decision = decisions[index] ?? ({ kind: "EXECUTE" } as unknown as Decision);
      index += 1;
      return decision;
    },
    dispatchActivity: async () => undefined,
    ...(opts.withHandoff === false
      ? {}
      : {
          escalationHandoff: {
            queue: async (envelope, reason) => {
              if (opts.handoffThrows === true) throw new Error("nats down");
              queued.push({ kind: String(envelope.kind), reason });
            },
          },
        }),
  });

  if (opts.anchor !== undefined) {
    runtime.recordSelectionDecision(CONFIRM_TURN, opts.anchor);
  }
  return { runtime, submissions, queued };
}

async function run(h: Harness): Promise<NonNullable<Awaited<ReturnType<WorkflowRuntime["run"]>>>> {
  const instance = h.runtime.select({
    turnId: SELECT_TURN,
    workflowId: "workflow.unit.coverage",
    slots: {},
    allowedIntents: [ANCHOR],
  });
  if (instance === undefined) throw new Error("select returned no instance");
  const trace = await h.runtime.run({
    instanceId: instance.instanceId,
    turnId: CONFIRM_TURN,
    actor: ACTOR,
    ctx: {},
  });
  if (trace === undefined) throw new Error("run returned no trace");
  return trace;
}

describe("LE2-023 — declared confirm coverage RESOLVES the covered question", () => {
  it("re-adjudicates the SAME envelope with a receipt and completes", async () => {
    const h = harnessOver(
      workflow({
        basisReason: COVERED_REASON,
        statesFacts: ["orderAmount", "refundConsequence"],
        why: "unit",
      }),
      {
        decisions: [confirmWithReason(COVERED_REASON), { kind: "EXECUTE" } as never],
        anchor: AFFIRMED_ANCHOR,
      },
    );

    const trace = await run(h);

    expect(trace.run.outcome).toBe("completed");
    // TWO submissions of the SAME kind: the first with no receipt, the second
    // carrying one. The second is what the kernel substitutes EXECUTE for, and
    // only for the ask-first threshold — every other guard ran both times.
    expect(h.submissions).toEqual([
      { kind: STEP, withReceipt: false },
      { kind: STEP, withReceipt: true },
    ]);
    expect(trace.steps[0]?.executed).toBe(true);
  });

  it("an UNDECLARED activity is untouched — LE2-022's default, byte-for-byte", async () => {
    // THE CONTROL THAT MATTERS MOST. Same decision, same affirmation; the only
    // difference is that the activity declares no coverage. If this ever went
    // green as `completed`, coverage would have become the default and the case
    // above would be proving nothing.
    const h = harnessOver(workflow(), {
      decisions: [confirmWithReason(COVERED_REASON)],
      anchor: AFFIRMED_ANCHOR,
    });

    const trace = await run(h);

    expect(trace.run.outcome).toBe("failed");
    expect(trace.steps[0]?.executed).toBe(false);
    expect(trace.steps[0]?.decision).toBe("REQUEST_CONFIRMATION");
    // ONE submission — no receipt was ever minted.
    expect(h.submissions).toEqual([{ kind: STEP, withReceipt: false }]);
  });

  it("a DIFFERENT question under a different reason is NOT covered", async () => {
    // Coverage names one guard verdict, not a guard and not an activity. A guard
    // that starts asking a second question under a second reason stops the run.
    const h = harnessOver(
      workflow({
        basisReason: COVERED_REASON,
        statesFacts: ["orderAmount"],
        why: "unit",
      }),
      {
        decisions: [confirmWithReason("some_other_question_entirely")],
        anchor: AFFIRMED_ANCHOR,
      },
    );

    const trace = await run(h);

    expect(trace.run.outcome).toBe("failed");
    expect(h.submissions).toEqual([{ kind: STEP, withReceipt: false }]);
  });

  it("WITHOUT a witnessed affirmation, a declared coverage is inert", async () => {
    // The anchor reached EXECUTE but carries no `confirmation:received` basis, so
    // no customer was proven to have said anything. Reaching the executor is
    // control flow; the basis is evidence.
    const h = harnessOver(
      workflow({
        basisReason: COVERED_REASON,
        statesFacts: ["orderAmount"],
        why: "unit",
      }),
      {
        decisions: [confirmWithReason(COVERED_REASON)],
        anchor: UNAFFIRMED_ANCHOR,
      },
    );

    const trace = await run(h);

    expect(trace.run.outcome).toBe("failed");
    expect(h.submissions).toEqual([{ kind: STEP, withReceipt: false }]);
  });

  it("NO anchor decision at all is inert too", async () => {
    const h = harnessOver(
      workflow({ basisReason: COVERED_REASON, statesFacts: [], why: "unit" }),
      { decisions: [confirmWithReason(COVERED_REASON)] },
    );
    const trace = await run(h);
    expect(trace.run.outcome).toBe("failed");
    expect(h.submissions).toHaveLength(1);
  });

  it("an ESCALATE is NEVER coverable — the ladder's upper band is untouched", async () => {
    // Gate 4. Every coverage precondition holds EXCEPT the decision kind, and the
    // run still stops: escalation means a human must look, and no amount of
    // customer agreement substitutes for that.
    const h = harnessOver(
      workflow({
        basisReason: COVERED_REASON,
        statesFacts: ["orderAmount", "refundConsequence"],
        why: "unit",
      }),
      { decisions: [ESCALATE], anchor: AFFIRMED_ANCHOR },
    );

    const trace = await run(h);

    expect(trace.steps[0]?.decision).toBe("ESCALATE");
    expect(h.submissions).toEqual([{ kind: STEP, withReceipt: false }]);
  });

  it("the second pass's answer STANDS — coverage is not a second chance", async () => {
    // If the re-adjudication REFUSEs (a state guard that now bites), that is the
    // answer. Coverage satisfies one specific already-asked question; it does not
    // retry until something works.
    const h = harnessOver(
      workflow({ basisReason: COVERED_REASON, statesFacts: [], why: "unit" }),
      {
        decisions: [confirmWithReason(COVERED_REASON), { kind: "REFUSE" } as never],
        anchor: AFFIRMED_ANCHOR,
      },
    );

    const trace = await run(h);

    expect(trace.run.outcome).toBe("failed");
    expect(trace.steps[0]?.decision).toBe("REFUSE");
    expect(h.submissions).toHaveLength(2);
  });
});

describe("LE2-023 — the `escalated` outcome", () => {
  it("an escalated step reaches `escalated`, never `failed`", async () => {
    const h = harnessOver(workflow(), { decisions: [ESCALATE], anchor: AFFIRMED_ANCHOR });
    const trace = await run(h);

    // `failed` would say "nothing ran", which is literally true here and still
    // misleading: an approval request is now live and an owner's decision will
    // change what happened.
    expect(trace.run.outcome).toBe("escalated");
    expect(trace.run.activitiesExecuted).toBe(0);
  });

  it("a plain REFUSE still reaches `failed` — the directional control", async () => {
    const h = harnessOver(workflow(), {
      decisions: [{ kind: "REFUSE" } as never],
      anchor: AFFIRMED_ANCHOR,
    });
    const trace = await run(h);
    expect(trace.run.outcome).toBe("failed");
  });
});

describe("LE2-023 — an escalated activity REACHES A HUMAN", () => {
  it("queues the escalated envelope to the injected handoff port", async () => {
    // The generic case, deliberately not the cancel one: this closes the hole for
    // EVERY activity that can escalate, which is what makes it worth a port
    // rather than a special case.
    const h = harnessOver(workflow(), { decisions: [ESCALATE], anchor: AFFIRMED_ANCHOR });
    await run(h);

    expect(h.queued).toEqual([
      { kind: STEP, reason: "paid_cancel_refund_above_escalate_threshold" },
    ]);
  });

  it("does NOT queue anything when no step escalated", async () => {
    const h = harnessOver(workflow(), {
      decisions: [{ kind: "EXECUTE" } as never],
      anchor: AFFIRMED_ANCHOR,
    });
    await run(h);
    expect(h.queued).toEqual([]);
  });

  it("a handoff that THROWS does not take the run down", async () => {
    // `natsHandoff`'s own posture: the customer's reply must not die on a broker
    // hiccup, and the kernel audit row is the fallback truth.
    const h = harnessOver(workflow(), {
      decisions: [ESCALATE],
      anchor: AFFIRMED_ANCHOR,
      handoffThrows: true,
    });
    const trace = await run(h);
    expect(trace.run.outcome).toBe("escalated");
  });

  it("an ABSENT port still reaches `escalated` — the surface is lost, not the truth", async () => {
    const h = harnessOver(workflow(), {
      decisions: [ESCALATE],
      anchor: AFFIRMED_ANCHOR,
      withHandoff: false,
    });
    const trace = await run(h);
    expect(trace.run.outcome).toBe("escalated");
    expect(h.queued).toEqual([]);
  });
});
