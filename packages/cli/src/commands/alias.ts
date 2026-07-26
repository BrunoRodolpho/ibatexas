// alias.ts — `ibx alias mine`, the LE2-026 alias-mining loop.
//
// An OFFLINE job. It reads two recorded stores, classifies what customers called
// things against the live product roster, and writes a ranked worksheet an owner
// ticks. It writes nothing back: not to the catalog, not to the runtime, not to
// any store it reads. The only way a mined candidate becomes behavior is a human
// editing `packages/catalog/src/alias-gazetteer.ts` in a reviewed PR, which is
// the ticket's "approved entries enter the catalog through the normal review
// flow as versioned data" criterion and also the reason mining cannot regress
// the runtime.
//
// Run cadence, and what triggers a rerun: see `docs/ops/runbooks/alias-mining.md`.

import fs from "node:fs"
import path from "node:path"
import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { ALIAS_GAZETTEER, normalizeAliasSurface } from "@ibatexas/catalog"
import { ROOT } from "../utils/root.js"
import { classifyAll, type KnownAlias } from "../lib/alias-mining/classify.js"
import { cosineSimilarity, rankCandidates, type NearestCanonical, type RankMode } from "../lib/alias-mining/rank.js"
import {
  REPORT_SCHEMA_VERSION,
  renderReport,
  scrubUtterance,
  type ReportContext,
  type SourceReport,
} from "../lib/alias-mining/report.js"
import {
  assertValidWindow,
  embedAll,
  embedderDescription,
  readLabelledEvents,
  readRoster,
  readTranscripts,
} from "../lib/alias-mining/sources.js"
import type { CandidateMention } from "../lib/alias-mining/extract.js"

/**
 * Where reports land: the LE2 measurement directory, OUTSIDE the repository.
 * Reports carry real (scrubbed) customer utterances and are worksheets rather
 * than artifacts — see `report.ts`'s `MINING_OUTPUT_NOTE`.
 *
 * Env-configurable because the default is only right for the MAIN checkout: it
 * is resolved as a sibling of the repo root, and from a git worktree under
 * `.claude/worktrees/` that sibling is a different (wrong, and newly created)
 * directory. `ALIAS_MINE_OUT_DIR` is how a worktree run points at the real one.
 */
function defaultOutDir(): string {
  return (
    process.env.ALIAS_MINE_OUT_DIR ??
    path.resolve(ROOT, "..", "scratch", "language-engine-2", "results")
  )
}

/** The gazetteer as the classifier wants it: folded surfaces. */
function knownAliases(): readonly KnownAlias[] {
  return ALIAS_GAZETTEER.map((e) => ({
    surface: normalizeAliasSurface(e.surface),
    canonical: e.canonical,
  }))
}

/**
 * Build the advisory nearest-canonical map.
 *
 * Embeds every candidate surface and every canonical product title, then keeps
 * the best pairing per surface. Returns an empty map — never throws — when the
 * embedder is absent, which is the `frequency-only` path.
 */
async function nearestCanonicals(
  surfaces: readonly string[],
  canonicals: readonly { handle: string; title: string }[],
): Promise<ReadonlyMap<string, NearestCanonical>> {
  const surfaceVecs = await embedAll(surfaces)
  if (surfaceVecs === undefined) return new Map()
  const canonicalVecs = await embedAll(canonicals.map((c) => c.title))
  if (canonicalVecs === undefined) return new Map()

  const out = new Map<string, NearestCanonical>()
  surfaces.forEach((surface, i) => {
    const sv = surfaceVecs[i]
    if (sv === undefined) return
    let best: NearestCanonical | undefined
    canonicals.forEach((c, j) => {
      const cv = canonicalVecs[j]
      if (cv === undefined) return
      const similarity = cosineSimilarity(sv, cv)
      if (best === undefined || similarity > best.similarity) {
        best = { handle: c.handle, similarity }
      }
    })
    if (best !== undefined) out.set(surface, best)
  })
  return out
}

interface MineOptions {
  since: string
  limit: string
  minEvidence: string
  out?: string
  embed: boolean
  stdout: boolean
  json: boolean
}

/**
 * The machine-readable projection of a report.
 *
 * Sorted by rank and free of the generation timestamp, so two runs over
 * unchanged stores diff cleanly — the repo's convention for a tool artifact
 * something else might consume. The markdown report keeps the timestamp,
 * because a worksheet a human marks up should say when it was taken.
 */
function toJson(
  ranked: readonly { rank: number; surface: string; rowType: string; target?: string; targets: readonly string[]; evidence: number; sources: readonly string[] }[],
  ctx: ReportContext,
): string {
  return `${JSON.stringify(
    {
      schemaVersion: REPORT_SCHEMA_VERSION,
      window: ctx.window,
      mode: ctx.mode,
      roster: { products: ctx.rosterProducts, categories: ctx.rosterCategories },
      gazetteerSize: ctx.gazetteerSize,
      sources: ctx.sources,
      candidates: [...ranked]
        .sort((a, b) => a.rank - b.rank)
        .map((c) => ({
          rank: c.rank,
          surface: scrubUtterance(c.surface),
          rowType: c.rowType,
          ...(c.target === undefined ? {} : { target: c.target }),
          targets: c.targets,
          evidence: c.evidence,
          sources: c.sources,
        })),
    },
    null,
    2,
  )}\n`
}

