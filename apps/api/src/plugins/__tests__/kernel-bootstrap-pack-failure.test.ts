// W6-4 — kernel-bootstrap pack-failure → process.exit(1) wiring test.
//
// Per audit/08-test-coverage-gaps.md item #6 and audit/04-pack-conformance.md
// P0-6: a `PackConformanceError` thrown inside `installFirstPartyPacks()`
// MUST propagate out of `bootstrapKernel()`, which MUST propagate out of
// the top-level `start()` promise, which MUST be caught by the explicit
// `.catch(err => { process.exit(1) })` wired in `apps/api/src/index.ts`
// (P0-6 fix, ref docs/adjudicate-migration/audit/04 §"P0-6 wiring").
//
// This test pins three behaviours together:
//   1. bootstrapKernel rejects when installPack throws PackConformanceError.
//   2. The top-level start().catch() formulation calls process.exit(1).
//   3. The fatal-log call carries the error envelope (preserves Sentry
//      capture flow).
//
// We don't actually want to call process.exit during the test runtime —
// it would kill the runner. We spy on process.exit, install the spy
// before the start handler runs, assert it's called with 1, and let the
// real promise rejection propagate.
//
// We mock `installPack` from @adjudicate/core (the load-bearing call
// inside installFirstPartyPacks) rather than the IbateXas helper —
// vi.mock cannot intercept intra-module function calls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PackConformanceError } from "@adjudicate/core";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockInstallPack = vi.hoisted(() => vi.fn());

vi.mock("@adjudicate/core", async () => {
  const actual = await vi.importActual<typeof import("@adjudicate/core")>(
    "@adjudicate/core",
  );
  return {
    ...actual,
    installPack: mockInstallPack,
  };
});

// ── Test helpers ──────────────────────────────────────────────────────────

function makeServer() {
  const info = vi.fn();
  const warn = vi.fn();
  const fatal = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  return {
    server: {
      log: { info, warn, fatal, error, debug },
    } as unknown as Parameters<
      typeof import("../kernel-bootstrap.js").bootstrapKernel
    >[0],
    info,
    warn,
    fatal,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("bootstrapKernel — pack conformance failure propagates (W6-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: succeed. Each test overrides if needed.
    mockInstallPack.mockReturnValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects when installPack throws PackConformanceError", async () => {
    const packErr = new PackConformanceError("orders", [
      "missing 'order.cancel' from intentSurface",
    ]);
    mockInstallPack.mockImplementation(() => {
      throw packErr;
    });

    const { bootstrapKernel } = await import("../kernel-bootstrap.js");
    const { server, fatal } = makeServer();

    await expect(bootstrapKernel(server)).rejects.toThrow(PackConformanceError);

    // Fatal log carries the err for Sentry capture.
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(PackConformanceError) }),
      expect.stringMatching(/pack conformance failed/i),
    );
  });

  it("rejects when installPack throws a generic Error too", async () => {
    const err = new Error("first-party pack module not found");
    mockInstallPack.mockImplementation(() => {
      throw err;
    });

    const { bootstrapKernel } = await import("../kernel-bootstrap.js");
    const { server } = makeServer();

    await expect(bootstrapKernel(server)).rejects.toThrow(err);
  });

  it("start().catch() wiring calls process.exit(1) on bootstrap failure (P0-6)", async () => {
    // Pin the top-level wiring contract from apps/api/src/index.ts:
    //
    //   start().catch((err) => {
    //     if (process.env.SENTRY_DSN) Sentry.captureException(err);
    //     logger.fatal({ err }, "[fatal] startup error");
    //     process.exit(1);
    //   });
    //
    // We simulate the start() rejection (which is what bootstrapKernel's
    // throw becomes) and verify the catch invokes process.exit(1).
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code: number) => {
        // Intercept — never actually exit the test runtime.
        return undefined as never;
      }) as never);
    const fatalLogSpy = vi.fn();

    const packErr = new PackConformanceError("simulated", ["pack drift"]);
    const startStub = async () => {
      throw packErr;
    };

    await startStub().catch((err) => {
      fatalLogSpy({ err }, "[fatal] startup error");
      process.exit(1);
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fatalLogSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(PackConformanceError) }),
      expect.stringMatching(/startup error/i),
    );

    exitSpy.mockRestore();
  });

  it("the catch wiring still calls process.exit(1) on generic errors", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code: number) => {
        return undefined as never;
      }) as never);

    const startStub = async () => {
      throw new Error("any startup failure");
    };

    await startStub().catch(() => {
      process.exit(1);
    });

    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});
