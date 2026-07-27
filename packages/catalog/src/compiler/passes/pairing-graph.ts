// PASS 10 — PAIRING GRAPH (LE2-029).
//
// The static half of the pairings & substitutions capability. Ticket 29 asks
// for a read that answers "o que combina com brisket?" from the house's own
// knowledge, and for one guarantee about the knowledge itself: "Allergen and
// dietary edges provably cannot exist in this graph: the compiler rejects
// them." This pass owns that guarantee, and the ordinary well-formedness a
// runtime needs before it can be handed a graph at all.
//
// # Why a tenth pass rather than rules on an existing one
//
// The three reasons `external-references` gave and `alias-gazetteer` repeated,
// all of which apply verbatim:
//
//   1. `checked` is the anti-vacuous measure and it only works PER PASS.
//      Folding pairing edges into another pass's count would hide "the graph
//      was never looked at" inside a number that moves for unrelated reasons.
//   2. This pass reads a FIFTH INPUT. Teaching an existing pass a new parameter
//      to serve one rule family is how a coherent pass becomes a junk drawer.
//   3. The static and runtime halves should share a name, so an author who sees
//      `pairing-graph/...` in a build log can grep the resolver that consumes
//      the same table.
//
// # The rules, and what each is actually protecting
//
//    1. `safety-restricted-pairing-subject`    — the asked-about end names an
//                                                allergen/dietary attribute
//    2. `safety-restricted-pairing-object`     — the SUGGESTED end does
//    3. `safety-restricted-pairing-rationale`  — the authored `why` does
//    4. `malformed-pairing-handle`             — an end that is not a handle
//    5. `unknown-pairing-relation`             — a relation outside the closed set
//    6. `unknown-pairing-provenance`           — a provenance outside the closed set
//    7. `malformed-pairing-rationale`          — a `why` that says nothing
//    8. `self-referential-pairing-edge`        — a thing paired with itself
//    9. `duplicate-pairing-edge`               — the same edge declared twice
//   10. `contradictory-pairing-relations`      — one pair related two ways
//   11. `unreviewed-authored-pairing`          — an invented edge with no flag
//   12. `unnecessary-pairing-review-flag`      — a grounded edge carrying one
//
// Rules 1-3 are the ticket's load-bearing acceptance criterion. Rules 11 and 12
// are the pair that makes provenance mean something. The rest is the shape a
// graph has to have before a renderer can walk it.
//
// # THE SAFETY BINDING, and why all THREE ends are checked
//
// The ratified rulings (BKL-143 / BKL-123 / BKL-171, quoted in full in
// `safety-implication-edges.ts`) forbid letting a stored attribute imply a
// customer-facing allergen or dietary assertion. A pairing graph is a machine
// for exactly that implication — it turns a stored edge into a spoken
// suggestion — so it can carry the forbidden move on any of its authored ends,
// and the three failures are different:
//
//   - SUBJECT end. An edge whose asked-about side is `sem-gluten` declares that
//     a dietary class is a thing one can ask for suggestions ABOUT. The read
//     would then answer a dietary question with a confident list, which is the
//     license BKL-171 refused in its plainest form.
//   - OBJECT end. This is the sharper one, and it is this graph's own. The
//     object is what gets SPOKEN — "experimente X" — so an edge terminating in
//     a dietary attribute makes the system recommend a restriction to a
//     customer, with no staff member in the loop. The rulings' standing policy
//     is honest self-report plus a real handoff; a recommender that routes
//     around it is worse than none, because it looks authoritative.
//   - RATIONALE end. `why` is a review field today and the renderer never
//     quotes it (the sentence is composed in code from the handles and the
//     relation). It is classified anyway, for the reason the alias pass gives
//     about its own two ends: a reason reading "combina porque é sem glúten" is
//     the forbidden implication WRITTEN DOWN, sitting one product decision away
//     from being rendered. Catching it while it is inert is free; catching it
//     after somebody decides the reason reads well in the reply is not.
//
// Classification is `safety-markers.ts`'s `safetyMarkerOf`, the same function
// `safety-implication-edges` and `alias-gazetteer` use. One vocabulary, three
// enforcement sites: a marker added there is enforced here the same day, with
// no second list to remember.
//
// ## What this pass does NOT claim
//
// It does not make the graph allergen-AWARE. `coleslaw-da-casa` carries eggs
// and lactose in the seed and is a legal pairing object, because its HANDLE
// asserts nothing about allergens — suggesting it is the house saying "this
// goes with that", not a dietary claim. The pass governs what the DATA
// ASSERTS, never what a product CONTAINS. The customer-safety half is §O#9's
// closed-taxonomy routing, which escalates a marker-carrying utterance before
// this read is ever consulted; that is asserted by the read's own tests,
// because it is the half a table cannot enforce about itself.
//
// The deliberate false positives (the seed's `pudim-de-leite-condensado` is
// permanently unpairable) are worked through in `src/pairing-graph.ts`.
//
// # There is no dangling-target rule, and that is a statement not an omission
//
// Whether `mandioca-frita` names a product anybody sells is a live-store
// question this package must never ask — a compiler that read the world would
// compile differently on two machines. So the strongest available static
// statement about an end is its SHAPE (rule 4), exactly the posture
// `alias-gazetteer` takes on canonical names and `external-references` on
// `keyFrom`, and for the same reason. What the graph CAN check is its internal
// coherence, which is rules 8-10.
//
// Building a reconciliation gate is a real owner decision with real blast
// radius (it would refuse to start any environment whose seed differs); see
// `src/pairing-graph.ts` and `src/alias-gazetteer.ts`, which defer the same
// decision. Until it is made, a typo'd handle is caught by review and by the
// runtime finding nothing — and the runtime's answer to finding nothing is the
// honest unknown, never an invented suggestion.
//
// # Order of checks is fail-closed
//
// Safety is classified FIRST, before shape, and a safety-bearing edge is
// reported as safety-bearing however badly it is spelled. The alternative —
// rejecting it for a stray capital and never mentioning the allergen marker —
// would let the most important diagnostic be masked by the least important one.
// Shape faults then suppress the GROUP rules for that edge, because an edge
// whose ends are not handles has no meaningful identity to be a duplicate of.
//
// That suppression is also what makes edge IDENTITY decidable by BYTES rather
// than by a fold: no two distinct WELL-FORMED handles can differ only by case,
// accent or punctuation, so by the time rules 8-10 run, `===` is a complete
// comparison. `src/pairing-graph.ts`'s `sameHandle` states the same thing from
// the data side, and says why a fold here would be a safeguard that cannot
// fire.
//
// Pure: no clock, no RNG, no IO.

