/**
 * The REPO-LOCAL `perResourceKey` SCHEMA WIDENING (inv.18 v2 adoption batch R2-S2).
 *
 * R2-S1 adopted the three PUBLIC FIXED-SUBJECT read types onto `.claim.ts` sources and
 * hit the hard limit it documented: `perResourceKey` — the registry facet that makes a
 * type's ledger keys `:{subject}`-parameterized at select time — has NO field in the
 * PUBLISHED compiler's source schema (`@adjudicate/core` 1.9.0
 * `ClaimDefinitionSource` / `CompiledRegistrySpec`), so 11 of 23 registry types were
 * unreachable. This module is that widening, and it lives ENTIRELY in this repo: the
 * published `compileClaimDefinition` is called UNCHANGED and re-exported around, never
 * forked, patched, or re-implemented.
 *
 * ── WHY A WRAPPER AND NOT A SPREAD AT THE CALL SITE ─────────────────────────────
 *
 * `toRegistrySpec` (the published compiler) is an EXPLICIT field projection: it reads
 * `kind` / `minSourceIntegrity` / `requiredEvidence` / `customerScoped` / the falsifier
 * stance / `valueBinding` and NOTHING else. An unknown field on the source is therefore
 * SILENTLY DROPPED — not rejected. That drop is the whole hazard this slice exists to
 * contain, because a dropped `perResourceKey` is INVISIBLE: `selectCandidateClaim`
 * simply never calls `parameterizeKeysBySubject`, the kernel resolves the BARE
 * `menu:item_price` against a ledger that only holds `menu:item_price:{id}`, the
 * evidence reads ABSENT, and the claim degrades to a perfectly honest UNKNOWN with
 * nothing red anywhere. A `{ ...artifacts.registrySpec, perResourceKey: true }` spread
 * at each generated-file consumption site would work, but it would put the flag back in
 * the HAND-MAINTAINED half — which is precisely what inv.18 v2 exists to remove — and
 * it would be one omission per new type away from that silent degrade. Here the flag is
 * a TYPED, REQUIRED field of the source and a FAIL-CLOSED step of the compile, so a
 * parameterized source that loses its flag cannot compile at all.
 *
 * ── THE TWO WIRE FACTS THE EMITTED SPEC MUST HONOUR (both silent if violated) ────
 *
 * 1. The spec carries the UNSUFFIXED BASE key plus the FLAG — never a pre-suffixed key.
 *    `selectCandidateClaim` → `parameterizeKeysBySubject` (claim-registry.ts) suffixes
 *    `requiredEvidence`, `falsifiers` AND `valueBinding.key` in LOCKSTEP at runtime, so
 *    a source that baked `:{subject}` into its own key would double-suffix and resolve
 *    nothing (and a `valueBinding.key` that drifted out of the requiredEvidence key set
 *    trips the kernel's C6 structural guard).
 * 2. `ownerScopedBaseKey` / `publicPerItemBaseKey` (claim-registry.ts /
 *    classify-only-reads.ts) decide owner-scoping and public-per-item subject
 *    resolution off that BASE key — reading `requiredEvidence[0].key` / the first
 *    `ownershipPolicy: "required"` key directly. They see the spec, not the source, so
 *    the base key IS the contract.
 *
 * The widening is deliberately NARROW: ONE optional boolean facet, projected verbatim.
 * It adds no semantics the runtime did not already have — `perResourceKey` has been a
 * `ClaimSpecBase` field and a `selectCandidateClaim` branch since Wall-2 groundwork;
 * what was missing was only a SOURCE to project it from. Everything else the compiler
 * cannot express (the BKL-270 `dietaryPosture` splice, span GUARD conjunctions,
 * classify-only eligibility, read bindings, the P2 pair table, planner personas) stays
 * hand-written at its own site, unchanged.
 *
 * PURE (no clock/RNG/IO). No kernel-downstream import (SDD §R: adjudicate → claustrum →
 * ibatexas, never backward).
 */

import {
  compileClaimDefinition,
  type ClaimDefinitionSource,
  type CompilableClaimDefinition,
  type CompiledArtifacts,
  type CompiledRegistrySpec,
} from "@adjudicate/core";