async function mine(opts: MineOptions): Promise<void> {
  const minEvidence = Number.parseInt(opts.minEvidence, 10)
  const limit = Number.parseInt(opts.limit, 10)
  // Refuse a malformed window rather than silently substituting one — the log
  // retention window is the only historical record there is.
  assertValidWindow(opts.since)
  if (!Number.isFinite(minEvidence) || minEvidence < 1) {
    throw new Error("--min-evidence must be a positive integer")
  }
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error("--limit must be a positive integer")
  }

  const spinner = ora("reading the live product roster").start()
  // Fatal by design: classifying against an empty roster would report the whole
  // catalog as a gap.
  const roster = await readRoster()
  spinner.succeed(
    `roster: ${roster.products.length} products, ${roster.categories.length} categories`,
  )

  spinner.start("reading labelled funnel events")
  const labelled = await readLabelledEvents(opts.since)
  if (labelled.report.unavailable !== undefined) {
    spinner.warn(`labelled events unavailable — ${labelled.report.unavailable}`)
  } else {
    spinner.succeed(
      `labelled events: ${labelled.report.records} records → ${labelled.mentions.length} mentions`,
    )
  }

  spinner.start("reading recorded transcripts")
  const transcripts = await readTranscripts(limit)
  if (transcripts.report.unavailable !== undefined) {
    spinner.warn(`transcripts unavailable — ${transcripts.report.unavailable}`)
  } else {
    spinner.succeed(
      `transcripts: ${transcripts.report.records} utterances → ${transcripts.mentions.length} mentions`,
    )
  }

  const mentions: readonly CandidateMention[] = [...labelled.mentions, ...transcripts.mentions]
  if (mentions.length === 0) {
    throw new Error(
      "no mentions from any source — nothing to mine. Check that the dev stack is up " +
        "(`ibx svc health`) and that the episodic memory store has recorded turns.",
    )
  }

  const classified = classifyAll(mentions, roster, knownAliases()).filter(
    (c) => c.evidence >= minEvidence,
  )

  let mode: RankMode = "frequency-only"
  let nearest: ReadonlyMap<string, NearestCanonical> = new Map()
  if (opts.embed) {
    spinner.start("embedding candidates (advisory)")
    nearest = await nearestCanonicals(
      classified.map((c) => c.surface),
      roster.products.map((p) => ({ handle: p.handle, title: p.title })),
    )
    if (nearest.size > 0) {
      mode = "embedding-assisted"
      spinner.succeed(`embedder: ${nearest.size} candidates scored`)
    } else {
      spinner.warn("embedder unreachable — ranking degraded to frequency")
    }
  }

  const ranked = rankCandidates(classified, nearest)
  const sources: readonly SourceReport[] = [labelled.report, transcripts.report]
  const generatedAt = new Date().toISOString()
  const ctx: ReportContext = {
    generatedAt,
    mode,
    window: opts.since,
    sources,
    gazetteerSize: ALIAS_GAZETTEER.length,
    rosterProducts: roster.products.length,
    rosterCategories: roster.categories.length,
    embedder: opts.embed
      ? embedderDescription(nearest.size > 0)
      : "disabled (`--no-embed`) — ranking by frequency",
  }
  const markdown = opts.json ? toJson(ranked, ctx) : renderReport(ranked, ctx)

  if (opts.stdout) {
    process.stdout.write(markdown)
    return
  }

  const ext = opts.json ? "json" : "md"
  const outPath =
    opts.out !== undefined
      ? path.resolve(opts.out)
      : path.join(defaultOutDir(), `26-alias-mining-${generatedAt.slice(0, 10)}.${ext}`)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, markdown, "utf8")

  const counts = new Map<string, number>()
  for (const r of ranked) counts.set(r.rowType, (counts.get(r.rowType) ?? 0) + 1)
  console.log()
  console.log(chalk.bold(`  ${ranked.length} candidate${ranked.length === 1 ? "" : "s"}, mode ${mode}`))
  for (const [type, n] of [...counts.entries()].sort()) {
    console.log(`    ${chalk.cyan(type.padEnd(22))} ${n}`)
  }
  console.log()
  console.log(`  report: ${chalk.green(outPath)}`)
  console.log(chalk.dim("  approve rows in place, then edit packages/catalog/src/alias-gazetteer.ts in a PR"))
  console.log()
}

/** Register `ibx alias …` onto the `alias` group command. */
export function registerAliasCommands(group: Command): void {
  group.description(
    "Alias gazetteer — offline mining of colloquial product names into an " +
      "owner-approval report (LE2-026). Reads recorded turns; writes no catalog data.",
  )

  group
    .command("mine")
    .description("Mine recorded turns into a ranked candidate-alias report for owner approval")
    .option("--since <window>", "LogsQL window for labelled funnel events", "30d")
    .option("--limit <n>", "max distinct transcript utterances to read", "5000")
    .option("--min-evidence <n>", "drop candidates below this many distinct utterances", "1")
    .option("--out <path>", `report path (default: ${defaultOutDir()}/26-alias-mining-<date>.md)`)
    .option("--no-embed", "skip the advisory embedder and rank by frequency alone")
    .option("--stdout", "print the report instead of writing it", false)
    .option("--json", "emit the machine-readable projection instead of the worksheet", false)
    .action(async (opts: MineOptions) => {
      try {
        await mine(opts)
      } catch (err) {
        console.error(chalk.red(`\n  alias mine failed: ${(err as Error).message}\n`))
        process.exitCode = 1
      }
    })
}
