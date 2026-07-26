// PASS 4 — ALIAS GAZETTEER (LE2-025, compile half).
//
// The static half of the semantic alias layer. Ticket 25 asks for two things
// that are easy to run together: a table of colloquial surface forms that
// resolve to canonical entities, and a runtime that canonicalizes at parse
// entry, feeds L1/L2, CLARIFIES on an unknown surface form and records the
// resolution in the trace. This pass owns the first exclusively and owns none
// of the second: it proves the table in `src/alias-gazetteer.ts` is one a
// runtime can be handed WITHOUT ever having to guess.
//
// # Why a seventh pass rather than rules on an existing one
//
// The same three reasons `external-references` gave for being its own pass
// (see that module), all of which apply verbatim here:
//
//   1. `checked` is the anti-vacuous measure and it only works PER PASS.
//      Folding alias edges into another pass's count would hide "the
//      gazetteer was never looked at" inside a number that moves for
//      unrelated reasons.
//   2. This pass reads a THIRD INPUT. Every other pass is a function of the
//      definitions (plus, for one of them, the external-reference table); this
//      one reads the gazetteer, and teaching an existing pass a new parameter
//      to serve one rule family is how a coherent pass becomes a junk drawer.
//   3. The static and runtime halves should share a name, so an author who
//      sees `alias-gazetteer/...` in a build log can grep the runtime that
//      will consume the same table.
//
// # The rules, and what each is actually protecting
//
//   1. `safety-restricted-alias-target`      — the canonical end names an
//                                              allergen/dietary attribute
//   2. `safety-restricted-alias-surface`     — the customer-spoken end does
//   3. `malformed-alias-surface`             — a surface form not in normal form
//   4. `malformed-alias-canonical`           — a canonical name that is not a handle
//   5. `duplicate-alias-edge`                — the same edge declared twice
//   6. `ambiguous-alias-surface`             — one surface, two entities, no
//                                              declared disambiguation
//   7. `colliding-alias-disambiguation`      — a declared disambiguation that
//                                              does not disambiguate
//   8. `unnecessary-alias-disambiguation`    — a disambiguation on a surface
//                                              that is not ambiguous
//
// Rule 6 is the ticket's load-bearing acceptance criterion, and the reasoning
// for making it a BUILD error rather than a runtime tie-break is in
// `src/alias-gazetteer.ts` (short version: the seed table already contains a
// real instance — two costelas, one word, real customers typing it — and no
// ordering of the table makes the coin flip correct).
//
// Rules 7 and 8 exist because rule 6 is otherwise satisfiable by a token that
// does nothing. A disambiguation both readings declare is still a coin flip
// with paperwork; a disambiguation on a surface form that names exactly one
// entity is worse than useless, because it makes a working alias stop matching
// the bare word it was written to catch. Both are the shape of a rule 6 fix
// applied without thinking, which is exactly when a gate earns its keep.
//
// # The safety binding, and why BOTH ends are checked
//
// The ratified rulings (BKL-143 / BKL-123 / BKL-171, quoted in full in
// `safety-implication-edges.ts`) forbid letting a stored attribute imply a
// customer-facing allergen or dietary assertion. An alias edge can do that
// from either end, and the two failures are different:
//
//   - TARGET end. An alias resolving to `sem-gluten` or `menu-item-allergens`
//     is the forbidden implication in its plainest form: it declares that a
//     colloquial word NAMES a dietary class, which is the license BKL-171
//     refused.
//   - SURFACE end. This one is the alias layer's own: canonicalization runs
//     BEFORE the parse, so a surface form carrying an allergen marker gets
//     rewritten into something else before anything downstream can see the
//     marker at all. The customer's safety-bearing words would be erased on
//     the way in, and §O#9's closed-taxonomy safety routing — an unrecognized
//     health/safety marker ESCALATES, never passes through — would never fire
//     because there would be nothing left to recognize. An alias layer that
//     can silently disarm the safety router is a worse failure than one that
//     rejects a few edges it did not need to.
//
// The customer-spoken end is the SURFACE FORM and the DISAMBIGUATING TOKEN
// alike — both are words the customer has to say for the reading to apply —
// so both are checked under rule 2, with `field` naming which one it was.
//
// Classification is `safety-markers.ts`'s `safetyMarkerOf`, the same function
// `safety-implication-edges` uses. One vocabulary, two enforcement sites: a
// marker added there is enforced here the same day, with no second list to
// remember.
//
// # The false positives are deliberate, and here is the worked example
//
// `safetyMarkerOf` matches STEMS and whole segments, not an exact denylist, so
// it fires on any name that CONTAINS a marker. Against claim ids that is
// almost always a true positive. Against product handles it is not: the seed
// catalog holds `pudim-de-leite-condensado`, and the `leite` segment makes it
// permanently unaliasable by this pass.
//
// That is the right answer, and not merely an accepted cost. An alias
// "pudim" -> `pudim-de-leite-condensado` resolves a word carrying no dairy
// signal into a dairy product, on the customer's behalf, before the parse. For
// a customer avoiding lactose that is precisely the silent implication
// BKL-143's conservative ruling exists to forbid — the alias would be doing
// the very inference the ruling says the system may not do. The product stays
// fully orderable by its real name, and an unaliased surface form CLARIFIES
// (ticket 25) rather than failing.
//
// Where a future false positive is genuinely just a name collision, the fix is
// an owner-ratified change to `safety-markers.ts`, reviewed — never a quiet
// exception here.
//
// # Order of checks is fail-closed
//
// Safety is classified FIRST, before shape. A safety-bearing edge is reported
// as safety-bearing however badly it is spelled; the alternative — rejecting
// it for a stray space and never mentioning the allergen marker — would let
// the most important diagnostic be masked by the least important one.
//
// Pure: no clock, no RNG, no IO.

