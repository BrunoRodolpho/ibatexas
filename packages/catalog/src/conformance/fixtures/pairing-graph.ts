// PAIRING-GRAPH rejection fixtures (LE2-029).
//
// The `pairing-graph` pass rejects twelve ways, and each fixture below is the
// minimal witness for exactly one. They share the shape the external-reference
// and alias families established: the CAPABILITY half is always one unmodified
// `IDENTITY_BASE`, present only because the suite requires every fixture to
// compile at least one capability. The specimen is the GRAPH.
//
// The edge below is the control, spelled once and mutated in one slot per
// fixture, in the same discipline `base.ts` establishes for capabilities.
//
// Every handle carries the word `conformance`, so a fixture edge can never
// collide with an authored production one — and, just as important, so that a
// fixture's normal form can never accidentally equal a real product handle
// somebody adds to the graph later.
//
// # The three fixtures worth reading before the other nine
//
// `safety-restricted-pairing-object` is the ticket's acceptance criterion in
// its sharpest form: the object end is what the read SPEAKS, so that fixture is
// the one standing between the compiler and a system that recommends a dietary
// restriction to a customer. `safety-restricted-pairing-rationale` covers the
// end no renderer reads today, which is precisely why it needs a pinned
// witness — an inert rule is the kind that gets quietly deleted.
// `contradictory-pairing-relations` is the only rule that needs the two
// relations to exist at all, and so the only one that would silently stop
// meaning anything if they were ever collapsed into one.
//
// # The one thing these fixtures cannot prove
//
// That a handle RESOLVES. `conformance-item-sujeito` is not a product and never
// will be; the pass checks its SHAPE, because whether a handle names a row
// anybody sells is a live-store question the catalog deliberately never asks
// (see `src/pairing-graph.ts` on the deferred reconciliation decision). The day
// that gate exists, its fixtures live with the reconciler, exactly as LE2-018's
// do.

import { IDENTITY_BASE } from "./base.js"
import { fixtureCatalog, fixturePairings, type ConformanceFixture } from "../types.js"

/** The capability every fixture here compiles alongside its graph. */
const CARRIER: readonly unknown[] = [
  { ...IDENTITY_BASE, kind: "conformance.pairing.carrier" },
]

/** The well-formed pairing edge each fixture mutates in exactly one slot. */
const PAIRING_BASE = {
  subject: "conformance-item-sujeito",
  relation: "pairs-with",
  object: "conformance-item-objeto",
  provenance: "menu-composition",
  why: "the fixture control — a pairing edge with nothing wrong with it.",
} as const

/** A third handle, for the rules that need two edges over distinct pairs. */
const OTHER_OBJECT = "conformance-item-alternativo"

