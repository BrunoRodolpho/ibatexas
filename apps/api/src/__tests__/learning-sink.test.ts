// learning-sink — ERDS-060 learning.event.v1 channel.
//
// Proves the leaf sink (injected fake NATS + Redis publishers; no real infra):
//   1. publishes each event to BOTH the NATS subject AND the Redis channel;
//   2. the NATS payload is the EXACT LearningEvent contract; Redis gets JSON;
//   3. FAIL-OPEN: a publisher throw on one arm never starves the other and
//      never surfaces to the caller (a turn/decision is never affected);
//   4. an un-wired leaf returns a no-op sink (never throws).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetLearningSink,
  __setLearningSinkDependencies,
  getLearningSink,
  LEARNING_EVENT_CHANNEL,
  LEARNING_EVENT_SUBJECT,
  type LearningEvent,
} from "../learning-sink-bootstrap.js";

const LOG = { warn: vi.fn(), info: vi.fn() };

const EVENT: LearningEvent = {
  schemaVersion: 1,
  at: "2026-06-16T12:00:00.000Z",
  agentId: "pix-payment-failure-remediation",
  sessionId: "agent:pix@1:entity:order_1",
  kind: "agent.turn",
  decisionKind: "EXECUTE",
  detail: { intentKind: "pix.charge.refund", modelCalls: 1 },
};

afterEach(() => {
  __resetLearningSink();
  vi.clearAllMocks();
});

describe("learning sink", () => {
  it("publishes to BOTH the NATS subject and the Redis channel", async () => {
    const natsPublish = vi.fn(async () => {});
    const redisPublish = vi.fn(async () => 1);
    __setLearningSinkDependencies({
      nats: { publish: natsPublish },
      redis: { publish: redisPublish },
      logger: LOG,
    });

    await getLearningSink().recordLearningEvent(EVENT);

    // NATS: short subject (client prefixes ibatexas.) + the EXACT event payload.
    expect(natsPublish).toHaveBeenCalledTimes(1);
    expect(natsPublish).toHaveBeenCalledWith(LEARNING_EVENT_SUBJECT, EVENT);

    // Redis: the live-tail channel, JSON-serialized.
    expect(redisPublish).toHaveBeenCalledTimes(1);
    const [channel, message] = redisPublish.mock.calls[0] as unknown as [string, string];
    expect(channel).toBe(LEARNING_EVENT_CHANNEL);
    expect(JSON.parse(message)).toEqual(EVENT);
  });

  it("fails open: a NATS throw does not block the Redis arm or reject", async () => {
    const natsPublish = vi.fn(async () => {
      throw new Error("nats down");
    });
    const redisPublish = vi.fn(async () => 1);
    __setLearningSinkDependencies({
      nats: { publish: natsPublish },
      redis: { publish: redisPublish },
      logger: LOG,
    });

    await expect(
      getLearningSink().recordLearningEvent(EVENT),
    ).resolves.toBeUndefined();
    expect(redisPublish).toHaveBeenCalledTimes(1);
    expect(LOG.warn).toHaveBeenCalled();
  });

  it("fails open: a Redis throw does not reject", async () => {
    const natsPublish = vi.fn(async () => {});
    const redisPublish = vi.fn(async () => {
      throw new Error("redis down");
    });
    __setLearningSinkDependencies({
      nats: { publish: natsPublish },
      redis: { publish: redisPublish },
      logger: LOG,
    });

    await expect(
      getLearningSink().recordLearningEvent(EVENT),
    ).resolves.toBeUndefined();
    expect(natsPublish).toHaveBeenCalledTimes(1);
  });

  it("skips an absent arm (Redis unreachable at boot)", async () => {
    const natsPublish = vi.fn(async () => {});
    __setLearningSinkDependencies({
      nats: { publish: natsPublish },
      logger: LOG,
    });

    await getLearningSink().recordLearningEvent(EVENT);
    expect(natsPublish).toHaveBeenCalledTimes(1);
  });

  it("an un-wired leaf returns a no-op sink (never throws)", async () => {
    __resetLearningSink();
    await expect(
      getLearningSink().recordLearningEvent(EVENT),
    ).resolves.toBeUndefined();
  });
});
