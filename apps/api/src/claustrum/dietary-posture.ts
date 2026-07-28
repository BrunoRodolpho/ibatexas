// BKL-270 — the DIETARY-POSTURE gate and its read-side enforcement index.
//
// The owner ruled (2026-07-27, Option C) that every READ claim spec must DECLARE
// what it does when the customer names a dietary restriction, and that an
// undeclared read family must not be able to boot. The declaration itself lives on
// `RegistryClaimSpec` (claim-registry.ts `dietaryPosture`); this module holds the
// two things that make the declaration MEAN something at runtime:
//
//   1. {@link assertDietaryPostureDeclared} — the fail-closed boot gate.
//   2. {@link buildDietarySuppressionIndex} — the evidence-KEY index the
//      investigator consumes to enforce an `abstain` on the READ.
//
// # Why a sibling gate rather than a check inside assertClaimDefinitionRegistryValid
//
// The ruling named the existing gate. That gate cannot host this check, for a
// structural reason worth recording because it is not obvious:
// `assertClaimDefinitionRegistryValid` validates `CLAIM_DEFINITIONS` — a table of
// `ClaimDefinition` objects whose TYPE is declared in the PUBLISHED
// `@adjudicate/core` package — and `assembleClaimDefinition` is a LOSSY projection
// that already drops `customerScoped` and `perResourceKey` because
// `ClaimDefinition` has no counterpart for them. A new spec field would be dropped
// exactly the same way and the gate would never see it. Teaching the vendored type
// about `dietaryPosture` would be a cross-repo release for no benefit.
//
// So the check is a SIBLING, called immediately beside it at the same boot site
// (`claims-pipeline.ts` `buildClaimsSeams`) — which is not an invention but the
// established local pattern: `claimsRenderDriftProblems()` already sits a few lines
// below as exactly this kind of in-repo fail-closed companion. Same boot path, same
// uncaught throw, same refuse-to-boot semantics.
//
// # Why the enforcement index is keyed by EVIDENCE KEY
//
// A `TurnRead` (ibatexas-investigator.ts) carries an evidence KEY and no claim
// type, and no reverse index exists anywhere in the repo. Enforcement therefore has
// to go key-side. That is sound only because of two properties the boot gate PINS
// rather than assumes:
//
//   · shared-key posture AGREEMENT — if two read types shared a `requiredEvidence`
//     key while declaring different postures, suppressing that key would silently
//     over- or under-apply. (Today exactly one key is shared: `schedule:store_hours`
//     serves STORE_HOURS and STORE_HOURS_FOR_DATE, and both declare `answer-anyway`.)
//   · required/falsifier DISJOINTNESS — suppressing a key that some type uses as a
//     FALSIFIER would make that claim MORE likely to validate, turning a safety
//     abstain into a soundness hole. (Today the two key sets do not intersect at
//     all.) This is the one clause whose violation would be actively dangerous
//     rather than merely wrong, which is why it fails the BOOT and not a lint.
//
// Both hold on today's registry, both are checked every boot, and neither can be
// broken silently by a future author.
//
// Pure: no clock, no RNG, no IO.

import {
  CUSTOMER_CLAIM_SCOPE,
  type ClaimPlaneScope,
  type DietaryPosture,
  type ReadClaimSpec,
} from "./claim-registry.js";

/** The legal posture values, as a runtime set (the type is compile-time only). */
const LEGAL_POSTURES: ReadonlySet<string> = new Set<DietaryPosture>([
  "abstain",
  "answer-anyway",
  "answer-with-abstention",
]);

/**
 * Is this spec a READ spec? THE predicate the whole gate quantifies over.
 *
 * Deliberately `kind === "read_claim"` and nothing else: `kind` is a closed
 * two-member discriminant that every spec declares, so the predicate is TOTAL —
 * there is no spec it cannot classify, and therefore no spec that can slip past the
 * gate by being neither. An action claim is exempt because the posture answers
 * "what do we do when someone asks this READ with a dietary qualifier", and an
 * action is not a read.
 */
