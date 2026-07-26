// report.ts — the owner-approval artifact (LE2-026).
//
// Ticket 26: "produces an owner-approval report ... Report format supports
// approve/reject per candidate ... Approved entries enter the catalog through
// the normal review flow as versioned data."
//
// Two things this file is careful about.
//
// # 1. The report is a WORKSHEET, not a changelog
//
// Every row carries a pair of checkboxes an owner ticks, the evidence that
// justifies the decision, and the exact edit approving it implies. It is meant
// to be read once, marked up, and thrown away — which is why it is markdown and
// why it is written OUTSIDE the repo by default (see `MINING_OUTPUT_NOTE`).
// The durable artifact of a mining run is the gazetteer diff it causes, reviewed
// as a normal PR; the miner never writes `alias-gazetteer.ts` itself. That
// separation is the ticket's "normal review flow as versioned data" criterion,
// and it is also the only thing keeping a mining bug out of the runtime.
//
// # 2. The examples are customer speech, so they are scrubbed
//
// Evidence is worthless without an example utterance, and an example utterance
// is raw customer text. Scrubbing runs through `@ibatexas/pii`'s PII_PATTERNS —
// the repo's single PII taxonomy, the same set the audit redactor and the
// decision-layer classification guard use — so the report cannot drift from the
// rest of the system on what counts as PII.
//
// Pure: no clock (the caller passes `generatedAt`), no RNG, no IO.

import { PII_PATTERNS, PII_SENTINELS } from "@ibatexas/pii"
import type { RowType } from "./classify.js"
import type { RankedCandidate, RankMode } from "./rank.js"

/**
 * Report schema version. Bump when a consumer would have to change: the row
 * grammar, the checkbox syntax, or the header contract. The number is in the
 * artifact so a stale report is recognisable as stale.
 */
export const REPORT_SCHEMA_VERSION = 1

/** Longest example utterance kept, in characters. */
const EXAMPLE_CAP = 200

/** How many example utterances are shown per row. */
const EXAMPLES_PER_ROW = 3

/**
 * Mask anything the repo's PII taxonomy recognises, then anything that looks
 * like an identifier.
 *
 * The second pass is miner-local and deliberately wider than `PII_PATTERNS`:
 * order references ("o pedido 947310") are not PII under the repo's taxonomy,
 * but they are a direct handle onto one customer's order, and no alias decision
 * has ever needed one. A digit run of four or more becomes `[num]`; shorter runs
 * survive because they are quantities and sizes ("coca 2L", "350ml"), which are
 * exactly the product detail a reviewer needs.
 */
export function scrubUtterance(text: string): string {
  let out = text
  for (const { pattern, redact } of PII_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), (m) => redact(m))
  }
  out = out.replace(/(?<!\d)\d{4,}(?!\d)/g, "[num]")
  return out.length > EXAMPLE_CAP
    ? `${out.slice(0, EXAMPLE_CAP)}… ${PII_SENTINELS.TRUNCATED}`
    : out
}

/**
 * The limits of what the LABELLED-EVENT source can see. Stated in every report
 * rather than fixed here: correcting either would mean changing what the runtime
 * emits, which is a runtime change and outside an offline miner's remit.
 */
export const MEASUREMENT_LIMITS: readonly string[] = [
  "**Only the FIRST ambiguous surface of a turn is logged.** `stampAliasClarify` " +
    "records `detail.ambiguousSurfaces` (the count) on the stage but does not put it on " +
    "the log line, and emits only `ambiguous[0]`. A turn where a customer used two " +
    "unresolvable words contributes one, and nothing downstream can tell that from a " +
    "turn that used one. Evidence counts on ALIAS-tier rows are therefore a LOWER BOUND.",
  "**Labelled events are log lines only** — a zero-call turn writes no `turn_trace` row " +
    "by design, so there is no database copy to reconcile against and no way to " +
    "reconstruct a missed surface after the fact.",
  "**No backfill exists.** The log retention window IS the entire historical record. A " +
    "clarify-miss older than the window is gone permanently, not merely un-queried — " +
    "which is why the cadence in the runbook is a floor, not a suggestion.",
]

/** Everything the header has to state for the report to be auditable. */
export interface ReportContext {
  /** ISO timestamp — injected, never read from a clock in here. */
  readonly generatedAt: string
  /** Which ranking signals were available. */
  readonly mode: RankMode
  /**
   * The labelled-event query window (a LogsQL duration like `30d`).
   *
   * Recorded prominently because logs are the only copy: a report says what it
   * covered, so a reader can tell "no ALIAS rows" (a finding) from "we looked
   * back seven days" (a window).
   */
  readonly window: string
  /** Human description of each source that was queried, and what it returned. */
  readonly sources: readonly SourceReport[]
  /** The gazetteer's declared edge count at mining time. */
  readonly gazetteerSize: number
  /** Live roster sizes, so a reviewer can tell WHICH store answered. */
  readonly rosterProducts: number
  readonly rosterCategories: number
  /** Embedder endpoint + model when one was used; a reason when it was not. */
  readonly embedder: string
}

