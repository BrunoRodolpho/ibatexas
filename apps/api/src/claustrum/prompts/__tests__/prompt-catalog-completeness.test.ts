// F-67 — the prompt catalog must enumerate every WIRED prompt.
//
// WHAT THIS EXISTS TO PREVENT
// ---------------------------
// `prompt-catalog.ts` calls itself "the single enumeration of every LLM-facing
// prompt the ibatexas agent runtime uses" and backs the qa-viewer "Prompts"
// navigate+edit view. A prompt that is WIRED but uncatalogued is worse than one
// that is merely undocumented: `resolvePrompt(id, default)` consults the
// override store for that id, so a `prompt_override` row WOULD take effect at
// runtime while the operator surface cannot list, show, or edit it. The prompt
// is live and invisible at the same time.
//
// That is not hypothetical. On dev @ b697ebd0 `ops/claim-planner.persona` —
// the persona that decides which claim TYPE every staff question maps to
// (ops-conductor.ts:230) — was wired and absent from the catalog. This guard
// was written against that state and observed RED naming exactly that id
// before the catalog row was added; the fix and the guard land together so the
// guard is born with a real red→green rather than a green it never earned.
//
// WHERE THE EXPECTED SET COMES FROM (and why it is not the catalog)
// ----------------------------------------------------------------
// A completeness check whose expected set is derived from the thing it checks
// cannot fail. So the wired population is collected from the two carriers that
// actually reach `resolvePrompt`, neither of which is the catalog:
//
//   A. The composer fragment graph — `ibatexasPromptFragments()` already
//      exports every fragment with its live `id` (it backs the prompt-drift
//      guard). These ids are built by `staticFragment`/`capabilityFragment`,
//      which close over `resolvePrompt(id, content)`.
//   B. Direct `resolvePrompt("<literal>", CONST)` seams outside the fragment
//      graph — the ops plane and two customer fallbacks. Collected by scanning
//      source, because these ids exist only as call-site literals; there is no
//      runtime registry to ask.
//
// Carrier B is a source scan on purpose. The alternative — importing every
// module and observing calls — would require booting the ops conductor, and a
// guard that needs the runtime up is a guard that gets skipped.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ibatexasPromptFragments } from "../ibatexas-prompts.js";
import { PROMPT_CATALOG } from "../prompt-catalog.js";

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Matches `resolvePrompt("some/id"` — the id must be a literal to be found. */
const LITERAL_RESOLVE_PROMPT = /resolvePrompt\(\s*["'`]([^"'`]+)["'`]/g;

function productionSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      productionSourceFiles(full, out);
      continue;
    }
    if (!full.endsWith(".ts") || full.endsWith(".d.ts")) continue;
    // Tests may reference an id in an assertion without wiring it.
    if (full.includes("__tests__") || full.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

/** Carrier B — ids passed to resolvePrompt as string literals, with call site. */
function literalResolvePromptSites(): ReadonlyMap<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of productionSourceFiles(API_SRC)) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(LITERAL_RESOLVE_PROMPT)) {
      const id = match[1]!;
      const line = src.slice(0, match.index).split("\n").length;
      const rel = file.slice(API_SRC.length + 1);
      const sites = found.get(id) ?? [];
      sites.push(`${rel}:${line}`);
      found.set(id, sites);
    }
  }
  return found;
}

describe("prompt catalog completeness (F-67)", () => {
  const catalogIds = new Set(PROMPT_CATALOG.map((e) => e.id));

  it("every fragment-graph prompt id is in the catalog", () => {
    const fragmentIds = ibatexasPromptFragments().map((f) => f.id);
    // Guard the guard: if the fragment graph ever returns nothing, an empty
    // set would satisfy this test vacuously.
    expect(fragmentIds.length).toBeGreaterThan(0);

    const missing = fragmentIds.filter((id) => !catalogIds.has(id)).sort();
    expect(
      missing,
      `Prompt ids composed into the model-facing surface but absent from PROMPT_CATALOG:\n` +
        missing.map((id) => `  - ${id}`).join("\n") +
        `\nAdd a PromptCatalogEntry for each, or the qa-viewer Prompts view cannot show them.`,
    ).toEqual([]);
  });

  it("every literal resolvePrompt() id is in the catalog", () => {
    const sites = literalResolvePromptSites();
    // Guard the guard: the scan must actually find call sites. A refactor that
    // renames resolvePrompt, or a broken path, would otherwise pass silently.
    expect(sites.size).toBeGreaterThan(0);

    const missing = [...sites.keys()].filter((id) => !catalogIds.has(id)).sort();
    const detail = missing
      .map((id) => `  - ${id}  (wired at ${sites.get(id)!.join(", ")})`)
      .join("\n");
    expect(
      missing,
      `Prompt ids wired through resolvePrompt() but absent from PROMPT_CATALOG:\n${detail}\n` +
        `These are LIVE-editable — an override for them takes effect at runtime — ` +
        `while the operator surface cannot enumerate them.`,
    ).toEqual([]);
  });

  it("the ops claim-planner persona specifically is catalogued and wired", () => {
    // F-67's named instance, pinned by NAME rather than by count so that
    // deleting the row reds this test and not merely a total.
    const entry = PROMPT_CATALOG.find((e) => e.id === "ops/claim-planner.persona");
    expect(entry, "ops/claim-planner.persona missing from PROMPT_CATALOG").toBeDefined();
    expect(entry!.wired).toBe(true);
    expect(entry!.stage).toBe("ops");
    // The catalogued default must be the text the ops conductor actually falls
    // back to — a row pointing at the wrong constant would list a prompt the
    // operator edits to no effect.
    expect(entry!.source).toContain("propose_claim");
    expect(literalResolvePromptSites().has("ops/claim-planner.persona")).toBe(true);
  });

  it("no catalog entry claims to be wired without a resolvePrompt carrier", () => {
    // The converse direction: `wired: true` is a promise to the operator that
    // an edit takes effect. Verify each such id is reachable by one of the two
    // carriers rather than trusting the flag.
    const fragmentIds = new Set(ibatexasPromptFragments().map((f) => f.id));
    const literalIds = new Set(literalResolvePromptSites().keys());
    const unbacked = PROMPT_CATALOG.filter(
      (e) => e.wired && !fragmentIds.has(e.id) && !literalIds.has(e.id),
    )
      .map((e) => e.id)
      .sort();
    expect(
      unbacked,
      `Catalog entries marked wired:true with no resolvePrompt carrier — an ` +
        `operator edit to these would be silently ignored:\n` +
        unbacked.map((id) => `  - ${id}`).join("\n"),
    ).toEqual([]);
  });
});
