// prompt-surfaces.ts — enumerate what the model actually receives.
//
// Extracted from the F-65b date guard so a second consumer (F-67's prompt
// catalog completeness axis) is a thin caller rather than a re-implementation.
// Two walkers answering "which prompts exist?" WILL drift, and they drift
// silently: each stays green while disagreeing with the other.
//
// This is a HELPER MODULE, deliberately not a test file. `collectSurfaces()`
// used to live inside `prompt-date-literal-guard.test.ts`, where it could not
// be shared — importing a test file executes its `describe` blocks in the
// importer's context, so the guard's cases would silently register and run
// again inside whatever suite imported it.
//
// ── TWO TRAPS FOR A CONSUMER, BOTH MEASURED ────────────────────────────────
//
// 1. NOT EVERY STRING EXPORT IS A PERSONA. `EXPRESS_INTENT_TOOL` is the tool
//    NAME ("express_intent"), not prompt text. A consumer asking "is every
//    persona catalogued / wired?" over the raw namespace would report it as an
//    uncatalogued persona — a false finding. `personaExports()` therefore
//    applies a HAND-WRITTEN exclusion (below); `promptTextExports()` is the
//    unfiltered walk for callers that want to judge for themselves.
//
// 2. THE TWO AUTHORING SHAPES. `asText` accepts a `string` or a `string[]`.
//    MEASURED 2026-08-05: every EXPORTED prompt text is currently a string —
//    the `string[]` branch is defensive and presently unexercised by any
//    export. It is kept because the array style is live inside this module
//    (`SCHEDULE_CLAIM_MAPPING_LINES` is a module-local `readonly string[]`,
//    spread into two personas), so the next persona could plausibly be
//    authored that way. Do NOT read the branch's existence as evidence that
//    array-shaped exports exist today; and do not assume the opposite either
//    — normalize through `asText` rather than indexing a `.join`.
//
// ── SCOPE, STATED PRECISELY ────────────────────────────────────────────────
//
// `collectSurfaces()` covers the model-facing text composable WITHOUT runtime
// state: every prompt-text export, the prompt catalog, the capability
// descriptions, and both wire rosters (rendered through `toPayloadJsonSchema`,
// which is what the model is actually handed).
//
// It does NOT cover anything a turn assembles at runtime — the relevance-gated
// closed-hours note, retrieved grounding, conversation history, or the
// workflow surface's per-turn slots. Those need a live turn to exist, so a
// caller asserting over `collectSurfaces()` is asserting over the STATIC
// prompt surface and must say so rather than implying repo-wide reach.

import * as personas from "../../prompts/personas.js";
import { PROMPT_CATALOG } from "../../prompts/prompt-catalog.js";
import { IBATEXAS_CAPABILITY_DESCRIPTIONS } from "../../../tools/register-ibatexas-tool-packs.js";
import { toPayloadJsonSchema } from "../../language-engine/extraction-schema.js";
import { AUTHORED_SCHEMAS } from "../../language-engine/wire-schemas.js";
import { READ_TOOL_AUTHORED_SCHEMAS } from "../../language-engine/read-tool-schemas.js";

/** One prompt-text export, by its source name, with its text normalized. */
export interface PersonaExport {
  /** The exported const's name, e.g. `OPS_CLAIM_PLANNER_PERSONA`. */
  readonly name: string;
  /** Its composed text — joined if the export is a `string[]`. */
  readonly text: string;
}

/** A model-facing surface: a stable site id and the text the model sees. */
export type PromptSurface = readonly [siteId: string, text: string];

/**
 * String exports of `personas.ts` that are NOT prompt text. HAND-WRITTEN, and
 * deliberately not a name-pattern rule: a pattern would silently reclassify a
 * future export, which is the failure this list exists to prevent. Adding a
 * name here should require stating why it is not prompt text.
 */
const NON_PROMPT_EXPORTS: ReadonlySet<string> = new Set([
  // The `express_intent` tool NAME, consumed as an identifier by the planner
  // and interpolated INTO personas — never a prompt in its own right.
  "EXPRESS_INTENT_TOOL",
]);

/**
 * Normalize a prompt export to text, or `null` if it is not text at all.
 * Handles both authored shapes — see trap 2 in the module header.
 */
export function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value.join("\n");
  }
  return null;
}

/**
 * EVERY text-valued export of `personas.ts`, unfiltered — including
 * non-persona constants. Use this only if you intend to classify them
 * yourself; most callers want {@link personaExports}.
 */
export function promptTextExports(): readonly PersonaExport[] {
  const out: PersonaExport[] = [];
  for (const [name, value] of Object.entries(personas)) {
    const text = asText(value);
    if (text !== null) out.push({ name, text });
  }
  return out;
}

/**
 * Every PERSONA export in `personas.ts`, by name — the text exports minus
 * {@link NON_PROMPT_EXPORTS}.
 *
 * A MODULE-NAMESPACE walk, not a hand-list, and that is the point: it covers
 * personas that other enumerations miss. `PROMPT_CATALOG` calls itself "the
 * single enumeration of every LLM-facing prompt" but omits
 * OPS_CLAIM_PLANNER_PERSONA, which is live (`ops-conductor.ts` composes it via
 * `resolvePrompt("ops/claim-planner.persona", …)`). Anything walking only the
 * catalog inherits that blind spot; this does not, and it picks up future
 * additions for free.
 */
export function personaExports(): readonly PersonaExport[] {
  return promptTextExports().filter((e) => !NON_PROMPT_EXPORTS.has(e.name));
}

/**
 * Every (siteId, text) pair the model can see without runtime state — the
 * union of the persona namespace walk, the catalog, the capability
 * descriptions and both wire rosters. See the header for what is NOT covered.
 *
 * Site ids are prefixed by origin (`persona:` / `catalog:` / `capability:` /
 * `wire:`) so a caller can attribute a finding to a place a human can open.
 */
export function collectSurfaces(): readonly PromptSurface[] {
  const out: PromptSurface[] = [];
  for (const { name, text } of personaExports()) out.push([`persona:${name}`, text]);
  for (const entry of PROMPT_CATALOG) out.push([`catalog:${entry.id}`, entry.source]);
  for (const [kind, text] of Object.entries(IBATEXAS_CAPABILITY_DESCRIPTIONS)) {
    out.push([`capability:${kind}`, text]);
  }
  for (const schema of [...AUTHORED_SCHEMAS, ...READ_TOOL_AUTHORED_SCHEMAS]) {
    out.push([`wire:${schema.capability}`, JSON.stringify(toPayloadJsonSchema(schema))]);
  }
  return out;
}