/** One source's contribution, reported whether or not it returned anything. */
export interface SourceReport {
  /** Display name, e.g. "labelled-event (VictoriaLogs funnel.tier)". */
  readonly name: string
  /** Exact query/window used, so the run is reproducible. */
  readonly query: string
  /** Utterances (or records) the source returned. */
  readonly records: number
  /** Populated when the source could not be reached — reported, never fatal. */
  readonly unavailable?: string
}

/** Section headings + the question each group asks the owner. */
const SECTIONS: ReadonlyArray<{ readonly type: RowType; readonly title: string; readonly ask: string }> = [
  {
    type: "propose-alias",
    title: "Propose alias",
    ask: "Approving adds one `AliasEdge` to `packages/catalog/src/alias-gazetteer.ts`.",
  },
  {
    type: "needs-disambiguation",
    title: "Needs disambiguation",
    ask:
      "The surface names more than one product. Approving means authoring one edge PER reading, " +
      "each with a `disambiguatedBy` token — the `alias-gazetteer` compile pass rejects anything less.",
  },
  {
    type: "variant-target",
    title: "Variant target — needs a shape decision",
    ask:
      "The surface names a product VARIANT. `AliasEdge.canonical` is a product or category handle, " +
      "so these cannot be expressed today. Approving means deciding to widen the edge shape first; " +
      "an edge pointing at the parent product would collapse two variants into one and lose the " +
      "customer's actual choice.",
  },
  {
    type: "catalog-gap",
    title: "Catalog gap — no product to alias",
    ask:
      "Customers ask for this by the unit and the live roster has nothing matching. This is a product " +
      "decision, not an alias one. An alias pointing at a handle that does not exist would turn a clear " +
      "request into a SILENT MISS, which is worse than the clarify it replaces.",
  },
  {
    type: "already-aliased",
    title: "Already aliased",
    ask: "No action — recorded so the evidence behind an existing edge stays visible.",
  },
  {
    type: "already-canonical",
    title: "Already canonical",
    ask: "No action — the word is the store's own name for the thing, not a colloquial for it.",
  },
  {
    type: "noise",
    title: "Noise",
    ask: "No action — extraction artefacts, listed so the extractor's error rate is visible.",
  },
]

/** The standing note on where reports live and why they are not committed. */
export const MINING_OUTPUT_NOTE =
  "Reports contain real customer utterances. They are PII-scrubbed through the repo's " +
  "`@ibatexas/pii` taxonomy, but scrubbing is a filter and not a proof, and a worksheet has no " +
  "reason to be durable. Reports therefore default to `scratch/language-engine-2/results/` — " +
  "outside the repository — alongside every other LE2 measurement artifact. What gets committed " +
  "is the gazetteer diff an approved row produces, reviewed as a normal PR."

function checkbox(surface: string): string {
  return `  - [ ] **approve** \`${surface}\`\n  - [ ] **reject** \`${surface}\``
}

function renderRow(c: RankedCandidate): string {
  const lines: string[] = []
  const arrow =
    c.target !== undefined
      ? ` → \`${c.target}\``
      : c.targets.length > 0
        ? ` → ${c.targets.map((t) => `\`${t}\``).join(" | ")}`
        : ""
  // The surface is scrubbed too, not just the example utterances. A candidate
  // surface is raw customer text on BOTH paths: the transcript path lifts it out
  // of an utterance, and on the labelled path `surface` / `resolutions` are
  // customer words the runtime's pino redact list cannot reach (it redacts by
  // field name, and these fields hold free text). Scrubbing only the examples
  // would have put an unredacted customer word in the row heading and in the
  // approve/reject tokens — the two places a reader is guaranteed to look.
  const display = scrubUtterance(c.display)
  lines.push(
    `#### ${c.rank}. \`${display}\`${arrow}`,
    "",
    `- **evidence:** ${c.evidence} distinct utterance${c.evidence === 1 ? "" : "s"}`,
    `- **source:** ${c.sources.join(", ")}`,
    `- **why:** ${c.why}`,
  )
  if (c.nearest !== undefined) {
    lines.push(
      `- **nearest canonical (advisory):** \`${c.nearest.handle}\` ` +
        `(cosine ${c.nearest.similarity.toFixed(3)})`,
    )
  }
  lines.push("- **examples:**")
  for (const ex of c.examples.slice(0, EXAMPLES_PER_ROW)) {
    lines.push(`  - "${scrubUtterance(ex)}"`)
  }
  lines.push("- **decision:**", checkbox(display), "")
  return lines.join("\n")
}

