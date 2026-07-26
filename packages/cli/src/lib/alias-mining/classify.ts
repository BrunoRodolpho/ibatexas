// classify.ts — deciding what each mined candidate IS (LE2-026).
//
// A mined surface form is not automatically an alias. Before an owner is asked
// to approve anything, the miner has to separate four genuinely different
// answers, because they need four different actions:
//
//   - it names something we sell, under a name the catalog does not know
//        -> propose an alias edge                      (`propose-alias`)
//   - it names something we DO NOT sell
//        -> a product decision, not an alias           (`catalog-gap`)
//   - it IS the canonical name, or already an alias
//        -> nothing to do                              (`already-canonical` /
//                                                       `already-aliased`)
//   - the extractor mis-read a verb phrase as a noun
//        -> discard                                    (`noise`)
//
// # Why classification is measured against the LIVE roster
//
// This is the module's load-bearing design decision and it was paid for.
//
// LE2-025a's gazetteer header states, as fact, that `refrigerante` is a catalog
// gap — "there is NO soft-drink handle in the seed at all". That is false:
// `apps/commerce/src/seed-data.ts` seeds a published `refrigerante` product with
// Coca-Cola and Guaraná Antarctica variants, and it is live in the store. The
// error is instructive rather than embarrassing, because the same header's
// "Reconciliation, deferred" section says plainly that the catalog package
// CANNOT prove a canonical name resolves to a live product — and then the header
// made exactly that live-store claim anyway, from a package-local view.
//
// So this module never asks the catalog what exists. It takes a {@link Roster}
// read from the live store and asks THAT. A gap row therefore means "the miner
// looked at the products table and found nothing", which is a claim a reviewer
// can re-run, rather than "nobody remembered a product existed", which is a
// claim that survives review by being confidently phrased.
//
// # Why the embedder cannot reach this file
//
// Ranking may use embeddings (`rank.ts`); classification may not, and the
// separation is deliberate. If a similarity score could flip a row from
// `catalog-gap` to `propose-alias`, the report's CONTENT would depend on whether
// an ollama host happened to be reachable — two runs, two different owner
// decisions, no way to tell them apart afterwards. Classification here is a pure
// function of (mentions, roster, gazetteer) and is byte-identical with the
// embedder up or down. Embeddings only ever reorder rows and fill an advisory
// column.
//
// Pure: no clock, no RNG, no IO, no `process.env`.

import { normalizeProseForm } from "@ibatexas/catalog"
import type { CandidateMention, MiningSource } from "./extract.js"

/**
 * What a candidate turned out to be. The report groups by this, and each group
 * asks the owner a different question.
 */
export const ROW_TYPES = [
  "propose-alias",
  "needs-disambiguation",
  "variant-target",
  "catalog-gap",
  "already-canonical",
  "already-aliased",
  "noise",
] as const

/** One classification outcome. */
export type RowType = (typeof ROW_TYPES)[number]

/** One product as the LIVE store knows it. */
export interface RosterProduct {
  /** kebab-case handle — what an `AliasEdge.canonical` would name. */
  readonly handle: string
  /** Natural pt-BR title, e.g. "Costela Bovina Defumada". */
  readonly title: string
  /** Variant titles, e.g. ["Coca-Cola", "Guaraná Antarctica"]. */
  readonly variantTitles: readonly string[]
}

/** One category as the live store knows it. */
export interface RosterCategory {
  readonly handle: string
  readonly name: string
}

/** The live store's canonical vocabulary — the ground truth for classification. */
export interface Roster {
  readonly products: readonly RosterProduct[]
  readonly categories: readonly RosterCategory[]
}

/** One already-declared alias surface, folded. Read from the catalog gazetteer. */
export interface KnownAlias {
  readonly surface: string
  readonly canonical: string
}

/** A fully classified candidate, ready to rank and render. */
export interface ClassifiedCandidate {
  /** Folded surface form — the identity of the row. */
  readonly surface: string
  /** The customer's own spelling, for the report. */
  readonly display: string
  /** What this is, and therefore what the owner is being asked. */
  readonly rowType: RowType
  /**
   * The canonical handle a `propose-alias` row would point at. Present only for
   * `propose-alias`; a `needs-disambiguation` row carries its options in
   * {@link targets} instead, and the other row types have no target at all.
   */
  readonly target?: string
  /** Every roster entry the surface matched — 0, 1 or many. */
  readonly targets: readonly string[]
  /** Distinct utterances that evidence this row. */
  readonly evidence: number
  /** Sources that contributed evidence, deduplicated and stably ordered. */
  readonly sources: readonly MiningSource[]
  /** Distinct utterances, raw — the renderer scrubs them. */
  readonly examples: readonly string[]
  /** One clause explaining the classification, shown in the report. */
  readonly why: string
}

