// T3-9 step 1 — managed-agent plane boot wiring (mapper logic + flag-off no-op).
//
// The flag-ON live start() (NATS subscribe + BullMQ worker + Redis pub/sub kill
// pollers) is validated by an operator on the running test stack — not here.
// What IS unit-validated: the event→trigger mapper (eventKind mapping + order→
// customer resolution + drop cases) and that the plane is a strict no-op unless
// IBX_AGENTS_ENABLED=true.

import { describe, expect, it } from "vitest";
import { PIX_REMEDIATION_AGENT } from "@ibatexas/agents";
import {
  agentsEnabled,
  createPixTriggerMapper,
  startManagedAgentPlane,
  type ManagedAgentPlaneDeps,
} from "../claustrum/managed-agent-plane.js";

const ORDER = "ord_456";

describe("createPixTriggerMapper", () => {
  const mapper = createPixTriggerMapper(async (orderId) =>
    orderId === ORDER ? "cus_1" : null,
  );

  it("maps a failed-PIX event to a TriggerJob with the resolved customer + agent: routing", async () => {
    const job = await mapper(PIX_REMEDIATION_AGENT, "payment.status_changed", {
      orderId: ORDER,
      paymentId: "pay_1",
      newStatus: "failed",
      method: "pix",
      timestamp: "2026-06-12T12:00:00.000Z",
    });
    expect(job).not.toBeNull();
    expect(job!.event.entityRef).toEqual({ kind: "order", id: ORDER, customerId: "cus_1" });
    expect(job!.event.kind).toBe("payment.status_changed");
    expect(job!.event.sourceSubject).toBe("ibatexas.payment.status_changed");
    expect(job!.event.eventId).toBe("pay_1:failed");
    expect(job!.event.occurredAt).toBe("2026-06-12T12:00:00.000Z");
  });

  it("qualifies on the agent's eventKinds: expired passes, paid is dropped", async () => {
    const expired = await mapper(PIX_REMEDIATION_AGENT, "payment.status_changed", {
      orderId: ORDER, paymentId: "p", newStatus: "expired",
    });
    expect(expired).not.toBeNull();

    const paid = await mapper(PIX_REMEDIATION_AGENT, "payment.status_changed", {
      orderId: ORDER, paymentId: "p", newStatus: "paid",
    });
    expect(paid).toBeNull(); // payment.paid ∉ {payment.failed, payment.expired}
  });

  it("drops when the customer cannot be resolved or required fields are missing", async () => {
    // Unresolvable order → no routable customer → drop.
    expect(
      await mapper(PIX_REMEDIATION_AGENT, "payment.status_changed", {
        orderId: "ord_unknown", paymentId: "p", newStatus: "failed",
      }),
    ).toBeNull();
    // Missing orderId / newStatus → drop.
    expect(
      await mapper(PIX_REMEDIATION_AGENT, "payment.status_changed", { newStatus: "failed" }),
    ).toBeNull();
    expect(
      await mapper(PIX_REMEDIATION_AGENT, "payment.status_changed", { orderId: ORDER }),
    ).toBeNull();
  });

  it("propagates a causal-actor sessionId for loop suppression", async () => {
    const job = await mapper(PIX_REMEDIATION_AGENT, "payment.status_changed", {
      orderId: ORDER, paymentId: "p", newStatus: "failed",
      causalActorSessionId: "agent:pix-payment-failure-remediation@0.1.0:entity:ord_456",
    });
    expect(job!.causalActorSessionId).toBe(
      "agent:pix-payment-failure-remediation@0.1.0:entity:ord_456",
    );
  });
});

describe("startManagedAgentPlane — opt-in flag", () => {
  it("agentsEnabled reads IBX_AGENTS_ENABLED", () => {
    expect(agentsEnabled({ IBX_AGENTS_ENABLED: "true" })).toBe(true);
    expect(agentsEnabled({ IBX_AGENTS_ENABLED: "false" })).toBe(false);
    expect(agentsEnabled({})).toBe(false);
  });

  it("is a strict no-op (returns null, touches no deps) when the flag is off", async () => {
    // Deps proxy throws if ANY property is read — proves nothing is touched.
    const tripwire = new Proxy(
      {},
      {
        get() {
          throw new Error("deps must not be read when the flag is off");
        },
      },
    ) as ManagedAgentPlaneDeps;
    const plane = await startManagedAgentPlane(tripwire, { IBX_AGENTS_ENABLED: "false" });
    expect(plane).toBeNull();
  });
});
