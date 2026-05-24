// W6-10 — Logger shim tests.
//
// Pins the resolveLogger() contract: pass `req.log` and the responder
// gets reqId correlation; pass undefined/null and the default
// console-passthrough is used.

import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultLogger, resolveLogger, type IbxLogger } from "../logger.js";

describe("resolveLogger (W6-10 P2-C)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the provided logger when it has warn + error methods", () => {
    const custom: IbxLogger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    expect(resolveLogger(custom)).toBe(custom);
  });

  it("falls back to defaultLogger when provided is undefined", () => {
    expect(resolveLogger(undefined)).toBe(defaultLogger);
  });

  it("falls back to defaultLogger when provided is null", () => {
    expect(resolveLogger(null)).toBe(defaultLogger);
  });

  it("falls back to defaultLogger when provided lacks warn", () => {
    const broken = { error: vi.fn() } as unknown as IbxLogger;
    expect(resolveLogger(broken)).toBe(defaultLogger);
  });

  it("falls back to defaultLogger when provided lacks error", () => {
    const broken = { warn: vi.fn() } as unknown as IbxLogger;
    expect(resolveLogger(broken)).toBe(defaultLogger);
  });

  it("accepts a pino-shaped logger (string-first style)", () => {
    // pino's runtime accepts both `log.warn("msg")` and
    // `log.warn({ ctx }, "msg")`. The shim must work with either form.
    const pinoStyle: IbxLogger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const resolved = resolveLogger(pinoStyle);
    resolved.warn("plain string");
    resolved.warn({ reqId: "abc-123" }, "with reqId");
    expect(pinoStyle.warn).toHaveBeenCalledTimes(2);
    expect(pinoStyle.warn).toHaveBeenCalledWith("plain string");
    expect(pinoStyle.warn).toHaveBeenCalledWith(
      { reqId: "abc-123" },
      "with reqId",
    );
  });
});

describe("defaultLogger console fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes warn to console.warn with [ibx-llm-provider] prefix", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    defaultLogger.warn("test warning");
    expect(spy).toHaveBeenCalledWith("[ibx-llm-provider]", "test warning");
  });

  it("writes error to console.error with [ibx-llm-provider] prefix", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    defaultLogger.error({ err: "boom" }, "operation failed");
    expect(spy).toHaveBeenCalledWith(
      "[ibx-llm-provider]",
      "operation failed",
      { err: "boom" },
    );
  });
});
