// THE ALIAS GAZETTEER — the colloquial names customers use for the things the
// catalog sells (LE2-025, compile half).
//
// Ticket 25: "Colloquial names resolve deterministically: 'pep', 'coquinha',
// 'calabresa americana' map to canonical entities through the catalog's alias
// gazetteer *before* the parse — feeding the L1 cache keys and L2 retrieval —
// and an unknown surface form clarifies, never nearest-neighbor guesses."
//
// This table is that gazetteer. It is DATA ONLY. Nothing reads it at request
// time yet: canonicalization at parse entry, the L1/L2 effects, the CLARIFY
// routing for an unknown surface form and the trace record of "why did it read
// pep as pepperoni" are the ticket's RUNTIME half and land separately. What is
// here is the surface those will consume, plus the build gates that make it
// trustworthy before anything depends on it — the same order LE2-033 landed
// the conversation projection in.
//
// # What an alias edge is
//
// One SURFACE FORM (what a customer types) and one CANONICAL name (what the
// system calls the thing). "farofa" is the whole product `Farofa de Bacon
// Defumado`; "brisket" is `brisket-americano`. The edge says nothing else —
// not a score, not a confidence, not a fallback ordering. A gazetteer that
// ranked guesses would be a nearest-neighbor matcher wearing a table's
// clothes, and the ticket rules that out in the same sentence it asks for the
// table.
//
// # Ambiguity is a COMPILE ERROR, not a runtime tie-break
//
// A surface form that names two entities and does not say how to tell them
// apart is rejected by the `alias-gazetteer` pass. This is the ticket's
// load-bearing acceptance criterion and it is worth being precise about why a
// build gate is the right place for it.
//
// The seed table below contains a real instance: the store sells BOTH
// `costela-bovina-defumada` and `costela-defumada-congelada`, and the
// intent_audit store holds real customers typing the bare word ("tira a
// costela do meu carrinho", "muda a costela para 3 unidades"). Every runtime
// resolution of that word is a coin flip between a fresh cut and a frozen one,
// and the two have different prices, different fulfilment and different
// expectations. There is no ordering of the table that makes the coin flip
// correct — so the table is not allowed to be silent. Either the author
// declares the token that separates the readings ({@link
// AliasEdge.disambiguatedBy}), or the build fails.
//
// What the runtime then does with an ambiguous-but-declared surface is its
// own decision (the ticket's answer: CLARIFY unless the utterance carries a
// disambiguating token). The catalog's job is only to guarantee the runtime is
// never handed an unanswerable question with no way to know it is one.
//
// # Canonical names are DECLARED, not verified
//
// A canonical name here is an opaque, well-shaped string. Nothing in this
// package proves `brisket-americano` is a product that exists — that is a live
// store question, of exactly the kind `external-references.ts` was built for,
// and answering it would need a reconciliation surface (a probe, a boot gate,
// an `ibx catalog check --live` leg) that this change deliberately does not
// build. See "Reconciliation, deferred" below.
//
// The strongest static statement available is therefore a SHAPE: every
// canonical name is a kebab-case ASCII handle, which is what CLAUDE.md's
// naming conventions already require of a product or category handle
// (`costela-bovina-defumada`). That is the same posture
// `external-references.ts` takes on `keyFrom`, and for the same reason: a
// compiler that read the world would compile differently on two machines.
//
// # Reconciliation, deferred (OPEN QUESTION FOR THE OWNER)
//
// Making alias targets verifiable-against-a-live-store means a new
// LE2-018-shaped gate: a `product` / `category` store in the external-reference
// union, a probe in `@ibatexas/tools`, and a boot refusal when a declared
// canonical name matches no row. That is a real decision with real blast
// radius (it would refuse to start any environment whose seed differs), and it
// is not made here. Until it is, a typo'd canonical name is caught by review
// and by the runtime finding nothing — never by a build gate.
//
// # Safety binding
//
// No alias edge may terminate in — or START from — an allergen or dietary
// attribute. That is the ratified conservative policy (BKL-143 / BKL-123 /
// BKL-171), enforced by the pass, and the reasoning for both directions is in
// `compiler/passes/alias-gazetteer.ts`. It is why this table holds food
// products and no ingredient, diet or restriction ever appears in it.
//
// # Surface forms are LITERAL
//
// "costela" is declared; "costelas" is not. The gazetteer holds the exact
// strings it holds, compared under {@link normalizeAliasSurface} (case,
// accent, punctuation and spacing folded — nothing else). Plurals, stems and
// inflections are the runtime canonicalizer's business; if it turns out to
// need the plural spelled out, that is a row in this table, not a change to
// what a row means.
//
// Pure: no clock, no RNG, no IO, no `process.env`.

