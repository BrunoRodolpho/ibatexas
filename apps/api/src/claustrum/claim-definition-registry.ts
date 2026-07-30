// claim-definition-registry.ts — the inv.18 ClaimDefinition compiler, APPLIED to
// the REAL ibatexas Trustworthiness-Triad registry (Plan 1 / W5b follow-on).
//
// This is the APPLICATION half of the inv.18 v1 slice: the generic, fail-closed
// completeness/consistency VALIDATOR lives in `@adjudicate/core`
// (`validateClaimDefinitions`, registry-agnostic + testable on synthetic
// fixtures); HERE we ASSEMBLE the three today-scattered ibatexas facets —
//
//   - the registry evidence/falsifier/value-binding SPECS (`claim-registry.ts`
//     `REGISTRY_SPECS`, keyed by the closed `CLAIM_REGISTRY` enum),
//   - the render-template slot grammar (`slot-grammar.ts` `VALIDATED_TEMPLATES`),
//   - the decomposition closure (`required-claim-decomposer.ts`
//     `REQUIRED_CLAIM_CLOSURE`),
//
// — into one `Record<type, ClaimDefinition>` and RUN the validator over it
// FAIL-CLOSED at registry load (`assertClaimDefinitionRegistryValid`, called from
// the claims-pipeline boot in `claims-pipeline.ts`). The three previously
// UNENFORCED alignment conventions become ONE mechanism that REJECTS the
// definition set — refusing to boot the claims pipeline — rather than silently
// booting an inconsistent registry:
//
//   (a) every render-template PROPOSITION slot is backed by a value projection
//       bound to a `requiredEvidence` key                        (INV-1 / INV-7)
//   (b) every `falsifierComplete: true` type enumerates falsifiers (INV-2)
//   (c) every VALIDATED_TEMPLATES entry has a registered ClaimDefinition (INV-3)
//       — this is what makes the dangling ORDER_ESTIMATED_ARRIVAL state (a
//       template with no registry row) MECHANICALLY IMPOSSIBLE; that dangling
//       template was deleted in `slot-grammar.ts` so this validator passes clean.
//
// …plus every Triad-scoped type appears in some decomposition closure (INV-4),
// provenance is default-deny (INV-5), C0 non-vacuity (INV-6), and structural
// validity incl. cacheable-requires-ttl (INV-8).
//
// PURE assembly (no clock/RNG/IO); the validator itself is definition-load-time
// only. No kernel-downstream import (SDD §R: adjudicate → claustrum → ibatexas).

import {
  validateClaimDefinitions,
  type ClaimDefinition,
  type RenderTemplate,
  type TemplateSlot as CoreTemplateSlot,
  type ValidationContext,
  type ValidationResult,
  type ValueProjection,
} from "@adjudicate/core";
import {
  CLAIM_REGISTRY,
  REGISTRY_SPECS,
  type RegistryClaimSpec,
  type RegistryClaimType,
} from "./claim-registry.js";
// inv.18 v2 — these ClaimDefinitions are GENERATED from their single `*.claim.ts`
// sources by the claimdef-compiler. Boot CONSUMES them VERBATIM (see
// GENERATED_DEFINITIONS below) as the single source of truth, rather than
// hand-reassembling them — so "sound-by-construction" cannot quietly decay into
// "sound-by-convention" (the EGRESS-finding failure shape). The generated definitions
// are no longer dead: they are the objects the validator actually runs over for these
// types.
import { CART_CONTENTS_DEFINITION } from "./claimdefs/cart-contents.generated.js";
import { CART_EMPTY_DEFINITION } from "./claimdefs/cart-empty.generated.js";
import { MENU_DIETARY_DEFINITION } from "./claimdefs/menu-dietary.generated.js";
import { MENU_ITEM_CONTENTS_DEFINITION } from "./claimdefs/menu-item-contents.generated.js";
import { MENU_ITEM_PRICE_DEFINITION } from "./claimdefs/menu-item-price.generated.js";
import { ORDER_HISTORY_DEFINITION } from "./claimdefs/order-history.generated.js";
import { PAYMENT_HISTORY_DEFINITION } from "./claimdefs/payment-history.generated.js";
import { RESERVATION_STATUS_DEFINITION } from "./claimdefs/reservation-status.generated.js";
import { STORE_HOURS_DEFINITION } from "./claimdefs/store-hours.generated.js";
import { STORE_INFO_DEFINITION } from "./claimdefs/store-info.generated.js";
import { STORE_OPEN_NOW_DEFINITION } from "./claimdefs/store-open-now.generated.js";
import { REQUIRED_CLAIM_CLOSURE } from "./required-claim-decomposer.js";
import { VALIDATED_TEMPLATES } from "./slot-grammar.js";