/**
 * The widened facet itself: `perResourceKey` is `true`-ONLY, never `false`. A type whose
 * keys are NOT parameterized omits the facet entirely and compiles through the plain
 * `defineClaim` / `compileClaimDefinition` path — exactly as `REGISTRY_SPECS` has always
 * spelled it (STORE_OPEN_NOW / STORE_HOURS / STORE_INFO carry no such property, and
 * `spec.perResourceKey !== true` is how every consumer tests it). Admitting a literal
 * `false` would mint a SECOND spelling for "not parameterized" and put a
 * `"perResourceKey": false` line into a generated spec that no pre-migration row has —
 * a byte-diff for no behaviour.
 */
export interface PerResourceKeyFacet {
  /**
   * This type's reads are recorded under PER-RESOURCE keys (`${baseKey}:{subject}`),
   * so `selectCandidateClaim` parameterizes its evidence/falsifier/value-binding keys
   * by the candidate `subject`. The keys DECLARED here stay UNSUFFIXED bases.
   */
  readonly perResourceKey: true;
}

/**
 * The widened SOURCE shape — the published `ClaimDefinitionSource` (which keeps every
 * illegal-states-unrepresentable lever: the INV-7 `RequiredKeyOf<Self>` value-binding
 * key union, the INV-6 non-empty evidence tuple, the INV-2 discriminated falsifier
 * stance) plus the required facet. `Self`-parameterized for the same reason the
 * published type is: `RequiredKeyOf` must resolve against the def's OWN literal.
 */
export type PerResourceClaimSource<Self = unknown> = ClaimDefinitionSource<Self> &
  PerResourceKeyFacet;

/**
 * The widened AUTHORING entrypoint — the `defineClaim` const-generic builder with the
 * facet folded into its F-bounded constraint, so `perResourceKey: true` is REQUIRED at
 * compile time rather than tolerated as an ignored excess property. Identity at runtime
 * (as `defineClaim` is): it exists purely to mint the per-def types.
 *
 * A parameterized source authored with the PLAIN `defineClaim` would type-check and
 * then compile to a spec with no flag — the silent degrade above. Using this builder is
 * what makes the two travel together.
 */
export function definePerResourceClaim<
  const T extends PerResourceClaimSource<T>,
>(source: T): T {
  return source;
}

/** The registry spec a parameterized source compiles to: the published projection + the facet. */
export type PerResourceRegistrySpec = CompiledRegistrySpec & PerResourceKeyFacet;

/**
 * `CompiledArtifacts` as THIS REPO consumes them: identical to the published bundle
 * except that the registry spec MAY carry the widened facet. Both a plain
 * `compileClaimDefinition` result and a {@link compilePerResourceClaimDefinition}
 * result are assignable, so ONE generated-module emitter serves both kinds of unit —
 * and the emitter's static view of `registrySpec` tells the truth about what it
 * serializes (a `CompiledArtifacts`-typed unit would statically deny the very field the
 * runtime object carries, which is how a widening quietly stops emitting).
 */
export type RepoCompiledArtifacts = Omit<CompiledArtifacts, "registrySpec"> & {
  readonly registrySpec: CompiledRegistrySpec & Partial<PerResourceKeyFacet>;
};

/** The artifacts a parameterized source compiles to (the facet is PRESENT, not optional). */
export type PerResourceCompiledArtifacts = Omit<CompiledArtifacts, "registrySpec"> & {
  readonly registrySpec: PerResourceRegistrySpec;
};

/** The spec field the widened flag is emitted immediately AFTER (see {@link widenRegistrySpec}). */
export const FLAG_ANCHOR_FIELD = "customerScoped";

/**
 * The doc-card line the widening appends. The published compiler's card lists the
 * evidence / falsifier / value-binding keys as authored — which for a parameterized type
 * is NOT what the runtime resolves. A card that says `required evidence:
 * menu:item_price` while the kernel looks up `menu:item_price:{subject}` is a
 * package-local doc asserting a false runtime fact, so the facet travels with it.
 */
