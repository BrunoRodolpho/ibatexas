// NEW-014 PR2 — fiscal-emitter subscriber contract:
//   1. delivered event → adjudicated emit → provider called → outcome recorded
//      (provider name persisted — the review gate).
//   2. IDEMPOTENCY: a duplicate delivered event (dedup says already-processed)
//      never re-emits.
//   3. TERMINAL: an existing `rejected` record is NEVER auto-retried; `approved`
//      is never re-emitted.
//   4. non-delivered statuses are ignored entirely.
//   5. kernel REFUSE → DLQ + NO provider call + NO record write.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockWithDedup = vi.hoisted(() => vi.fn());
const mockPushToDlq = vi.hoisted(() => vi.fn());
const mockEmitFiscalFromEnvelope = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockFiscalGetByOrderId = vi.hoisted(() => vi.fn());
const mockBeginAttempt = vi.hoisted(() => vi.fn());
const mockRecordOutcome = vi.hoisted(() => vi.fn());
const mockProviderEmit = vi.hoisted(() => vi.fn());
const mockCustomerFindUnique = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent,
}));

vi.mock("@ibatexas/domain", () => ({
  createOrderCommandService: () => ({ emitFiscalFromEnvelope: mockEmitFiscalFromEnvelope }),
  createOrderQueryService: () => ({ getById: mockGetById }),
  createFiscalDocumentService: () => ({
    getByOrderId: mockFiscalGetByOrderId,
    beginAttempt: mockBeginAttempt,
    recordOutcome: mockRecordOutcome,
  }),
  prisma: { customer: { findUnique: mockCustomerFindUnique } },
}));

vi.mock("@ibatexas/tools", () => ({
  createFiscalProvider: () => ({ name: "mock", emit: mockProviderEmit }),
}));

vi.mock("@ibatexas/audit-sink", () => ({
  getAuditSink: () => ({ record: vi.fn() }),
}));

vi.mock("../dedup.js", () => ({ withDedup: mockWithDedup }));
vi.mock("../dlq.js", () => ({ pushToDlq: mockPushToDlq }));

import { startFiscalEmitSubscriber } from "../fiscal-emitter.js";

const PROJECTION = {
  id: "ord-1",
  displayId: 42,
  customerId: "cus-1",
  totalInCentavos: 10100,
  fulfillmentStatus: "delivered",
  itemsJson: [
    { title: "Costela bovina", quantity: 1, priceInCentavos: 8900 },
    { title: "Guaraná", quantity: 2, priceInCentavos: 600 },
  ],
};

async function deliverEvent(newStatus = "delivered"): Promise<void> {
  await startFiscalEmitSubscriber();
  const handler = mockSubscribeNatsEvent.mock.calls[0]![1] as (p: unknown) => Promise<void>;
  await handler({ orderId: "ord-1", displayId: 42, newStatus, previousStatus: "in_delivery" });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: dedup passes the handler through and reports "processed".
  mockWithDedup.mockImplementation(async (_key: string, fn: () => Promise<void>) => {
    await fn();
    return true;
  });
  mockGetById.mockResolvedValue(PROJECTION);
  mockFiscalGetByOrderId.mockResolvedValue(null);
  mockBeginAttempt.mockResolvedValue({ orderId: "ord-1", provider: "mock", attempts: 1, status: "pending" });
  mockRecordOutcome.mockImplementation(async (_orderId: string, o: Record<string, unknown>) => ({
    orderId: "ord-1",
    provider: "mock",
    attempts: 1,
    ...o,
  }));
  mockProviderEmit.mockResolvedValue({
    status: "approved",
    accessKey: "MOCK-00" + "1".repeat(42),
    xmlUrl: "mock://fiscal/x.xml",
    pdfUrl: "mock://fiscal/x.pdf",
  });
  mockCustomerFindUnique.mockResolvedValue({ cpf: "12345678909" });
  // Default: kernel EXECUTEs and runs the executor.
  mockEmitFiscalFromEnvelope.mockImplementation(
    async (_env: unknown, _state: unknown, executor: () => Promise<unknown>) => ({
      decision: { kind: "EXECUTE" },
      result: await executor(),
    }),
  );
});