import { normalizeProseForm } from "./text-normalization.js"

/**
 * Where an alias's SURFACE FORM came from — the review surface, in the
 * provenance discipline LE2-033 established for the conversation projection.
 *
 * The tag is about the surface, never about the canonical target: every
 * canonical name below is a handle that appears in this repo's own seed data,
 * whatever the surface's grounding.
 *
 *   `production-utterance` — the surface form was READ from a real customer
 *     utterance in the `intent_audit` store. Grounded: somebody actually typed
 *     this word at the system.
 *
 *   `authored` — a freely authored colloquial. Plausible pt-BR, no external
 *     grounding, and the class that needs owner review most.
 */
export const ALIAS_PROVENANCES = ["production-utterance", "authored"] as const

/** One alias's provenance tag. */
export type AliasProvenance = (typeof ALIAS_PROVENANCES)[number]

/** One colloquial surface form and the canonical entity it names. */
export interface AliasEdge {
  /**
   * What the customer types, in natural pt-BR — accents, spacing and all.
   * STORED natural, COMPARED under {@link normalizeAliasSurface}, exactly as
   * `conversationTriggers` stores natural phrasings and compares folded ones.
   */
  readonly surface: string
  /**
   * The canonical entity the surface names — a kebab-case ASCII handle. An
   * opaque declared name: this package never proves it resolves (see the
   * module doc's "Reconciliation, deferred").
   */
  readonly canonical: string
  /**
   * The extra token that selects THIS reading of an ambiguous surface form.
   *
   * REQUIRED on every edge of a surface form that names more than one entity,
   * and forbidden on a surface form that names exactly one — an unambiguous
   * alias carrying a required token would silently stop matching the bare word
   * it exists to catch. Declared as a natural token and compared folded, like
   * {@link AliasEdge.surface}.
   */
  readonly disambiguatedBy?: string
  /** Where the surface form came from. */
  readonly provenance: AliasProvenance
  /** Why this alias is worth carrying, in one clause. */
  readonly why: string
}

/**
 * The normal form two surface forms are compared under — the package's shared
 * word-space fold, the same one `normalizeTriggerPhrasing` uses. "Coquinha",
 * "coquinha" and "coquinhá!" are one surface form; nothing else is folded
 * (see `text-normalization.ts` on why stemming is deliberately absent).
 */
export function normalizeAliasSurface(surface: string): string {
  return normalizeProseForm(surface)
}

/**
 * The authored alias gazetteer.
 *
 * # Why it is this small, and why these
 *
 * Nine edges, six of them read out of real production traffic. The table is
 * a SEED — the shape plus enough real rows to prove the gates fire on real
 * data — and not an attempt at coverage. LE2-026's mining loop is what grows
 * it; authoring a hundred plausible colloquials here would be inventing the
 * measurement that ticket exists to take.
 *
 * # One thing deliberately NOT in the table
 *
 * The ticket names "pep" -> pepperoni as a motivating example. It is not here,
 * and that is a finding rather than an omission: IbateXas is a smokehouse and
 * there is no pepperoni in the seed catalog. Authoring that edge would mean
 * inventing a canonical name for an entity that does not exist, which is
 * precisely the mistake `external-references.ts` refused when it declined to
 * declare a delivery zone no code path names ("declaring one would INVENT a
 * go-live requirement"). It earns a row the day the store sells the thing.
 *
 * # CORRECTION (LE2-026): `refrigerante` is NOT a catalog gap
 *
 * An earlier revision of this header stated that `refrigerante` is the most
 * frequent product word in production utterances and that "there is NO
 * soft-drink handle in the seed at all" — a catalog gap the alias layer must
 * not paper over. The first half is true. **The second half is false**, and it
 * is corrected here rather than quietly deleted, because the way it went wrong
 * is the most useful thing in this file.
 *
 * `apps/commerce/src/seed-data.ts` seeds a product titled "Refrigerante",
 * handle `refrigerante`, category `bebidas`, with two variants — Coca-Cola and
 * Guaraná Antarctica. It is published and live. Two other modules already
 * depend on that fact: `packages/tools/src/mappers/product-mapper.ts` lifts
 * variant titles into search tags precisely so "coca" and "guaraná" match the
 * generic product, and `packages/journeys/src/live/seed-item-cart.ts` maps
 * both colloquials onto `refrigerante` variants. The ticket's OTHER motivating
 * example, "coquinha" -> Coca-Cola, was therefore declined on a false premise.
 *
 * **The lesson is the one this module doc states two sections above and then
 * failed to apply to itself.** "Reconciliation, deferred" says plainly that
 * this package cannot prove a canonical name resolves to a live product — that
 * is a live-store question needing a probe or a boot gate. The claim above was
 * exactly that kind of live-store claim, made from a package-local view, and it
 * read as authoritative because it was specific and confidently phrased. A
 * reviewer acting on it would have rejected a CORRECT alias.
 *
 * So: a statement in this file about what the store does or does not sell is
 * not a fact this package can hold. Verify it against the live roster
 * (`ibx alias mine` classifies every mined surface against `product` /
 * `product_variant`, which is how this error was caught) or do not write it.
 *
 * What the corrected evidence actually shows, for whoever grows this table:
 *   - `coca` (12 distinct production utterances), `coca-cola` and `guaraná`
 *     name VARIANTS of `refrigerante`. {@link AliasEdge.canonical} is a product
 *     or category handle, so they cannot be expressed here yet — and an edge
 *     pointing at the parent product would collapse two variants into one and
 *     lose the customer's actual choice. Open owner decision on the edge shape.
 *   - `agua` / `água` IS a real catalog gap: no water product exists in the
 *     seed or in the live store, and customers ask for one by the unit.
 */