/**
 * The Trustworthiness-Triad-scoped registry types (the live, owner/override-aware
 * reads the §O#15 decomposer quantifies over — `required-claim-decomposer.ts`
 * scope note). Declared EXPLICITLY (NOT derived from the closure table) so INV-4
 * is a MEANINGFUL check: a Triad type that is absent from every
 * `REQUIRED_CLAIM_CLOSURE` value would be REJECTED (it would be unreachable by
 * the P4 required-set completeness check). The non-Triad public/action types
 * (MENU_ITEM_ALLERGENS, STORE_HOURS, PURCHASE_COMPLETED) are deliberately NOT
 * marked, so INV-4 imposes no closure obligation on them.
 *
 * This set drives `triadScoped` only for the HAND-ASSEMBLED types (see
 * {@link buildClaimDefinition}). STORE_OPEN_NOW and (R2-S4) RESERVATION_STATUS are still
 * listed for documentation + as the fail-safe should their generated consumption ever be
 * removed, but their `triadScoped` flags are now sourced from the generated
 * {@link STORE_OPEN_NOW_DEFINITION} / {@link RESERVATION_STATUS_DEFINITION} (a
 * compile-time constant in each `.claim.ts` source), not from this set.
 */
const TRIAD_SCOPED_TYPES: ReadonlySet<RegistryClaimType> = new Set<RegistryClaimType>([
  "STORE_OPEN_NOW",
  "ORDER_FULFILLMENT_STAGE",
  "PAYMENT_STATUS",
  // R2-S4 — `triadScoped: true` is DECLARED in reservation-status.claim.ts, so this
  // membership is documentation/fail-safe only (the STORE_OPEN_NOW disposition).
  "RESERVATION_STATUS",
  // BKL-139 — CART_CONTENTS is an owner-scoped live read; INV-4 REQUIRES it to appear
  // in some REQUIRED_CLAIM_CLOSURE row (the CART_CONTENTS_Q closure), or boot rejects
  // it as DECOMPOSITION_UNREACHABLE (the FE-T17 gate).
  // BKL-163 — CART_EMPTY is the owner-scoped provable-empty twin; INV-4 satisfied by
  // the same CART_CONTENTS_Q closure row (which requires the complementary pair).
  // R2-S6 — `triadScoped: true` is now DECLARED in cart-contents.claim.ts /
  // cart-empty.claim.ts, so both memberships are documentation/fail-safe only (the
  // STORE_OPEN_NOW / RESERVATION_STATUS / histories disposition). For CART_EMPTY the
  // declared flag is doing MORE work than for any predecessor: it is the half of the
  // SHARED-CLOSURE-ROW agreement that lives on the non-span-owning twin, so INV-4 refuses
  // boot the moment cart-contents.claim.ts's `requires` stops naming CART_EMPTY.
  "CART_CONTENTS",
  "CART_EMPTY",
  // FE-D03 slice C — owner-scoped list reads; INV-4 requires each in a
  // REQUIRED_CLAIM_CLOSURE row (ORDER_HISTORY_Q / PAYMENT_HISTORY_Q).
  // R2-S5 — `triadScoped: true` is now DECLARED in order-history.claim.ts /
  // payment-history.claim.ts, so these two memberships are documentation/fail-safe only
  // (the STORE_OPEN_NOW / RESERVATION_STATUS disposition).
  "ORDER_HISTORY",
  "PAYMENT_HISTORY",
]);

