/**
 * F2 observability — the claims-pipeline KERNEL-FLOOR boot guard.
 *
 * RCA 2026-06-29: with the pipeline ENABLED, a store-open turn silently degraded
 * to UNKNOWN because the runtime resolved the PUBLISHED kernels (@adjudicate/core
 * 1.6.0 + @claustrum/core 0.3.1), which lack the egress-brand surface the
 * Track-A code requires (>=1.7.0 W6 + >=0.3.2 6a render-from-claims). That drop
 * point was invisible. This guard makes it operator-VISIBLE at boot.
 *
 * These tests pin the PURE warning function + the boot-wiring (`buildClaimsSeams`
 * → `warnOnBelowFloorKernel`): it fires ONLY when enabled AND a kernel is below
 * floor, never false-alarms on an unknown/at-floor version, and never throws.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CLAIMS_KERNEL_FLOOR,
  claimsKernelFloorWarnings,
} from "../claims-kernel-floor.js";
import {
  buildClaimsSeams,
  warnOnBelowFloorKernel,
  type BuildClaimsSeamsDeps,
} from "../claims-pipeline.js";
import type { ClaimAwarePlannerPort } from "../ibatexas-planner.js";

const stubPlanner = {
  async propose() {
    return { envelopes: [] };
  },
  async proposeClaims() {
    return { candidates: [], completeness: [], droppedClaimTypes: [] };
  },
} as unknown as ClaimAwarePlannerPort;

const ON = { ENABLE_CLAIMS_PIPELINE: "true" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

describe("claimsKernelFloorWarnings — pure floor check", () => {
  it("warns for each kernel strictly BELOW the floor (the published-kernel state)", () => {
    const warnings = claimsKernelFloorWarnings({
      "@adjudicate/core": "1.6.0",
      "@claustrum/core": "0.3.1",
    });
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("@adjudicate/core@1.6.0 is BELOW");
    expect(warnings.join("\n")).toContain("@claustrum/core@0.3.1 is BELOW");
    expect(warnings.join("\n")).toContain(">=1.7.0");
  });

  it("is SILENT when the linked kernels meet the floor (egress-brand state)", () => {
    expect(
      claimsKernelFloorWarnings({
        "@adjudicate/core": CLAIMS_KERNEL_FLOOR["@adjudicate/core"],
        "@claustrum/core": "0.3.5",
      }),
    ).toEqual([]);
  });

  it("never false-alarms on an UNKNOWN (unresolved) version", () => {
    // Empty resolution ⟹ no warnings (better silent than wrong).
    expect(claimsKernelFloorWarnings({})).toEqual([]);
    // One known-below + one unknown ⟹ exactly one warning.
    expect(
      claimsKernelFloorWarnings({ "@adjudicate/core": "1.6.9" }),
    ).toHaveLength(1);
  });

  it("compares numerically, not lexically (1.10.0 is NOT below 1.7.0)", () => {
    expect(
      claimsKernelFloorWarnings({ "@adjudicate/core": "1.10.0" }),
    ).toEqual([]);
  });

  it("treats an exact-floor version as satisfied (>= floor)", () => {
    expect(
      claimsKernelFloorWarnings({ "@claustrum/core": "0.3.2" }),
    ).toEqual([]);
  });
});

describe("warnOnBelowFloorKernel + buildClaimsSeams — boot wiring", () => {
  function depsWith(over: Partial<BuildClaimsSeamsDeps>): BuildClaimsSeamsDeps {
    return { planner: stubPlanner, ...over };
  }

  it("emits the warning through the injected sink when ENABLED + below floor", () => {
    const warn = vi.fn();
    warnOnBelowFloorKernel(
      depsWith({
        warn,
        resolveKernelVersions: () => ({ "@adjudicate/core": "1.6.0" }),
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("@adjudicate/core@1.6.0 is BELOW");
  });

  it("buildClaimsSeams WARNS at assembly when the flag is ON + a kernel is stale", () => {
    const warn = vi.fn();
    const seams = buildClaimsSeams(
      depsWith({
        env: ON,
        warn,
        resolveKernelVersions: () => ({ "@claustrum/core": "0.3.1" }),
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    // The seams are still assembled (the warning is observability, not a gate).
    expect(seams.claimsRenderer).toBeDefined();
  });

  it("buildClaimsSeams is SILENT when the flag is OFF (byte-identical default boot)", () => {
    const warn = vi.fn();
    const resolveKernelVersions = vi.fn(() => ({ "@adjudicate/core": "1.0.0" }));
    const seams = buildClaimsSeams(depsWith({ env: OFF, warn, resolveKernelVersions }));
    expect(warn).not.toHaveBeenCalled();
    expect(resolveKernelVersions).not.toHaveBeenCalled();
    expect(seams).toEqual({});
  });

  it("never throws when the version resolver itself throws (best-effort)", () => {
    const warn = vi.fn();
    expect(() =>
      warnOnBelowFloorKernel(
        depsWith({
          warn,
          resolveKernelVersions: () => {
            throw new Error("resolve blew up");
          },
        }),
      ),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
