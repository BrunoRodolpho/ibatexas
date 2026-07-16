/**
 * claim-definition-registry tests (inv.18 v1 — the APPLIED ClaimDefinition
 * compiler over the REAL ibatexas Trustworthiness-Triad registry).
 *
 * NON-VACUOUS: every test exercises the real assembled `CLAIM_DEFINITIONS` +
 * the real cross-tables (`VALIDATED_TEMPLATES` / `REQUIRED_CLAIM_CLOSURE` /
 * `CLAIM_REGISTRY`) against the LINKED `@adjudicate/core` validator — not a stub.
 *
 * The two load-bearing guarantees:
 *   (a) the real registry PASSES the fail-closed validator (it boots), and
 *   (b) an incomplete/inconsistent registry entry makes registry-load THROW —
 *       so the dangling-template state (a template with no backing
 *       ClaimDefinition, e.g. the deleted ORDER_ESTIMATED_ARRIVAL) is now
 *       mechanically IMPOSSIBLE.
 */
import { describe, expect, it } from "vitest";
import type { ClaimDefinition } from "@adjudicate/core";
import { CLAIM_REGISTRY } from "../claim-registry.js";
import { STORE_OPEN_NOW_DEFINITION } from "../claimdefs/store-open-now.generated.js";
import {
  assertClaimDefinitionRegistryValid,
  CLAIM_DEFINITIONS,
  CLAIM_DEFINITION_CONTEXT,
  validateClaimDefinitionRegistry,
} from "../claim-definition-registry.js";

const TRIAD = [
  "STORE_OPEN_NOW",
  "ORDER_FULFILLMENT_STAGE",
  "PAYMENT_STATUS",
  "RESERVATION_STATUS",
];

// A deep clone of the real definitions, mutable for fault injection.
const cloneDefs = (): Record<string, ClaimDefinition> =>
  structuredClone(CLAIM_DEFINITIONS) as Record<string, ClaimDefinition>;