/** Minimum characters before a prefix match is allowed to mean anything. */
const MIN_PREFIX = 4

/** Fold a kebab-case handle into word space: `costela-bovina` -> `costela bovina`. */
function foldHandle(handle: string): string {
  return normalizeProseForm(handle.replace(/-/g, " "))
}

/**
 * Strip a pt-BR plural `-s` from each word of a folded surface.
 *
 * A blunt rule, on purpose. The catalog package deliberately refuses to guess at
 * plurals — its gazetteer stores literal surface forms and its module doc says
 * "whether 'costelas' and 'costela' are the same WORD is a language question the
 * runtime canonicalizer owns, and a build gate that guessed at it would reject
 * authored data over a linguistic opinion". That reasoning binds a BUILD GATE.
 * It does not bind an advisory miner whose output a human approves, and the
 * cost of not guessing here was measured: `costelas`, `Farofas`, `linguicas` and
 * `costelas bovinas defumadas` were all reported as CATALOG GAPS — the miner
 * claiming the store sells no costela.
 *
 * The guess is confined to matching and never reaches the report's proposal:
 * an approved row still writes the surface the customer actually typed.
 */
function singularize(surface: string): string {
  return surface
    .split(" ")
    .map((w) => (w.length >= 4 && w.endsWith("s") ? w.slice(0, -1) : w))
    .join(" ")
}

/**
 * Does `surface` name `name`?
 *
 * Three readings count, in descending strength:
 *   - the whole folded name          ("costela bovina defumada")
 *   - one whole word of the name     ("brisket" in "Brisket Americano")
 *   - a >= 4-char prefix of one word ("linguic" for "linguiça")
 *
 * The prefix floor exists so "co" does not match "Coleslaw", "Costela" and
 * "Coca-Cola" at once and drown the report in false ambiguity.
 */
function namesExactly(surface: string, name: string): boolean {
  const folded = normalizeProseForm(name)
  if (folded === surface) return true
  const words = folded.split(" ")
  if (words.includes(surface)) return true
  if (surface.length < MIN_PREFIX) return false
  return words.some((w) => w.length >= MIN_PREFIX && w.startsWith(surface))
}

/** {@link namesExactly}, retried against the de-pluralized surface. */
function namesIt(surface: string, name: string): boolean {
  if (namesExactly(surface, name)) return true
  const singular = singularize(surface)
  return singular !== surface && namesExactly(singular, name)
}

/** True when only the de-pluralized reading matched — reported in the `why`. */
function matchedViaPlural(surface: string, name: string): boolean {
  return !namesExactly(surface, name) && namesIt(surface, name)
}

/**
 * Classify one candidate against the live roster and the declared gazetteer.
 *
 * Precedence is strict and matters: a surface that is BOTH already declared and
 * a canonical name is reported as `already-aliased`, because the row an owner
 * would act on is the one that already exists.
 */