import {
  PAIRING_PROVENANCES,
  PAIRING_RELATIONS,
  sameHandle,
  type PairingEdge,
} from "../../pairing-graph.js"
import {
  pairingObjectName,
  type CatalogDiagnostic,
  type CatalogPassResult,
} from "../diagnostics.js"
import { safetyMarkerOf } from "../safety-markers.js"

const PASS = "pairing-graph" as const

/**
 * A product or category handle: kebab-case, ASCII only — CLAUDE.md's standing
 * convention (`costela-bovina-defumada`), and the same SHAPE-not-lookup check
 * `alias-gazetteer` applies to a canonical name. See the module doc on why
 * there is no lookup.
 */
const PAIRING_HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const RELATION_SET: ReadonlySet<string> = new Set<string>(PAIRING_RELATIONS)
const PROVENANCE_SET: ReadonlySet<string> = new Set<string>(PAIRING_PROVENANCES)

/** Read a slot off an edge structurally — fixtures carry deliberately bad data. */
function slot(edge: PairingEdge, name: string): unknown {
  return typeof edge === "object" && edge !== null
    ? (edge as unknown as Record<string, unknown>)[name]
    : undefined
}

/**
 * One diagnostic. The local-helper idiom every pass in this directory uses;
 * `rule` stays a positional literal at each call site so the conformance
 * scanner can resolve the rule inventory statically (see
 * `src/conformance/rule-inventory.ts`).
 */
function diag(
  object: string,
  rule: string,
  field: string,
  message: string,
  reference?: string,
): CatalogDiagnostic {
  return {
    pass: PASS,
    rule,
    severity: "error",
    object,
    field,
    message,
    ...(reference === undefined ? {} : { reference }),
  }
}

