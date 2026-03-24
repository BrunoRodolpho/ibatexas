// Unit tests for the Sentry plugin registration
// Verifies Sentry.init is called when SENTRY_DSN is set and skipped otherwise.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockSentryInit = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const mockAddHook = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());

vi.mock("@sentry/node", () => ({
  init: mockSentryInit,
  captureException: mockCaptureException,
}));

// ── Import source after mocks ───────────────────────────────────────────────

import { registerSentry } from "../plugins/sentry.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildFakeServer() {
  return {
    log: { warn: mockLogWarn },
    addHook: mockAddHook,
  } as unknown as import("fastify").FastifyInstance;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("registerSentry", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("initializes Sentry when SENTRY_DSN is set", async () => {
    process.env.SENTRY_DSN = "https://test-dsn@sentry.io/123";
    process.env.SENTRY_ENVIRONMENT = "production";

    const server = buildFakeServer();
    await registerSentry(server);

    expect(mockSentryInit).toHaveBeenCalledOnce();
    expect(mockSentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://test-dsn@sentry.io/123",
        environment: "production",
        tracesSampleRate: 0.1,
      }),
    );
  });

  it("registers onError hook when SENTRY_DSN is set", async () => {
    process.env.SENTRY_DSN = "https://test-dsn@sentry.io/123";

    const server = buildFakeServer();
    await registerSentry(server);

    expect(mockAddHook).toHaveBeenCalledWith("onError", expect.any(Function));
  });

  it("falls back to APP_ENV when SENTRY_ENVIRONMENT is not set", async () => {
    process.env.SENTRY_DSN = "https://test-dsn@sentry.io/456";
    delete process.env.SENTRY_ENVIRONMENT;
    process.env.APP_ENV = "staging";

    const server = buildFakeServer();
    await registerSentry(server);

    expect(mockSentryInit).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "staging" }),
    );
  });

  it("falls back to 'development' when neither SENTRY_ENVIRONMENT nor APP_ENV is set", async () => {
    process.env.SENTRY_DSN = "https://test-dsn@sentry.io/789";
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.APP_ENV;

    const server = buildFakeServer();
    await registerSentry(server);

    expect(mockSentryInit).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "development" }),
    );
  });

  it("skips initialization when SENTRY_DSN is not set", async () => {
    delete process.env.SENTRY_DSN;

    const server = buildFakeServer();
    await registerSentry(server);

    expect(mockSentryInit).not.toHaveBeenCalled();
    expect(mockAddHook).not.toHaveBeenCalled();
  });

  it("logs a warning when SENTRY_DSN is not set", async () => {
    delete process.env.SENTRY_DSN;

    const server = buildFakeServer();
    await registerSentry(server);

    expect(mockLogWarn).toHaveBeenCalledWith("SENTRY_DSN not set — Sentry disabled");
  });
});
