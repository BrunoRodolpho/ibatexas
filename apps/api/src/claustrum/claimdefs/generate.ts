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
import { MENU_DIETARY_SOURCE } from "./menu-dietary.claim.js";
import { MENU_ITEM_CONTENTS_SOURCE } from "./menu-item-contents.claim.js";
import { MENU_ITEM_PRICE_SOURCE } from "./menu-item-price.claim.js";
import {
  compilePerResourceClaimDefinition,
  type RepoCompiledArtifacts,
} from "./per-resource-claim.js";
import { RESERVATION_STATUS_SOURCE } from "./reservation-status.claim.js";
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
];

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
  const template = tsLiteral({
    claimType: a.type,
    posture: "validated",
    slots: a.renderTemplate?.slots ?? [],
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
    `import type { Template } from "../slot-grammar.js";`,
    `import type { ClaimDefinition } from "@adjudicate/core";`,
    "",
    `/** (1) GENERATED registry spec row (evidence / falsifiers / value-binding). */`,
    `export const ${P}_REGISTRY_SPEC = ${registrySpec} satisfies GeneratedReadClaimSpec;`,
    "",
    `/** (3) GENERATED render template (proposition slots bound 1:1 to self + field). */`,
    `export const ${P}_TEMPLATE = ${template} satisfies Template;`,
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

export { UNITS };

// Direct-run entrypoint (ESM): regenerate when invoked as a script.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  generateAll();
  // eslint-disable-next-line no-console
  console.log(`[claimdef-compiler] generated ${UNITS.length} claim type(s).`);
}