/**
 * The GENERATED ClaimDefinitions the boot fold CONSUMES verbatim — the single
 * source of truth for any type that has a compiled `*.claim.ts` source. A type
 * present here is NEVER hand-reassembled by {@link buildClaimDefinition}; the
 * generated object (checked in-sync with its source by the
 * `claimdefs/__tests__/generated-drift.test.ts` drift guard) is the exact
 * `ClaimDefinition` the fail-closed validator runs over. This closes the
 * dead-definition loophole: the compiler's `STORE_OPEN_NOW_DEFINITION` used to be
 * imported nowhere while boot separately hand-rebuilt the same shape from a
 * separately-maintained `TRIAD_SCOPED_TYPES` — two sources that could silently
 * drift (sound-by-convention). Now there is ONE.
 *
 * `Partial` because only types with a `.claim.ts` source appear; the remaining
 * registry types fall back to {@link buildClaimDefinition} until they too are
 * compiled from source.
 */
const GENERATED_DEFINITIONS: Readonly<
  Partial<Record<RegistryClaimType, ClaimDefinition>>
> = {
  STORE_OPEN_NOW: STORE_OPEN_NOW_DEFINITION,
  // R2-S1 — both are PUBLIC, FIXED-SUBJECT reads (`triadScoped: false` is declared in
  // their sources, so neither carries an INV-4 closure obligation and neither depends on
  // TRIAD_SCOPED_TYPES).
  STORE_HOURS: STORE_HOURS_DEFINITION,
  STORE_INFO: STORE_INFO_DEFINITION,
  // R2-S2 — the first PARAMETERIZED type to compile from source, reached by the
  // repo-local `perResourceKey` widening (claimdefs/per-resource-claim.ts). The facet is
  // deliberately ABSENT from this object: `perResourceKey` is a REGISTRY-SPEC field that
  // `selectCandidateClaim` reads, and the generic `ClaimDefinition` the inv.18 validator
  // quantifies over has no such field — `assembleClaimDefinition` never propagated one
  // either, so consuming the generated definition here is shape-for-shape what boot
  // hand-assembled before. `triadScoped: false` is DECLARED in the source (public
  // per-item reads carry no INV-4 closure obligation).
  MENU_ITEM_PRICE: MENU_ITEM_PRICE_DEFINITION,
  // R2-S3 — the price type's two PUBLIC per-item siblings, on exactly the same footing:
  // the `perResourceKey` facet lives on the REGISTRY SPEC, not here, so what boot consumes
  // for each is the published projection unchanged, shape-for-shape what
  // `assembleClaimDefinition` built before. `triadScoped: false` is DECLARED in both
  // sources.
  MENU_ITEM_CONTENTS: MENU_ITEM_CONTENTS_DEFINITION,
  MENU_DIETARY: MENU_DIETARY_DEFINITION,
  // R2-S4 — the FIRST OWNER-SCOPED type to compile from source, and the first generated
  // definition with `triadScoped: TRUE`. That flag is DECLARED in the source, so this
  // type's INV-4 closure obligation is now discharged by the generated
  // RESERVATION_STATUS_Q row rather than by its membership in TRIAD_SCOPED_TYPES below
  // (which no longer decides anything for it — see that set's note). `perResourceKey`
  // and the per-row `ownershipPolicy` are REGISTRY-SPEC facets that
  // `selectCandidateClaim` / `ownerScopedBaseKey` read, not fields of the generic
  // `ClaimDefinition` the inv.18 validator quantifies over — `assembleClaimDefinition`
  // never propagated either, so what boot consumes here is shape-for-shape what it
  // hand-assembled before.
  RESERVATION_STATUS: RESERVATION_STATUS_DEFINITION,
  // R2-S5 — the HISTORIES pair, the second and third owner-scoped types to compile from
  // source and the second and third generated definitions with `triadScoped: TRUE`. That
  // flag is DECLARED in each source, so each type's INV-4 closure obligation is now
  // discharged by its GENERATED ORDER_HISTORY_Q / PAYMENT_HISTORY_Q row rather than by its
  // membership in TRIAD_SCOPED_TYPES above (which no longer decides anything for either —
  // see that set's note). `perResourceKey` and the per-row `ownershipPolicy` are
  // REGISTRY-SPEC facets that `selectCandidateClaim` / `ownerScopedBaseKey` read, not
  // fields of the generic `ClaimDefinition` the inv.18 validator quantifies over —
  // `assembleClaimDefinition` never propagated either, so what boot consumes here is
  // shape-for-shape what it hand-assembled before.
  ORDER_HISTORY: ORDER_HISTORY_DEFINITION,
  PAYMENT_HISTORY: PAYMENT_HISTORY_DEFINITION,
  // R2-S6 — the CART PRESENCE-COMPLEMENT PAIR, the fourth and fifth owner-scoped types to
  // compile from source and the first pair to SHARE one §O#15 closure row (declared by the
  // span-owning `cart-contents.claim.ts`; the twin declares none — see that file's header).
  // `triadScoped: true` is DECLARED in each source, so each type's INV-4 closure obligation
  // is discharged against the GENERATED CART_CONTENTS_Q row rather than by its membership in
  // TRIAD_SCOPED_TYPES above (which no longer decides anything for either). That is also
  // what makes the pair's AGREEMENT fail-closed here, with no new machinery: the validator
  // this module runs quantifies over BOTH definitions and the one shared row, so a
  // `requires` that stopped naming CART_EMPTY would leave a Triad-scoped type in no closure
  // and {@link assertClaimDefinitionRegistryValid} would THROW. `perResourceKey` and the
  // per-row `ownershipPolicy` are REGISTRY-SPEC facets that `selectCandidateClaim` /
  // `ownerScopedBaseKey` read, not fields of the generic `ClaimDefinition` the inv.18
  // validator quantifies over — `assembleClaimDefinition` never propagated either, so what
  // boot consumes here is shape-for-shape what it hand-assembled before.
  CART_CONTENTS: CART_CONTENTS_DEFINITION,
  CART_EMPTY: CART_EMPTY_DEFINITION,
};

