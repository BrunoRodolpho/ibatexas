/**
 * claimdef-compiler GENERATOR (inv.18 v2). Emits the GENERATED runtime artifacts for
 * a claim type FROM its ClaimDefinition source, using the @adjudicate/core
 * `compileClaimDefinition` (the small declarative interpreter). This is the
 * "GENERATE, don't handwrite" half (constraint 5): the def source is the ONLY
 * editable artifact; the registry spec, render template, decomposition closure,
 * validator-wiring definition, and the doc card are all MACHINE-EMITTED with a
 * `@generated` header + a source checksum, and a CI/boot drift guard
 * (`./__tests__/generated-drift.test.ts`) re-runs this and fail-closes on any
 * divergence.
 *
 * Run it with:  pnpm exec tsx apps/api/src/claustrum/claimdefs/generate.ts
 *
 * PURE codegen (no clock/RNG/network); the only IO is reading the source file (for
 * its checksum) and writing the generated outputs. Deterministic: same source ⟹
 * byte-identical outputs.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileClaimDefinition } from "@adjudicate/core";
import { CART_CONTENTS_SOURCE } from "./cart-contents.claim.js";
import { CART_EMPTY_SOURCE } from "./cart-empty.claim.js";
import { COUPON_INVALID_SOURCE } from "./coupon-invalid.claim.js";
import { COUPON_VALID_SOURCE } from "./coupon-valid.claim.js";
import { DELIVERY_COVERAGE_SOURCE } from "./delivery-coverage.claim.js";
import { DELIVERY_NO_COVERAGE_SOURCE } from "./delivery-no-coverage.claim.js";
import { MENU_DIETARY_SOURCE } from "./menu-dietary.claim.js";
import { MENU_ITEM_ALLERGENS_SOURCE } from "./menu-item-allergens.claim.js";
import { MENU_ITEM_CONTENTS_SOURCE } from "./menu-item-contents.claim.js";
import { MENU_ITEM_PRICE_SOURCE } from "./menu-item-price.claim.js";
import { MENU_OVERVIEW_SOURCE } from "./menu-overview.claim.js";
import { MENU_PAIRINGS_SOURCE } from "./menu-pairings.claim.js";
import { MENU_SUBSTITUTIONS_SOURCE } from "./menu-substitutions.claim.js";
import { ORDER_FULFILLMENT_STAGE_SOURCE } from "./order-fulfillment-stage.claim.js";
import { ORDER_HISTORY_SOURCE } from "./order-history.claim.js";
import { PAYMENT_HISTORY_SOURCE } from "./payment-history.claim.js";
import { PAYMENT_STATUS_SOURCE } from "./payment-status.claim.js";
import {
  compilePerResourceClaimDefinition,
  type RepoCompiledArtifacts,
} from "./per-resource-claim.js";
import { RESERVATION_STATUS_SOURCE } from "./reservation-status.claim.js";
import { STORE_HOURS_FOR_DATE_SOURCE } from "./store-hours-for-date.claim.js";
import { STORE_HOURS_SOURCE } from "./store-hours.claim.js";
import { STORE_INFO_SOURCE } from "./store-info.claim.js";
import { STORE_OPEN_NOW_SOURCE } from "./store-open-now.claim.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A single claim type's codegen unit: its source file + compiled artifacts.
 *
 * `artifacts` is the REPO-widened bundle ({@link RepoCompiledArtifacts}) rather than the
 * published `CompiledArtifacts`: both a FIXED-SUBJECT unit (plain
 * `compileClaimDefinition`) and a PARAMETERIZED one (R2-S2's
 * `compilePerResourceClaimDefinition`) are assignable to it, so ONE emitter serves both
 * and its static view of `registrySpec` includes the `perResourceKey` facet it actually
 * serializes. Typing this as the published bundle would statically DENY that field while
 * the runtime object carried it — the shape in which a widening quietly stops emitting.
 */
interface GenUnit {
  /** The slug used for the generated file names (kebab-case). */
  readonly slug: string;
  /** The source `.claim.ts` file name (for the checksum + the header). */
  readonly sourceFile: string;
  readonly artifacts: RepoCompiledArtifacts;
}