/** Render the full markdown report. */
export function renderReport(
  candidates: readonly RankedCandidate[],
  ctx: ReportContext,
): string {
  const out: string[] = []
  const counts = new Map<RowType, number>()
  for (const c of candidates) counts.set(c.rowType, (counts.get(c.rowType) ?? 0) + 1)

  out.push(
    `# Alias mining report — ${ctx.generatedAt.slice(0, 10)}`,
    "",
    `**Schema:** v${REPORT_SCHEMA_VERSION} · **Generated:** ${ctx.generatedAt}`,
    `**Labelled-event window:** \`${ctx.window}\` — see "What this report could not see"`,
    `**Ranking mode:** \`${ctx.mode}\` · **Embedder:** ${ctx.embedder}`,
  )
  out.push(
    `**Measured against:** ${ctx.rosterProducts} live products, ` +
      `${ctx.rosterCategories} categories, ${ctx.gazetteerSize} declared alias edges`,
  )
  out.push("")

  out.push("## Sources", "", "| Source | Query | Records |", "|---|---|---|")
  for (const s of ctx.sources) {
    const records = s.unavailable === undefined ? String(s.records) : `— (${s.unavailable})`
    out.push(`| ${s.name} | \`${s.query}\` | ${records} |`)
  }
  out.push("")
  out.push(
    "> **Sourcing boundary.** Nothing here is mined from `packages/journeys/extraction-corpus` " +
      "or the extraction-eval fixtures. That corpus is the hard gate for every parser change, and " +
      "mining it would convert the gate into training data. Every row states its source so the " +
      "boundary is checkable rather than asserted.",
  )
  out.push("")

  out.push("## How an approved row reaches the catalog", "")
  out.push(
    "The miner never writes `alias-gazetteer.ts`. Approving a row is a request for a normal, " +
      "reviewed, versioned edit:",
  )
  out.push("")
  out.push("1. Tick **approve** on the rows you want.")
  out.push(
    "2. Add one `AliasEdge` per approved row to `ALIAS_GAZETTEER` in " +
      "`packages/catalog/src/alias-gazetteer.ts`, with `provenance: \"production-utterance\"` " +
      "(every row here is grounded in real traffic) and a `why` clause taken from the evidence.",
  )
  out.push(
    "3. Run the catalog build gates. The `alias-gazetteer` pass enforces the ambiguity rule " +
      "(`disambiguatedBy` required on a surface naming two entities) and the allergen/dietary " +
      "safety binding — an approved row that violates either fails the build rather than shipping.",
  )
  out.push("4. Open a PR. The gazetteer diff is the durable, reviewable record of this run.")
  out.push("")
  out.push(`> ${MINING_OUTPUT_NOTE}`)
  out.push("")

  out.push("## Method, and what it cannot see", "")
  out.push(
    "Candidates are the OBJECTS OF REQUESTS — the noun phrase after an ordering verb and an " +
      "optional article or quantity (`quero uma coca` → `coca`). A request phrased with a verb the " +
      "extractor's lexicon does not hold contributes nothing at all: that is a recall limit, and it " +
      "is the safe direction to fail in when a human approves the output, because a missed candidate " +
      "costs another run and an invented one costs a wrong alias.",
  )
  out.push("")
  out.push(
    "Row types are decided against the **live product roster**, never against the catalog package's " +
      "own view. A `catalog-gap` row means the miner queried the products table and found nothing — " +
      "a claim you can re-run. Embeddings, when available, only reorder rows and fill the advisory " +
      "*nearest canonical* line; they cannot change a row's type, add a row or remove one, so the " +
      "report's content is identical with the embedder up or down.",
  )
  out.push("")
  out.push(
    "Every surface and every example utterance printed below is scrubbed — the surfaces too, not " +
      "just the examples. On the labelled path `surface` and `resolutions` are free customer text " +
      "that the runtime's field-name-based redact list does not reach.",
  )
  out.push("")

  out.push(`## What this report could not see (labelled-event window: \`${ctx.window}\`)`, "")
  for (const limit of MEASUREMENT_LIMITS) out.push(`- ${limit}`)
  out.push("")

  out.push("## Summary", "", "| Row type | Rows |", "|---|---|")
  for (const { type } of SECTIONS) out.push(`| ${type} | ${counts.get(type) ?? 0} |`)
  out.push(`| **total** | **${candidates.length}** |`, "")

  for (const section of SECTIONS) {
    const rows = candidates.filter((c) => c.rowType === section.type)
    out.push(`## ${section.title} (${rows.length})`, "", `> ${section.ask}`, "")
    if (rows.length === 0) {
      out.push("_None._", "")
      continue
    }
    for (const row of rows) out.push(renderRow(row))
  }

  return `${out.join("\n").trimEnd()}\n`
}