/**
 * Assemble ONE generic `ClaimDefinition` from the scattered ibatexas facets for a
 * single registry type — the FALLBACK path for types that do NOT yet have a
 * compiled `.claim.ts` source in {@link GENERATED_DEFINITIONS}. The render template
 * (if any) is lifted from `VALIDATED_TEMPLATES`; the value projections that back its
 * PROPOSITION slots are derived from the type's `valueBinding` (so each slot's
 * `field` binds to the §5-gated evidence `key` — INV-1/INV-7); falsifiers + the
 * value binding are threaded verbatim from the registry spec. Pure.
 *
 * A type that HAS a generated definition (STORE_OPEN_NOW) is consumed verbatim and
 * never routed through here — see the {@link CLAIM_DEFINITIONS} fold.
 */
function buildClaimDefinition(type: RegistryClaimType): ClaimDefinition {
  // Widen the `as const` literal member to the interface so the OPTIONAL fields
  // (valueBinding / falsifierComplete / falsifiers) are readable on EVERY member
  // (a member that omits them reads `undefined`, not a missing property) — the
  // same widening `selectCandidateClaim` uses in claim-registry.ts.
  const spec: RegistryClaimSpec = REGISTRY_SPECS[type];
  return assembleClaimDefinition({
    type,
    spec,
    template: VALIDATED_TEMPLATES[type],
    triadScoped: TRIAD_SCOPED_TYPES.has(type),
  });
}

/**
 * LE2-012 — the REGISTRY-AGNOSTIC half of {@link buildClaimDefinition}, extracted
 * VERBATIM so a PLANE-SCOPED registry (`apps/api/src/ops/ops-claim-registry.ts`)
 * assembles its `ClaimDefinition`s through the SAME code the customer registry
 * uses and is validated by the SAME fail-closed inv.18 validator. No behaviour
 * change: `buildClaimDefinition` now delegates here with the customer facets.
 * Pure.
 */
export function assembleClaimDefinition(input: {
  readonly type: string;
  readonly spec: RegistryClaimSpec;
  /** The type's `validated` render template, when it has one. */
  readonly template?: { readonly slots: readonly CoreTemplateSlot[] };
  readonly triadScoped: boolean;
}): ClaimDefinition {
  const { spec, template } = input;

  const renderTemplate: RenderTemplate | undefined =
    template === undefined
      ? undefined
      : { slots: template.slots as readonly CoreTemplateSlot[] };

  // Derive a value projection for every PROPOSITION slot in the render template,
  // binding the slot's `field` to the type's value-binding evidence `key` (with
  // its optional projection `path`). Only types that carry BOTH a template and a
  // value binding produce projections — the public/action types carry neither.
  let valueProjections: ValueProjection[] | undefined;
  if (template !== undefined && spec.valueBinding !== undefined) {
    const binding = spec.valueBinding;
    valueProjections = template.slots
      .filter(
        (slot): slot is Extract<typeof slot, { kind: "PROPOSITION" }> =>
          slot.kind === "PROPOSITION",
      )
      .map((slot) => ({
        field: slot.field,
        key: binding.key,
        ...(binding.path === undefined ? {} : { path: binding.path }),
      }));
  }

  return {
    type: input.type,
    kind: spec.kind,
    requiredEvidence: spec.requiredEvidence,
    minSourceIntegrity: spec.minSourceIntegrity,
    triadScoped: input.triadScoped,
    ...(spec.valueBinding === undefined ? {} : { valueBinding: spec.valueBinding }),
    ...(valueProjections === undefined ? {} : { valueProjections }),
    ...(renderTemplate === undefined ? {} : { renderTemplate }),
    ...(spec.falsifierComplete === true
      ? { falsifierComplete: true, falsifiers: spec.falsifiers ?? [] }
      : {}),
  };
}