const UNITS: readonly GenUnit[] = [
  {
    slug: "store-open-now",
    sourceFile: "store-open-now.claim.ts",
    artifacts: compileClaimDefinition(STORE_OPEN_NOW_SOURCE),
  },
  {
    slug: "store-hours",
    sourceFile: "store-hours.claim.ts",
    artifacts: compileClaimDefinition(STORE_HOURS_SOURCE),
  },
  {
    slug: "store-info",
    sourceFile: "store-info.claim.ts",
    artifacts: compileClaimDefinition(STORE_INFO_SOURCE),
  },
  // R2-S2 — the first PARAMETERIZED unit. Compiled through the repo-local widening so
  // the emitted registry spec carries `perResourceKey: true`; the published
  // `compileClaimDefinition` would drop it silently (see ./per-resource-claim.ts).
  {
    slug: "menu-item-price",
    sourceFile: "menu-item-price.claim.ts",
    artifacts: compilePerResourceClaimDefinition(MENU_ITEM_PRICE_SOURCE),
  },
  // R2-S3 — the price type's two PUBLIC per-item siblings, compiled through the same
  // widening (their generated specs carry `perResourceKey: true` beside UNSUFFIXED base
  // keys, which is what `selectCandidateClaim` requires — it does the suffixing).
  {
    slug: "menu-item-contents",
    sourceFile: "menu-item-contents.claim.ts",
    artifacts: compilePerResourceClaimDefinition(MENU_ITEM_CONTENTS_SOURCE),
  },
  {
    slug: "menu-dietary",
    sourceFile: "menu-dietary.claim.ts",
    artifacts: compilePerResourceClaimDefinition(MENU_DIETARY_SOURCE),
  },
  // R2-S4 — the FIRST OWNER-SCOPED unit. Same widening as the public per-item three (the
  // `perResourceKey` facet is the only thing the published compiler cannot express), but
  // its required-evidence row carries `ownershipPolicy: "required"`, which is what makes
  // `ownerScopedBaseKey` resolve a base key for it instead of `publicPerItemBaseKey`.
  // That row is projected VERBATIM by the published `toRegistrySpec`, so the ownership
  // axis needed no second widening.
  {
    slug: "reservation-status",
    sourceFile: "reservation-status.claim.ts",
    artifacts: compilePerResourceClaimDefinition(RESERVATION_STATUS_SOURCE),
  },
  // R2-S5 — the HISTORIES pair, the second and third owner-scoped units. Same widening
  // and the same `ownershipPolicy: "required"` evidence row as reservation-status; what is
  // new is only that their SUBJECT is the authenticated customerId rather than a resource
  // id (one history per customer), which is a runtime fact about the investigator's
  // ledger keys and needs nothing from the compiler. Each contributes ONE closure row; the
  // singular-sibling SPLICE that accompanies each span is a SEQUENCING fact about
  // `classifyRequestSpans` and stays hand-written there (see either source's header).
  {
    slug: "order-history",
    sourceFile: "order-history.claim.ts",
    artifacts: compilePerResourceClaimDefinition(ORDER_HISTORY_SOURCE),
  },
  {
    slug: "payment-history",
    sourceFile: "payment-history.claim.ts",
    artifacts: compilePerResourceClaimDefinition(PAYMENT_HISTORY_SOURCE),
  },
  // R2-S6 — the CART PRESENCE-COMPLEMENT PAIR, the fourth and fifth owner-scoped units and
  // the FIRST pair to SHARE one closure row. Same widening and the same
  // `ownershipPolicy: "required"` evidence rows as their three owner-scoped predecessors;
  // what is new is the closure OWNERSHIP asymmetry: `cart-contents.claim.ts` declares the
  // `CART_CONTENTS_Q` row INCLUDING its twin in `requires` (the published
  // `DecompositionSource.requires` is `NonEmpty<string>`, passed through BY REFERENCE — no
  // widening needed), and `cart-empty.claim.ts` declares NO `decomposition` at all, so it
  // emits NO closure export. Its `triadScoped: true` is what makes a de-synced pair a
  // fail-closed INV-4 boot REFUSAL. See cart-contents.claim.ts's header for the full
  // decision and the shapes that were rejected.
  {
    slug: "cart-contents",
    sourceFile: "cart-contents.claim.ts",
    artifacts: compilePerResourceClaimDefinition(CART_CONTENTS_SOURCE),
  },
  {
    slug: "cart-empty",
    sourceFile: "cart-empty.claim.ts",
    artifacts: compilePerResourceClaimDefinition(CART_EMPTY_SOURCE),
  },
  // R2-S7 — the STATUS SIBLINGS, the sixth and seventh owner-scoped units. Same widening and
  // the same `ownershipPolicy: "required"` evidence rows as their five owner-scoped
  // predecessors; both are subjected by the ORDER id (the RESERVATION_STATUS shape, not the
  // histories' customerId). Two things are new, and neither needed a compiler change:
  //
  //   - ORDER_FULFILLMENT_STAGE owns a SELF-ONLY `ORDER_STATUS_Q` row while ALSO being
  //     required by `PICKUP_Q`, a span NO type owns (its net is its own and it requires two
  //     types, neither named after it). Per R2-S6's shared-row rule that row stays
  //     HAND-WRITTEN beside the closure table. INV-4 stays green with both rows — MEASURED —
  //     but its forward direction is consequently MASKED as a de-sync detector for this one
  //     type; see order-fulfillment-stage.claim.ts's header.
  //   - PAYMENT_STATUS carries three REGISTRY FIRSTS: TWO falsifiers, the
  //     `first_party_verified` integrity floor, and `first_party_only` provenance on all
  //     three rows. All three survive the published projection by the SAME reference-pass
  //     mechanism R2-S4 proved for `ownershipPolicy` (`toRegistrySpec` spreads the whole
  //     falsifier tuple by reference and passes the floor through as a scalar), so
  //     per-resource-claim.ts is UNCHANGED by this slice — the only facet the published
  //     compiler cannot express remains R2-S2's `perResourceKey`. Each field is asserted
  //     individually in __tests__/per-resource-claim.test.ts.
  {
    slug: "order-fulfillment-stage",
    sourceFile: "order-fulfillment-stage.claim.ts",
    artifacts: compilePerResourceClaimDefinition(ORDER_FULFILLMENT_STAGE_SOURCE),
  },
  {
    slug: "payment-status",
    sourceFile: "payment-status.claim.ts",
    artifacts: compilePerResourceClaimDefinition(PAYMENT_STATUS_SOURCE),
  },
  // R2-S8 — the LAST parameterized type, and the first whose span predicate is a
  // CONJUNCTION. It reaches the compiler through the SAME R2-S2 widening as the public
  // per-item three (PUBLIC `not_applicable` evidence, subject = the QUERIED ISO date), so
  // per-resource-claim.ts is UNCHANGED by this slice. What is new is only the marker/guard
  // split: `markers` carries the `scheduleContext` conjunct (a flat nine-arm alternation
  // that rejoins byte-identically), while the `dateAnchor` conjunct — whose `|`s sit inside
  // a group under a shared `\b`, so no per-arm split rejoins to the same bytes — stays a
  // hand-written GUARD at `classifyRequestSpans`, as does the BKL-152 STORE_OPEN_NOW_Q
  // suppression seam in `decomposeRequiredClaims` (sequencing over the assembled required
  // set, which no single closure row can express). See store-hours-for-date.claim.ts's
  // header for the measurement that chose the split.
  {
    slug: "store-hours-for-date",
    sourceFile: "store-hours-for-date.claim.ts",
    artifacts: compilePerResourceClaimDefinition(STORE_HOURS_FOR_DATE_SOURCE),
  },
  // R2-S9 — the FIXED-SUBJECT BATCH: the last eight compilable types, and the first eight
  // since R2-S1 to reach the compiler through the PUBLISHED `compileClaimDefinition`
  // rather than R2-S2's per-resource wrapper. None of them is `perResourceKey` (each is a
  // single-key store-policy or whole-catalog read), which is verified per type in
  // `./__tests__/per-resource-claim.test.ts`'s base-key axis rather than assumed from the
  // absence of a flag.
  //
  // THE THREE PRESENCE-COMPLEMENT PAIRS, all under R2-S6's shared-row rule (the span owner
  // declares the row naming BOTH members; the twin declares no `decomposition` and so emits
  // no closure export). What does NOT carry over from the cart pair is the ENFORCEMENT:
  // both members of all three pairs are PUBLIC (`triadScoped: false`), so INV-4's forward
  // direction obliges neither and CANNOT see a `requires` that stopped naming the twin.
  // MEASURED against the real validator — CART_CONTENTS_Q losing CART_EMPTY is
  // DECOMPOSITION_UNREACHABLE, while each of the three rows below losing its twin is
  // `{ ok: true }`. The explicit structural pin that stands in for it lives in
  // `./__tests__/generated-drift.test.ts`; the full derivation is in
  // `./delivery-coverage.claim.ts`'s header.
  {
    slug: "delivery-coverage",
    sourceFile: "delivery-coverage.claim.ts",
    artifacts: compileClaimDefinition(DELIVERY_COVERAGE_SOURCE),
  },
  {
    slug: "delivery-no-coverage",
    sourceFile: "delivery-no-coverage.claim.ts",
    artifacts: compileClaimDefinition(DELIVERY_NO_COVERAGE_SOURCE),
  },
  // COUPON — the first pair whose span (`COUPON_VALIDITY_Q`) is named after NEITHER type,
  // so ownership needed a stated TIE-BREAK rather than the naming settlement the cart and
  // delivery pairs had. The positive member declares the row; see
  // `./coupon-valid.claim.ts`'s header for the three reasons and for why the marker net is
  // the coupon NOUN alone (no conjunct of this span's predicate splits into rejoinable
  // arms — every one is a single lookbehind-anchored literal — so the choice is WHICH
  // conjunct is the marker net, and the compiler's own semantics answer it).
  {
    slug: "coupon-valid",
    sourceFile: "coupon-valid.claim.ts",
    artifacts: compileClaimDefinition(COUPON_VALID_SOURCE),
  },
  {
    slug: "coupon-invalid",
    sourceFile: "coupon-invalid.claim.ts",
    artifacts: compileClaimDefinition(COUPON_INVALID_SOURCE),
  },
  // PAIRING — the family the compiler was built for (LE2-029 registered it across SIX
  // files / +430 lines pre-compiler). It is also the ONLY unit whose generated `markers`
  // ORDER a RUNTIME branch reads: the two arms are the relation discriminator
  // `classifyPairingAsk` tests in sequence, so `menu-pairings.claim.ts` declares them in
  // that order and the decomposer reads them through NAMED index constants, with each arm
  // pinned byte-for-byte and INDIVIDUALLY.
  {
    slug: "menu-pairings",
    sourceFile: "menu-pairings.claim.ts",
    artifacts: compileClaimDefinition(MENU_PAIRINGS_SOURCE),
  },
  {
    slug: "menu-substitutions",
    sourceFile: "menu-substitutions.claim.ts",
    artifacts: compileClaimDefinition(MENU_SUBSTITUTIONS_SOURCE),
  },
  // MENU_OVERVIEW — the composed net. Its three arms were ALREADY separate literals
  // `||`-ed at the use site, so the migration is the R2-S4 relocation-with-no-splitting
  // case and the byte pin it rejoins to (`__SPAN_NET_SOURCES_FOR_TEST.menuOverview`)
  // PRE-DATES this slice with its value unchanged. The BKL-205 negative lookahead travels
  // INSIDE arm 2; the BKL-205 SPECIFICITY ORDERING (this span's verdict suppressing the
  // per-ITEM contents span) is sequencing between two DIFFERENT types and stays
  // hand-written, byte-pin-blind, with behavioural pins.
  {
    slug: "menu-overview",
    sourceFile: "menu-overview.claim.ts",
    artifacts: compileClaimDefinition(MENU_OVERVIEW_SOURCE),
  },
  // MENU_ITEM_ALLERGENS — the DEGENERATE unit, and the one R2-S1 rejected as proving
  // nothing. It is here for the CENSUS (see the exclusion note below): no falsifiers, no
  // valueBinding, no render, no decomposition. It is what made the emitter's template block
  // conditional — a type whose un-renderability is a ratified safety decision (BKL-123)
  // must not ship an empty-slot `_TEMPLATE` export a consumer could splice — and what
  // turned the drift harness's hardcoded `>= 4` mutation floor into a DERIVED exact count,
  // since it is the only unit generating exactly TWO.
  {
    slug: "menu-item-allergens",
    sourceFile: "menu-item-allergens.claim.ts",
    artifacts: compileClaimDefinition(MENU_ITEM_ALLERGENS_SOURCE),
  },
];

