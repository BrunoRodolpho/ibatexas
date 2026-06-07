// Regression tests for P1-ERR-WORKERLISTENERS — the "failed" listener half.
//
// pix-expiry-monitor and hesitation-nudge schedule jobs with removeOnFail, so a
// processor failure would otherwise vanish silently (no expiry/nudge, no signal).
// Each worker must attach a "failed" listener that logs + reports to Sentry.
//
// These tests mock ../queue.js so createWorker returns a stub that records the
// listeners the job registers. No Redis, no BullMQ, no network.

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

type Listener = (...args: unknown[]) => void;
// One listener map per worker instance the factory hands out.
const workerListeners = vi.hoisted(() => new Map<string, Listener>());
const mockCreateWorker = vi.hoisted(() =>
  vi.fn(() => ({
    on: vi.fn((event: string, handler: Listener) => {
      workerListeners.set(event, handler);
    }),
    close: vi.fn(),
  })),
);

vi.mock("../queue.js", () => ({
  createQueue: vi.fn(() => ({ add: vi.fn(), close: vi.fn() })),
  createWorker: mockCreateWorker,
}));

vi.mock("@sentry/node", () => ({
  withScope: mockWithScope,
  captureException: mockCaptureException,
}));

vi.mock("../../lib/logger.js", () => ({
  default: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(),
  rk: vi.fn((k: string) => `test:${k}`),
  medusaAdmin: vi.fn(),
}));

vi.mock("../../whatsapp/client.js", () => ({
  sendText: vi.fn(),
}));

import {
  startPixExpiryMonitor,
  stopPixExpiryMonitor,
} from "../pix-expiry-monitor.js";
import {
  startHesitationNudgeWorker,
  stopHesitationNudgeWorker,
} from "../hesitation-nudge.js";

describe("background-job 'failed' listeners (P1-ERR-WORKERLISTENERS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerListeners.clear();
  });

  describe("pix-expiry-monitor", () => {
    it("attaches a 'failed' listener that logs + reports to Sentry without throwing", async () => {
      startPixExpiryMonitor();

      expect(mockCreateWorker).toHaveBeenCalledWith("pix-expiry-monitor", expect.any(Function));
      expect(workerListeners.has("failed")).toBe(true);

      const onFailed = workerListeners.get("failed")!;
      const err = new Error("send failed");
      expect(() => onFailed({ data: { stage: "reminder" } }, err)).not.toThrow();

      expect(mockLoggerError).toHaveBeenCalledTimes(1);
      expect(mockWithScope).toHaveBeenCalled();
      expect(mockSetTag).toHaveBeenCalledWith("job", "pix-expiry-monitor");
      expect(mockSetTag).toHaveBeenCalledWith("source", "background-job");
      expect(mockCaptureException).toHaveBeenCalledWith(err);

      await stopPixExpiryMonitor();
    });
  });

  describe("hesitation-nudge", () => {
    it("attaches a 'failed' listener that logs + reports to Sentry without throwing", async () => {
      startHesitationNudgeWorker();

      expect(mockCreateWorker).toHaveBeenCalledWith("hesitation-nudge", expect.any(Function));
      expect(workerListeners.has("failed")).toBe(true);

      const onFailed = workerListeners.get("failed")!;
      const err = new Error("nudge send failed");
      expect(() => onFailed({ data: {} }, err)).not.toThrow();

      expect(mockLoggerError).toHaveBeenCalledTimes(1);
      expect(mockWithScope).toHaveBeenCalled();
      expect(mockSetTag).toHaveBeenCalledWith("job", "hesitation-nudge");
      expect(mockSetTag).toHaveBeenCalledWith("source", "background-job");
      expect(mockCaptureException).toHaveBeenCalledWith(err);

      await stopHesitationNudgeWorker();
    });
  });
});
