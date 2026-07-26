/**
 * LE2-021 — the WORKFLOW TURN BINDING under concurrency.
 *
 * LE2-020 bound the observer's turn with a module-scope `let` in the test
 * harness and flagged it as not production-sound. These tests are what "not
 * sound" means, made measurable: the same interleaving is run against BOTH
 * bindings, and the module-scope control is included precisely so the
 * AsyncLocalStorage assertion cannot pass vacuously. If someone reverts
 * `workflow-turn.ts` to a `let`, the control test keeps passing and the real
 * ones fail — which is the direction that catches the regression.
 */

import { describe, expect, it, vi } from "vitest";
import type { Adjudicator } from "@claustrum/core";
import type { Decision, IntentEnvelope } from "@adjudicate/core";
import {
  beginWorkflowTurn,
  currentWorkflowChannel,
  currentWorkflowTurnId,
} from "../workflow-turn.js";
import { observeWorkflowDecisions } from "../workflow-install.js";
import type { WorkflowRuntime } from "../workflow-runtime.js";

/** Yield to the microtask/macrotask queue so two turns genuinely interleave. */
const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("LE2-021 — beginWorkflowTurn binds the turn to the async call tree", () => {
  it("returns undefined outside any binding", () => {
    expect(currentWorkflowTurnId()).toBeUndefined();
  });

  it("two INTERLEAVED turns each read their OWN id at every checkpoint", async () => {
    const readings: Array<{ turn: string; saw: string | undefined }> = [];

    const drive = async (turn: string, delay: number): Promise<void> => {
      await beginWorkflowTurn({ turnId: turn, channel: "web" }, async () => {
        readings.push({ turn, saw: currentWorkflowTurnId() });
        // The await is the whole point: control returns to the event loop here,
        // the OTHER turn runs, and a module-scope binding would be clobbered
        // before this line resumes.
        await tick(delay);
        readings.push({ turn, saw: currentWorkflowTurnId() });
        await tick(delay);
        readings.push({ turn, saw: currentWorkflowTurnId() });
      });
    };

    await Promise.all([drive("turn_a", 4), drive("turn_b", 1)]);

    // Every reading matched the turn that took it — no cross-binding.
    expect(readings).toHaveLength(6);
    for (const reading of readings) expect(reading.saw).toBe(reading.turn);

    // And the interleaving was REAL: the two turns' readings are not two
    // contiguous blocks. Without this the test could pass on sequential
    // execution, proving nothing about concurrency.
    const order = readings.map((r) => r.turn).join(",");
    expect(order).not.toBe("turn_a,turn_a,turn_a,turn_b,turn_b,turn_b");
    expect(order).not.toBe("turn_b,turn_b,turn_b,turn_a,turn_a,turn_a");
  });

  it("carries the CHANNEL too, per turn, without cross-binding", async () => {
    // The channel feeds a real guard (`canCheckout` treats WhatsApp differently
    // from web), and the composition root projects an activity's SystemState
    // from it. A web turn and a WhatsApp turn in flight together must not read
    // each other's channel, or a WhatsApp reorder would be adjudicated as web.
    const seen: Array<{ turn: string; channel: string | undefined }> = [];

    const drive = (turn: string, channel: string, delay: number): Promise<void> =>
      beginWorkflowTurn({ turnId: turn, channel }, async () => {
        await tick(delay);
        seen.push({ turn, channel: currentWorkflowChannel() });
      });

    await Promise.all([drive("t_web", "web", 4), drive("t_wa", "whatsapp", 1)]);

    expect(seen.find((s) => s.turn === "t_web")?.channel).toBe("web");
    expect(seen.find((s) => s.turn === "t_wa")?.channel).toBe("whatsapp");
    // Outside a binding it is undefined, never a defaulted guess — the caller
    // decides what an unbound context means for its own guards.
    expect(currentWorkflowChannel()).toBeUndefined();
  });

  it("CONTROL — the module-scope `let` this replaced DOES cross-bind under the same interleaving", async () => {
    // The LE2-020 harness shortcut, reproduced verbatim in shape. This test
    // asserts the BUG, which is what makes the two tests above non-vacuous: the
    // interleaving is strong enough to break a module-scope binding, so their
    // passing is a property of AsyncLocalStorage and not of a lazy schedule.
    let moduleScopeTurnId: string | undefined;
    const readings: Array<{ turn: string; saw: string | undefined }> = [];

    const drive = async (turn: string, delay: number): Promise<void> => {
      moduleScopeTurnId = turn;
      await tick(delay);
      readings.push({ turn, saw: moduleScopeTurnId });
      moduleScopeTurnId = undefined;
    };

    await Promise.all([drive("turn_a", 4), drive("turn_b", 1)]);

    // At least one turn read a value that was not its own — the exact defect.
    expect(readings.some((r) => r.saw !== r.turn)).toBe(true);
  });
});

