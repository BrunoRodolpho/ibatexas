// T3-2 — agent trigger bridge + dedup stack.
//
// processTriggerJob() owns the host-level dedup + safety stack between a NATS
// delivery and a managed-agent turn. The runner is injected (T3-6/T3-9 wire the
// real shadow Conductor), so every path here is deterministic against an
// in-memory Redis + a stub runner:
//
//   - REDELIVERY: two deliveries of the SAME event → exactly one run + one
//     suppression (plan v2 §5 T3-2 acceptance).
//   - COOLDOWN: two DISTINCT events on the same entity inside the window → one
//     run + one suppression.
//   - LOOP: an event whose causal actor carries the `agent:` prefix → zero
//     runs, suppression journaled (the agent never re-wakes on its own side
//     effect).
//   - HOST CAPS: the wall-clock deadline aborts a slow turn (and releases both
//     claims so a retry reprocesses); createModelCallCap bounds model calls.

import { describe, expect, it } from "vitest";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";
import {
  AGENT_REGISTRY,
  agentSessionId,
  AgentDefinitionSchema,
  type AgentDefinition,
} from "@ibatexas/agents";
import type { ModelProvider } from "@claustrum/core";
import { rk } from "@ibatexas/tools";
import {
  createModelCallCap,
  processTriggerJob,
  type TriggerDedupRedis,
  type TriggerJournalEntry,
  type TriggerTurnRunner,
} from "../claustrum/agent-trigger-bridge.js";
import { triggerExternalId, type TriggerEvent } from "../claustrum/system-channel.js";

const PIX_AGENT = AGENT_REGISTRY.find(
  (a) => a.id === "pix-payment-failure-remediation",
)!;

// ── In-memory Redis honoring SET NX / SET (overwrite) / DEL ──────────────────

// R5-S7 — the canonical in-memory adapter. The hand-rolled TriggerDedupRedis it
// replaces re-implemented SET NX by hand and ignored EX entirely, so the dedup
// window's expiry was never modelled.
//
// F-21 — plus `compareAndDelete`, the ownership-conditional release the catch
// path now issues. `createInMemoryRedis` REFUSES `eval` on purpose (W4 RULE 3:
// a Map-stub of Lua decides the comparison in OUR process and hands back green
// on a path with no real coverage), so the CAD is written out here over the
// adapter's own get/del rather than smuggled in as a fake `eval`.
//
// That is honest for THIS layer and only this layer. These cases prove the
// SHAPE — a release compares against the token it claimed with, and a
// non-matching token deletes nothing — which is enough for the outcome-level
// assertions in this file. The ATOMICITY of that compare, which is the entire
// reason the production code uses Lua, is proven against a real Redis server in
// `agent-trigger-dedup-ownership.test.ts`.
function fakeRedis(): Omit<InMemoryRedis, "client"> & {
  readonly client: TriggerDedupRedis;
} {
  const mem = createInMemoryRedis();
  const client: TriggerDedupRedis = {
    set: (key, value, opts) => mem.client.set(key, value, opts),
    async compareAndDelete(key, expectedValue) {
      const current = await mem.client.get(key);
      if (current !== expectedValue) return 0;
      return mem.client.del(key);
    },
  };
  return { ...mem, client };
}

function failedPixEvent(eventId: string, orderId = "ord_456"): TriggerEvent {
  return {
    sourceSubject: "ibatexas.payment.status_changed",
    eventId,
    kind: "payment.status_changed",
    payload: { paymentId: "pay_1", orderId, newStatus: "failed", method: "pix" },
    entityRef: { kind: "order", id: orderId, customerId: "cus_t32" },
    occurredAt: "2026-06-12T12:00:00.000Z",
  };
}

/** A runner that always reaches EXECUTE and records each invocation. */
function recordingRunner(): TriggerTurnRunner & { calls: number } {
  const runner = Object.assign(
    async (_input: Parameters<TriggerTurnRunner>[0]) => {
      runner.calls += 1;
      return { decisionKind: "EXECUTE", modelCalls: 1 };
    },
    { calls: 0 },
  );
  return runner;
}

describe("processTriggerJob — redelivery dedup", () => {
  it("two deliveries of the same event run exactly once; the second is suppressed", async () => {
    const redis = fakeRedis();
    const runner = recordingRunner();
    const event = failedPixEvent("evt-1");

    const first = await processTriggerJob(
      { agent: PIX_AGENT, event },
      { redis: redis.client, runner },
    );
    const second = await processTriggerJob(
      { agent: PIX_AGENT, event: { ...event } },
      { redis: redis.client, runner },
    );

    expect(first).toEqual({ status: "ran", decisionKind: "EXECUTE", modelCalls: 1 });
    expect(second).toEqual({ status: "suppressed", reason: "redelivery" });
    expect(runner.calls).toBe(1);
    // The seen-key was promoted to the full window (overwrote the in-flight claim).
    expect(redis.keys()).toContain(triggerSeenKey(event));
  });
});

