// Unit tests for the standalone pino logger
// Verifies the logger is a valid pino instance and respects LOG_LEVEL.

import { describe, it, expect, vi, afterEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

// pino returns a logger whose .level is set at creation time.
// We test the exported singleton so we check its shape, not re-instantiate.

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("logger", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it("exports a pino logger instance with standard logging methods", async () => {
    const { logger } = await import("../lib/logger.js");

    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.fatal).toBe("function");
    expect(typeof logger.trace).toBe("function");
  });

  it("exports logger as both named and default export", async () => {
    const mod = await import("../lib/logger.js");

    expect(mod.logger).toBeDefined();
    expect(mod.default).toBeDefined();
    expect(mod.logger).toBe(mod.default);
  });

  it("defaults to 'info' level when LOG_LEVEL is not set", async () => {
    process.env = { ...originalEnv };
    delete process.env.LOG_LEVEL;

    const { logger } = await import("../lib/logger.js");

    expect(logger.level).toBe("info");
  });

  it("respects LOG_LEVEL env var", async () => {
    vi.resetModules();
    process.env = { ...originalEnv, LOG_LEVEL: "warn" };

    const { logger } = await import("../lib/logger.js");

    expect(logger.level).toBe("warn");
  });
});