export const PAIRING_GRAPH_FIXTURES: readonly ConformanceFixture[] = [
  {
    name: "pairing-graph.safety-restricted-pairing-subject",
    targets: "pairing-graph/safety-restricted-pairing-subject",
    why:
      "an edge whose ASKED-ABOUT end is a dietary class. It would make the graph " +
      "answer a dietary question with a confident list of suggestions, which is " +
      "the BKL-171 license in its plainest form. Note the handle is perfectly " +
      "well-shaped — the shape rule cannot see this, which is why the safety " +
      "rule is not a special case of it.",
    definitions: fixtureCatalog(...CARRIER),
    pairings: fixturePairings({ ...PAIRING_BASE, subject: "conformance-sem-gluten" }),
  },
  {
    name: "pairing-graph.safety-restricted-pairing-object",
    targets: "pairing-graph/safety-restricted-pairing-object",
    why:
      "an edge whose SUGGESTED end carries an allergen marker — the ticket's " +
      "acceptance criterion at its sharpest, and this graph's own failure mode " +
      "rather than a restatement of the subject rule. The object is what the read " +
      "SPEAKS, so this edge would have the system recommend a restriction to a " +
      "customer with no staff member in the loop. The subject here is the " +
      "untouched control.",
    definitions: fixtureCatalog(...CARRIER),
    pairings: fixturePairings({ ...PAIRING_BASE, object: "conformance-sem-lactose" }),
  },
  {
    name: "pairing-graph.safety-restricted-pairing-rationale",
    targets: "pairing-graph/safety-restricted-pairing-rationale",
    why:
      "a `why` clause stating a dietary reason. The renderer never quotes `why`, " +
      "so this edge is INERT — and that is the point: the forbidden implication " +
      "is written down and sitting one product decision away from being " +
      "customer-facing. A rule that only fires on what is rendered today would " +
      "have to be remembered on the day that changes.",
    definitions: fixtureCatalog(...CARRIER),
    pairings: fixturePairings({
      ...PAIRING_BASE,
      why: "combina porque e sem gluten.",
    }),
  },
  {
    name: "pairing-graph.malformed-pairing-handle",
    targets: "pairing-graph/malformed-pairing-handle",
    why:
      "an object spelled as a display title rather than a handle. The catalog " +
      "cannot check that a handle EXISTS, so its shape is the only static " +
      "statement available — and it is the form the read looks the graph up by, " +
      "so a mis-shaped end is an edge that can never fire.",
    definitions: fixtureCatalog(...CARRIER),
    pairings: fixturePairings({ ...PAIRING_BASE, object: "Conformance Item Objeto" }),
  },
  {
    name: "pairing-graph.unknown-pairing-relation",
    targets: "pairing-graph/unknown-pairing-relation",
    why:
      "a relation outside the closed two-member set. The relation selects which " +
      "sentence the read renders, so an unknown one is an edge with no way to be " +
      "spoken — and 'goes-nicely-with' is exactly the plausible-looking third " +
      "relation somebody adds without touching a template.",
    definitions: fixtureCatalog(...CARRIER),
    pairings: fixturePairings({ ...PAIRING_BASE, relation: "goes-nicely-with" }),
  },
  {
    name: "pairing-graph.unknown-pairing-provenance",
    targets: "pairing-graph/unknown-pairing-provenance",
    why:
      "a provenance tag that looks grounded and is not a real member. This is a " +
      "FAIL-OPEN if left unchecked: the owner-review rules branch on provenance, " +
      "so an unrecognized tag would let an invented pairing skip the flag it " +
      "exists to carry. A typo here has to be an error rather than a default.",
    definitions: fixtureCatalog(...CARRIER),
    pairings: fixturePairings({ ...PAIRING_BASE, provenance: "grounded" }),
  },
  {
    name: "pairing-graph.malformed-pairing-rationale",
    targets: "pairing-graph/malformed-pairing-rationale",
    why:
      "a blank `why`. Deliberately whitespace rather than absent: the type " +
      "system already stops a missing field on an authored literal, and the " +
      "failure that survives review is the one that LOOKS filled in. A row whose " +
      "rows cannot be checked against anything external has to say why it exists.",
    definitions: fixtureCatalog(...CARRIER),
    pairings: fixturePairings({ ...PAIRING_BASE, why: "   " }),
  },
  {
    name: "pairing-graph.self-referential-pairing-edge",
    targets: "pairing-graph/self-referential-pairing-edge",
    why:
      "a handle paired with itself. Neither relation can mean anything about one " +
      "thing — 'vai bem com' would suggest what the customer just asked about, " +
      "and 'no lugar' would offer the unavailable item as its own stand-in. Both " +
      "read as helpful and tell the customer nothing.",
    definitions: fixtureCatalog(...CARRIER),
    pairings: fixturePairings({ ...PAIRING_BASE, object: PAIRING_BASE.subject }),
  },
  {
    name: "pairing-graph.duplicate-pairing-edge",
    targets: "pairing-graph/duplicate-pairing-edge",
    why:
      "the same subject, relation and object declared twice. Byte-identical on " +
      "purpose, and that is the whole available shape of this fault: the handle " +
      "rule forces one canonical spelling per handle, so two DISTINCT " +
      "well-formed handles can never differ by case or punctuation and a " +
      "near-miss duplicate is unrepresentable. The second row can only drift " +
      "from the first, and it would make one suggestion appear twice in one " +
      "sentence.",
    definitions: fixtureCatalog(...CARRIER),
    pairings: fixturePairings({ ...PAIRING_BASE }, { ...PAIRING_BASE }),
  },
  {
    name: "pairing-graph.contradictory-pairing-relations",
    targets: "pairing-graph/contradictory-pairing-relations",
    why:
      "one pair of handles related BOTH ways. Needs two edges by nature, and the " +
      "second is deliberately REVERSED (object and subject swapped) to pin that " +
      "the rule is keyed on the UNORDERED pair: 'have these together' and 'have " +
      "this instead' are incoherent in either direction, and a rule that only " +
      "caught the aligned spelling would be trivially evaded.",
    definitions: fixtureCatalog(...CARRIER),
    pairings: fixturePairings(
      { ...PAIRING_BASE },
      {
        ...PAIRING_BASE,
        subject: PAIRING_BASE.object,
        object: PAIRING_BASE.subject,
        relation: "substitutes-for",
      },
    ),
  },
  {
    name: "pairing-graph.unreviewed-authored-pairing",
    targets: "pairing-graph/unreviewed-authored-pairing",
    why:
      "an invented edge with no `ownerReview: true`. The flag is required " +
      "precisely because an invented pairing reads exactly like a real one in " +
      "review — there is no external fact to check the house's taste against, so " +
      "the table has to say which rows are awaiting an opinion.",
    definitions: fixtureCatalog(...CARRIER),
    pairings: fixturePairings({ ...PAIRING_BASE, provenance: "authored" }),
  },
  {
    name: "pairing-graph.unnecessary-pairing-review-flag",
    targets: "pairing-graph/unnecessary-pairing-review-flag",
    why:
      "a menu-grounded edge carrying a review flag. The mirror of the rule above, " +
      "and not merely tidiness: the flag's whole value is that counting it counts " +
      "the UNGROUNDED rows, and a review queue padded with rows nobody needs to " +
      "look at is a queue nobody looks at.",
    definitions: fixtureCatalog(...CARRIER),
    pairings: fixturePairings({ ...PAIRING_BASE, ownerReview: true }),
  },
]

