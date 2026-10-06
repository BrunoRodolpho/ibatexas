// F-21 (class rollout, site 2) — the agent trigger dedup claims cannot be
// released by a non-owner. REAL REDIS.
//
// ── The defect being regressed ───────────────────────────────────────────────
//
// `processTriggerJob` claims two keys before running a managed-agent turn: a
// redelivery claim on the deterministic event carrier (5 min in-flight TTL) and
// a per-entity cooldown claim (the agent's `cooldownSeconds`). If the turn
// THROWS, the catch releases both so a BullMQ retry genuinely reprocesses.
// Before F-21 that release was:
//
//     await deps.redis.del(seenKey);
//     await deps.redis.del(cdKey);
//
// Unconditional. The sequence that breaks it:
//
//   1. Delivery A claims seenKey (+ cooldown) and starts a turn.
//   2. A's in-flight claim lapses.
//   3. Delivery B claims the free carrier and starts its own turn, establishing
//      a fresh cooldown.
//   4. A throws. Its catch DELETES B's live redelivery claim and B's cooldown.
//   5. A third delivery is no longer deduped and no longer cooled — the agent
//      wakes again on the same entity, past the cooldown that bounds how many
//      remediation attempts an entity can draw.
//
// With a per-invocation UUID token and a compare-and-delete, A's release
// matches nothing and B keeps both claims. Hard Rule #10.
//
// ── Why a container and not a double ─────────────────────────────────────────
//
// The property is compare-and-delete ATOMICITY — one indivisible server-side
// step, precisely because another delivery is interleaving. `createInMemoryRedis`
// refuses `eval` for this reason (W4 RULE 3). The unit layer
// (`agent-trigger-bridge.test.ts`) proves the SHAPE against a JS stand-in — the
// release compares the token it claimed with; this file proves the SEMANTICS
// against a real server, driving the PRODUCTION `processTriggerJob` over the
// PRODUCTION `createTriggerDedupRedis` composition.
//
// Enrolled in the M0 loud-skip roll call (`scripts/check-real-redis-suites.mjs`).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AGENT_REGISTRY, type AgentDefinition } from "@ibatexas/agents";
import { rk } from "@ibatexas/tools";
import {
  processTriggerJob,
  type TriggerDedupRedis,
  type TriggerTurnRunner,
} from "../claustrum/agent-trigger-bridge.js";
import { createTriggerDedupRedis } from "../claustrum/trigger-dedup-redis.js";
import {
  triggerExternalId,
  type TriggerEvent,
} from "../claustrum/system-channel.js";
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js";

const PIX_AGENT = AGENT_REGISTRY.find(
  (a) => a.id === "pix-payment-failure-remediation",
) as AgentDefinition;

function failedPixEvent(eventId: string, orderId = "ord_f21"): TriggerEvent {
  return {
    sourceSubject: "ibatexas.payment.status_changed",
    eventId,
    kind: "payment.status_changed",
    payload: { paymentId: "pay_1", orderId, newStatus: "failed", method: "pix" },
    entityRef: { kind: "order", id: orderId, customerId: "cus_f21" },
    occurredAt: "2026-08-04T12:00:00.000Z",
  };
}

/** A runner that always throws — the only path that reaches the catch release. */
const throwingRunner: TriggerTurnRunner = async () => {
  throw new Error("turn blew up");
};

/** A runner that always reaches EXECUTE. */
const okRunner: TriggerTurnRunner = async () => ({
  decisionKind: "EXECUTE",
  modelCalls: 1,
});

