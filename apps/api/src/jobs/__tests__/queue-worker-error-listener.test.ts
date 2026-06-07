// Regression tests for P1-ERR-WORKERLISTENERS (apps/api/src/jobs/queue.ts).
//
// A BullMQ Worker is an EventEmitter that emits "error" on connection-level
// failures (e.g. a transient Redis hiccup). An UNHANDLED "error" is rethrown by
// Node and caught by the process-level uncaughtException handler in index.ts,
// which calls process.exit(1) — taking down the HTTP server. The worker factory
// must attach a default "error" listener that logs + reports to Sentry and
// NEVER rethrows.
//
// These tests mock the `bullmq` Worker so the REAL createWorker runs (we are
// asserting the factory's behaviour), with no Redis or network.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mockLoggerError = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const mockSetTag = vi.hoisted(() => vi.fn());
const mockWithScope = vi.hoisted(() =>
  vi.fn((cb: (scope: { setTag: typeof mockSetTag; setContext: () => void }) => void) => {
    cb({ setTag: mockSetTag, setContext: vi.fn() });
  }),
);

// Capture the listeners the factory registers on the Worker instance so we can
// invoke the "error" handler directly and assert its behaviour.
type Listener = (...args: unknown[]) => void;
const workerListeners = vi.hoisted(() => new Map<string, Listener>());

vi.mock("bullmq", () => ({
  // Minimal Worker stub: records `.on(event, handler)` registrations.
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn((event: string, handler: Listener) => {
      workerListeners.set(event, handler);
    }),
    close: vi.fn(),
  })),
  Queue: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  withScope: mockWithScope,
  captureException: mockCaptureException,
}));

vi.mock("../../lib/logger.js", () => ({
  default: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
}));

import { createWorker } from "../queue.js";

describe("createWorker — default error listener (P1-ERR-WORKERLISTENERS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerListeners.clear();
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  it("attaches an 'error' listener to every Worker it creates", () => {
    createWorker("test-job", async () => {});
    expect(workerListeners.has("error")).toBe(true);
    expect(typeof workerListeners.get("error")).toBe("function");
  });

  it("the error listener logs and reports to Sentry but does NOT rethrow", () => {
    createWorker("test-job", async () => {});
    const onError = workerListeners.get("error")!;
    const connErr = new Error("Redis connection lost");

    // A transient Redis hiccup must not crash the process.
    expect(() => onError(connErr)).not.toThrow();

    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: connErr, job: "test-job" }),
      expect.any(String),
    );
    expect(mockWithScope).toHaveBeenCalled();
    expect(mockSetTag).toHaveBeenCalledWith("job", "test-job");
    expect(mockSetTag).toHaveBeenCalledWith("source", "background-job");
    expect(mockCaptureException).toHaveBeenCalledWith(connErr);
  });
});
