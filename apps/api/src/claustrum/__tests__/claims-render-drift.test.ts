// claims-render-drift tests (FE-T16 / FE-3.3) — the customer-plane
// advertised-⊆-renderable BOOT gate, mirroring `ops-drift-parity.test.ts`'s
// idiom for `opsPlaneDriftProblems` (dependency-injected `proposable` /
// `renderable` / `knownUnrenderable` overrides, exactly like that suite's
// `renderableReadKeys` override): a real, healthy boot must be GREEN against
// the actual CLAIM_REGISTRY / VALIDATED_TEMPLATES, and an injected
// unrenderable-but-advertised type must fail closed (non-empty problems), which
// `claims-pipeline.ts` `buildClaimsSeams` turns into a boot-time throw.

import { describe, expect, it } from "vitest";
import { CLAIM_REGISTRY } from "../claim-registry.js";
import {
  claimsRenderDriftProblems,
  KNOWN_CUSTOMER_UNRENDERABLE_TYPES,
} from "../claims-render-drift.js";
import { VALIDATED_TEMPLATES } from "../slot-grammar.js";

describe("claimsRenderDriftProblems — the real registry", () => {
  it("is GREEN for the real CLAIM_REGISTRY / VALIDATED_TEMPLATES (no overrides)", () => {
    // No overrides → the real sets. This is the exact check `claims-pipeline.ts`
    // runs at boot; a real gap here means a customer-facing type is stuck
    // honest-abstaining forever with no render path.
    expect(claimsRenderDriftProblems()).toEqual([]);
  });

  it("the deliberate exception list is itself proposable (else the pin is stale)", () => {
    const proposable = new Set<string>(CLAIM_REGISTRY);
    for (const type of KNOWN_CUSTOMER_UNRENDERABLE_TYPES) {
      expect(proposable.has(type), `${type} must be a registered proposable type`).toBe(
        true,
      );
    }
  });
});

describe("claimsRenderDriftProblems — FAILS CLOSED on a deliberately unrenderable-but-advertised type (acceptance criterion 1)", () => {
  it("a synthetic proposable type with NO template and NO declared exception trips the gate", () => {
    const problems = claimsRenderDriftProblems({
      proposable: [...CLAIM_REGISTRY, "SYNTHETIC_UNRENDERABLE_TYPE"],
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("SYNTHETIC_UNRENDERABLE_TYPE");
    expect(problems.join("\n")).toContain("NO validated render template");
  });

  it("the SAME synthetic type is silenced once declared a deliberate exception (extending the pin)", () => {
    // Proves the override mechanism itself: adding the type to the exception list
    // (as an operator would when consciously accepting a new gap) clears the
    // problem — the gate is not accidentally unfalsifiable in the other direction.
    const problems = claimsRenderDriftProblems({
      proposable: [...CLAIM_REGISTRY, "SYNTHETIC_UNRENDERABLE_TYPE"],
      knownUnrenderable: [
        ...KNOWN_CUSTOMER_UNRENDERABLE_TYPES,
        "SYNTHETIC_UNRENDERABLE_TYPE",
      ],
    });
    expect(problems).toEqual([]);
  });

  it("a real template with a REMOVED deliberate exception trips the gate (the pin shrinking without cleanup)", () => {
    // MENU_ITEM_ALLERGENS is genuinely unrenderable today (BKL-123); dropping it
    // from the exception list without giving it a template must fail closed too.
    const problems = claimsRenderDriftProblems({ knownUnrenderable: ["PURCHASE_COMPLETED"] });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("MENU_ITEM_ALLERGENS");
  });

  it("FAILS on a dangling template — a renderable type absent from the registry", () => {
    const dangling = new Set([
      ...Object.keys(VALIDATED_TEMPLATES),
      "DANGLING_TEMPLATE_TYPE",
    ]);
    const problems = claimsRenderDriftProblems({ renderable: dangling });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("DANGLING_TEMPLATE_TYPE");
    expect(problems.join("\n")).toContain("dangling template");
  });
});