export function isReadClaimSpec(spec: {
  readonly kind: "read_claim" | "action_claim";
}): spec is ReadClaimSpec {
  return spec.kind === "read_claim";
}

/** Every `[type, spec]` pair in `scope` whose spec is a read spec. */
function readSpecsOf(scope: ClaimPlaneScope): Array<[string, ReadClaimSpec]> {
  const out: Array<[string, ReadClaimSpec]> = [];
  for (const type of scope.types) {
    const spec = scope.specs[type];
    if (spec !== undefined && isReadClaimSpec(spec)) out.push([type, spec]);
  }
  return out;
}

/**
 * BKL-270 — the fail-closed boot gate. Throws (uncaught, aborting boot) unless
 * every read spec in `scope` declares a legal `dietaryPosture`, the check actually
 * RAN over all of them, and the two key-side soundness properties hold.
 *
 * `label` names the plane in the error so an ops-side failure is not mistaken for a
 * customer-side one.
 */
export function assertDietaryPostureDeclared(
  scope: ClaimPlaneScope = CUSTOMER_CLAIM_SCOPE,
  label = "customer",
): void {
  const reads = readSpecsOf(scope);

  // ── 1. DECLARED ────────────────────────────────────────────────────────────
  for (const [type, spec] of reads) {
    const posture: unknown = spec.dietaryPosture;
    if (typeof posture !== "string" || !LEGAL_POSTURES.has(posture)) {
      throw new Error(
        `[${label} claim registry] read claim "${type}" declares no legal dietaryPosture ` +
          `(got ${JSON.stringify(posture)}; expected one of ` +
          `${[...LEGAL_POSTURES].map((p) => `"${p}"`).join(" | ")}). BKL-270: every read ` +
          `family must state what it does when a customer names a dietary restriction.`,
      );
    }
  }

  // ── 2. NON-VACUITY ─────────────────────────────────────────────────────────
  // Not ceremony. A gate that iterates nothing passes green forever, and this repo
  // has already paid for that class once (the sampling-gate blind spot: a
  // conformance suite reported 72/72 while probing an empty state). If the loop
  // above visited fewer read specs than the scope actually contains, the gate did
  // not do its job and must say so rather than return quietly.
  const declaredReadCount = Object.values(scope.specs).filter((s) =>
    isReadClaimSpec(s),
  ).length;
  if (reads.length !== declaredReadCount) {
    throw new Error(
      `[${label} claim registry] dietaryPosture gate inspected ${reads.length} read ` +
        `spec(s) but the scope declares ${declaredReadCount}. The gate is not covering ` +
        `the registry it claims to cover (a type in \`specs\` is missing from \`types\`, ` +
        `or vice versa) — BKL-270 non-vacuity clause.`,
    );
  }
  if (reads.length === 0) {
    throw new Error(
      `[${label} claim registry] dietaryPosture gate found ZERO read specs. An empty ` +
        `registry is never correct here, and a vacuously-passing safety gate is worse ` +
        `than an absent one — BKL-270 non-vacuity clause.`,
    );
  }

  // ── 3. SHARED-KEY POSTURE AGREEMENT ────────────────────────────────────────
  const posturesByKey = new Map<string, Map<string, DietaryPosture>>();
  for (const [type, spec] of reads) {
    for (const evidence of spec.requiredEvidence) {
      const byType = posturesByKey.get(evidence.key) ?? new Map<string, DietaryPosture>();
      byType.set(type, spec.dietaryPosture);
      posturesByKey.set(evidence.key, byType);
    }
  }
  for (const [key, byType] of posturesByKey) {
    const distinct = new Set(byType.values());
    if (distinct.size > 1) {
      const detail = [...byType]
        .map(([type, posture]) => `${type}=${posture}`)
        .join(", ");
      throw new Error(
        `[${label} claim registry] evidence key "${key}" is required by read claims with ` +
          `DIFFERENT dietary postures (${detail}). Enforcement suppresses a KEY, not a ` +
          `type, so a mixed key would silently over- or under-apply the abstain. Give the ` +
          `types distinct evidence keys, or reconcile their postures — BKL-270.`,
      );
    }
  }

  // ── 4. REQUIRED / FALSIFIER DISJOINTNESS ───────────────────────────────────
  // The dangerous one. Suppressing a key that some type relies on as a FALSIFIER
  // would REMOVE a demotion signal, i.e. make that claim more likely to reach
  // VALIDATED — a safety abstain that manufactures a soundness hole. Fail closed.
  const falsifierKeys = new Map<string, string[]>();
  for (const [type, spec] of reads) {
    for (const falsifier of spec.falsifiers ?? []) {
      falsifierKeys.set(falsifier.key, [
        ...(falsifierKeys.get(falsifier.key) ?? []),
        type,
      ]);
    }
  }
  for (const [key, byType] of posturesByKey) {
    const suppressed = [...byType.values()].every((p) => p === "abstain");
    if (!suppressed) continue;
    const alsoFalsifierFor = falsifierKeys.get(key);
    if (alsoFalsifierFor !== undefined) {
      throw new Error(
        `[${label} claim registry] evidence key "${key}" would be SUPPRESSED under an ` +
          `abstain posture, but it is also a W6 falsifier for ${alsoFalsifierFor.join(", ")}. ` +
          `Suppressing it would remove a demotion signal and make that claim MORE likely ` +
          `to validate — the abstain would create a soundness hole. BKL-270.`,
      );
    }
  }
}

