// ALIAS-GAZETTEER rejection fixtures (LE2-025a).
//
// The `alias-gazetteer` pass rejects eight ways, and each fixture below is the
// minimal witness for exactly one. They share the shape the external-reference
// family established: the CAPABILITY half is always one unmodified
// `IDENTITY_BASE`, present only because the suite requires every fixture to
// compile at least one capability. The specimen is the GAZETTEER.
//
// The edge below is the control, spelled once and mutated in one slot per
// fixture, in the same discipline `base.ts` establishes for capabilities.
//
// Every surface form carries the word `conformance`, so a fixture alias can
// never collide with an authored production one — and, just as important, so
// that a fixture's normal form can never accidentally equal a real customer
// word somebody adds to the gazetteer later.
//
// # The one thing these fixtures cannot prove
//
// That a canonical name RESOLVES. `conformance-entidade-canonica` is not a
// product and never will be; the pass checks its SHAPE, because whether a
// handle names a row anybody sells is a live-store question the catalog
// deliberately never asks (see `src/alias-gazetteer.ts` on the deferred
// reconciliation decision). The day that gate exists, its fixtures live with
// the reconciler, exactly as LE2-018's do.

import { IDENTITY_BASE } from "./base.js"
import { fixtureAliases, fixtureCatalog, type ConformanceFixture } from "../types.js"

/** The capability every fixture here compiles alongside its gazetteer. */
const CARRIER: readonly unknown[] = [
  { ...IDENTITY_BASE, kind: "conformance.alias.carrier" },
]

/** The well-formed alias edge each fixture mutates in exactly one slot. */
const ALIAS_BASE = {
  surface: "conformance apelido",
  canonical: "conformance-entidade-canonica",
  provenance: "authored",
  why: "the fixture control — an alias edge with nothing wrong with it.",
} as const

/** A second entity, for the rules that need two readings of one surface. */
const OTHER_CANONICAL = "conformance-entidade-alternativa"