/**
 * PURCHASE_COMPLETED — EXCLUDED BY DESIGN. It is the 23rd registry type and the ONLY one
 * with no `GenUnit` above, and this note is half of the census pin
 * (`22 generated + 1 documented exclusion = 23`, asserted in
 * `./__tests__/generated-drift.test.ts`); the other half is the matching ruling in
 * `../claim-registry.ts`'s header. The pin is what forces a future type ADDITION to
 * declare itself as one or the other instead of quietly becoming a second undocumented
 * hand-written row.
 *
 * WHY EXCLUDED, and it is NOT "the compiler would reject it" — it would not. A source for
 * this type would type-check and compile: `kind: "action_claim"` is a member of the
 * published `ClaimKind`, its single `action_outcome` evidence row is structurally ordinary,
 * and with no `render` block the F7 guard never fires. The exclusion is about what such a
 * source would ASSERT, not about what the compiler can chew.
 *
 * This is the registry's ONLY `action_claim`, and an action claim does not render through
 * the read-template grammar at all: it renders through the responder's
 * `SUCCESS_CLAIM_CLASSES` path (`../ibatexas-responder.ts`), where `PURCHASE_COMPLETED`
 * maps to TWO lowercase guard classes (`order-placed` + `purchase-completed`) in a
 * different namespace from the registry's. The compiler's `render` block models exactly one
 * posture — the `validated` READ template — and has no shape for that. So a compiled source
 * would be SILENT about the one mechanism that actually determines how this type reaches a
 * customer, and its generated doc card would print `**render (validated)**: _(no render
 * template)_` — which for a read type truthfully means "abstains to SAFE_UNKNOWN", and for
 * this one would be actively FALSE, since it does render. Publishing that card is the
 * dead-and-misleading-artifact failure inv.18 v2 exists to prevent, which is why the
 * ruling is an exclusion rather than a low-value adoption (contrast MENU_ITEM_ALLERGENS
 * directly above, where `_(no render template)_` is TRUE and the adoption is therefore
 * honest, if small).
 *
 * WHAT WOULD CHANGE THE RULING: an `action_claim` render posture in the published
 * compiler's `RenderSource` — a block that names the guard classes an action claim earns —
 * at which point this type becomes an ordinary adoption. Nothing in this repo can supply
 * that; `@adjudicate/core` is a separately published package and the dependency arrow never
 * points backward (SDD §M/§Q).
 *
 * NOT a deferral, NOT pending BKL-121/-123, and NOT to be "fixed" by adding a GenUnit that
 * compiles: doing so would move the census to 23/23 while publishing the false card above.
 */