/** An edge that survived classification, with everything the group rules need. */
interface Registered {
  readonly index: number
  readonly object: string
  readonly relation: string
  /** The subject handle, verbatim — see `sameHandle` on why bytes suffice. */
  readonly subject: string
  /** The object handle, verbatim. */
  readonly target: string
}

/**
 * The prose of a safety diagnostic: the end-specific reason, then the shared
 * ratified basis and the false-positive escape hatch.
 *
 * The MESSAGE is table-shaped; the RULE ID may not be. `rule-inventory.ts`
 * resolves rule ids out of this file's source and refuses to guess, so the
 * three rules below are spelled as literals at three separate call sites rather
 * than looped over a table — which is what makes the conformance gate able to
 * prove each has a fixture. Sharing the sentence and not the id is the split
 * that keeps both honest.
 */
function safetyMessage(field: string, family: string, token: string, reason: string): string {
  return (
    `this pairing edge's \`${field}\` carries the ${family} marker "${token}". ` +
    `${reason}. Forbidden by the ratified BKL-143 / BKL-123 / BKL-171 rulings, ` +
    "whose standing policy is honest self-report plus a real staff handoff; " +
    "reopening requires an explicit owner reversal in writing. If this is an " +
    "ordinary product whose NAME merely contains an ingredient word, that is the " +
    "deliberate false positive documented in `src/pairing-graph.ts` — the product " +
    "stays orderable and answerable by every other read, it just cannot be the " +
    "subject of an automated suggestion."
  )
}

/**
 * Rules 1-3 — the safety verdict on one edge's three authored ends. Returns
 * the diagnostics; a non-empty result means the edge is already rejected and
 * nothing else is reported about it (a second opinion on its spelling would
 * only bury the finding).
 */
function safetyDiagnostics(edge: PairingEdge, object: string): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []

  const subject = slot(edge, "subject")
  if (typeof subject === "string") {
    const marker = safetyMarkerOf(subject)
    if (marker !== undefined) {
      out.push(
        diag(
          object,
          "safety-restricted-pairing-subject",
          "subject",
          safetyMessage(
            "subject",
            marker.family,
            marker.token,
            "the asked-about end of a pairing edge may not name an allergen or " +
              "dietary class: it would make the graph answer a dietary question " +
              "with a confident list of suggestions",
          ),
          subject,
        ),
      )
    }
  }

  const target = slot(edge, "object")
  if (typeof target === "string") {
    const marker = safetyMarkerOf(target)
    if (marker !== undefined) {
      out.push(
        diag(
          object,
          "safety-restricted-pairing-object",
          "object",
          safetyMessage(
            "object",
            marker.family,
            marker.token,
            "the SUGGESTED end of a pairing edge may not name an allergen or " +
              "dietary class: the object is what the read SPEAKS, so this edge " +
              "would have the system recommend a restriction to a customer with " +
              "no staff member in the loop",
          ),
          target,
        ),
      )
    }
  }

  const why = slot(edge, "why")
  if (typeof why === "string") {
    const marker = safetyMarkerOf(why)
    if (marker !== undefined) {
      out.push(
        diag(
          object,
          "safety-restricted-pairing-rationale",
          "why",
          safetyMessage(
            "why",
            marker.family,
            marker.token,
            "a pairing edge's authored rationale may not state an allergen or " +
              "dietary reason. The renderer does not quote `why` today, so this " +
              "edge is inert — which is exactly why it is cheap to reject now, " +
              "one product decision before somebody makes the reason " +
              "customer-facing",
          ),
          why,
        ),
      )
    }
  }

  return out
}