/**
 * The clean control for the family: the well-formed grounded edge, a correctly
 * flagged authored one, and a substitution over a DIFFERENT pair.
 *
 * The last two are what make this more than a control. Eleven of the twelve
 * rejections above are absences, and a corpus of absences never proves the
 * positive path exists — this fixture is the one showing that an `authored`
 * edge IS allowed (flagged), and that both relations coexist in one graph as
 * long as no single pair carries both. That is the shape the real graph takes,
 * and the shape the contradiction and review diagnostics tell authors to reach
 * for.
 *
 * Registered with the other clean fixtures so the corpus reads in one place,
 * but authored here next to the specimens it controls for.
 */
export const CLEAN_PAIRING_GRAPH_FIXTURE: ConformanceFixture = {
  name: "clean.pairing-graph",
  targets: null,
  why:
    "a grounded edge, a correctly flagged authored edge, and a substitution over " +
    "a different pair. The control for all twelve pairing rejections, and the " +
    "only clean fixture whose `pairing-graph` pass reports a non-zero `checked` " +
    "— which is what proves the other clean goldens' zeros mean 'nothing " +
    "declared' rather than 'pass not running'.",
  definitions: fixtureCatalog(...CARRIER),
  pairings: fixturePairings(
    { ...PAIRING_BASE },
    {
      ...PAIRING_BASE,
      object: OTHER_OBJECT,
      provenance: "authored",
      ownerReview: true,
      why: "the authored control — invented, and flagged, which is what makes it legal.",
    },
    {
      ...PAIRING_BASE,
      subject: OTHER_OBJECT,
      object: "conformance-item-substituto",
      relation: "substitutes-for",
      why: "the substitution control, over a pair no other edge here relates.",
    },
  ),
}