const EXCLUDED_BY_DESIGN = ["PURCHASE_COMPLETED"] as const;

/** sha256 of a generated file's source-of-record (the `.claim.ts`). */
function sourceChecksum(sourceFile: string): string {
  const text = readFileSync(join(HERE, sourceFile), "utf8");
  return createHash("sha256").update(text).digest("hex");
}

/** Serialize a JSON-safe value to a TS object/array literal (stable 2-space indent). */
function tsLiteral(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Serialize an array of RegExp as a TS array of regex LITERALS (JSON can't). */
function regexArrayLiteral(markers: readonly RegExp[]): string {
  return `[${markers.map((m) => m.toString()).join(", ")}]`;
}

const HEADER = (sourceFile: string, checksum: string): string =>
  [
    `// @generated by claimdef-compiler from ${sourceFile} — DO NOT EDIT.`,
    `// Regenerate with: pnpm exec tsx apps/api/src/claustrum/claimdefs/generate.ts`,
    `// source-checksum (sha256): ${checksum}`,
    "//",
    "// The editable artifact is the .claim.ts SOURCE; every export below is a pure",
    "// projection of it computed by @adjudicate/core compileClaimDefinition. A boot/CI",
    "// drift guard (./__tests__/generated-drift.test.ts) fail-closes if this file diverges.",
  ].join("\n");

/** Build the GENERATED .ts module content for one unit. */
export function emitGeneratedModule(unit: GenUnit): string {
  const { artifacts: a, sourceFile } = unit;
  const checksum = sourceChecksum(sourceFile);

  // (1) registry spec — assignable to `GeneratedReadClaimSpec`, i.e. a read spec
  // MINUS `dietaryPosture` (BKL-270). The compiler cannot emit that field —
  // `compileClaimDefinition` is in the published @adjudicate/core and has no concept
  // of it, and the value is an OWNER RULING rather than a projection of the source —
  // so the generated row asserts exactly what it can honestly produce and the
  // posture is spliced in at the REGISTRY_SPECS site, where a reviewer sees it beside
  // every other family's.
  const registrySpec = tsLiteral(a.registrySpec);

  // (3) render template — wrap the compiled slots in the ibatexas Template shape
  // (claimType keyed + the `validated` posture).
  // OPTIONAL, on exactly the closure block's footing (R2-S9): a source with NO `render`
  // block compiles to `renderTemplate: undefined`, and such a type emits NO template
  // export at all. The alternative — an empty-`slots` stub — would publish a template that
  // renders the empty string and that a consumer could splice into VALIDATED_TEMPLATES,
  // for a type whose UN-RENDERABILITY is the ratified decision (MENU_ITEM_ALLERGENS,
  // BKL-123: a validated allergen template is soundness-sensitive and owner-gated). The
  // block and its `Template` import are therefore both conditional, exactly as the closure
  // block and its `RegistryClaimType` import already are.
  const renderTemplate = a.renderTemplate;
  const template =
    renderTemplate === undefined
      ? undefined
      : tsLiteral({
          claimType: a.type,
          posture: "validated",
          slots: renderTemplate.slots,
        });

  // (7) decomposition closure — spanClass literal + requires + the regex markers.
  // OPTIONAL: a type with no §O#15 span (no closure row, no markers — e.g. STORE_HOURS,
  // whose questions route to STORE_OPEN_NOW_Q / STORE_HOURS_FOR_DATE_Q) emits NO closure
  // export at all. Emitting an empty-spanClass stub instead would publish a row that
  // reads as a declared-but-blank span, and would pull an unused `RegistryClaimType`
  // import in with it — so the block and its import are both conditional.
  const closure = a.closure;

  // Every export is PREFIXED with the compiled type name, so the export identifiers are
  // a projection of the source like everything else here (adding a claim type stays
  // "add a source + a GenUnit", with no per-type edit to this emitter).
  const P = a.type;

  return [
    HEADER(sourceFile, checksum),
    "",
    closure === undefined
      ? `import type { GeneratedReadClaimSpec } from "../claim-registry.js";`
      : `import type { GeneratedReadClaimSpec, RegistryClaimType } from "../claim-registry.js";`,
    ...(template === undefined ? [] : [`import type { Template } from "../slot-grammar.js";`]),
    `import type { ClaimDefinition } from "@adjudicate/core";`,
    "",
    `/** (1) GENERATED registry spec row (evidence / falsifiers / value-binding). */`,
    `export const ${P}_REGISTRY_SPEC = ${registrySpec} satisfies GeneratedReadClaimSpec;`,
    ...(template === undefined
      ? []
      : [
          "",
          `/** (3) GENERATED render template (proposition slots bound 1:1 to self + field). */`,
          `export const ${P}_TEMPLATE = ${template} satisfies Template;`,
        ]),
    ...(closure === undefined
      ? []
      : [
          "",
          `/** (7) GENERATED decomposition closure: span class + required companions + pt-BR markers. */`,
          `export const ${P}_CLOSURE = {`,
          `  spanClass: ${JSON.stringify(closure.spanClass)},`,
          `  requires: ${JSON.stringify(closure.requires)} satisfies readonly RegistryClaimType[],`,
          `  markers: ${regexArrayLiteral(closure.markers)},`,
          `} as const;`,
        ]),
    "",
    `/** (4) GENERATED validator-wiring definition (defense-in-depth for set-level invariants). */`,
    `export const ${P}_DEFINITION = ${tsLiteral(a.definition)} satisfies ClaimDefinition;`,
    "",
    `/** The compiled id (type@version) — the designed-in versioning stamp. */`,
    `export const ${P}_ID = ${JSON.stringify(a.id)};`,
    "",
  ].join("\n");
}

/** Build the GENERATED .md doc card for one unit. */
export function emitGeneratedDoc(unit: GenUnit): string {
  return unit.artifacts.doc;
}

/** Write all generated outputs to disk. */
export function generateAll(): void {
  for (const unit of UNITS) {
    writeFileSync(join(HERE, `${unit.slug}.generated.ts`), `${emitGeneratedModule(unit)}\n`, "utf8");
    writeFileSync(join(HERE, `${unit.slug}.generated.md`), emitGeneratedDoc(unit), "utf8");
  }
}

export { EXCLUDED_BY_DESIGN, UNITS };

// Direct-run entrypoint (ESM): regenerate when invoked as a script.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  generateAll();
  // eslint-disable-next-line no-console
  console.log(`[claimdef-compiler] generated ${UNITS.length} claim type(s).`);
}