import { type AliasEdge, normalizeAliasSurface } from "../../alias-gazetteer.js"
import {
  aliasObjectName,
  type CatalogDiagnostic,
  type CatalogPassResult,
} from "../diagnostics.js"
import { safetyMarkerOf } from "../safety-markers.js"

const PASS = "alias-gazetteer" as const

/**
 * A canonical entity name: kebab-case, ASCII only — CLAUDE.md's standing
 * convention for a product or category handle (`costela-bovina-defumada`).
 *
 * A SHAPE check, and deliberately not a lookup. Whether the handle names a row
 * anybody sells is a live-store question this package must never ask (a
 * compiler that read the world would compile differently on two machines); see
 * `src/alias-gazetteer.ts` on the deferred reconciliation decision. What the
 * shape does buy is that the day that gate is built, every declared name is
 * already in the form it would be probed by.
 */
const CANONICAL_HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Read a slot off an edge structurally — fixtures carry deliberately bad data. */
function slot(edge: AliasEdge, name: string): unknown {
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

/**
 * Why a surface form is not in normal form, or `undefined` when it is.
 *
 * The same modest contract `conversation-projection` holds phrasings to:
 * trimmed, single-spaced, no control characters, and carrying at least one
 * letter or digit. Case and accents are NOT constrained — they are folded for
 * COMPARISON instead, which is where they matter, and a surface form is the
 * customer's own spelling.
 */
function malformation(surface: string): string | undefined {
  if (surface !== surface.trim()) return "it has leading or trailing whitespace"
  if (/[\u0000-\u001f\u007f]/.test(surface)) return "it contains a control character"
  if (/\s{2,}/.test(surface)) return "it contains a run of consecutive whitespace"
  if (normalizeAliasSurface(surface) === "") {
    return "it carries no letter or digit once punctuation is stripped"
  }
  return undefined
}

/** An edge that survived classification, with everything the group rules need. */
interface Registered {
  readonly index: number
  readonly object: string
  readonly surface: string
  readonly normal: string
  readonly canonical: string
  /** Normal form of the declared disambiguation, or `undefined` when absent. */
  readonly token: string | undefined
  /** The disambiguation exactly as authored, for the message. */
  readonly rawToken: string | undefined
}

/**
 * The safety verdict on one edge — rules 1 and 2. Returns the diagnostics and
 * whether the edge is safety-bearing (in which case nothing else is reported
 * about it: it is already rejected, and a second opinion on its spelling would
 * only bury the finding).
 */
function safetyDiagnostics(edge: AliasEdge, object: string): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const surface = slot(edge, "surface")
  const canonical = slot(edge, "canonical")
  const rawToken = slot(edge, "disambiguatedBy")

  // The customer-spoken end first — the alias layer's own failure mode, and
  // the one no other pass in this compiler can see.
  for (const [field, value] of [
    ["surface", surface],
    ["disambiguatedBy", rawToken],
  ] as const) {
    if (typeof value !== "string") continue
    const marker = safetyMarkerOf(value)
    if (marker === undefined) continue
    out.push(
      diag(
        object,
        "safety-restricted-alias-surface",
        field,
        `the customer-spoken side of this alias carries the ${marker.family} ` +
          `marker "${marker.token}". Canonicalization runs BEFORE the parse, so an ` +
          "alias on a safety-bearing phrase rewrites the customer's own words out " +
          "of the utterance and the closed-taxonomy safety routing (§O#9: an " +
          "unrecognized health/safety marker ESCALATES) never sees the marker it " +
          "exists to catch. Forbidden by the ratified BKL-143 / BKL-123 / BKL-171 " +
          "rulings; an allergen or dietary phrase must reach the parser intact.",
        String(value),
      ),
    )
  }

  if (typeof canonical === "string") {
    const marker = safetyMarkerOf(canonical)
    if (marker !== undefined) {
      out.push(
        diag(
          object,
          "safety-restricted-alias-target",
          "canonical",
          `alias edge terminates in the ${marker.family} attribute "${canonical}" ` +
            `(marker "${marker.token}"). Forbidden by the ratified BKL-143 / ` +
            "BKL-123 / BKL-171 rulings: a colloquial word may not be declared to " +
            "NAME an allergen or dietary class, because the resolution would then " +
            "license exactly the customer-facing assertion those rulings refused. " +
            "Reopening requires an explicit owner reversal in writing. If this is " +
            "an ordinary product whose NAME merely contains an ingredient word, " +
            "that is the deliberate false positive documented in this pass — the " +
            "product stays orderable by its real name.",
          canonical,
        ),
      )
    }
  }

  return out
}

