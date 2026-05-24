// Unit tests for the system-actor-envelope helper — Task 16.

import { describe, it, expect } from "vitest";
import { buildSystemEnvelope } from "../../subscribers/__shared__/system-actor-envelope.js";

describe("buildSystemEnvelope (task 16)", () => {
  it("produces SYSTEM-actor envelope with deterministic nonce + sessionId", () => {
    const envelope = buildSystemEnvelope({
      kind: "order.status.transition",
      payload: { orderId: "order_01", newStatus: "confirmed", actor: "system" },
      sourceSubject: "payment.status_changed",
      eventId: "pay_01:paid",
    });

    expect(envelope.kind).toBe("order.status.transition");
    expect(envelope.actor.principal).toBe("system");
    expect(envelope.actor.sessionId).toBe("payment.status_changed:pay_01:paid");
    expect(envelope.taint).toBe("SYSTEM");
    expect(envelope.nonce).toBe("pay_01:paid");
  });

  it("same eventId produces byte-identical intentHash (replay-safe)", () => {
    const args = {
      kind: "order.status.transition" as const,
      payload: { orderId: "order_01", newStatus: "canceled", actor: "system" as const },
      sourceSubject: "stale-order-checker",
      eventId: "stale:order_01",
    };
    const env1 = buildSystemEnvelope(args);
    const env2 = buildSystemEnvelope(args);

    expect(env1.nonce).toBe(env2.nonce);
    expect(env1.intentHash).toBe(env2.intentHash);
  });

  it("different eventId produces different intentHash", () => {
    const env1 = buildSystemEnvelope({
      kind: "order.status.transition",
      payload: { orderId: "order_01", newStatus: "confirmed", actor: "system" },
      sourceSubject: "payment.status_changed",
      eventId: "pay_01:paid",
    });
    const env2 = buildSystemEnvelope({
      kind: "order.status.transition",
      payload: { orderId: "order_01", newStatus: "confirmed", actor: "system" },
      sourceSubject: "payment.status_changed",
      eventId: "pay_02:paid",
    });

    expect(env1.intentHash).not.toBe(env2.intentHash);
  });
});