export const PER_RESOURCE_DOC_LINE =
  "- **per-resource key**: yes — the keys above are UNSUFFIXED BASES. " +
  "`selectCandidateClaim` → `parameterizeKeysBySubject` suffixes every evidence, " +
  "falsifier and value-binding key with `:{subject}` at select time, matching the " +
  "investigator's per-resource ledger entries.";

/**
 * THE WIDENING ITSELF — re-attach `perResourceKey` to a published registry-spec
 * projection, at a DECLARED position, fail-closed.
 *
 * POSITION IS DELIBERATE, and it is a REVIEW property rather than a behavioural one.
 * The flag is inserted immediately after {@link FLAG_ANCHOR_FIELD}, which is where every
 * hand-written parameterized row already spells it — so the generated row reads like
 * the stanza it replaces and the only key-order delta a runtime spec dump can show for
 * an adopted type stays the ONE R2-S1 already accepted (`dietaryPosture` moving to the
 * end of the spread-then-splice object). Appending the flag instead would add a second,
 * purely cosmetic delta to every future migration's evidence. The insert walks the
 * published projection's OWN entries rather than re-listing its fields, so a future
 * upstream field is carried through untouched and unordered-by-us.
 *
 * FAIL-CLOSED: if the anchor field is absent (an upstream rename), this THROWS rather
 * than emit a spec whose flag landed somewhere unreviewed or — worse — was dropped,
 * which is the §R hard registry-load-error posture the published
 * `compileClaimDefinition` already takes on a structurally-invalid definition.
 * `customerScoped` is non-optional in `CompiledRegistrySpec`, so no source can reach the
 * throw through {@link compilePerResourceClaimDefinition}; this function is exported so
 * the branch is REACHED BY TEST with an anchor-less spec rather than shipped as a
 * guard nothing ever exercises. Pure.
 */
export function widenRegistrySpec(
  spec: CompiledRegistrySpec,
  perResourceKey: true,
  specId = "<unnamed>",
): PerResourceRegistrySpec {
  const widened: Record<string, unknown> = {};
  let anchored = false;
  for (const [field, value] of Object.entries(spec)) {
    widened[field] = value;
    if (field === FLAG_ANCHOR_FIELD) {
      widened.perResourceKey = perResourceKey;
      anchored = true;
    }
  }
  if (!anchored) {
    throw new Error(
      `[per-resource-claim] FAIL-CLOSED: the compiled registry spec for ` +
        `${specId} has no \`${FLAG_ANCHOR_FIELD}\` field to anchor ` +
        `\`perResourceKey\` after, so the widened flag would be emitted in an ` +
        `unreviewed position or dropped entirely (a dropped flag is a SILENT ` +
        `degrade: the runtime never suffixes this type's keys and every candidate ` +
        `resolves ABSENT evidence). Re-anchor the widening against the published ` +
        `@adjudicate/core projection.`,
    );
  }
  return widened as unknown as PerResourceRegistrySpec;
}

/**
 * Compile a PARAMETERIZED source into its runtime image: the PUBLISHED
 * `compileClaimDefinition` verbatim, with the registry spec widened by
 * {@link widenRegistrySpec} and the doc card carrying {@link PER_RESOURCE_DOC_LINE}.
 * Every other artifact (the validator-wiring `ClaimDefinition`, the render template, the
 * closure, the fixtures) is the published projection UNTOUCHED — `perResourceKey` is a
 * REGISTRY-SPEC facet that `selectCandidateClaim` reads, and the generic
 * `ClaimDefinition` the inv.18 validator quantifies over has no field for it.
 *
 * PURE (deterministic; no clock/RNG/IO) but NOT total, exactly like the published
 * compiler it wraps.
 */
export function compilePerResourceClaimDefinition(
  def: CompilableClaimDefinition & PerResourceKeyFacet,
): PerResourceCompiledArtifacts {
  const compiled = compileClaimDefinition(def);
  return {
    ...compiled,
    registrySpec: widenRegistrySpec(
      compiled.registrySpec,
      def.perResourceKey,
      compiled.id,
    ),
    doc: `${compiled.doc.replace(/\n+$/, "")}\n${PER_RESOURCE_DOC_LINE}\n`,
  };
}