describe("fiscal-emitter — happy path", () => {
  it("delivered → adjudicated → attempt stamped with the PROVIDER NAME → provider emit → outcome recorded", async () => {
    await deliverEvent();

    expect(mockEmitFiscalFromEnvelope).toHaveBeenCalledTimes(1);
    const [envelope, orderState] = mockEmitFiscalFromEnvelope.mock.calls[0]!;
    expect((envelope as { kind: string }).kind).toBe("order.fiscal.emit");
    expect((envelope as { actor: { principal: string } }).actor.principal).toBe("system");
    expect((orderState as { ctx: Record<string, unknown> }).ctx).toMatchObject({
      fulfillmentStatus: "delivered",
      fiscalEmitAttempts: 0,
    });

    // Gate: provider name persisted on the record.
    expect(mockBeginAttempt).toHaveBeenCalledWith("ord-1", "mock");
    // Emit input mapped from the projection (title→description, centavos intact).
    expect(mockProviderEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "ord-1",
        displayId: 42,
        totalCentavos: 10100,
        customerTaxId: "12345678909",
        items: [
          { description: "Costela bovina", quantity: 1, unitPriceCentavos: 8900 },
          { description: "Guaraná", quantity: 2, unitPriceCentavos: 600 },
        ],
      }),
    );
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      "ord-1",
      expect.objectContaining({ status: "approved" }),
    );
    expect(mockPushToDlq).not.toHaveBeenCalled();
  });

  it("anonymous customer (no CPF) → customerTaxId omitted", async () => {
    mockCustomerFindUnique.mockResolvedValue({ cpf: null });
    await deliverEvent();
    const input = mockProviderEmit.mock.calls[0]![0] as Record<string, unknown>;
    expect("customerTaxId" in input).toBe(false);
  });
});

describe("fiscal-emitter — idempotency + terminal rules", () => {
  it("IDEMPOTENT: a duplicate delivered event (dedup already-processed) never re-emits", async () => {
    mockWithDedup.mockResolvedValue(false); // claim already held — handler NOT run
    await deliverEvent();
    expect(mockEmitFiscalFromEnvelope).not.toHaveBeenCalled();
    expect(mockProviderEmit).not.toHaveBeenCalled();
    expect(mockBeginAttempt).not.toHaveBeenCalled();
  });

  it("TERMINAL rejected: NEVER auto-retried (no adjudication, no provider call)", async () => {
    mockFiscalGetByOrderId.mockResolvedValue({
      orderId: "ord-1", provider: "mock", attempts: 2, status: "rejected",
    });
    await deliverEvent();
    expect(mockEmitFiscalFromEnvelope).not.toHaveBeenCalled();
    expect(mockProviderEmit).not.toHaveBeenCalled();
  });

  it("TERMINAL approved: never re-emitted", async () => {
    mockFiscalGetByOrderId.mockResolvedValue({
      orderId: "ord-1", provider: "mock", attempts: 1, status: "approved",
    });
    await deliverEvent();
    expect(mockEmitFiscalFromEnvelope).not.toHaveBeenCalled();
  });

  it("a retriable prior outcome (timeout) re-adjudicates with the PERSISTED attempts count", async () => {
    mockFiscalGetByOrderId.mockResolvedValue({
      orderId: "ord-1", provider: "mock", attempts: 3, status: "timeout",
    });
    await deliverEvent();
    const [, orderState] = mockEmitFiscalFromEnvelope.mock.calls[0]!;
    expect((orderState as { ctx: { fiscalEmitAttempts: number } }).ctx.fiscalEmitAttempts).toBe(3);
  });
});

describe("fiscal-emitter — gating", () => {
  it("non-delivered statuses are ignored entirely", async () => {
    await deliverEvent("confirmed");
    expect(mockWithDedup).not.toHaveBeenCalled();
    expect(mockEmitFiscalFromEnvelope).not.toHaveBeenCalled();
  });

  it("kernel REFUSE → DLQ, NO provider call, NO record write", async () => {
    mockEmitFiscalFromEnvelope.mockResolvedValue({
      decision: { kind: "REFUSE", refusal: { code: "order.fiscal.not_eligible" } },
    });
    await deliverEvent();
    expect(mockProviderEmit).not.toHaveBeenCalled();
    expect(mockBeginAttempt).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    expect(mockPushToDlq).toHaveBeenCalledWith(
      "order.status_changed",
      expect.anything(),
      expect.stringContaining("order.fiscal.not_eligible"),
      undefined,
    );
  });

  it("a THROWN provider records an honest error outcome (never a silent no-op)", async () => {
    mockProviderEmit.mockRejectedValue(new Error("focusnfe not configured"));
    await expect(deliverEvent()).rejects.toThrow("focusnfe not configured");
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      "ord-1",
      expect.objectContaining({ status: "error", rejectionReason: "focusnfe not configured" }),
    );
  });

  it("missing projection → skip (no adjudication)", async () => {
    mockGetById.mockResolvedValue(null);
    await deliverEvent();
    expect(mockEmitFiscalFromEnvelope).not.toHaveBeenCalled();
  });
});
