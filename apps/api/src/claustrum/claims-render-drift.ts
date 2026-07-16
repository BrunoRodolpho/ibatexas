// claims-render-drift.ts — FE-T16 (FE-3.3): the customer-plane render BOOT GATE,
// promoting BKL-112's unit-test-only proposable-⊇-renderable subset check
// (proposable-renderable-drift.test.ts) into a real fail-closed boot guard —
// mirroring the ops plane's `opsPlaneDriftProblems` (ops-conductor.ts) so a
// future proposable customer read-claim type shipped with NO validated render
// template fails BOOT, not merely CI.
//
// Non-throwing PROBLEMS function (mirrors `opsPlaneDriftProblems` / the chat
// `toolRosterDrift` / `readToolRosterDrift` idiom): returns human-readable
// problem strings, empty = healthy. The composition root (`claims-pipeline.ts`)
// throws when this is non-empty, refusing to boot the claims pipeline.
//
// {@link KNOWN_CUSTOMER_UNRENDERABLE_TYPES} is the SAME deliberate,
// by-design partition `proposable-renderable-drift.test.ts` pins (BKL-112 /
// BKL-123) — single-sourced HERE so the unit test and the boot gate can never
// silently diverge:
//   (i)  MENU_ITEM_ALLERGENS — a `read_claim` with a real answer but no template;
//        decision-gated on a renderer list-slot capability + an owner
//        allergen-liability policy (BKL-123 / FE-3.4). Separate, non-blocking.
//   (ii) PURCHASE_COMPLETED — an `action_claim` whose customer-facing surface is
//        the responder's SUCCESS_CLAIM_CLASSES path, NOT the read-template
//        grammar. DELIBERATELY + PERMANENTLY absent from VALIDATED_TEMPLATES.
//
// PURE (no clock/RNG/IO) — safe to call at boot and from tests.

import { CLAIM_REGISTRY } from "./claim-registry.js";
import { VALIDATED_TEMPLATES } from "./slot-grammar.js";

/**
 * The deliberate, by-design proposable-but-unrenderable gap (BKL-112 / BKL-123)
 * — see the module header. Single source of truth for BOTH the boot gate below
 * and the pre-existing unit-test pin (`proposable-renderable-drift.test.ts`).
 */
export const KNOWN_CUSTOMER_UNRENDERABLE_TYPES: readonly string[] = [
  "MENU_ITEM_ALLERGENS",
  "PURCHASE_COMPLETED",
];

export interface ClaimsRenderDriftInput {
  /** Every claim TYPE the constrained-generation planner may select. Defaults to
   *  the real {@link CLAIM_REGISTRY}; overridable so a test can inject a
   *  synthetic proposable-but-unrenderable type and prove the gate fails closed. */
  readonly proposable?: readonly string[];
  /** Every claim TYPE with a `validated` (asserting) template. Defaults to the
   *  real `Object.keys(VALIDATED_TEMPLATES)`. */
  readonly renderable?: ReadonlySet<string>;
  /** The deliberate, by-design exceptions to advertised-⊆-renderable. Defaults
   *  to {@link KNOWN_CUSTOMER_UNRENDERABLE_TYPES}; overridable for a test. */
  readonly knownUnrenderable?: readonly string[];
}

/**
 * The customer-plane advertised-⊆-renderable boot gate (FE-3.3 / BKL-112
 * promoted). Returns human-readable problems; empty = healthy.
 *
 * TWO independent checks, both defense-in-depth over the SAME two sets:
 *   1. advertised ⊆ renderable — every PROPOSABLE type not in the deliberate
 *      exception list must have a validated template, else a customer read turn
 *      for that type would dead-end in the honest-abstain UNKNOWN with no path
 *      to ever render the fact it validated.
 *   2. renderable ⊆ proposable (no dangling template) — a template keyed to a
 *      type ABSENT from the registry is the dangling-template shape the
 *      ClaimDefinition validator (INV-3, `assertClaimDefinitionRegistryValid`)
 *      already rejects at registry load; this is a second, independent witness
 *      at the SAME render seam (belt and braces — a boot gate should not depend
 *      on a single check to catch a soundness hole).
 */
export function claimsRenderDriftProblems(
  input: ClaimsRenderDriftInput = {},
): string[] {
  const proposable = input.proposable ?? CLAIM_REGISTRY;
  const renderable =
    input.renderable ?? new Set(Object.keys(VALIDATED_TEMPLATES));
  const knownUnrenderable = new Set(
    input.knownUnrenderable ?? KNOWN_CUSTOMER_UNRENDERABLE_TYPES,
  );
  const problems: string[] = [];

  for (const type of proposable) {
    if (renderable.has(type) || knownUnrenderable.has(type)) continue;
    problems.push(
      `customer-advertised claim type "${type}" is proposable (CLAIM_REGISTRY) ` +
        `but has NO validated render template (slot-grammar.ts ` +
        `VALIDATED_TEMPLATES) and is not a declared deliberate exception — a ` +
        `validated read of this type can only ever honest-abstain. Add a ` +
        `template (see BKL-112), or extend KNOWN_CUSTOMER_UNRENDERABLE_TYPES ` +
        `with a linked tracker id if the gap is deliberate (BKL-123 idiom).`,
    );
  }

  const proposableSet = new Set(proposable);
  for (const type of renderable) {
    if (proposableSet.has(type)) continue;
    problems.push(
      `render template "${type}" (slot-grammar.ts VALIDATED_TEMPLATES) has no ` +
        `matching CLAIM_REGISTRY entry — a dangling template with no registered ` +
        `claim type.`,
    );
  }

  return problems;
}
