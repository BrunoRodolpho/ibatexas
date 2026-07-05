/**
 * BKL-118 — the `get_payment_status` read executor (IBATEXAS_READ_TOOL_EXECUTORS)
 * must yield a TYPED empty fact for a session that owns no resolvable order — a
 * GUEST, or an authenticated owner whose call carries no orderId — NEVER the
 * NonRetryableError("Autenticação necessária.") throw the one-hop read-loop turns
 * into an "(indisponível: …)" error blob the planner fabricates a payment status
 * around (same class as BKL-107 / BKL-003).
 *
 * The AUTHENTICATED-owner + orderId path must still delegate to the real
 * checkPaymentStatus (byte-identical), with the IDOR protections intact: a
 * model-forged customerId is stripped, identity is taken from turn state (never
 * model input), and a guest can never reach a foreign order.
 *
 * The @ibatexas/tools barrel is real EXCEPT checkPaymentStatus, which is spied so
 * the delegate branch is asserted without a live Medusa/payment read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CognitiveState } from "@claustrum/core";

const mockCheckPaymentStatus = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return { ...actual, checkPaymentStatus: mockCheckPaymentStatus };
});

const { IBATEXAS_READ_TOOL_EXECUTORS } = await import("../claustrum-bootstrap.js");

const getPaymentStatusExecutor = IBATEXAS_READ_TOOL_EXECUTORS.get_payment_status!;

/** Minimal CognitiveState — a recalled `customerId` marks an authenticated owner;
 *  its absence (or a `guest:` marker) marks a guest, exactly as production. */
function stateWithCustomer(customerId: string | undefined): CognitiveState {
  return {
    perception: {
      text: "meu pagamento caiu?",
      channel: "web",
      receivedAt: "2026-07-04T00:00:00.000Z",
    },
    memory:
      customerId === undefined
        ? {}
        : {
            customerId,
            episodic: [],
            semantic: [],
            procedural: [],
            relational: [],
            assembledAt: "2026-07-04T00:00:00.000Z",
          },
    retrieval: { docs: [], retrievedAt: "2026-07-04T00:00:00.000Z", modelId: "m" },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  } as unknown as CognitiveState;
}

const EMPTY_FACT = { payment: null, reason: "no_payment_for_session" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("get_payment_status executor — BKL-118 typed-empty vs real read", () => {
  it("AUTHENTICATED owner + orderId → delegates to the real checkPaymentStatus (byte-identical); forged customerId stripped; identity from state", async () => {
    const real = {
      hasPayment: true,
      paymentId: "pay_1",
      method: "pix",
      status: "paid",
      statusLabel: "Pago",
    };
    mockCheckPaymentStatus.mockResolvedValue(real);

    // The model forges a foreign customerId in the tool input; the executor must
    // strip it and pass the AUTHENTICATED identity (from state) to the handler.
    const result = await getPaymentStatusExecutor(
      { orderId: "order-1", customerId: "VICTIM" },
      stateWithCustomer("cus_1"),
    );

    // Returned verbatim → the working path is byte-identical to a bare delegate.
    expect(result).toBe(real);
    expect(mockCheckPaymentStatus).toHaveBeenCalledTimes(1);
    const [passedInput, passedCtx] = mockCheckPaymentStatus.mock.calls[0]!;
    // IDOR: the model-forged customerId is stripped from the handler input…
    expect(passedInput).toEqual({ orderId: "order-1" });
    // …and the owner comes from the authenticated turn state, never model input.
    expect((passedCtx as { customerId?: string }).customerId).toBe("cus_1");
  });

  it("GUEST, no orderId (the live defect) → typed empty fact; the real read is NEVER called", async () => {
    const result = await getPaymentStatusExecutor({}, stateWithCustomer(undefined));
    expect(result).toEqual(EMPTY_FACT);
    expect(mockCheckPaymentStatus).not.toHaveBeenCalled();
  });

  it("GUEST + model-forged orderId → typed empty fact; a guest can NEVER reach a foreign order (IDOR)", async () => {
    const result = await getPaymentStatusExecutor(
      { orderId: "someone-elses-order" },
      stateWithCustomer(undefined),
    );
    expect(result).toEqual(EMPTY_FACT);
    expect(mockCheckPaymentStatus).not.toHaveBeenCalled();
  });

  it("a `guest:` marker is unauthenticated → typed empty fact", async () => {
    const result = await getPaymentStatusExecutor({}, stateWithCustomer("guest:abc"));
    expect(result).toEqual(EMPTY_FACT);
    expect(mockCheckPaymentStatus).not.toHaveBeenCalled();
  });

  it("AUTHENTICATED owner but NO orderId → typed empty fact (no auth-error throw); the real read is NEVER called", async () => {
    const result = await getPaymentStatusExecutor({}, stateWithCustomer("cus_1"));
    expect(result).toEqual(EMPTY_FACT);
    expect(mockCheckPaymentStatus).not.toHaveBeenCalled();
  });

  it("an empty/whitespace orderId is not resolvable → typed empty fact", async () => {
    const result = await getPaymentStatusExecutor(
      { orderId: "   " },
      stateWithCustomer("cus_1"),
    );
    expect(result).toEqual(EMPTY_FACT);
    expect(mockCheckPaymentStatus).not.toHaveBeenCalled();
  });
});
