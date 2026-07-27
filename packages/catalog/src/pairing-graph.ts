// THE PAIRING GRAPH — what the house says goes with what, and what stands in
// for what when something is unavailable (LE2-029).
//
// Ticket 29: "'O que combina com brisket?' gets grounded suggestions from the
// restaurant's own pairing/substitution knowledge — semantic edges in the
// catalog, surfaced through a typed read capability emitting its own claim,
// rendered from templates. Unknown item or empty pairing data → honest unknown.
// Allergen and dietary edges provably cannot exist in this graph: the compiler
// rejects them."
//
// This table is the first half. It is DATA ONLY: the read capability, the claim
// types and the templates that turn an edge into a pt-BR sentence live in
// `apps/api` and land beside it. What is here is the surface they consume, plus
// the build gates that make it trustworthy before anything depends on it — the
// same order LE2-033 landed the conversation projection in and LE2-025a the
// alias gazetteer.
//
// # What a pairing edge is
//
// One SUBJECT handle, one RELATION, one OBJECT handle. `brisket-americano`
// `pairs-with` `mandioca-frita`. The edge says nothing else — no score, no
// rank, no confidence, no "strength". A graph that ranked its suggestions would
// be a recommender wearing a table's clothes, and the whole reason this is
// catalog data rather than a model prompt is that the house's advice is
// AUTHORED and REVIEWED, not inferred. Where several edges share a subject the
// read renders them in DECLARATION ORDER, which is a decision an author makes
// by moving a row, visibly, in a diff.
//
// # The two relations, and why they are not one
//
//   `pairs-with`      — have these TOGETHER. Additive: the customer ends up
//                       with both.
//   `substitutes-for` — have this INSTEAD. Replacing: the customer ends up with
//                       one.
//
// They are not two spellings of "related to". The rendered sentences are
// different acts — "vai bem com" invites an addition, "no lugar" answers an
// absence — and collapsing them would leave one template that can say nothing
// true in both cases. That is the same argument the DELIVERY_COVERAGE and
// COUPON_VALID pairs made for being pairs, and it holds identically here.
//
// The distinction is also what makes rule `contradictory-pairing-relations`
// meaningful: the house cannot coherently say both "have the coleslaw WITH the
// pulled pork" and "have the coleslaw INSTEAD OF the pulled pork".
//
// # Handles are DECLARED, not verified
//
// A handle here is an opaque, well-shaped string, exactly as
// `alias-gazetteer.ts` holds canonical names. Nothing in this package proves
// `mandioca-frita` is a product that exists — that is a live-store question of
// exactly the kind `external-references.ts` was built for, and answering it
// would need a reconciliation surface (a probe, a boot gate, an `ibx catalog
// check --live` leg) that this change deliberately does not build, for the same
// blast-radius reason the gazetteer gave: a gate that refuses to start any
// environment whose seed differs is a real owner decision, and it is not made
// here.
//
// So there is NO dangling-target rule against a live roster, and the pass says
// so rather than shipping a gate that only looks like one. The strongest static
// statement available is the SHAPE (kebab-case ASCII, CLAUDE.md's naming
// convention for a product or category handle), plus the four INTERNAL
// coherence rules the graph can genuinely check about itself: no edge to
// itself, no edge declared twice, no pair related two contradictory ways, and
// no unreviewed authored claim about the house's own menu.
//
// A REVIEWER is therefore the thing standing between a typo'd handle and a
// customer — and the runtime's answer to a handle that resolves to nothing is
// the honest unknown, never an invented suggestion. That is why the read is
// built to say "não sei" cheaply.
//
// # THE SAFETY BINDING — the ticket's hardest acceptance criterion
//
// No pairing edge may touch an allergen or dietary attribute, on ANY of its
// three authored ends: the subject handle, the object handle, or the `why`
// clause. That is the ratified conservative policy (BKL-143 / BKL-123 /
// BKL-171), enforced by `compiler/passes/pairing-graph.ts`, and the reasoning
// for each end is there.
//
// The short version, because it is the reason this ticket names the rule at
// all: a pairing graph is a machine for turning a stored attribute into a
// customer-facing suggestion. That is precisely the move BKL-143 refused. An
// edge saying `sem-gluten` `substitutes-for` `pao-brioche` would let the system
// answer a dietary question with a confident recommendation — sourced from a
// hand-authored table, rendered as the house's own advice, with no staff member
// in the loop. The rulings' standing policy is honest self-report plus a real
// staff handoff, and a recommender that quietly routes around it is worse than
// one that never existed, because it looks authoritative.
//
// ## What the safety rule does NOT do, stated plainly
//
// It does not make this graph allergen-AWARE, and it must not be read as
// though it did.
//
// `coleslaw-da-casa` carries `allergens: ["eggs", "lactose"]` in the seed and is
// a perfectly legal pairing object here, because its HANDLE asserts nothing
// about allergens. Suggesting it to a customer is not a dietary claim — it is
// the house saying "this goes with that", which is all any edge in this table
// ever says. The pass governs what the DATA ASSERTS, never what a product
// CONTAINS; the catalog holds no ingredient knowledge and this table does not
// give it any.
//
// The customer-safety half is a RUNTIME guard, because a table cannot enforce
// it about itself — and getting that half right cost this ticket a correction
// worth recording here, where the next author will be tempted to make the same
// assumption.
//
// This header, the ticket, and the pass's own doc originally asserted that
// §O#9's closed-taxonomy safety routing ESCALATES an utterance carrying an
// allergen or dietary marker before any of this is consulted, so that "o que
// combina com brisket que seja sem glúten?" could never reach a pairing render.
// MEASURED AT THE REAL CUSTOMER TURN SEAM, IT DOES NOT. §O#9's deterministic
// contribution keys on ACTIVE DISTRESS and is deliberately disjoint from merely
// naming a diet — correctly so, since the ratified policy for an allergen INFO
// question is honest self-report, not a handoff for every "tem amendoim?". The
// only other channel is a model-populated marker array. That utterance flagged
// nothing, and the turn rendered the full suggestion list.
//
// Which is BKL-143's forbidden implication reached by a different road: a
// customer asking which of these is gluten-free got a list, reading as an
// assurance, sourced from a hand-authored TASTE table, with no staff member in
// the loop. The read now carries its OWN allergen guard and degrades to the
// honest self-report plus handoff; the argument sits at that guard in
// `apps/api/src/claustrum/pairing-resolver.ts`, and a directional e2e pins it.
//
// The lesson for this file: the compiler can prove the DATA encodes no allergen
// or dietary semantics, and that is all it can prove. What a customer is told
// when they attach a dietary condition to an ordinary question is a runtime
// question, and asserting a safety property this package cannot observe is how
// a false assurance ends up in the one file people trust on safety.
//
// ## `why` states the PAIRING reason and nothing else — measured, not assumed
//
// The rationale rule caught this table's own author on the first compile, and
// the way it did is the most useful thing to know before writing a row.
//
// Two edges below originally carried meta-commentary — one said the coleslaw
// "carries eggs and lactose in its seed metadata and is still a legal object
// here", the other explained that the pudim's handle "carries an allergen
// marker". Both are TRUE, both are about the rules rather than about the food,
// and both were rejected: `safetyMarkerOf` fires on the `egg` segment and the
// `allerg` stem wherever they appear, and it has no way to tell prose that
// ASSERTS a dietary reason ("combina porque é sem glúten") from prose that
// merely DISCUSSES one.
//
// That is the conservative direction and the rule stays as it is. The
// consequence for an author is a rule of thumb worth more than the diagnostic:
// `why` is one clause about why the house puts these two things together.
// Commentary about allergens, about this pass, or about what the compiler
// allows belongs in this module doc — where it is not data, and where no future
// renderer can reach it.
//
// ## The deliberate false positive, worked
//
// `safetyMarkerOf` matches STEMS and whole segments, so it fires on any handle
// CONTAINING a marker. The seed catalog holds `pudim-de-leite-condensado`, and
// the `leite` segment makes it permanently unpairable by this pass.
//
// That is the right answer and not merely an accepted cost — the identical
// argument `alias-gazetteer.ts` makes about the same product. An edge
// "brisket-americano pairs-with pudim-de-leite-condensado" is the house
// recommending a dairy dessert to whoever asked, and the graph has no way to
// know why they asked. The product stays fully orderable by its real name and
// fully answerable by every other read; what it cannot be is the object of an
// automated suggestion. Where a future false positive is genuinely just a name
// collision, the fix is an owner-ratified change to `safety-markers.ts`,
// reviewed — never a quiet exception here.
//
// # Provenance, and the owner-review flag
//
// Every edge declares WHERE THE CLAIM CAME FROM, in the discipline LE2-033
// established for the conversation projection and LE2-025a for the gazetteer.
// The distinction that matters here is sharper than in either, because a
// pairing edge is an assertion about the HOUSE'S OWN TASTE — there is no
// external fact to check it against, and a plausible-sounding invented pairing
// is indistinguishable from a real one in review unless the table says which it
// is. So `authored` edges MUST carry `ownerReview: true`, and grounded ones may
// not (an edge read off the menu is not awaiting anybody's opinion). Both
// halves are compile-enforced — see rules 10 and 11.
//
// Pure: no clock, no RNG, no IO, no `process.env`.

