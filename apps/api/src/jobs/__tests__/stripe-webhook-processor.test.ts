// Unit tests for the Stripe webhook processor (P1-NET-STRIPESYNC).
//
// Covers the durable-async plumbing: enqueue uses jobId=event.id + attempts +
// backoff + completion-trim (failed jobs retained for replay), and the worker
// dispatches job.data through the injected handler dispatch. The handlers
// themselves are covered by stripe-webhook-route.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockQueueAdd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockQueueClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockWorkerClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockWorkerOn = vi.hoisted(() => vi.fn());
const captured = vi.hoisted(
  () => ({ processor: null as null | ((job: unknown) => Promise<void>) }),
);
const mockCreateQueue = vi.hoisted(() =>
  vi.fn(() => ({ add: mockQueueAdd, close: mockQueueClose })),
);
const mockCreateWorker = vi.hoisted(() =>
  vi.fn((_name: string, processor: (job: unknown) => Promise<void>) => {
    captured.processor = processor;
    return { on: mockWorkerOn, close: mockWorkerClose };
  }),
);

vi.mock("../queue.js", () => ({
  createQueue: mockCreateQueue,
  createWorker: mockCreateWorker,
}));

vi.mock("@sentry/node", () => ({
  withScope: vi.fn(),
  captureException: vi.fn(),
}));

function makeEvent(id = "evt_1", type = "payment_intent.succeeded") {
  return { id, type, livemode: false, created: 1, data: { object: {} } };
}

describe("stripe-webhook-processor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules(); // fresh module-level queue/worker singletons per test
    captured.processor = null;
  });

  it("enqueues with jobId=event.id and durable-retry options", async () => {
    const { enqueueStripeWebhookEvent } = await import("../stripe-webhook-processor.js");
    const event = makeEvent("evt_42", "charge.refunded");

    await enqueueStripeWebhookEvent(event as never, 123);

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(name).toBe("charge.refunded");
    expect(data).toEqual({ event, receivedAtMs: 123 });
    // jobId = event.id → BullMQ-level dedup across re-deliveries.
    expect(opts.jobId).toBe("evt_42");
    expect(opts.attempts as number).toBeGreaterThanOrEqual(1);
    expect(opts.backoff).toMatchObject({ type: "exponential" });
    expect(opts.removeOnComplete).toBe(true);
    // removeOnFail intentionally unset → inherits the factory's retention so a
    // permanently-failing money event survives for replay.
    expect(opts.removeOnFail).toBeUndefined();
  });

  it("starts a worker that dispatches job.data through the injected dispatch", async () => {
    const { startStripeWebhookProcessor } = await import("../stripe-webhook-processor.js");
    const dispatch = vi.fn().mockResolvedValue(undefined);

    startStripeWebhookProcessor(dispatch);

    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
    expect(captured.processor).toBeTypeOf("function");
    // A "failed" listener is attached for retained-job observability.
    expect(mockWorkerOn).toHaveBeenCalledWith("failed", expect.any(Function));

    const event = makeEvent("evt_7");
    await captured.processor!({ data: { event, receivedAtMs: 999 } });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toEqual(event);
    expect(dispatch.mock.calls[0][1]).toBe(999);
  });

  it("is idempotent — a second start does not create a second worker", async () => {
    const { startStripeWebhookProcessor } = await import("../stripe-webhook-processor.js");

    startStripeWebhookProcessor(vi.fn());
    startStripeWebhookProcessor(vi.fn());

    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
  });
});
