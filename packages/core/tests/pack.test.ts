/**
 * Pack contract — light coverage of `PackV0`, `PackMetadata`, and the
 * runtime metadata sniffer. The type-level conformance check itself is
 * exercised in each Pack package's own test suite (e.g.
 * `packages/pack-payments-pix/tests/pack-conformance.test.ts`).
 */

import { describe, expect, it } from "vitest";
import {
  expectPackV0,
  isPackMetadata,
  type PackV0,
} from "../src/pack.js";
import type { CapabilityPlanner } from "../src/llm/planner.js";
import type { ToolClassification } from "../src/llm/tool-classifier.js";
import type { PolicyBundle } from "../src/kernel/policy.js";

const sampleClassification: ToolClassification = {
  READ_ONLY: new Set(["search"]),
  MUTATING: new Set(["create"]),
};

const samplePolicy: PolicyBundle<"x.create", unknown, { ok: boolean }> = {
  stateGuards: [],
  authGuards: [],
  taint: { minimumFor: () => "UNTRUSTED" },
  business: [],
  default: "REFUSE",
};

const samplePlanner: CapabilityPlanner<{ ok: boolean }> = {
  plan: () => ({
    visibleReadTools: ["search"],
    allowedIntents: ["x.create"],
    forbiddenConcepts: [],
  }),
};

describe("PackV0", () => {
  it("composes policy + planner + tool classification + metadata", () => {
    const pack: PackV0<"x.create", unknown, { ok: boolean }> = {
      metadata: {
        name: "@example/pack-x",
        version: "0.1.0-experimental",
        intentKinds: ["x.create"] as const,
        summary: "A test pack.",
      },
      policyBundle: samplePolicy,
      capabilityPlanner: samplePlanner,
      toolClassification: sampleClassification,
    };
    expect(pack.metadata.name).toBe("@example/pack-x");
    expect(pack.metadata.intentKinds).toContain("x.create");
    expect(pack.policyBundle.default).toBe("REFUSE");
    expect(pack.toolClassification.MUTATING.has("create")).toBe(true);
  });

  it("expectPackV0 is a no-op at runtime (compile-time only)", () => {
    const pack: PackV0<"x.create", unknown, { ok: boolean }> = {
      metadata: {
        name: "@example/pack-x",
        version: "0.1.0-experimental",
        intentKinds: ["x.create"] as const,
        summary: "ok",
      },
      policyBundle: samplePolicy,
      capabilityPlanner: samplePlanner,
      toolClassification: sampleClassification,
    };
    expect(() => expectPackV0(pack)).not.toThrow();
  });
});

describe("isPackMetadata", () => {
  it("accepts a well-formed metadata block", () => {
    expect(
      isPackMetadata({
        name: "@example/pack-x",
        version: "0.1.0",
        intentKinds: ["x.create"],
        summary: "hi",
      }),
    ).toBe(true);
  });

  it("rejects missing fields", () => {
    expect(isPackMetadata({ name: "x", version: "0.1.0" })).toBe(false);
  });

  it("rejects non-string intent kinds", () => {
    expect(
      isPackMetadata({
        name: "x",
        version: "0.1.0",
        intentKinds: [42],
        summary: "hi",
      }),
    ).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isPackMetadata(null)).toBe(false);
    expect(isPackMetadata("not an object")).toBe(false);
    expect(isPackMetadata(undefined)).toBe(false);
  });
});