/**
 * What one edge asserts about its two ends.
 *
 * A closed vocabulary, and deliberately a small one. Every member has to earn
 * its own rendered sentence in the slot grammar and its own answer to "what
 * does a customer do with this", so a third relation is a template change and a
 * claim-type conversation, not a row.
 */
export const PAIRING_RELATIONS = ["pairs-with", "substitutes-for"] as const

/** One edge's relation. */
export type PairingRelation = (typeof PAIRING_RELATIONS)[number]

/**
 * Where a pairing claim came from — the review surface.
 *
 *   `menu-composition` — the pairing is READ OFF the store's own menu data: a
 *     combo whose description lists both items, or a product whose description
 *     states it is the prepared form of another. Grounded: the house already
 *     sells these together, or sells one as the other's stand-in, and the edge
 *     only writes down what the menu already says.
 *
 *   `authored` — a freely authored suggestion. Plausible, conventional, and
 *     with NO grounding in anything this repo can check. The class that needs
 *     owner review most, and the one {@link PairingEdge.ownerReview} exists
 *     for.
 */
export const PAIRING_PROVENANCES = ["menu-composition", "authored"] as const

/** One edge's provenance tag. */
export type PairingProvenance = (typeof PAIRING_PROVENANCES)[number]

/** One directed statement about two things the house sells. */
export interface PairingEdge {
  /**
   * The handle the customer asked ABOUT — a kebab-case ASCII product or
   * category handle. An opaque declared name: this package never proves it
   * resolves (see the module doc's "Handles are DECLARED, not verified").
   */
  readonly subject: string
  /** What this edge asserts — see {@link PairingRelation}. */
  readonly relation: PairingRelation
  /** The handle being suggested. Same shape and same opacity as the subject. */
  readonly object: string
  /** Where the claim came from. */
  readonly provenance: PairingProvenance
  /**
   * Why the house says this, in one clause — the REVIEW surface, and never a
   * rendered one.
   *
   * NOT customer-facing: the read composes its sentence in code from the two
   * handles and the relation alone, so no authored prose reaches a customer
   * through this table. Kept for the reviewer who has to decide whether an
   * `authored` edge is the house's taste or the author's.
   *
   * Safety-classified anyway (rule 3). A `why` reading "combina porque é sem
   * glúten" is the forbidden implication written down, whether or not today's
   * renderer quotes it — and the day somebody decides the reason WOULD read
   * well in the reply, the gate is already there.
   */
  readonly why: string
  /**
   * REQUIRED on an `authored` edge, forbidden on a grounded one — the flag that
   * makes the un-checkable class countable.
   *
   * `true` means "no menu data stands behind this; an owner has to say whether
   * the house agrees". Its absence on an authored edge is a build error rather
   * than a lint, because the whole point is that an unreviewed invented pairing
   * reads exactly like a real one.
   */
  readonly ownerReview?: true
}