export function classifyCandidate(
  surface: string,
  display: string,
  mentions: readonly CandidateMention[],
  roster: Roster,
  gazetteer: readonly KnownAlias[],
): ClassifiedCandidate {
  const examples = [...new Set(mentions.map((m) => m.utterance))]
  const sources = [...new Set(mentions.map((m) => m.source))].sort()
  const evidence = examples.length
  const base = { surface, display, evidence, sources, examples }

  // 1. Already declared as an alias — nothing to propose.
  const declared = gazetteer.find((a) => a.surface === surface)
  if (declared !== undefined) {
    return {
      ...base,
      rowType: "already-aliased",
      targets: [declared.canonical],
      why: `already in the gazetteer, pointing at \`${declared.canonical}\``,
    }
  }

  // 2. It IS a canonical name. This is the branch that catches the mistake
  //    LE2-025a made about `refrigerante`: the word is not an alias for the
  //    product, it is the product's own name.
  const canonicalProduct = roster.products.find(
    (p) => normalizeProseForm(p.title) === surface || foldHandle(p.handle) === surface,
  )
  if (canonicalProduct !== undefined) {
    return {
      ...base,
      rowType: "already-canonical",
      targets: [canonicalProduct.handle],
      why: `the store's own name for \`${canonicalProduct.handle}\` — no alias needed`,
    }
  }
  const canonicalCategory = roster.categories.find(
    (c) => normalizeProseForm(c.name) === surface || foldHandle(c.handle) === surface,
  )
  if (canonicalCategory !== undefined) {
    return {
      ...base,
      rowType: "already-canonical",
      targets: [canonicalCategory.handle],
      why: `the store's own category name (\`${canonicalCategory.handle}\`)`,
    }
  }

  // 3. It names a VARIANT. Real, resolvable, and NOT expressible as an alias
  //    edge today — `AliasEdge.canonical` is specified as a product or category
  //    handle, so "coca" -> the Coca-Cola variant of `refrigerante` has nowhere
  //    to land. Its own row type rather than a silent `propose-alias`, because
  //    an edge pointing at the parent product would resolve "coca" and "guaraná"
  //    to the SAME thing and quietly lose the customer's actual choice.
  const variantHits = roster.products.filter((p) =>
    p.variantTitles.some((v) => namesIt(surface, v)),
  )
  if (variantHits.length > 0) {
    const where = variantHits
      .map((p) => {
        const v = p.variantTitles.find((t) => namesIt(surface, t)) as string
        return `${p.handle}/${v}`
      })
      .sort()
    return {
      ...base,
      rowType: "variant-target",
      targets: where,
      why:
        `names a VARIANT (${where.join(", ")}), not a product — ` +
        "an AliasEdge cannot express a variant target today",
    }
  }

  // 4. It resolves to product(s) by name.
  const productHits = roster.products.filter(
    (p) => namesIt(surface, p.title) || namesIt(surface, foldHandle(p.handle)),
  )
  if (productHits.length === 1) {
    const hit = productHits[0] as RosterProduct
    const viaPlural =
      matchedViaPlural(surface, hit.title) && matchedViaPlural(surface, foldHandle(hit.handle))
    return {
      ...base,
      rowType: "propose-alias",
      target: hit.handle,
      targets: [hit.handle],
      why: viaPlural
        ? `the plural of a name for "${hit.title}" — the gazetteer stores surface forms literally, so the plural needs its own edge`
        : `resolves to exactly one product — "${hit.title}"`,
    }
  }
  if (productHits.length > 1) {
    const handles = productHits.map((p) => p.handle).sort()
    return {
      ...base,
      rowType: "needs-disambiguation",
      targets: handles,
      why:
        `names ${handles.length} products (${handles.join(", ")}) — an edge needs ` +
        "`disambiguatedBy`, or the build gate will reject it",
    }
  }
  const categoryHits = roster.categories.filter((c) => namesIt(surface, c.name))
  if (categoryHits.length === 1) {
    const hit = categoryHits[0] as RosterCategory
    return {
      ...base,
      rowType: "propose-alias",
      target: hit.handle,
      targets: [hit.handle],
      why: `resolves to exactly one category — "${hit.name}"`,
    }
  }

  // 5. Nothing in the store answers to this word. Whether that is a missing
  //    product or a mis-read verb phrase is the one call the roster cannot make,
  //    so it falls to the count-noun signal the extractor recorded.
  const quantified = mentions.some((m) => m.quantified)
  if (quantified) {
    return {
      ...base,
      rowType: "catalog-gap",
      targets: [],
      why:
        "customers ask for it by the unit and NOTHING in the live roster matches — " +
        "a product decision, not an alias",
    }
  }
  return {
    ...base,
    rowType: "noise",
    targets: [],
    why: "no roster match and never quantified — most likely a mis-read phrase",
  }
}

/**
 * Group mentions by surface form and classify each group.
 *
 * Output order is deterministic (surface ascending); `rank.ts` decides the order
 * the report actually shows.
 */
export function classifyAll(
  mentions: readonly CandidateMention[],
  roster: Roster,
  gazetteer: readonly KnownAlias[],
): readonly ClassifiedCandidate[] {
  const bySurface = new Map<string, CandidateMention[]>()
  for (const m of mentions) {
    const bucket = bySurface.get(m.surface)
    if (bucket === undefined) bySurface.set(m.surface, [m])
    else bucket.push(m)
  }
  return [...bySurface.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([surface, group]) =>
      classifyCandidate(
        surface,
        (group[0] as CandidateMention).display,
        group,
        roster,
        gazetteer,
      ),
    )
}