/**
 * BKL-270 — the evidence KEYS whose reads must not be recorded when the turn names
 * a dietary restriction, i.e. every key required ONLY by read claims that declare
 * `abstain`.
 *
 * `answer-anyway` and `answer-with-abstention` keys are deliberately absent:
 * `answer-with-abstention` RENDERS (CART_CONTENTS shows the customer their own
 * cart) and merely appends the abstain sentence at the copy layer, so suppressing
 * its read would silently convert the owner's ruling back into a plain abstain.
 *
 * Derived from the registry on every call rather than hand-listed — a new abstaining
 * family is covered the moment it declares, which is the entire point of Option C.
 * Pure.
 */
export function buildDietarySuppressionIndex(
  scope: ClaimPlaneScope = CUSTOMER_CLAIM_SCOPE,
): ReadonlySet<string> {
  const byKey = new Map<string, DietaryPosture[]>();
  for (const [, spec] of readSpecsOf(scope)) {
    for (const evidence of spec.requiredEvidence) {
      byKey.set(evidence.key, [
        ...(byKey.get(evidence.key) ?? []),
        spec.dietaryPosture,
      ]);
    }
  }
  const suppressed = new Set<string>();
  for (const [key, postures] of byKey) {
    if (postures.every((p) => p === "abstain")) suppressed.add(key);
  }
  return suppressed;
}

/**
 * Does this RUNTIME evidence key belong to a suppressed (abstaining) family?
 *
 * The registry declares BASE keys (`menu:item_price`), but a `perResourceKey` type's
 * reads are recorded under `${base}:${subject}` (`menu:item_price:prod_123`), so a
 * plain set lookup would miss every per-resource read — the exact silent-miss this
 * ticket exists to eliminate.
 *
 * Matches the base exactly, or as a `${base}:` PREFIX. The trailing colon is
 * load-bearing: without it `menu:item_price` would also swallow a future
 * `menu:item_price_history`. A naive split on ":" is wrong in both directions —
 * base keys are themselves namespaced (`menu:item_price`, `schedule:store_hours`),
 * so splitting on the FIRST colon mangles every one of them, and splitting on the
 * LAST mangles any subject containing a colon. Pure.
 */
export function isDietarySuppressedKey(
  key: string,
  suppressedBaseKeys: ReadonlySet<string>,
): boolean {
  if (suppressedBaseKeys.has(key)) return true;
  for (const base of suppressedBaseKeys) {
    if (key.startsWith(`${base}:`)) return true;
  }
  return false;
}