export const ALIAS_GAZETTEER_FIXTURES: readonly ConformanceFixture[] = [
  {
    name: "alias-gazetteer.safety-restricted-alias-target",
    targets: "alias-gazetteer/safety-restricted-alias-target",
    why:
      "an alias resolving to a dietary class. This is the ratified BKL-171 " +
      "rejection in its plainest form: declaring that a colloquial word NAMES " +
      "`sem gluten` is declaring that resolving it justifies the dietary " +
      "assertion the ruling refused. Note the canonical name is a perfectly " +
      "well-shaped handle — the shape rule cannot see this, which is why the " +
      "safety rule is not a special case of it.",
    definitions: fixtureCatalog(...CARRIER),
    aliases: fixtureAliases({
      ...ALIAS_BASE,
      canonical: "conformance-sem-gluten",
    }),
  },
  {
    name: "alias-gazetteer.safety-restricted-alias-surface",
    targets: "alias-gazetteer/safety-restricted-alias-surface",
    why:
      "an alias whose SURFACE carries a dietary marker — the alias layer's own " +
      "failure mode rather than a restatement of the target rule. " +
      "Canonicalization runs before the parse, so this edge would rewrite the " +
      "customer's dietary words out of the utterance and the closed-taxonomy " +
      "safety routing would never see the marker it exists to escalate on. The " +
      "target here is the untouched control.",
    definitions: fixtureCatalog(...CARRIER),
    aliases: fixtureAliases({
      ...ALIAS_BASE,
      surface: "conformance sem lactose",
    }),
  },
  {
    name: "alias-gazetteer.malformed-alias-surface",
    targets: "alias-gazetteer/malformed-alias-surface",
    why:
      "a surface form with a leading space and an internal double space. Both " +
      "are invisible in review and both make an alias that can never match what " +
      "a customer typed — a dead row that looks correct, which is the failure a " +
      "normal-form gate is cheapest at catching.",
    definitions: fixtureCatalog(...CARRIER),
    aliases: fixtureAliases({
      ...ALIAS_BASE,
      surface: " conformance  apelido malformado ",
    }),
  },
  {
    name: "alias-gazetteer.malformed-alias-canonical",
    targets: "alias-gazetteer/malformed-alias-canonical",
    why:
      "a canonical name spelled as a display title rather than a handle. The " +
      "catalog cannot check that a canonical name EXISTS, so its shape is the " +
      "only static statement available — and it is the form a future " +
      "reconciliation gate would probe the live store by.",
    definitions: fixtureCatalog(...CARRIER),
    aliases: fixtureAliases({
      ...ALIAS_BASE,
      canonical: "Conformance Entidade Canônica",
    }),
  },
  {
    name: "alias-gazetteer.duplicate-alias-edge",
    targets: "alias-gazetteer/duplicate-alias-edge",
    why:
      "the same surface form resolving to the same entity twice, spelled with " +
      "different case and punctuation. Deliberately NOT a byte-identical row: " +
      "the point is that the gazetteer's normal form is what decides identity, " +
      "and a second copy can only ever drift away from the first when somebody " +
      "edits the wrong one.",
    definitions: fixtureCatalog(...CARRIER),
    aliases: fixtureAliases(
      { ...ALIAS_BASE, surface: "conformance apelido repetido" },
      { ...ALIAS_BASE, surface: "Conformance Apelido Repetido!" },
    ),
  },
  {
    name: "alias-gazetteer.ambiguous-alias-surface",
    targets: "alias-gazetteer/ambiguous-alias-surface",
    why:
      "one surface form naming two entities with no declared disambiguation — " +
      "ticket 25's load-bearing acceptance criterion. Needs two edges by " +
      "nature: ambiguity is not a property either row has alone. BOTH readings " +
      "are reported, because each is separately fixable and a diagnostic on " +
      "only one would imply the other is the right answer.",
    definitions: fixtureCatalog(...CARRIER),
    aliases: fixtureAliases(
      { ...ALIAS_BASE, surface: "conformance apelido ambiguo" },
      {
        ...ALIAS_BASE,
        surface: "conformance apelido ambiguo",
        canonical: OTHER_CANONICAL,
      },
    ),
  },
  {
    name: "alias-gazetteer.colliding-alias-disambiguation",
    targets: "alias-gazetteer/colliding-alias-disambiguation",
    why:
      "an ambiguous surface where BOTH readings declare the same disambiguating " +
      "token. This is what the ambiguity rule looks like when it is satisfied " +
      "without being answered — a coin flip with paperwork — so it must be its " +
      "own rejection rather than something the ambiguity rule happens to miss.",
    definitions: fixtureCatalog(...CARRIER),
    aliases: fixtureAliases(
      {
        ...ALIAS_BASE,
        surface: "conformance apelido colidente",
        disambiguatedBy: "conformance token",
      },
      {
        ...ALIAS_BASE,
        surface: "conformance apelido colidente",
        canonical: OTHER_CANONICAL,
        disambiguatedBy: "conformance token",
      },
    ),
  },
  {
    name: "alias-gazetteer.unnecessary-alias-disambiguation",
    targets: "alias-gazetteer/unnecessary-alias-disambiguation",
    why:
      "a disambiguating token on a surface form that names exactly one entity. " +
      "The mirror of the ambiguity rule, and not merely tidiness: a required " +
      "token on an unambiguous alias makes it stop matching the bare word it " +
      "was written to catch, and the failure is silent.",
    definitions: fixtureCatalog(...CARRIER),
    aliases: fixtureAliases({
      ...ALIAS_BASE,
      surface: "conformance apelido solitario",
      disambiguatedBy: "conformance token",
    }),
  },
]

/**
 * The clean control for the family: the well-formed edge, plus an ambiguous
 * surface form that is ambiguous CORRECTLY.
 *
 * The second half is what makes this more than a control. Seven of the eight
 * rejections above are absences, and a corpus of absences never proves the
 * positive path exists — this fixture is the one that shows a surface form
 * naming two entities is ALLOWED, and compiles silent, as long as each reading
 * declares the token that selects it. That is the shape the real gazetteer's
 * `costela` pair takes, and the rule the ambiguity diagnostic tells authors to
 * reach for.
 *
 * Registered with the other clean fixtures so the corpus reads in one place,
 * but authored here next to the specimens it controls for.
 */
export const CLEAN_ALIAS_GAZETTEER_FIXTURE: ConformanceFixture = {
  name: "clean.alias-gazetteer",
  targets: null,
  why:
    "a well-formed alias edge beside a correctly-declared ambiguous pair. The " +
    "control for all eight alias rejections, and the only clean fixture whose " +
    "`alias-gazetteer` pass reports a non-zero `checked` — which is what proves " +
    "the other clean goldens' zeros mean 'nothing declared' rather than 'pass " +
    "not running'.",
  definitions: fixtureCatalog(...CARRIER),
  aliases: fixtureAliases(
    { ...ALIAS_BASE },
    {
      ...ALIAS_BASE,
      surface: "conformance apelido ambiguo",
      disambiguatedBy: "primeira",
    },
    {
      ...ALIAS_BASE,
      surface: "conformance apelido ambiguo",
      canonical: OTHER_CANONICAL,
      disambiguatedBy: "segunda",
    },
  ),
}