/** Rules 3 and 4 — the shape of one edge's two ends. */
function shapeDiagnostics(edge: AliasEdge, object: string): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const surface = slot(edge, "surface")
  const canonical = slot(edge, "canonical")

  const fault =
    typeof surface !== "string"
      ? `it is not a string (${typeof surface})`
      : malformation(surface)
  if (fault !== undefined) {
    out.push(
      diag(
        object,
        "malformed-alias-surface",
        "surface",
        `surface form ${JSON.stringify(surface)} is not in normal form: ${fault}. ` +
          "A surface form is matched against what a customer typed, so stray " +
          "whitespace and control characters make an alias that can never fire — " +
          "silently, and looking correct in review.",
        typeof surface === "string" ? surface : undefined,
      ),
    )
  }

  if (typeof canonical !== "string" || !CANONICAL_HANDLE.test(canonical)) {
    out.push(
      diag(
        object,
        "malformed-alias-canonical",
        "canonical",
        `${JSON.stringify(canonical)} is not a canonical entity name (expected a ` +
          "kebab-case ASCII handle like `costela-bovina-defumada`, per CLAUDE.md's " +
          "naming conventions). The catalog cannot check that a canonical name " +
          "EXISTS — that is a live-store question it deliberately never asks — so " +
          "its shape is the only static statement available, and it is what a " +
          "future reconciliation gate would probe by.",
        typeof canonical === "string" ? canonical : undefined,
      ),
    )
  }

  return out
}