describe("processTriggerJob — per-entity cooldown", () => {
  it("a DISTINCT event on the same entity inside the window is suppressed by cooldown", async () => {
    const redis = fakeRedis();
    const runner = recordingRunner();

    const first = await processTriggerJob(
      { agent: PIX_AGENT, event: failedPixEvent("evt-A") },
      { redis: redis.client, runner },
    );
    // Different eventId (distinct externalId → passes redelivery), same order.
    const second = await processTriggerJob(
      { agent: PIX_AGENT, event: failedPixEvent("evt-B") },
      { redis: redis.client, runner },
    );

    expect(first.status).toBe("ran");
    expect(second).toEqual({ status: "suppressed", reason: "cooldown" });
    expect(runner.calls).toBe(1);
  });

  it("a DISTINCT entity is NOT cooled down by another entity's trigger", async () => {
    const redis = fakeRedis();
    const runner = recordingRunner();

    await processTriggerJob(
      { agent: PIX_AGENT, event: failedPixEvent("evt-A", "ord_1") },
      { redis: redis.client, runner },
    );
    const other = await processTriggerJob(
      { agent: PIX_AGENT, event: failedPixEvent("evt-B", "ord_2") },
      { redis: redis.client, runner },
    );

    expect(other.status).toBe("ran");
    expect(runner.calls).toBe(2);
  });
});

describe("processTriggerJob — loop suppression", () => {
  it("drops an event the agent itself caused (causal actor carries the agent: prefix); journals it", async () => {
    const redis = fakeRedis();
    const runner = recordingRunner();
    const journal: TriggerJournalEntry[] = [];
    const event = failedPixEvent("evt-loop");

    const outcome = await processTriggerJob(
      {
        agent: PIX_AGENT,
        event,
        // The agent's OWN remediation re-published payment.status_changed.
        causalActorSessionId: agentSessionId(PIX_AGENT, "ord_456"),
      },
      { redis: redis.client, runner, journal: (e) => journal.push(e) },
    );

    expect(outcome).toEqual({ status: "suppressed", reason: "agent_loop" });
    expect(runner.calls).toBe(0);
    // Nothing claimed in Redis — the synchronous loop check short-circuits first.
    expect(redis.keys()).toEqual([]);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      event: "agent_trigger.bridge",
      agentId: PIX_AGENT.id,
      entity: "order:ord_456",
      outcome: { status: "suppressed", reason: "agent_loop" },
    });
  });

  it("a NON-agent causal actor (a real customer/system sessionId) runs normally", async () => {
    const redis = fakeRedis();
    const runner = recordingRunner();
    const outcome = await processTriggerJob(
      {
        agent: PIX_AGENT,
        event: failedPixEvent("evt-cust"),
        causalActorSessionId: "payment.status_changed:evt-cust", // system-actor shape
      },
      { redis: redis.client, runner },
    );
    expect(outcome.status).toBe("ran");
  });
});

describe("processTriggerJob — host hard caps", () => {
  const shortWallClock: AgentDefinition = AgentDefinitionSchema.parse({
    ...PIX_AGENT,
    budgets: { ...PIX_AGENT.budgets, wallClockMsPerTrigger: 20 },
  });

  it("aborts a turn that exceeds the wall-clock deadline and releases both claims", async () => {
    const redis = fakeRedis();
    let aborted = false;
    // A runner that ignores the deadline and runs for 200ms.
    const slowRunner: TriggerTurnRunner = ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        setTimeout(() => resolve({ decisionKind: "EXECUTE", modelCalls: 1 }), 200);
      });
    const event = failedPixEvent("evt-slow");

    const outcome = await processTriggerJob(
      { agent: shortWallClock, event },
      { redis: redis.client, runner: slowRunner },
    );

    expect(outcome.status).toBe("failed");
    expect((outcome as { error: string }).error).toMatch(/wall-clock cap exceeded/);
    expect(aborted).toBe(true);
    // Both claims released → a redelivery (BullMQ retry) can reprocess.
    expect(redis.keys()).toEqual([]);

    const retry = await processTriggerJob(
      { agent: shortWallClock, event: { ...event } },
      { redis: redis.client, runner: recordingRunner() },
    );
    expect(retry.status).toBe("ran");
  });
});

describe("createModelCallCap", () => {
  function fakeModel(): ModelProvider {
    return {
      async complete() {
        return {
          model: "scripted",
          stopReason: "end_turn",
          text: "ok",
          toolCalls: [],
          inputTokens: 1,
          outputTokens: 1,
        } as Awaited<ReturnType<ModelProvider["complete"]>>;
      },
      stream() {
        throw new Error("not used");
      },
      async embed() {
        return [0.1, 0.2];
      },
    };
  }

  it("allows up to maxCalls completions then throws; embed never counts", async () => {
    const capped = createModelCallCap(fakeModel(), 2);
    const req = { model: "scripted", messages: [{ role: "user" as const, content: "hi" }] };

    await expect(capped.embed("anything")).resolves.toEqual([0.1, 0.2]);
    await expect(capped.complete(req)).resolves.toBeDefined();
    await expect(capped.complete(req)).resolves.toBeDefined();
    expect(capped.calls()).toBe(2);
    await expect(capped.complete(req)).rejects.toThrow(/model-call cap exceeded \(2 per trigger\)/);
    // embed still works after the completion cap is hit.
    await expect(capped.embed("x")).resolves.toEqual([0.1, 0.2]);
  });
});

// Mirror the bridge's internal key shape for the assertion above (kept local so
// the production module need not export an internal helper).
function triggerSeenKey(event: TriggerEvent): string {
  return rk(`agent:trigger:seen:${PIX_AGENT.id}:${triggerExternalId(event)}`);
}