export const ALIAS_GAZETTEER: readonly AliasEdge[] = [
  // ── The ambiguous surface: two costelas, one word ────────────────────────
  {
    surface: "costela",
    canonical: "costela-bovina-defumada",
    disambiguatedBy: "bovina",
    provenance: "production-utterance",
    why:
      "customers type the bare word at every stage of the order ('tira a costela " +
      "do meu carrinho', 'muda a costela para 3 unidades'), and the store sells " +
      "two of them — this is the fresh cut.",
  },
  {
    surface: "costela",
    canonical: "costela-defumada-congelada",
    disambiguatedBy: "congelada",
    provenance: "production-utterance",
    why:
      "the frozen sibling of the row above. Different price and different " +
      "fulfilment, which is why the bare word may not resolve to either without " +
      "the customer saying which.",
  },

  // ── Unambiguous colloquials read from production traffic ─────────────────
  {
    surface: "farofa",
    canonical: "farofa-de-bacon-defumado",
    provenance: "production-utterance",
    why:
      "the bare word appears in the store far more often than the full product " +
      "name ('adiciona uma farofa ao carrinho', 'poe mais uma farofa no pedido').",
  },
  {
    surface: "brisket",
    canonical: "brisket-americano",
    provenance: "production-utterance",
    why: "observed bare in a real order ('me faz o Brisket por 5 reais').",
  },
  {
    surface: "linguiça",
    canonical: "linguica-artesanal-defumada",
    provenance: "production-utterance",
    why:
      "observed bare on both sides of the cart ('adiciona uma linguiça no meu " +
      "carrinho', 'tira a linguiça do meu carrinho'); also the accent-free " +
      "spelling, which the normal form folds to the same key.",
  },
  {
    surface: "brownie",
    canonical: "brownie-com-sorvete",
    provenance: "production-utterance",
    why:
      "the dessert's first word, observed bare in a real question about it " +
      "('tem amendoim no brownie?').",
  },

  // ── Freely authored — the class with no external grounding ───────────────
  {
    surface: "mandioca",
    canonical: "mandioca-frita",
    provenance: "authored",
    why:
      "the side is ordered and removed by name in production, but always as the " +
      "full 'Mandioca Frita' — the bare first word is AUTHORED, not observed.",
  },
  {
    surface: "cerveja",
    canonical: "cerveja-artesanal-ipa",
    provenance: "authored",
    why:
      "the only beer in the catalog, so the category word names it " +
      "unambiguously today. AUTHORED: no production utterance orders one yet, " +
      "and a second beer makes this row ambiguous — which the build will say.",
  },
  {
    surface: "limonada",
    canonical: "limonada-suica",
    provenance: "authored",
    why:
      "the drink is universally ordered by its first word in pt-BR. AUTHORED: " +
      "plausible, not observed.",
  },
]