/**
 * The assembled REAL Triad registry as generic `ClaimDefinition`s, keyed by type.
 * Built once from `CLAIM_REGISTRY` (the `Record` is exhaustive over the closed
 * enum): a type with a compiled source is CONSUMED from {@link GENERATED_DEFINITIONS}
 * verbatim (single source of truth); the rest fall back to hand-assembly via
 * {@link buildClaimDefinition}. Pure data — the fail-closed VALIDATION is a separate
 * call ({@link assertClaimDefinitionRegistryValid}) so this module can be
 * imported (e.g. by tests) without triggering a throw.
 */
export const CLAIM_DEFINITIONS: Readonly<Record<RegistryClaimType, ClaimDefinition>> =
  Object.fromEntries(
    CLAIM_REGISTRY.map(
      (type) =>
        [type, GENERATED_DEFINITIONS[type] ?? buildClaimDefinition(type)] as const,
    ),
  ) as Readonly<Record<RegistryClaimType, ClaimDefinition>>;

/**
 * The cross-tables the SET-level invariants (INV-3 template→registered, INV-4
 * decomposition-closure) quantify over: the real `VALIDATED_TEMPLATES`, the real
 * `REQUIRED_CLAIM_CLOSURE`, and the closed `CLAIM_REGISTRY` enum as the
 * "registered" universe. Exposed so a test can validate the real registry with
 * the real cross-tables, and inject a corrupted one to prove load REJECTS.
 */
export const CLAIM_DEFINITION_CONTEXT: ValidationContext = {
  templates: VALIDATED_TEMPLATES,
  closures: REQUIRED_CLAIM_CLOSURE,
  registryEnum: CLAIM_REGISTRY,
};

/**
 * Run the inv.18 validator over a definition set + cross-tables and return the
 * raw {@link ValidationResult} (no throw). Defaults to the REAL registry; a test
 * passes a mutated set/context to assert the SPECIFIC rejection code. Pure.
 */
export function validateClaimDefinitionRegistry(
  defs: Readonly<Record<string, ClaimDefinition>> = CLAIM_DEFINITIONS,
  context: ValidationContext = CLAIM_DEFINITION_CONTEXT,
): ValidationResult {
  return validateClaimDefinitions(defs, context);
}

/**
 * FAIL-CLOSED registry-load guard (inv.18 v1). Validates the assembled Triad
 * registry against its cross-tables and THROWS on any incomplete/inconsistent
 * definition — refusing to boot the claims pipeline rather than serving an
 * unaligned registry. Called from `claims-pipeline.ts` `buildClaimsSeams` when
 * `ENABLE_CLAIMS_PIPELINE` is ON. Idempotent + pure (no clock/RNG/IO); safe to
 * call repeatedly. The thrown message carries the stable invariant CODE + reason.
 */
export function assertClaimDefinitionRegistryValid(
  defs: Readonly<Record<string, ClaimDefinition>> = CLAIM_DEFINITIONS,
  context: ValidationContext = CLAIM_DEFINITION_CONTEXT,
): void {
  const result = validateClaimDefinitionRegistry(defs, context);
  if (!result.ok) {
    throw new Error(
      `[claim-definition-registry] FAIL-CLOSED: the claim definition registry is ` +
        `incomplete/inconsistent and must not boot the claims pipeline (inv.18 ` +
        `${result.code}): ${result.reason}`,
    );
  }
}