describe("claim-definition-registry — inv.18 v1 applied validator", () => {
  // ── (a) The real registry is complete + consistent → it BOOTS. ──
  it("the REAL assembled registry passes the fail-closed validator", () => {
    const result = validateClaimDefinitionRegistry();
    expect(result.ok).toBe(true);
  });

  it("assertClaimDefinitionRegistryValid() does NOT throw on the real registry", () => {
    expect(() => assertClaimDefinitionRegistryValid()).not.toThrow();
  });

  it("assembles one ClaimDefinition per CLAIM_REGISTRY member (exhaustive, no extras)", () => {
    expect(Object.keys(CLAIM_DEFINITIONS).sort()).toEqual([...CLAIM_REGISTRY].sort());
    for (const type of CLAIM_REGISTRY) {
      const def = CLAIM_DEFINITIONS[type];
      expect(def.type).toBe(type);
      expect(def.requiredEvidence.length).toBeGreaterThan(0); // INV-6 holds by construction
    }
  });

  it("marks exactly the Triad types as triadScoped (each present in a closure)", () => {
    for (const type of CLAIM_REGISTRY) {
      expect(CLAIM_DEFINITIONS[type].triadScoped).toBe(TRIAD.includes(type));
    }
  });

  // ── (b) An incomplete/inconsistent entry makes registry-load THROW. ──

  it("REJECTS a dangling template — a VALIDATED_TEMPLATES entry with no registered definition (INV-3)", () => {
    // This is the exact ORDER_ESTIMATED_ARRIVAL shape that was deleted: a render
    // template keyed to a type that is NOT in CLAIM_REGISTRY/CLAIM_DEFINITIONS.
    const danglingContext = {
      ...CLAIM_DEFINITION_CONTEXT,
      templates: {
        ...CLAIM_DEFINITION_CONTEXT.templates,
        ORDER_ESTIMATED_ARRIVAL: {
          claimType: "ORDER_ESTIMATED_ARRIVAL",
          posture: "validated",
          slots: [{ kind: "PROPOSITION", claimType: "ORDER_ESTIMATED_ARRIVAL", field: "etaMinutes" }],
        },
      },
    };
    const result = validateClaimDefinitionRegistry(CLAIM_DEFINITIONS, danglingContext);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("TEMPLATE_UNREGISTERED");
    expect(() => assertClaimDefinitionRegistryValid(CLAIM_DEFINITIONS, danglingContext)).toThrow(
      /TEMPLATE_UNREGISTERED/,
    );
  });

  it("REJECTS a definition with empty requiredEvidence (INV-6 / C0 non-vacuity)", () => {
    const defs = cloneDefs();
    (defs.PAYMENT_STATUS as { requiredEvidence: unknown }).requiredEvidence = [];
    const result = validateClaimDefinitionRegistry(defs);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("EMPTY_REQUIRED_EVIDENCE");
    expect(() => assertClaimDefinitionRegistryValid(defs)).toThrow(/EMPTY_REQUIRED_EVIDENCE/);
  });

  it("REJECTS a render-template PROPOSITION slot with no backing value projection (INV-1)", () => {
    const defs = cloneDefs();
    // Keep the render template (with its proposition slot) but strip the backing
    // projection — the slot is now unbacked.
    delete (defs.STORE_OPEN_NOW as { valueProjections?: unknown }).valueProjections;
    const result = validateClaimDefinitionRegistry(defs);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("SLOT_UNBACKED");
    expect(() => assertClaimDefinitionRegistryValid(defs)).toThrow(/SLOT_UNBACKED/);
  });

  it("REJECTS the falsifier lying case — falsifierComplete:true with empty falsifiers (INV-2)", () => {
    const defs = cloneDefs();
    (defs.STORE_OPEN_NOW as { falsifiers: unknown }).falsifiers = [];
    const result = validateClaimDefinitionRegistry(defs);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("FALSIFIER_INCOMPLETE");
    expect(() => assertClaimDefinitionRegistryValid(defs)).toThrow(/FALSIFIER_INCOMPLETE/);
  });

  it("REJECTS a valueBinding.key that is not a member of requiredEvidence keys (INV-7)", () => {
    const defs = cloneDefs();
    (defs.PAYMENT_STATUS as { valueBinding: { key: string } }).valueBinding = {
      key: "not_a_required_key",
    };
    const result = validateClaimDefinitionRegistry(defs);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("BINDING_KEY_UNGATED");
  });

  it("REJECTS an evidence requirement with an absent provenancePolicy (INV-5 default-deny)", () => {
    const defs = cloneDefs();
    delete (defs.STORE_HOURS.requiredEvidence[0] as { provenancePolicy?: unknown })
      .provenancePolicy;
    const result = validateClaimDefinitionRegistry(defs);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("PROVENANCE_DENY");
  });
});

// ── inv.18 v2 — the dead-definition loophole is CLOSED: boot consumes the
//    claimdef-compiler's generated ClaimDefinition VERBATIM (single source of
//    truth) instead of hand-reassembling the same shape from a separately-
//    maintained TRIAD_SCOPED_TYPES. ─────────────────────────────────────────────
describe("claim-definition-registry — boot CONSUMES the generated definition", () => {
  it("CLAIM_DEFINITIONS.STORE_OPEN_NOW IS the generated STORE_OPEN_NOW_DEFINITION (reference identity)", () => {
    // Reference equality (not deep-equal): boot must wire the compiler's OUTPUT
    // object through unchanged. If someone reverts to a hand-reassembly the
    // reference diverges and this fails — the previously-DEAD generated definition
    // is now the exact object the fail-closed validator runs over. This is what
    // makes "sound-by-construction" a MECHANISM again, not a convention that two
    // separately-maintained copies happen to agree.
    expect(CLAIM_DEFINITIONS.STORE_OPEN_NOW).toBe(STORE_OPEN_NOW_DEFINITION);
  });

  it("the consumed definition's triadScoped is source-declared (survives without TRIAD_SCOPED_TYPES)", () => {
    // STORE_OPEN_NOW's triadScoped now comes from its `.claim.ts` source (compiled
    // into STORE_OPEN_NOW_DEFINITION), NOT from the hand-maintained TRIAD_SCOPED_TYPES
    // set — proving the flag can no longer silently drift from the generated shape.
    expect(STORE_OPEN_NOW_DEFINITION.triadScoped).toBe(true);
    expect(CLAIM_DEFINITIONS.STORE_OPEN_NOW.triadScoped).toBe(true);
  });
});
