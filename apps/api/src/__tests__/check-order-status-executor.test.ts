/**
 * BKL-107 — the `check_order_status` read executor (IBATEXAS_READ_TOOL_EXECUTORS)
 * must yield a TYPED empty fact for a session that owns no resolvable order — a
 * GUEST, or an authenticated owner with no order to resolve — NEVER a zod
 * schema throw the one-hop read-loop turns into an "(indisponível: …)" error blob
 * the planner fabricates around (live: sessions 10996ec9 + 2d78f587).
 *
 * The AUTHENTICATED-owner + orderId path must still delegate to the real
 * checkOrderStatus (byte-identical), with the IDOR protections intact: a
 * model-forged customerId is stripped, identity is taken from turn state (never
 * model input), and a guest can never reach a foreign order.
 *
 * FE-T13 — `orderId` is now Identity-class and forbidden from this tool's
 * model-facing schema (read-tool-schemas.ts); the one model-facing field is
 * `orderReference`, an optional display-number NL reference ("1234", "#1234").
 * An authenticated owner's call therefore resolves via
 * `resolveCustomerOrderReference` (resolve-and-assemble.ts): an explicit
 * reference wins (IDOR-checked against the caller) else auto-resolve the
 * most-recent order — the pre-FE-T13 "AUTHENTICATED owner but NO orderId"
 * dead end is now the COMMON case, not a corner case. Both resolution
 * outcomes (an order found vs. genuinely none) and both reference states
 * (present vs. absent) are covered below.
 *
 * The @ibatexas/tools barrel is real EXCEPT checkOrderStatus, which is spied so the
 * delegate branch is asserted without a live Medusa read. `resolveCustomerOrderReference`
 * is spied too (resolve-and-assemble.ts's own DB-backed logic is exercised by its
 * own suite, not re-verified here).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CognitiveState } from "@claustrum/core";

const mockCheckOrderStatus = vi.hoisted(() => vi.fn());
const mockResolveCustomerOrderReference = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return { ...actual, checkOrderStatus: mockCheckOrderStatus };
});

vi.mock("../claustrum/resolve-and-assemble.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claustrum/resolve-and-assemble.js")>();
  return { ...actual, resolveCustomerOrderReference: mockResolveCustomerOrderReference };
});

const { IBATEXAS_READ_TOOL_EXECUTORS } = await import("../claustrum-bootstrap.js");

const checkOrderStatusExecutor = IBATEXAS_READ_TOOL_EXECUTORS.check_order_status!;

/** Minimal CognitiveState — a recalled `customerId` marks an authenticated owner;
 *  its absence (or a `guest:` marker) marks a guest, exactly as production. */
