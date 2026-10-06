// prompt-date-literal-guard.test.ts — F-65b.
//
// F-65 established that a hardcoded date can sit in LIVE model-facing prompt
// text and no test will ever notice: nothing asserts what a persona or a field
// `description` SAYS. This file is that missing alarm.
//
// ── WHAT IT ASSERTS, AND IN BOTH DIRECTIONS ─────────────────────────────────
//
// It renders the surfaces the model actually receives, extracts every
// date-shaped literal, and compares the (site, literal) pairs against a
// HAND-WRITTEN allowlist:
//
//   · a pair found but NOT allowlisted  ⇒ RED (a new date entered the prompt)
//   · a pair allowlisted but NOT found  ⇒ RED (the allowlist is stale)
//
// The second direction is not decoration. Without it the allowlist could be
// wrong in every entry and still pass, which is the "vacuous by default" class:
// it is what proves the allowlist is CONSULTED rather than merely present.
//
// ── WHY THE ALLOWLIST IS HAND-WRITTEN ───────────────────────────────────────
//
// Deriving it from the sites it guards would make it self-satisfying — it would
// pass with the guard's own subject deleted, the derived-control failure this
// program has hit before. Every entry below is typed out by hand. Adding one is
// meant to be a deliberate act a reviewer sees.
//
// ── WHY IT READS RENDERED SURFACES, NOT SOURCE TEXT ─────────────────────────
//
// Grepping the source cannot tell a live literal from an inert one, and F-65's
// finding was precisely that the distinction inverts the obvious ranking: the
// three few-shot `example` dates are structurally incapable of reaching the
// model (`toPayloadJsonSchema` builds the wire object from `schema.fields`
// alone), while the "illustrative" field descriptions and persona lines are
// live. So the input here is the rendered wire schema and the composed persona
// text. INERT_LITERALS below pins that inversion: if one of those ever appears
// in the collected surface, this guard has started reading source and its
// verdicts are no longer trustworthy.
//
// ── WHY THE INPUT IS NOT `PROMPT_CATALOG` ALONE ─────────────────────────────
//
// `prompt-catalog.ts` calls itself "the single enumeration of every LLM-facing
// prompt", and when this guard was written it omitted OPS_CLAIM_PLANNER_PERSONA
// — live (`ops-conductor.ts` composes it) and carrying one of the dates below —
// so a catalog-only walk was blind at one of the three live sites. #570 has
// since catalogued that persona, and a completeness guard now enforces the
// catalog's claim; do not read this paragraph as a standing assertion that the
// catalog is incomplete.
//
// The union input stands on its own terms regardless: the catalog is a
// hand-maintained list, so anything walking only it inherits whatever it
// happens to be missing THAT DAY. A module-namespace walk cannot be behind.
// The input is therefore the UNION of a namespace walk of `personas.ts`, the
// catalog, the capability descriptions, and both wire rosters. Inputs should be
// as complete as possible and should grow on their own; only the ALLOWLIST is
// hand-written.

import { describe, expect, it } from "vitest";
// The walkers live in a helper module, not here, so F-67's catalog-completeness
// axis can consume the SAME enumeration instead of growing a second one that
// drifts. See helpers/prompt-surfaces.ts for the two-shapes hazard and for the
// precise scope this covers (static surface only — no runtime-composed text).
import { collectSurfaces } from "./helpers/prompt-surfaces.js";

/** `YYYY-MM-DD` anywhere in the text. */
const DATE_RE = /\d{4}-\d{2}-\d{2}/g;

/**
 * THE ALLOWLIST — hand-written, never derived. `"<site>|<literal>"`.
 *
 * Keyed by SITE **and** literal, so both of these fire:
 *   · the same date moved to a new site (new pair, not allowlisted);
 *   · a different date at a known site (new pair AND a missing old one).
 *
 * Each entry is a live model-facing date. Before adding one, read the F-65
 * note at its source: the ruling is that if a date here is ever measured to
 * anchor the model's output year, it gets DE-ANCHORED (symbolic spec, or a
 * placeholder whose concreteness is not load-bearing) — never derived from the
 * turn clock, because the composed prompt and the tool surface are digested
 * components of the L1 parse-cache key and a per-turn value voids every parse.
 */