/**
 * Are two authored handles the same thing? A BYTE comparison, deliberately, and
 * the reason is worth writing down because the sibling table does it
 * differently.
 *
 * `alias-gazetteer.ts` folds its SURFACE FORMS under the package's shared
 * word-space normal form (`text-normalization.ts`'s `normalizeProseForm`)
 * because a surface form is the customer's own spelling and "Coquinha" and
 * "coquinha" are one word. A handle is not spoken by anybody: it is a
 * kebab-case ASCII identifier the shape rule (`malformed-pairing-handle`)
 * already forces into a single canonical spelling, and no two DISTINCT
 * well-formed handles can differ by case, accent or punctuation. A fold here
 * would therefore be a no-op that looks like a safeguard — the worst kind, in a
 * file whose whole job is to be checkable.
 *
 * The completeness of this comparison is thus a consequence of the shape rule
 * running first, which is why the pass's check order says so out loud.
 */
export function sameHandle(left: string, right: string): boolean {
  return left === right
}

/**
 * The authored pairing graph.
 *
 * # Why it is this small, and why these
 *
 * Ten edges: four the store's own menu already states, six authored and every
 * one of them flagged. The table is a SEED — the shape, plus enough genuinely
 * grounded rows to prove the read renders real house knowledge rather than a
 * fixture — and not an attempt at coverage. Authoring forty plausible pairings
 * would be inventing the very thing the provenance tag exists to distinguish,
 * and would bury the four real ones in them.
 *
 * # Where the grounded four come from, exactly
 *
 * `apps/commerce/src/seed-data.ts`, quoted rather than remembered:
 *
 *   - `combo-brisket` is described as "400g de brisket fatiado + mandioca
 *     frita + bebida 500ml à escolha". The house therefore already sells
 *     `brisket-americano` (whose sole variant is "400g") together with
 *     `mandioca-frita`, and together with a 500ml drink. Two edges.
 *   - `costela-defumada-congelada` is described as "Costela bovina defumada
 *     pré-pronta para aquecer em casa" — the same cut as
 *     `costela-bovina-defumada`, prepared to take away. That is a substitution
 *     the menu itself states.
 *   - `pulled-pork-congelado` is "Paleta suína desfiada pré-pronta", the same
 *     for `pulled-pork`.
 *
 * # The drink edge, and the precision the last ticket paid for
 *
 * "bebida 500ml à escolha" is a REAL constraint and it is not satisfied by
 * every drink. `refrigerante` is a 350ml can, `suco-do-dia` is 400ml; only
 * `limonada-suica` (300ml / 500ml) and `cerveja-artesanal-ipa` (500ml) carry a
 * 500ml variant at all. So the combo grounds a limonada edge and nothing wider.
 *
 * The beer is deliberately NOT declared, on either provenance. Making an
 * alcoholic drink the house's default suggestion beside a combo is a business
 * decision with a licensing and a duty-of-care dimension, and inventing it here
 * — even flagged — would put it in front of customers while it waited to be
 * reviewed. An owner may add the row.
 *
 * This is LE2-025a's lesson applied on purpose rather than relearned: that
 * module's header once asserted, confidently and specifically, that the store
 * sold no soft drink, and a reviewer acting on it would have rejected a correct
 * alias. Every store fact above is quoted from the seed in the same commit that
 * reads it.
 *
 * # What is deliberately NOT in the table
 *
 * Anything touching `pudim-de-leite-condensado`. It is the seed's one dessert
 * whose handle carries an allergen marker (`leite`), so the pass would reject
 * the edge — see the module doc's worked false positive. `brownie-com-sorvete`
 * is the dessert this table can name, and does.
 */