/** Rules 5 to 8 — everything that is a property of a GROUP of edges. */
function groupDiagnostics(group: readonly Registered[]): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const canonicals = new Set(group.map((entry) => entry.canonical))

  // Rule 5 — the same surface -> the same entity, declared twice.
  const firstAt = new Map<string, Registered>()
  for (const entry of group) {
    const earlier = firstAt.get(entry.canonical)
    if (earlier === undefined) {
      firstAt.set(entry.canonical, entry)
      continue
    }
    out.push(
      diag(
        entry.object,
        "duplicate-alias-edge",
        "canonical",
        `this edge repeats the one at array position ${earlier.index} — the same ` +
          `surface form ("${entry.normal}" under the gazetteer's normal form) ` +
          `resolving to the same entity "${entry.canonical}". The second row can ` +
          "never change a resolution; it can only drift away from the first one " +
          "when somebody edits the wrong copy.",
        entry.canonical,
      ),
    )
  }

  if (canonicals.size > 1) {
    const competing = [...canonicals].sort().join(", ")

    // Rule 6 — ambiguity with no declared disambiguation. Reported on every
    // reading that fails to declare one, because each is separately fixable.
    for (const entry of group) {
      if (entry.token !== undefined) continue
      out.push(
        diag(
          entry.object,
          "ambiguous-alias-surface",
          "surface",
          `this surface form names ${canonicals.size} entities (${competing}), and ` +
            `the reading at array position ${entry.index} ("${entry.canonical}") ` +
            "declares no `disambiguatedBy` — so resolving it would be a coin flip " +
            "between entities with different prices and different fulfilment. " +
            "Ticket 25: an ambiguous alias without a declared disambiguation is a " +
            "compile error, because there is no ordering of the table that makes " +
            "the guess correct. Declare the token the customer actually says to " +
            "select THIS reading; the runtime CLARIFIES when none is present.",
          entry.canonical,
        ),
      )
    }

    // Rule 7 — a declared disambiguation that does not disambiguate.
    const tokenFirstAt = new Map<string, Registered>()
    for (const entry of group) {
      if (entry.token === undefined) continue
      const earlier = tokenFirstAt.get(entry.token)
      if (earlier === undefined) {
        tokenFirstAt.set(entry.token, entry)
        continue
      }
      out.push(
        diag(
          entry.object,
          "colliding-alias-disambiguation",
          "disambiguatedBy",
          `${JSON.stringify(entry.rawToken)} already selects the reading at array ` +
            `position ${earlier.index} ("${earlier.canonical}"). A token both ` +
            "readings claim leaves the surface form exactly as ambiguous as it was " +
            "before — a coin flip with paperwork. The disambiguating token must be " +
            "the thing that actually differs in what the customer says.",
          entry.token,
        ),
      )
    }
    return out
  }

  // Rule 8 — a disambiguation on a surface form that names one entity.
  for (const entry of group) {
    if (entry.token === undefined) continue
    out.push(
      diag(
        entry.object,
        "unnecessary-alias-disambiguation",
        "disambiguatedBy",
        `this surface form names exactly one entity ("${entry.canonical}"), so ` +
          `there is nothing for ${JSON.stringify(entry.rawToken)} to select ` +
          "between. A required token on an unambiguous alias is not harmless: it " +
          "makes the alias stop matching the bare word it was written to catch, " +
          "and the failure is silent. Drop it, or declare the sibling reading it " +
          "was meant to be told apart from.",
        entry.token,
      ),
    )
  }

  return out
}

/**
 * Run the alias-gazetteer pass.
 *
 * `checked` counts alias ENDS the pass takes responsibility for — the surface
 * and the canonical of every declared edge, plus every declared disambiguation
 * token. A run reporting `checked: 0` against the real catalog means the
 * gazetteer is gone, not that it is clean (the anti-vacuous-gate signal
 * `CatalogPassResult.checked` exists for).
 */
export function runAliasGazetteerPass(aliases: readonly AliasEdge[] = []): CatalogPassResult {
  const diagnostics: CatalogDiagnostic[] = []
  let checked = 0

  /** Normal-form surface -> the edges claiming it, in declaration order. */
  const groups = new Map<string, Registered[]>()

  aliases.forEach((edge, index) => {
    const surface = slot(edge, "surface")
    const object = aliasObjectName(surface, index)
    const rawToken = slot(edge, "disambiguatedBy")
    checked += 2 + (rawToken === undefined ? 0 : 1)

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

    // Both ends are well-formed strings by the time we get here.
    const normal = normalizeAliasSurface(surface as string)
    // A blank or non-string `disambiguatedBy` reads as ABSENT rather than as a
    // second fault: fail-closed, because that routes it into rule 6 (which
    // demands a real one) instead of letting an empty string satisfy it.
    const token =
      typeof rawToken === "string" && normalizeAliasSurface(rawToken) !== ""
        ? normalizeAliasSurface(rawToken)
        : undefined
    const registered: Registered = {
      index,
      object,
      surface: surface as string,
      normal,
      canonical: slot(edge, "canonical") as string,
      token,
      rawToken: token === undefined ? undefined : (rawToken as string),
    }
    groups.set(normal, [...(groups.get(normal) ?? []), registered])
  })

  for (const group of groups.values()) {
    diagnostics.push(...groupDiagnostics(group))
  }

  return { pass: PASS, checked, diagnostics }
}