/** Rules 4-7 — the shape of one edge's five authored slots. */
function shapeDiagnostics(edge: PairingEdge, object: string): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []

  for (const field of ["subject", "object"] as const) {
    const value = slot(edge, field)
    if (typeof value === "string" && PAIRING_HANDLE.test(value)) continue
    out.push(
      diag(
        object,
        "malformed-pairing-handle",
        field,
        `${JSON.stringify(value)} is not a product or category handle (expected ` +
          "kebab-case ASCII like `costela-bovina-defumada`, per CLAUDE.md's naming " +
          "conventions). The catalog cannot check that a handle EXISTS — that is a " +
          "live-store question it deliberately never asks — so its shape is the " +
          "only static statement available, and it is the form the read looks the " +
          "graph up by, so a mis-shaped end is an edge that can never fire.",
        typeof value === "string" ? value : undefined,
      ),
    )
  }

  const relation = slot(edge, "relation")
  if (typeof relation !== "string" || !RELATION_SET.has(relation)) {
    out.push(
      diag(
        object,
        "unknown-pairing-relation",
        "relation",
        `${JSON.stringify(relation)} is not a pairing relation (expected one of ` +
          `${PAIRING_RELATIONS.join(", ")}). The relation selects which sentence the ` +
          "read renders — 'vai bem com' invites an addition, 'no lugar' answers an " +
          "absence — so an unknown one is an edge with no way to be spoken. Adding " +
          "a relation is a template change and a claim-type conversation, not a row.",
        typeof relation === "string" ? relation : undefined,
      ),
    )
  }

  const provenance = slot(edge, "provenance")
  if (typeof provenance !== "string" || !PROVENANCE_SET.has(provenance)) {
    out.push(
      diag(
        object,
        "unknown-pairing-provenance",
        "provenance",
        `${JSON.stringify(provenance)} is not a pairing provenance (expected one of ` +
          `${PAIRING_PROVENANCES.join(", ")}). This is not bookkeeping: the ` +
          "owner-review rules below branch on provenance, so an unrecognized tag " +
          "would let an invented pairing skip the review flag it exists to carry — " +
          "a fail-OPEN, which is why a typo here is an error rather than a default.",
        typeof provenance === "string" ? provenance : undefined,
      ),
    )
  }

  const why = slot(edge, "why")
  if (typeof why !== "string" || why.trim() === "") {
    out.push(
      diag(
        object,
        "malformed-pairing-rationale",
        "why",
        `${JSON.stringify(why)} states no reason. \`why\` is the REVIEW surface for ` +
          "a table whose rows cannot be checked against anything external — an " +
          "author's taste and the house's taste look identical without it — so an " +
          "edge that declines to say why it exists is not reviewable, which is the " +
          "one thing every row here has to be.",
      ),
    )
  }

  return out
}

/**
 * Rules 11-12 — provenance and its review flag, the pair that makes the
 * `authored` tag mean something. Checked per edge and only once its provenance
 * is known to be a real one.
 */
function reviewDiagnostics(edge: PairingEdge, object: string): readonly CatalogDiagnostic[] {
  const provenance = slot(edge, "provenance")
  const flagged = slot(edge, "ownerReview") === true

  if (provenance === "authored" && !flagged) {
    return [
      diag(
        object,
        "unreviewed-authored-pairing",
        "ownerReview",
        "this edge is tagged `authored` — invented, with no menu data behind it — " +
          "and carries no `ownerReview: true`. That flag is required precisely " +
          "because an invented pairing reads exactly like a real one in review: " +
          "there is no external fact to check the house's taste against, so the " +
          "table has to say which rows are awaiting an opinion. Either flag it, or " +
          "ground it in menu data and tag it `menu-composition` with the quote.",
      ),
    ]
  }

  if (provenance === "menu-composition" && flagged) {
    return [
      diag(
        object,
        "unnecessary-pairing-review-flag",
        "ownerReview",
        "this edge is grounded in the store's own menu data and still carries " +
          "`ownerReview: true`. An edge read off the menu is not awaiting anybody's " +
          "opinion, and a flag on it is not harmless: the flag's whole value is " +
          "that counting it counts the UNGROUNDED rows, and a review queue padded " +
          "with rows nobody needs to look at is a queue nobody looks at.",
      ),
    ]
  }

  return []
}