export const PAIRING_GRAPH: readonly PairingEdge[] = [
  // ── Read off the house's own combo ───────────────────────────────────────
  {
    subject: "brisket-americano",
    relation: "pairs-with",
    object: "mandioca-frita",
    provenance: "menu-composition",
    why:
      "the store already sells the two together: `combo-brisket` is '400g de " +
      "brisket fatiado + mandioca frita + bebida 500ml à escolha', and " +
      "brisket-americano's only variant is 400g.",
  },
  {
    subject: "brisket-americano",
    relation: "pairs-with",
    object: "limonada-suica",
    provenance: "menu-composition",
    why:
      "the same combo's 'bebida 500ml à escolha'. Of the drinks on the menu " +
      "only limonada-suica and cerveja-artesanal-ipa carry a 500ml variant, " +
      "and the beer is left to an owner decision (see the table's header).",
  },

  // ── Substitutions the menu itself states ─────────────────────────────────
  {
    subject: "costela-bovina-defumada",
    relation: "substitutes-for",
    object: "costela-defumada-congelada",
    provenance: "menu-composition",
    why:
      "the frozen row is described as 'Costela bovina defumada pré-pronta para " +
      "aquecer em casa' — the same cut, prepared to take away. The menu states " +
      "the stand-in; this edge only writes it down.",
  },
  {
    subject: "pulled-pork",
    relation: "substitutes-for",
    object: "pulled-pork-congelado",
    provenance: "menu-composition",
    why:
      "'Paleta suína desfiada pré-pronta' — the take-home form of the same " +
      "preparation, exactly as the costela pair above.",
  },

  // ── Authored — the class with no grounding, every row flagged ────────────
  {
    subject: "costela-bovina-defumada",
    relation: "pairs-with",
    object: "farofa-de-bacon-defumado",
    provenance: "authored",
    ownerReview: true,
    why:
      "farofa beside a smoked rib is the conventional pt-BR churrasco plate. " +
      "AUTHORED: no combo, no menu text and no order history in this repo " +
      "states it — it is plausible, not observed.",
  },
  {
    subject: "costela-bovina-defumada",
    relation: "pairs-with",
    object: "molho-barbecue-artesanal",
    provenance: "authored",
    ownerReview: true,
    why:
      "the house's own barbecue sauce is sold to take home; offering it beside " +
      "the rib is the obvious cross-sell. AUTHORED: the menu never pairs them.",
  },
  {
    subject: "pulled-pork",
    relation: "pairs-with",
    object: "coleslaw-da-casa",
    provenance: "authored",
    ownerReview: true,
    why:
      "coleslaw with pulled pork is the American barbecue convention the menu " +
      "is written in. AUTHORED: read off the cuisine, not off this store's data.",
  },
  {
    subject: "linguica-artesanal-defumada",
    relation: "pairs-with",
    object: "feijao-tropeiro",
    provenance: "authored",
    ownerReview: true,
    why:
      "linguiça is an ingredient of tropeiro across pt-BR cooking, so the two " +
      "read as one plate. AUTHORED: inferred from cuisine, not from this menu.",
  },
  {
    subject: "brisket-americano",
    relation: "pairs-with",
    object: "brownie-com-sorvete",
    provenance: "authored",
    ownerReview: true,
    why:
      "the one dessert this table is able to name (see the header on the other " +
      "one). AUTHORED: a dessert follows a main course, which is a convention " +
      "rather than a fact about this store.",
  },
  {
    subject: "frango-defumado-inteiro",
    relation: "substitutes-for",
    object: "barriga-de-porco-defumada",
    provenance: "authored",
    ownerReview: true,
    why:
      "both are whole-cut smoked mains in the same category and a similar price " +
      "band, so one stands in when the other is out. AUTHORED, and the edge most " +
      "worth an owner's eye: a substitution crosses poultry and pork, which is a " +
      "swap plenty of customers would not accept for reasons this table cannot " +
      "see and must not guess at.",
  },
]