describe("LE2-021 — the decision observer records against the RIGHT turn", () => {
  /** A runtime stub that records only what `recordSelectionDecision` is told. */
  function recordingRuntime(): {
    readonly runtime: WorkflowRuntime;
    readonly recorded: Array<{ turnId: string; prompt: unknown }>;
  } {
    const recorded: Array<{ turnId: string; prompt: unknown }> = [];
    const runtime = {
      recordSelectionDecision: (turnId: string, decision: Decision) => {
        recorded.push({
          turnId,
          prompt: (decision as { prompt?: unknown }).prompt,
        });
      },
    } as unknown as WorkflowRuntime;
    return { runtime, recorded };
  }

  it("two concurrent adjudications land on their own turns, prompts intact", async () => {
    const { runtime, recorded } = recordingRuntime();

    // An adjudicator whose latency DIFFERS per envelope, so the two turns'
    // decisions come back in the opposite order from the one they were
    // submitted in — the interleaving that breaks a module-scope binding.
    const inner: Adjudicator = {
      adjudicate: async (envelope: unknown): Promise<Decision> => {
        const payload = (envelope as IntentEnvelope).payload as {
          delay: number;
          prompt: string;
        };
        await tick(payload.delay);
        return { kind: "REQUEST_CONFIRMATION", prompt: payload.prompt } as unknown as Decision;
      },
      adjudicatePlan: vi.fn(),
    } as unknown as Adjudicator;

    const observed = observeWorkflowDecisions(inner, runtime, currentWorkflowTurnId);

    const drive = (turnId: string, delay: number, prompt: string): Promise<unknown> =>
      beginWorkflowTurn({ turnId, channel: "web" }, () =>
        observed.adjudicate(
          { kind: "order.cart.ensure", payload: { delay, prompt } } as unknown as never,
          {} as never,
          {} as never,
        ),
      );

    await Promise.all([
      drive("turn_slow", 6, "Esse pedido soma R$ 1500,00. Confirma a finalização?"),
      drive("turn_fast", 1, "Esse pedido soma R$ 90,00. Confirma a finalização?"),
    ]);

    expect(recorded).toHaveLength(2);
    // The FAST turn finished first, so a module-scope binding would have
    // recorded its decision under whichever turn started last. Each turn's
    // grounded amount must be filed under the turn that earned it — quoting one
    // customer's total into another's confirm is the failure this prevents.
    const slow = recorded.find((r) => r.turnId === "turn_slow");
    const fast = recorded.find((r) => r.turnId === "turn_fast");
    expect(slow?.prompt).toBe("Esse pedido soma R$ 1500,00. Confirma a finalização?");
    expect(fast?.prompt).toBe("Esse pedido soma R$ 90,00. Confirma a finalização?");
  });

  it("outside a binding the observer records NOTHING (fail-closed, never a stray turn)", async () => {
    const { runtime, recorded } = recordingRuntime();
    const inner: Adjudicator = {
      adjudicate: async (): Promise<Decision> =>
        ({ kind: "EXECUTE" }) as unknown as Decision,
      adjudicatePlan: vi.fn(),
    } as unknown as Adjudicator;

    const observed = observeWorkflowDecisions(inner, runtime, currentWorkflowTurnId);
    const decision = await observed.adjudicate(
      { kind: "order.cart.ensure", payload: {} } as unknown as never,
      {} as never,
      {} as never,
    );

    // The decision passes through UNCHANGED — the observer never substitutes.
    expect((decision as { kind: string }).kind).toBe("EXECUTE");
    expect(recorded).toHaveLength(0);
  });
});