describe.skipIf(!RUN_REAL_REDIS)(
  "F-21 agent trigger dedup claim ownership (real Redis)",
  () => {
    let harness: RedisTestHarness;
    let redis: TriggerDedupRedis;
    let seenKey: string;
    let cdKey: string;
    const event = failedPixEvent("evt-f21");

    beforeAll(async () => {
      harness = await setupRedisTestContainer();
      process.env.APP_ENV = "test";
      // The PRODUCTION composition root, over the container client. This is the
      // seam F-21 fixed: it used to be `deps.redis as unknown as
      // TriggerDedupRedis` over an object that had no `eval` at all.
      redis = createTriggerDedupRedis(
        harness.client as unknown as Parameters<typeof createTriggerDedupRedis>[0],
      );
      seenKey = rk(`agent:trigger:seen:${PIX_AGENT.id}:${triggerExternalId(event)}`);
      cdKey = rk(
        `agent:trigger:cooldown:${PIX_AGENT.id}:${event.entityRef.kind}:${event.entityRef.id}`,
      );
    }, 90_000);

    afterAll(async () => {
      await harness?.teardown();
    });

    beforeEach(async () => {
      await harness.client.flushAll();
    });

    // ── (i) OWNED → deleted ─────────────────────────────────────────────────

    it("a throwing turn releases BOTH of its OWN claims (a retry reprocesses)", async () => {
      const outcome = await processTriggerJob(
        { agent: PIX_AGENT, event },
        { redis, runner: throwingRunner, journal: () => {} },
      );

      expect(outcome.status).toBe("failed");
      // Both claims really gone from the keyspace — not "a method was called".
      expect(await harness.client.get(seenKey)).toBeNull();
      expect(await harness.client.get(cdKey)).toBeNull();

      // …which is the point: the BullMQ retry genuinely reprocesses.
      const retry = await processTriggerJob(
        { agent: PIX_AGENT, event: { ...event } },
        { redis, runner: okRunner, journal: () => {} },
      );
      expect(retry.status).toBe("ran");
    });

    // ── (ii) LAPSED + FOREIGN → left alone ──────────────────────────────────

    it("a throwing turn does NOT release a FOREIGN claim after its own lapsed", async () => {
      // Delivery A claims and begins a turn that will throw. Rather than
      // orchestrate two real concurrent invocations (the throw is synchronous
      // once the runner rejects), the interleaving is reproduced exactly as the
      // production code would see it: A's claims are replaced in the keyspace
      // by ANOTHER owner's tokens before A's catch runs.
      //
      // A slow runner gives us the window to do that mid-turn, so the
      // substitution happens while A is genuinely in flight.
      const foreignSeen = "foreign-delivery-B-seen-token";
      const foreignCd = "foreign-delivery-B-cooldown-token";

      const slowThrowingRunner: TriggerTurnRunner = async () => {
        // A's claims lapse …
        await harness.client.del(seenKey);
        await harness.client.del(cdKey);
        // … and delivery B claims the free carrier + a fresh cooldown.
        await harness.client.set(seenKey, foreignSeen, { EX: 300 });
        await harness.client.set(cdKey, foreignCd, { EX: 900 });
        throw new Error("turn blew up after the carrier changed hands");
      };

      const outcome = await processTriggerJob(
        { agent: PIX_AGENT, event },
        { redis, runner: slowThrowingRunner, journal: () => {} },
      );
      expect(outcome.status).toBe("failed");

      // THE DEFECT WOULD FIRE IN THAT CATCH. B's claims are untouched.
      expect(await harness.client.get(seenKey)).toBe(foreignSeen);
      expect(await harness.client.get(cdKey)).toBe(foreignCd);

      // …so B is still deduped and still cooled: a third delivery of the same
      // event is suppressed rather than waking the agent again.
      const third = await processTriggerJob(
        { agent: PIX_AGENT, event: { ...event } },
        { redis, runner: okRunner, journal: () => {} },
      );
      expect(third).toEqual({ status: "suppressed", reason: "redelivery" });
    });

    // ── (iii) The claims carry tokens, not the constant "1" ─────────────────

    it("both in-flight claims carry a UUID token, never the constant \"1\"", async () => {
      const held: { seen: string | null; cd: string | null } = {
        seen: null,
        cd: null,
      };
      const inspectingRunner: TriggerTurnRunner = async () => {
        held.seen = await harness.client.get(seenKey);
        held.cd = await harness.client.get(cdKey);
        return { decisionKind: "EXECUTE", modelCalls: 1 };
      };

      await processTriggerJob(
        { agent: PIX_AGENT, event },
        { redis, runner: inspectingRunner, journal: () => {} },
      );

      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(held.seen).not.toBe("1");
      expect(held.cd).not.toBe("1");
      expect(held.seen).toMatch(uuid);
      expect(held.cd).toMatch(uuid);
      // One token covers both claims — acquired and released together by the
      // same invocation (see the comment at the claim site).
      expect(held.seen).toBe(held.cd);
    });

    // ── (iv) The PROMOTE stays ownership-blind, and that is correct ─────────

    it("a CONFIRMED turn promotes the seen-key to the terminal marker with the 7-day window", async () => {
      const outcome = await processTriggerJob(
        { agent: PIX_AGENT, event },
        { redis, runner: okRunner, journal: () => {} },
      );
      expect(outcome.status).toBe("ran");

      // The decided marker is a CONSTANT, deliberately: a decided event is
      // terminal and owned by nobody, so nothing may release it. See the
      // PROMOTE-OVERWRITE block in agent-trigger-bridge.ts.
      expect(await harness.client.get(seenKey)).toBe("1");

      // BOUNDED, not exact-equality — the TTL decays between SET and read
      // (#517). 7 days = 604800s.
      const ttl = await harness.client.ttl(seenKey);
      expect(ttl).toBeGreaterThan(604_800 - 60);
      expect(ttl).toBeLessThanOrEqual(604_800);
    });

    // ── (v) CONTROL: the pre-F-21 release DOES destroy the foreign claims ───
    //
    // Without this, case (ii) could pass for the wrong reason — e.g. if the
    // catch never ran at all. This reproduces the IDENTICAL end state and swaps
    // ONLY the release mechanism for the one the fix removed. It MUST show the
    // damage.

    it("control — the pre-F-21 unconditional DEL in the same end state DOES destroy them", async () => {
      const foreignSeen = "foreign-delivery-B-seen-token";
      const foreignCd = "foreign-delivery-B-cooldown-token";
      await harness.client.set(seenKey, foreignSeen, { EX: 300 });
      await harness.client.set(cdKey, foreignCd, { EX: 900 });

      // The pre-F-21 release, verbatim: `del(seenKey); del(cdKey)`.
      await harness.client.del(seenKey);
      await harness.client.del(cdKey);

      expect(await harness.client.get(seenKey)).toBeNull();
      expect(await harness.client.get(cdKey)).toBeNull();

      // B is no longer deduped and no longer cooled: the next delivery RUNS,
      // waking the agent a second time on the same entity.
      const third = await processTriggerJob(
        { agent: PIX_AGENT, event: { ...event } },
        { redis, runner: okRunner, journal: () => {} },
      );
      expect(third.status).toBe("ran");
    });

    // ── (vi) compareAndDelete's own semantics, through the production factory ─

    it("compareAndDelete deletes on a token match and returns 1", async () => {
      await harness.client.set(seenKey, "tok-a", { EX: 300 });
      expect(await redis.compareAndDelete(seenKey, "tok-a")).toBe(1);
      expect(await harness.client.get(seenKey)).toBeNull();
    });

    it("compareAndDelete leaves the key and returns 0 on a token mismatch", async () => {
      await harness.client.set(seenKey, "tok-b", { EX: 300 });
      expect(await redis.compareAndDelete(seenKey, "tok-a")).toBe(0);
      expect(await harness.client.get(seenKey)).toBe("tok-b");
    });

    it("compareAndDelete elects exactly one winner under a 40-way race", async () => {
      await harness.client.set(seenKey, "tok-race", { EX: 300 });

      const results = await Promise.all(
        Array.from({ length: 40 }, () =>
          redis.compareAndDelete(seenKey, "tok-race"),
        ),
      );

      // Atomicity: the compare and the delete are ONE server-side step, so
      // exactly one caller observes the match. A JS-side get-then-del would let
      // several read "tok-race" before any deleted.
      expect(results.filter((r) => r === 1)).toHaveLength(1);
      expect(results.filter((r) => r === 0)).toHaveLength(39);
      expect(await harness.client.get(seenKey)).toBeNull();
    });
  },
);
