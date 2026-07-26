// sources.ts — the miner's ONLY IO (LE2-026).
//
// Everything that touches a store lives here so the mining logic next door stays
// pure and testable. Four reads, in the order the ticket ranks them:
//
//   1. LABELLED EVENTS — VictoriaLogs, `funnel.tier` / `funnel.alias.resolved`
//      (LE2-025b, PR #426). The runtime itself labelling an alias miss, with the
//      surface form and candidate handles carried IN the record. Best evidence
//      available; also the newest, so on a fresh stack there may be none.
//   2. TRANSCRIPTS — Postgres `claustrum_memory_episodic.user_text`. Free text,
//      read-only, for words that never got far enough to be labelled.
//   3. THE LIVE ROSTER — Postgres `product` / `product_variant` /
//      `product_category`. Ground truth for classification.
//   4. THE EMBEDDER — a local ollama host, optional and advisory.
//
// # Failure posture: report, never fail
//
// A source that is down produces a `SourceReport` carrying the reason and zero
// records; it never aborts the run. This is the correct posture for an offline
// worksheet — a report that says "VictoriaLogs was unreachable, these rows are
// transcript-only" is useful and honest, while a crashed job at 3am is neither.
// The one thing that IS fatal is an unreachable roster, because classification
// without ground truth would silently relabel every row as a catalog gap.
//
// # Sourcing boundary
//
// Nothing in this file can reach `packages/journeys/extraction-corpus` or the
// extraction-eval fixtures. There is no filesystem read here at all — the only
// inputs are two live stores — which is the strongest available form of the
// guarantee: the boundary holds because the code has no path to cross it.

import { Client } from "pg"
import { queryLogs, VICTORIALOGS_URL, type LogEntry } from "../logs-query.js"
import { labelledMention, mentionsFrom, type CandidateMention } from "./extract.js"
import type { Roster, RosterCategory, RosterProduct } from "./classify.js"
import type { SourceReport } from "./report.js"

/** What one source read produced: its mentions plus its audit row. */
export interface SourceResult {
  readonly mentions: readonly CandidateMention[]
  readonly report: SourceReport
}

/** Connection string for the shared dev Postgres. */
function databaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    "postgresql://ibatexas:ibatexas@localhost:5433/ibatexas"
  )
}

/** Run one read-only query and always close the client. */
async function withPg<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl() })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

// ── 1. Labelled events ───────────────────────────────────────────────────────

/**
 * Read the runtime's own alias labels out of VictoriaLogs.
 *
 * Two record shapes, both emitted by `apps/api/src/claustrum/funnel-tier.ts`:
 *
 *   `funnel.tier` with `tier: "ALIAS"`, `reason: "alias_ambiguous"` — a clarify
 *     miss. Carries `surface` (the word that could not be resolved) and
 *     `candidates` (the handles it could have meant). This is a labelled
 *     CLARIFY turn, which is precisely what the ticket asks to mine.
 *
 *   `funnel.alias.resolved` — carries `resolutions`, an array of
 *     `"surface=>canonical"` strings for every alias that DID resolve. Mined
 *     too, because a resolution that keeps recurring is evidence the edge is
 *     load-bearing, and because a resolution the owner disagrees with is only
 *     visible if it is reported.
 *
 * The utterance itself is deliberately NOT in these records (the funnel logs
 * surfaces and handles, never customer prose), so the mention's `utterance` is
 * the surface form itself. That is a real evidence limit and the report shows it
 * as such rather than fabricating context.
 */
export async function readLabelledEvents(since: string): Promise<SourceResult> {
  const query = `_time:${since} component:="funnel" (event:="funnel.tier" OR event:="funnel.alias.resolved")`
  let entries: LogEntry[]
  try {
    entries = await queryLogs(query, 5000)
  } catch (err) {
    return {
      mentions: [],
      report: {
        name: "labelled-event (VictoriaLogs `funnel.tier` / `funnel.alias.resolved`)",
        query,
        records: 0,
        unavailable: `${VICTORIALOGS_URL} — ${(err as Error).message}`,
      },
    }
  }

  const mentions: CandidateMention[] = []
  for (const e of entries) {
    if (e.event === "funnel.tier" && e.tier === "ALIAS") {
      const surface = typeof e.surface === "string" ? e.surface : ""
      if (surface.length > 0) mentions.push(labelledMention(surface, surface))
      continue
    }
    if (e.event === "funnel.alias.resolved" && Array.isArray(e.resolutions)) {
      for (const r of e.resolutions) {
        if (typeof r !== "string") continue
        const surface = (r.split("=>")[0] ?? "").trim()
        if (surface.length > 0) mentions.push(labelledMention(surface, surface))
      }
    }
  }

  return {
    mentions,
    report: {
      name: "labelled-event (VictoriaLogs `funnel.tier` / `funnel.alias.resolved`)",
      query,
      records: entries.length,
    },
  }
}