const ALLOWED_SITE_LITERALS: readonly string[] = [
  // personas.ts — SCHEDULE_CLAIM_MAPPING_LINES, spread into BOTH claim planners.
  "persona:CLAIM_PLANNER_PERSONA|2026-07-12",
  "persona:OPS_CLAIM_PLANNER_PERSONA|2026-07-12",
  // personas.ts — schedule.override.set format example (third of three).
  "persona:OPS_PLANNER_PERSONA|2026-07-25",
  // reservation-convenience.schema.ts — `date` / `newDate` field descriptions.
  "wire:reservation.create|2026-03-15",
  "wire:reservation.modify|2026-03-15",
];

/**
 * Dates that live in source but must NEVER reach a rendered surface — the
 * three few-shot `example` payloads. Their presence here would mean the
 * collector has started reading source text instead of what the model gets.
 */
const INERT_LITERALS: readonly string[] = ["2026-03-20", "2026-07-18"];

/**
 * `"<site>|<literal>"` for every date found. Deduped by TEXT first, so a
 * persona reachable through both the namespace walk and the catalog is ONE
 * site, attributed to the first label in collection order rather than two
 * near-duplicate allowlist rows.
 */
function foundSiteLiterals(): ReadonlySet<string> {
  const firstLabelForText = new Map<string, string>();
  for (const [site, text] of collectSurfaces()) {
    if (!firstLabelForText.has(text)) firstLabelForText.set(text, site);
  }
  const found = new Set<string>();
  for (const [text, site] of firstLabelForText) {
    for (const hit of text.match(DATE_RE) ?? []) found.add(`${site}|${hit}`);
  }
  return found;
}

describe("F-65b — no unexpected date literal reaches a model-facing surface", () => {
  it("finds exactly the allowlisted (site, literal) pairs — both directions", () => {
    const found = foundSiteLiterals();
    const allowed = new Set(ALLOWED_SITE_LITERALS);

    // Direction 1 — a date entered the prompt surface without a review.
    const unexpected = [...found].filter((p) => !allowed.has(p)).sort();
    expect(
      unexpected,
      "a date literal reached a model-facing surface without an allowlist entry. " +
        "Read the F-65 note at its source before adding one: de-anchor, never " +
        "derive from the turn clock (it is a digested parse-cache key component).",
    ).toEqual([]);

    // Direction 2 — proves the allowlist is CONSULTED, not merely present.
    const stale = [...allowed].filter((p) => !found.has(p)).sort();
    expect(
      stale,
      "an allowlisted (site, literal) pair no longer exists. If the date was " +
        "removed or de-anchored, delete its row here too.",
    ).toEqual([]);
  });

  it("the collector reads RENDERED surfaces — inert `example` dates never appear", () => {
    // The engine's own self-check. `example` is author-facing and cannot reach
    // the wire; seeing one of its dates means this guard is reading source text,
    // which would make every verdict above untrustworthy.
    const surface = collectSurfaces()
      .map(([, text]) => text)
      .join("\n");
    for (const inert of INERT_LITERALS) {
      expect(
        surface.includes(inert),
        `${inert} lives only in an \`example\` payload and must not be on any ` +
          `rendered surface — the collector is reading source, not the wire.`,
      ).toBe(false);
    }
  });

  it("covers persona sites regardless of catalog membership", () => {
    // Regression pin for the blind spot that motivated the union input: the
    // namespace walk reaches every persona whether or not the catalog lists
    // it, so a persona can never fall out of this guard's reach by being
    // absent from — or later added to — PROMPT_CATALOG.
    //
    // This assertion used to ALSO require that the catalog omit
    // OPS_CLAIM_PLANNER_PERSONA, which was true when this file was written and
    // false once #570 catalogued it — reddening dev. The property worth
    // pinning was always "the walk covers this site", never "the catalog lacks
    // it": a pin on a defect expires the moment the defect is fixed, and takes
    // the build with it. Catalog membership is asserted by the completeness
    // guard that owns it (prompts/__tests__/prompt-catalog-completeness.test.ts);
    // re-asserting it here would be a second mirror of the same claim.
    const sites = new Set(collectSurfaces().map(([site]) => site));
    expect(sites.has("persona:OPS_CLAIM_PLANNER_PERSONA")).toBe(true);
  });
});
