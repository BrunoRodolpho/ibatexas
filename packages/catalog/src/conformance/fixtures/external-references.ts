// EXTERNAL-REFERENCES rejection fixtures (LE2-018).
//
// The `external-references` pass rejects five ways, and each fixture below is
// the minimal witness for exactly one. They share a shape the other families
// do not: the CAPABILITY half is always one unmodified `IDENTITY_BASE` — the
// specimen is the DECLARATION table, and the capability is there only so the
// consumer edge has something real to resolve against (and because the suite
// requires every fixture to compile at least one capability).
//
// The declaration below is therefore the control, spelled once and mutated in
// one slot per fixture, in the same discipline `base.ts` establishes for
// capabilities.
//
// # The one thing these fixtures cannot prove
//
// That the reference EXISTS. This pass reads a table; whether Medusa holds a
// promotion called whatever `WELCOME_CREDIT_COUPON_CODE` resolves to is
// answered by IO, and IO does not belong in a conformance fixture — it belongs
// in the reconciler's seam tests (`packages/tools/src/__tests__/external-
// references/`) and in the api's boot-gate test, which is where LE2-018's
// refuse-to-start half is actually proven.

import { IDENTITY_BASE } from "./base.js"
import { fixtureCatalog, fixtureExternalReferences, type ConformanceFixture } from "../types.js"

/** The capability every fixture here declares as its consumer. */
const CONSUMER_KIND = "conformance.external-ref.consumer"

const CONSUMER: readonly unknown[] = [{ ...IDENTITY_BASE, kind: CONSUMER_KIND }]

/** The well-formed declaration each fixture mutates in exactly one slot. */
const DECLARATION_BASE = {
  id: "promotion.conformance",
  store: "promotion",
  keyFrom: "CONFORMANCE_COUPON_CODE",
  why: "the fixture control — a declaration with nothing wrong with it.",
  declaredBy: [
    {
      capability: CONSUMER_KIND,
      site: "packages/catalog/src/conformance/fixtures/external-references.ts",
      usage: "the conformance corpus's stand-in consumer",
    },
  ],
} as const

export const EXTERNAL_REFERENCES_FIXTURES: readonly ConformanceFixture[] = [
  {
    name: "external-references.external-reference-unknown-store",
    targets: "external-references/external-reference-unknown-store",
    why:
      "a declaration naming a store the repo has no probe for. The store id is " +
      "half of a pair — the other half is a probe in @ibatexas/tools — and a " +
      "reference in an unprobeable store can only ever fail the boot or be " +
      "skipped silently, so the compiler refuses it before either happens.",
    definitions: fixtureCatalog(...CONSUMER),
    externalReferences: fixtureExternalReferences({
      ...DECLARATION_BASE,
      store: "loyalty-ledger",
    }),
  },
  {
    name: "external-references.external-reference-malformed-key-source",
    targets: "external-references/external-reference-malformed-key-source",
    why:
      "`keyFrom` spelled in lower case — a variable name nothing will ever set, " +
      "so the reference could never resolve. Note what this rule CANNOT catch, " +
      "which the first draft of this fixture learned the hard way: `BEMVINDO15` " +
      "is a legal env-var name by shape, so a hardcoded coupon smuggled into " +
      "keyFrom passes the static check and is caught one layer down, at " +
      "reconciliation, where the unset variable becomes a named boot refusal.",
    definitions: fixtureCatalog(...CONSUMER),
    externalReferences: fixtureExternalReferences({
      ...DECLARATION_BASE,
      keyFrom: "welcome_credit_coupon_code",
    }),
  },
  {
    name: "external-references.external-reference-no-consumer",
    targets: "external-references/external-reference-no-consumer",
    why:
      "a declaration nothing consumes. It can still refuse the boot, and the " +
      "refusal would name no code site to fix — a gate that takes the process " +
      "hostage without saying why is worse than no gate.",
    definitions: fixtureCatalog(...CONSUMER),
    externalReferences: fixtureExternalReferences({
      ...DECLARATION_BASE,
      declaredBy: [],
    }),
  },
  {
    name: "external-references.external-reference-consumer-dangling",
    targets: "external-references/external-reference-consumer-dangling",
    why:
      "a consumer naming a capability kind the catalog does not define — what a " +
      "renamed capability leaves behind. The declaration survives the rename " +
      "and keeps sending operators to a symbol that no longer exists, which is " +
      "the failure mode a boot diagnostic can least afford.",
    definitions: fixtureCatalog(...CONSUMER),
    externalReferences: fixtureExternalReferences({
      ...DECLARATION_BASE,
      declaredBy: [
        { ...DECLARATION_BASE.declaredBy[0], capability: "order.coupon.renamed-away" },
      ],
    }),
  },
  {
    name: "external-references.external-reference-duplicate-id",
    targets: "external-references/external-reference-duplicate-id",
    why:
      "two declarations sharing one id. The id is the handle the boot refusal, " +
      "the --live report and every diagnostic address a reference by, so a " +
      "collision leaves an operator told to fix `promotion.conformance` with no " +
      "way to know which row is broken. Both rows are reported, deliberately.",
    definitions: fixtureCatalog(...CONSUMER),
    externalReferences: fixtureExternalReferences(
      { ...DECLARATION_BASE },
      { ...DECLARATION_BASE, keyFrom: "CONFORMANCE_COUPON_CODE_ALT" },
    ),
  },
]

/**
 * The clean control for the family: the same declaration, unmutated, beside
 * the capability it names. Registered with the other clean fixtures so the
 * corpus reads in one place, but authored here next to the specimens it
 * controls for.
 */
export const CLEAN_EXTERNAL_REFERENCE_FIXTURE: ConformanceFixture = {
  name: "clean.external-reference",
  targets: null,
  why:
    "a well-formed declaration and the capability that consumes it. The " +
    "control for all five external-reference rejections, and the only clean " +
    "fixture whose `external-references` pass reports a non-zero `checked` — " +
    "which is what proves the other clean goldens' zeros mean 'nothing " +
    "declared' rather than 'pass not running'.",
  definitions: fixtureCatalog(...CONSUMER),
  externalReferences: fixtureExternalReferences({ ...DECLARATION_BASE }),
}