// ── 2. Transcripts ───────────────────────────────────────────────────────────

/**
 * Read recorded customer utterances from the episodic memory store.
 *
 * DISTINCT on `user_text`: the evidence unit is "a thing somebody said", and
 * counting one retried message five times would inflate a candidate past a word
 * five different customers used. The `decision_kind` filter is deliberately
 * absent — a CLARIFY miss can surface as any terminal, and narrowing to one
 * would silently drop evidence the ticket asks for.
 */
export async function readTranscripts(limit: number): Promise<SourceResult> {
  const sql =
    "SELECT DISTINCT user_text FROM claustrum_memory_episodic " +
    "WHERE user_text IS NOT NULL AND user_text <> '' LIMIT $1"
  try {
    const utterances = await withPg(async (c) => {
      const res = await c.query<{ user_text: string }>(sql, [limit])
      return res.rows.map((r) => r.user_text)
    })
    return {
      mentions: mentionsFrom(utterances, "transcript"),
      report: {
        name: "transcript (Postgres `claustrum_memory_episodic.user_text`)",
        query: `${sql} — limit ${limit}`,
        records: utterances.length,
      },
    }
  } catch (err) {
    return {
      mentions: [],
      report: {
        name: "transcript (Postgres `claustrum_memory_episodic.user_text`)",
        query: sql,
        records: 0,
        unavailable: (err as Error).message,
      },
    }
  }
}

// ── 3. The live roster ───────────────────────────────────────────────────────

/**
 * Read the store's canonical vocabulary — every published product with its
 * variant titles, and every category.
 *
 * Throws when unreachable, and that is the one fatal source: classification
 * against an empty roster would report the entire catalog as a gap, which is
 * both wrong and expensive to act on.
 */
export async function readRoster(): Promise<Roster> {
  return withPg(async (c) => {
    const products = await c.query<{
      handle: string
      title: string
      variant_titles: string[] | null
    }>(
      `SELECT p.handle, p.title,
              array_remove(array_agg(v.title ORDER BY v.title), NULL) AS variant_titles
         FROM product p
         LEFT JOIN product_variant v
                ON v.product_id = p.id AND v.deleted_at IS NULL
        WHERE p.deleted_at IS NULL
        GROUP BY p.handle, p.title`,
    )
    const categories = await c.query<{ handle: string; name: string }>(
      "SELECT handle, name FROM product_category WHERE deleted_at IS NULL",
    )
    return {
      products: products.rows.map(
        (r): RosterProduct => ({
          handle: r.handle,
          title: r.title,
          variantTitles: r.variant_titles ?? [],
        }),
      ),
      categories: categories.rows.map((r): RosterCategory => ({ handle: r.handle, name: r.name })),
    }
  })
}

// ── 4. The embedder (optional, advisory) ─────────────────────────────────────

/** Ollama embeddings endpoint; unset means frequency-only ranking. */
function embedUrl(): string | undefined {
  return process.env.OLLAMA_EMBED_URL
}

/** Embedding model id. */
function embedModel(): string {
  return process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text"
}

/**
 * Embed a batch of strings, or return `undefined` when no embedder is
 * configured or reachable.
 *
 * `undefined` is not an error path — it is the documented `frequency-only`
 * ranking mode, and the report says which mode produced it.
 */
export async function embedAll(
  texts: readonly string[],
): Promise<readonly (readonly number[])[] | undefined> {
  const base = embedUrl()
  if (base === undefined || texts.length === 0) return undefined
  const out: number[][] = []
  try {
    for (const text of texts) {
      const res = await fetch(`${base.replace(/\/+$/, "")}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: embedModel(), prompt: text }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) return undefined
      const json = (await res.json()) as { embedding?: number[] }
      if (!Array.isArray(json.embedding)) return undefined
      out.push(json.embedding)
    }
  } catch {
    return undefined
  }
  return out
}

/** Describe the embedder for the report header. */
export function embedderDescription(available: boolean): string {
  const base = embedUrl()
  if (base === undefined) return "not configured (`OLLAMA_EMBED_URL` unset) — ranking by frequency"
  if (!available) return `\`${embedModel()}\` at ${base} — UNREACHABLE, ranking degraded to frequency`
  return `\`${embedModel()}\` at ${base}`
}