/** Rules 8-10 — everything that is a property of a GROUP of edges. */
function groupDiagnostics(edges: readonly Registered[]): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const edgeFirstAt = new Map<string, Registered>()
  /** Unordered pair -> the first edge seen for it, whatever its relation. */
  const pairFirstAt = new Map<string, Registered>()

  for (const entry of edges) {
    // Rule 9 — the same subject, relation and object declared twice.
    const edgeKey = `${entry.subject} ${entry.relation} ${entry.target}`
    const duplicated = edgeFirstAt.get(edgeKey)
    if (duplicated === undefined) {
      edgeFirstAt.set(edgeKey, entry)
    } else {
      out.push(
        diag(
          entry.object,
          "duplicate-pairing-edge",
          "object",
          `this edge repeats the one at array position ${duplicated.index} — the ` +
            `same subject, the same relation and the same object ("${entry.target}"). ` +
            "The second row can never change what " +
            "the read renders; it can only drift away from the first one when " +
            "somebody edits the wrong copy, and it would make the suggestion appear " +
            "twice in one sentence.",
          entry.target,
        ),
      )
      continue
    }

    // Rule 10 — one pair of things related two contradictory ways. Keyed on the
    // UNORDERED pair: "have the coleslaw WITH the pulled pork" and "have it
    // INSTEAD OF the pulled pork" are incoherent in either direction.
    const pairKey = [entry.subject, entry.target].sort().join(" ")
    const related = pairFirstAt.get(pairKey)
    if (related === undefined) {
      pairFirstAt.set(pairKey, entry)
      continue
    }
    if (related.relation === entry.relation) continue
    out.push(
      diag(
        entry.object,
        "contradictory-pairing-relations",
        "relation",
        `these two handles are already related as "${related.relation}" at array ` +
          `position ${related.index}, and this edge relates them as ` +
          `"${entry.relation}". The house cannot coherently say both "have these ` +
          'together" and "have this INSTEAD" about one pair — the two render as ' +
          "different acts, and a customer asking about either end would be told " +
          "both. Keep the relation the house actually means; the direction of the " +
          "edges does not rescue it, which is why this is keyed on the unordered " +
          "pair.",
        entry.target,
      ),
    )
  }

  return out
}

/**
 * Run the pairing-graph pass.
 *
 * `checked` counts authored SLOTS the pass takes responsibility for — the
 * subject, relation, object, provenance and rationale of every declared edge,
 * plus every declared review flag. A run reporting `checked: 0` against the
 * real catalog means the graph is gone, not that it is clean (the
 * anti-vacuous-gate signal `CatalogPassResult.checked` exists for).
 */
export function runPairingGraphPass(edges: readonly PairingEdge[] = []): CatalogPassResult {
  const diagnostics: CatalogDiagnostic[] = []
  let checked = 0
  const registered: Registered[] = []

  edges.forEach((edge, index) => {
    const subject = slot(edge, "subject")
    const object = pairingObjectName(subject, index)
    checked += 5 + (slot(edge, "ownerReview") === undefined ? 0 : 1)

    const safety = safetyDiagnostics(edge, object)
    if (safety.length > 0) {
      diagnostics.push(...safety)
      return
    }

    const shape = shapeDiagnostics(edge, object)
    if (shape.length > 0) {
      diagnostics.push(...shape)
      return
    }

    // Provenance is known to be a real tag by the time we get here, which is
    // what makes the review rules' branch on it total.
    const review = reviewDiagnostics(edge, object)
    if (review.length > 0) {
      diagnostics.push(...review)
      return
    }

    // Both ends are well-formed handles by now, which is what makes a BYTE
    // comparison complete from here on (see `sameHandle`).
    const subjectHandle = subject as string
    const targetHandle = slot(edge, "object") as string

    // Rule 8 — a thing paired with itself. Reported here rather than in the
    // group rules because it is a property of the one edge, and registering it
    // would make its unordered pair key degenerate.
    if (sameHandle(subjectHandle, targetHandle)) {
      diagnostics.push(
        diag(
          object,
          "self-referential-pairing-edge",
          "object",
          "this edge relates a handle to itself. Neither relation can mean " +
            "anything about one thing: 'vai bem com' would suggest what the " +
            "customer already asked about, and 'no lugar' would offer the " +
            "unavailable item as its own stand-in — an answer that reads as " +
            "helpful and tells the customer nothing.",
          targetHandle,
        ),
      )
      return
    }

    registered.push({
      index,
      object,
      relation: slot(edge, "relation") as string,
      subject: subjectHandle,
      target: targetHandle,
    })
  })

  diagnostics.push(...groupDiagnostics(registered))

  return { pass: PASS, checked, diagnostics }
}
