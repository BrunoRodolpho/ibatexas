import { describe, expect, it, vi } from "vitest";
import {
  buildAuditRecord,
  buildEnvelope,
  decisionExecute,
} from "@adjudicate/core";
import {
  createNatsSink,
  NatsSinkError,
  type NatsPublisher,
} from "../src/sink-nats.js";

function record() {
  const env = buildEnvelope({
    kind: "order.tool.propose",
    payload: {},
    actor: { principal: "llm", sessionId: "s" },
    taint: "TRUSTED",
    createdAt: "2026-04-23T12:00:00.000Z",
  });
  return buildAuditRecord({
    envelope: env,
    decision: decisionExecute([]),
    durationMs: 1,
  });
}

describe("NatsSink — burst-failure detection (P0-g)", () => {
  it("resets the counter on success", async () => {
    let attempts = 0;
    const publisher: NatsPublisher = {
      async publish() {
        attempts++;
        if (attempts <= 3) throw new Error("nats down");
      },
    };
    const sink = createNatsSink({ publisher, failureThreshold: 5 });
    // 3 failures
    await expect(sink.emit(record())).rejects.toThrow("nats down");
    await expect(sink.emit(record())).rejects.toThrow("nats down");
    await expect(sink.emit(record())).rejects.toThrow("nats down");
    // Now success — counter resets
    await expect(sink.emit(record())).resolves.toBeUndefined();
    // 4 more failures should NOT trip the threshold (5)
    attempts = 0; // reset for failure cycle
    publisher.publish = async () => {
      throw new Error("again down");
    };
    for (let i = 0; i < 4; i++) {
      await expect(sink.emit(record())).rejects.toThrow("again down");
    }
  });

  it("throws NatsSinkError after N consecutive failures", async () => {
    const publisher: NatsPublisher = {
      async publish() {
        throw new Error("offline");
      },
    };
    const sink = createNatsSink({ publisher, failureThreshold: 3 });
    await expect(sink.emit(record())).rejects.toThrow("offline");
    await expect(sink.emit(record())).rejects.toThrow("offline");
    await expect(sink.emit(record())).rejects.toThrow(NatsSinkError);
  });

  it("invokes onFailure callback on each failure", async () => {
    const onFailure = vi.fn();
    const publisher: NatsPublisher = {
      async publish() {
        throw new Error("oops");
      },
    };
    const sink = createNatsSink({ publisher, onFailure });
    await expect(sink.emit(record())).rejects.toThrow();
    await expect(sink.emit(record())).rejects.toThrow();
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure.mock.calls[0]![0]).toMatchObject({
      subject: "audit.intent.decision.v1",
      errorClass: "Error",
      consecutiveFailures: 1,
    });
    expect(onFailure.mock.calls[1]![0]!.consecutiveFailures).toBe(2);
  });

  it("default threshold is 10", async () => {
    const publisher: NatsPublisher = {
      async publish() {
        throw new Error("oops");
      },
    };
    const sink = createNatsSink({ publisher });
    // 9 failures should still throw the inner error, not NatsSinkError
    for (let i = 0; i < 9; i++) {
      await expect(sink.emit(record())).rejects.not.toThrow(NatsSinkError);
    }
    // 10th failure throws NatsSinkError
    await expect(sink.emit(record())).rejects.toThrow(NatsSinkError);
  });
});
