// rank.ts — ordering the mined candidates for review (LE2-026).
//
// The ticket asks for a RANKED report, and the thing being ranked is an owner's
// attention. So the sort key is not "most interesting word", it is "soonest
// worth a decision":
//
//   1. actionability — a row that proposes a concrete catalog edit outranks a
//      row that only reports a fact. `propose-alias` before `catalog-gap`
//      before `already-canonical`, and `noise` last, always.
//   2. evidence — how many DISTINCT customers hit it. The one number in the
//      report that is a straight measurement.
//   3. label strength — a runtime-labelled miss (`funnel.tier` tier=ALIAS)
//      outranks a surface inferred from prose at the same evidence count,
//      because the runtime already said it failed on that word.
//   4. embedding similarity — advisory, ADDITIVE, and last among the signals.
//   5. the surface form itself — so the order is total and two runs over the
//      same data produce byte-identical reports.
//
// # The embedder is a tie-breaker, and the report says so
//
// Similarity enters at position 4 and nowhere else. It cannot change a row's
// type (see `classify.ts`), cannot add or remove a row, and cannot move a row
// past one with more evidence. With the embedder down, ranks 1-3 and 5 still
// produce a total order — the report degrades to `frequency-only` mode and says
// which mode produced it, which is the difference between a weaker report and
// an untrustworthy one.
//
// Pure: no clock, no RNG, no IO, no `process.env`.

import type { ClassifiedCandidate, RowType } from "./classify.js"

/** Which signals were available when the report was ranked. */
export const RANK_MODES = ["frequency-only", "embedding-assisted"] as const

/** The ranking mode a report was produced under. Printed in its header. */
export type RankMode = (typeof RANK_MODES)[number]

/** The nearest canonical entity by embedding, when an embedder was reachable. */
export interface NearestCanonical {
  /** The canonical handle. */
  readonly handle: string
  /** Cosine similarity in [-1, 1]. */
  readonly similarity: number
}

/** A classified candidate with its place in the review queue. */
export interface RankedCandidate extends ClassifiedCandidate {
  /** 1-based position in the global order. */
  readonly rank: number
  /** Advisory nearest-canonical hint; absent in `frequency-only` mode. */
  readonly nearest?: NearestCanonical
}

/**
 * Actionability tiers. Lower sorts first.
 *
 * `variant-target` sits directly behind `propose-alias` rather than with the
 * informational rows because it is also a decision an owner has to make — just
 * a decision about the alias SHAPE rather than about one edge.
 */
const ACTIONABILITY: Readonly<Record<RowType, number>> = {
  "propose-alias": 0,
  "needs-disambiguation": 1,
  "variant-target": 2,
  "catalog-gap": 3,
  "already-aliased": 4,
  "already-canonical": 5,
  noise: 6,
}

/** Cosine similarity of two equal-length vectors; 0 when either has no norm. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Put the candidates in review order.
 *
 * `nearest` is consulted by surface form and is entirely optional — passing an
 * empty map is exactly what happens when the embedder is unreachable, and it
 * yields the same order as omitting the argument.
 */
export function rankCandidates(
  candidates: readonly ClassifiedCandidate[],
  nearest: ReadonlyMap<string, NearestCanonical> = new Map(),
): readonly RankedCandidate[] {
  const labelled = (c: ClassifiedCandidate): number =>
    c.sources.includes("labelled-event") ? 0 : 1

  return [...candidates]
    .sort((a, b) => {
      const act = ACTIONABILITY[a.rowType] - ACTIONABILITY[b.rowType]
      if (act !== 0) return act
      if (a.evidence !== b.evidence) return b.evidence - a.evidence
      const lab = labelled(a) - labelled(b)
      if (lab !== 0) return lab
      const sa = nearest.get(a.surface)?.similarity ?? 0
      const sb = nearest.get(b.surface)?.similarity ?? 0
      if (sa !== sb) return sb - sa
      return a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0
    })
    .map((c, i) => {
      const hit = nearest.get(c.surface)
      return hit === undefined
        ? { ...c, rank: i + 1 }
        : { ...c, rank: i + 1, nearest: hit }
    })
}