function stateWithCustomer(customerId: string | undefined): CognitiveState {
  return {
    perception: {
      text: "cadê meu pedido?",
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

const EMPTY_FACT = { order: null, reason: "no_orders_for_session" };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no resolvable order — individual tests override for the
  // "an order exists to resolve" branch.
  mockResolveCustomerOrderReference.mockResolvedValue({
    orderId: null,
    autoResolved: false,
    referenceMatched: false,
    ambiguous: false,
    candidates: [],
  });
});

describe("check_order_status executor — BKL-107 typed-empty vs real read", () => {
  it("AUTHENTICATED owner + orderId → delegates to the real checkOrderStatus (byte-identical); forged customerId stripped; identity from state", async () => {
    const real = { order: { id: "order-1", customer_id: "cus_1", status: "pending" } };
    mockCheckOrderStatus.mockResolvedValue(real);

    // The model forges a foreign customerId in the tool input; the executor must
    // strip it and pass the AUTHENTICATED identity (from state) to the handler.
    const result = await checkOrderStatusExecutor(
      { orderId: "order-1", customerId: "VICTIM" },
      stateWithCustomer("cus_1"),
    );

    // Returned verbatim → the working path is byte-identical to a bare delegate.
    expect(result).toBe(real);
    expect(mockCheckOrderStatus).toHaveBeenCalledTimes(1);
    const [passedInput, passedCtx] = mockCheckOrderStatus.mock.calls[0]!;
    // IDOR: the model-forged customerId is stripped from the handler input…
    expect(passedInput).toEqual({ orderId: "order-1" });
    // …and the owner comes from the authenticated turn state, never model input.
    expect((passedCtx as { customerId?: string }).customerId).toBe("cus_1");
    // The direct-orderId path never touches the reference resolver.
    expect(mockResolveCustomerOrderReference).not.toHaveBeenCalled();
  });

  it("GUEST, no orderId (the live defect) → typed empty fact; neither the real read nor the resolver runs", async () => {
    const result = await checkOrderStatusExecutor({}, stateWithCustomer(undefined));
    expect(result).toEqual(EMPTY_FACT);
    expect(mockCheckOrderStatus).not.toHaveBeenCalled();
    expect(mockResolveCustomerOrderReference).not.toHaveBeenCalled();
  });

  it("GUEST + model-forged orderId → typed empty fact; a guest can NEVER reach a foreign order (IDOR)", async () => {
    const result = await checkOrderStatusExecutor(
      { orderId: "someone-elses-order" },
      stateWithCustomer(undefined),
    );
    expect(result).toEqual(EMPTY_FACT);
    expect(mockCheckOrderStatus).not.toHaveBeenCalled();
    expect(mockResolveCustomerOrderReference).not.toHaveBeenCalled();
  });

  it("a `guest:` marker is unauthenticated → typed empty fact", async () => {
    const result = await checkOrderStatusExecutor({}, stateWithCustomer("guest:abc"));
    expect(result).toEqual(EMPTY_FACT);
    expect(mockCheckOrderStatus).not.toHaveBeenCalled();
    expect(mockResolveCustomerOrderReference).not.toHaveBeenCalled();
  });

  // FE-T13 — `orderId` is now forbidden from this tool's model-facing schema,
  // so an authenticated owner's call structurally never carries one: this is
  // now the COMMON case, not a dead end. Reference-ABSENT arm: no
  // orderReference given → auto-resolve finds the customer's most-recent
  // order and delegates to the real read with it.
  it("AUTHENTICATED owner, no orderReference, an order TO resolve → auto-resolves and delegates to the real read", async () => {
    mockResolveCustomerOrderReference.mockResolvedValue({
      orderId: "order-recent",
      autoResolved: true,
      referenceMatched: false,
    });
    const real = { order: { id: "order-recent", customer_id: "cus_1", status: "preparing" } };
    mockCheckOrderStatus.mockResolvedValue(real);

    const result = await checkOrderStatusExecutor({}, stateWithCustomer("cus_1"));

    expect(result).toBe(real);
    expect(mockResolveCustomerOrderReference).toHaveBeenCalledTimes(1);
    expect(mockResolveCustomerOrderReference).toHaveBeenCalledWith(undefined, "cus_1");
    expect(mockCheckOrderStatus).toHaveBeenCalledTimes(1);
    expect(mockCheckOrderStatus).toHaveBeenCalledWith(
      { orderId: "order-recent" },
      expect.objectContaining({ customerId: "cus_1" }),
    );
  });

  // Reference-PRESENT arm: the model relays a display-number reference the
  // customer named ("pedido 1234"); the resolver's own IDOR check + match
  // logic is exercised by resolve-and-assemble.ts's own suite — this test
  // only asserts the executor THREADS the reference through unchanged.
  it("AUTHENTICATED owner WITH an orderReference → threads it to resolveCustomerOrderReference and delegates with the matched id", async () => {
    mockResolveCustomerOrderReference.mockResolvedValue({
      orderId: "order-1234",
      autoResolved: false,
      referenceMatched: true,
    });
    const real = { order: { id: "order-1234", customer_id: "cus_1", status: "ready" } };
    mockCheckOrderStatus.mockResolvedValue(real);

    const result = await checkOrderStatusExecutor({ orderReference: "1234" }, stateWithCustomer("cus_1"));

    expect(result).toBe(real);
    expect(mockResolveCustomerOrderReference).toHaveBeenCalledTimes(1);
    expect(mockResolveCustomerOrderReference).toHaveBeenCalledWith("1234", "cus_1");
    expect(mockCheckOrderStatus).toHaveBeenCalledWith(
      { orderId: "order-1234" },
      expect.objectContaining({ customerId: "cus_1" }),
    );
  });

  it("AUTHENTICATED owner, NO order to resolve (with or without a reference) → typed empty fact; the real read is NEVER called", async () => {
    mockResolveCustomerOrderReference.mockResolvedValue({
      orderId: null,
      autoResolved: false,
      referenceMatched: false,
    });
    const result = await checkOrderStatusExecutor({ orderReference: "9999" }, stateWithCustomer("cus_1"));
    expect(result).toEqual(EMPTY_FACT);
    expect(mockResolveCustomerOrderReference).toHaveBeenCalledWith("9999", "cus_1");
    expect(mockCheckOrderStatus).not.toHaveBeenCalled();
  });

  // BKL-140 — ≥2 owned orders matched an ambiguous id-less/date reference: the
  // executor returns a disambiguation-shaped fact (never guesses one) and the real
  // read is NEVER called.
  it("AMBIGUOUS resolution (≥2 orders) → disambiguation-shaped fact; the real read is NEVER called", async () => {
    mockResolveCustomerOrderReference.mockResolvedValue({
      orderId: null,
      autoResolved: false,
      referenceMatched: false,
      ambiguous: true,
      candidates: [
        { orderId: "ord_a", displayId: 11 },
        { orderId: "ord_b", displayId: 12 },
      ],
    });
    const result = await checkOrderStatusExecutor({}, stateWithCustomer("cus_1"));
    expect(result).toEqual({
      order: null,
      reason: "multiple_orders",
      candidates: [
        { orderId: "ord_a", displayId: 11 },
        { orderId: "ord_b", displayId: 12 },
      ],
    });
    expect(mockCheckOrderStatus).not.toHaveBeenCalled();
  });

  it("a blank orderReference is treated as absent (undefined passed to the resolver)", async () => {
    mockResolveCustomerOrderReference.mockResolvedValue({
      orderId: "order-recent",
      autoResolved: true,
      referenceMatched: false,
    });
    mockCheckOrderStatus.mockResolvedValue({ order: { id: "order-recent" } });

    await checkOrderStatusExecutor({ orderReference: "   " }, stateWithCustomer("cus_1"));

    expect(mockResolveCustomerOrderReference).toHaveBeenCalledWith(undefined, "cus_1");
  });

  it("an empty/whitespace orderId is not resolvable → falls through to reference resolution (not a dead end)", async () => {
    mockResolveCustomerOrderReference.mockResolvedValue({
      orderId: "order-recent",
      autoResolved: true,
      referenceMatched: false,
    });
    const real = { order: { id: "order-recent", customer_id: "cus_1", status: "ready" } };
    mockCheckOrderStatus.mockResolvedValue(real);

    const result = await checkOrderStatusExecutor({ orderId: "   " }, stateWithCustomer("cus_1"));

    expect(result).toBe(real);
    expect(mockResolveCustomerOrderReference).toHaveBeenCalledTimes(1);
    expect(mockResolveCustomerOrderReference).toHaveBeenCalledWith(undefined, "cus_1");
  });
});
