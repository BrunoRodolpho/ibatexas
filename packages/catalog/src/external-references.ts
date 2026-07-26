// EXTERNAL REFERENCES — the things the catalog points at but does not own
// (LE2-018).
//
// LE2 Implementation Decision 16, strict form: "boot reconciliation REFUSES TO
// START on any miss … The hardcoded welcome-coupon literal becomes a declared
// external reference under this gate."
//
// A capability's cross-references all resolve INSIDE the catalog: a claim
// class, a Pack id, another capability's kind. The referential-integrity pass
// settles those at compile time and nothing at runtime can invalidate them.
// This table is for the other kind — a name the code depends on that lives in
// a LIVE STORE somebody else administers: a promotion in Medusa, a zone row in
// the domain database. Nothing static can prove those exist, and until this
// ticket nothing dynamic tried: the dependency was a comment
// ("must be created in Medusa admin before going live") next to a string
// literal, which is a to-do list, not a gate.
//
// # What a declaration is, and what it deliberately is NOT
//
// A declaration says: THIS reference must exist in THAT store, its key comes
// from THIS config var, and THESE code sites break without it. It does not say
// what the key IS. A coupon code is environment data — staging and production
// may legitimately run different codes, and CLAUDE.md rule 3 ("config: always
// from process.env — never hardcode values in code") is not suspended because
// the value happens to be short and memorable. So the catalog declares
// {@link ExternalReferenceDeclaration.keyFrom}, the NAME of the variable, and
// the value is read at the boundary that verifies it.
//
// That split is what keeps the promise this package makes. The catalog stays
// inert, versioned, environment-free data; the verification — the IO, the
// Medusa call, the Prisma query, the refusal to start — lives downstream in
// `@ibatexas/tools`' reconciler, in the api's boot gate, and behind
// `ibx catalog check --live`. THE CATALOG DECLARES; IT NEVER VERIFIES.
//
// # Why `declaredBy` is a list of sites and not a boolean
//
// The whole value of the gate is the diagnostic. "Promotion BEMVINDO15 is
// missing" tells an operator a fact; "…and `apps/api/src/whatsapp/session.ts`
// will hand a dead coupon code to every new WhatsApp customer for the next 30
// days" tells them what it costs and where to look. A refusal to start is an
// expensive event — blast radius the owner accepted deliberately — so it has
// to pay for itself in the first screen of output.
//
// Pure: no clock, no RNG, no IO, no `process.env`.

/**
 * The live stores a reference can live in.
 *
 * Extensible by design — this union is the pass's vocabulary AND the
 * reconciler's probe registry key, so adding a store is: append here, add a
 * probe in `@ibatexas/tools`, add the conformance fixture the meta-gate will
 * demand. A store with no probe cannot be reconciled and the reconciler says
 * so by name rather than passing it silently.
 */
export const EXTERNAL_REFERENCE_STORES = ["promotion", "delivery-zone"] as const

/** One live store's stable id. */
export type ExternalReferenceStore = (typeof EXTERNAL_REFERENCE_STORES)[number]

/** One code site that breaks when a declared reference is missing. */
export interface ExternalReferenceConsumer {
  /**
   * The capability kind that consumes the reference, or `null` when the
   * consumer is not a capability at all (a session helper, a NATS subscriber).
   * A non-null value is a real edge — the compiler resolves it against the
   * authored capability kinds, so a renamed capability cannot leave a
   * declaration pointing at nothing.
   */
  readonly capability: string | null
  /** Repo-relative path (optionally `#symbol`) — where to go when it fails. */
  readonly site: string
  /** What this site does with the reference, in one clause. */
  readonly usage: string
}

/** One reference the catalog depends on and does not own. */
export interface ExternalReferenceDeclaration {
  /**
   * Stable, unique id — `<store>.<slug>`. This is the name the compiler's
   * diagnostics, the boot refusal and the `--live` report all use, so it
   * outranks the key itself as the thing a human searches for.
   */
  readonly id: string
  /** Which live store must hold it. */
  readonly store: ExternalReferenceStore
  /**
   * The environment variable whose value is the reference's KEY in that store
   * (a promotion `code`, a delivery zone `name` or `id`). Never the key: see
   * the module doc.
   */
  readonly keyFrom: string
  /** Every code site that depends on it. Never empty. */
  readonly declaredBy: readonly ExternalReferenceConsumer[]
  /** Why it must exist — the sentence a boot refusal quotes at the operator. */
  readonly why: string
}

/**
 * The authored external references.
 *
 * # Why there are two promotions and no delivery zones
 *
 * The two coupons are the repo's actual dangling references, found by the
 * comments that stood in for a gate: `BEMVINDO15` (welcome credit) and
 * `FIEL20` (loyalty reward). Both were string literals in code with a
 * "must be created in Medusa admin" note beside them; both are now declared,
 * config-sourced and boot-verified, and both notes are gone.
 *
 * No delivery zone is declared, and that is a finding rather than an omission.
 * The `delivery-zone` store, its probe and its conformance fixtures all exist —
 * zones ARE declarable, which is the acceptance criterion — but nothing in the
 * repo names a zone: `estimate-delivery.ts` matches whatever active rows the
 * `delivery_zones` table holds, by CEP prefix or by Haversine distance, and
 * degrades to a pt-BR out-of-area message when none match. Declaring, say,
 * "Araraquara Centro" here would INVENT a go-live requirement and then refuse
 * to boot any environment whose seed differs — manufacturing exactly the class
 * of outage this gate exists to prevent. A zone earns a row here the day a code
 * path names one.
 */
export const EXTERNAL_REFERENCES: readonly ExternalReferenceDeclaration[] = [
  {
    id: "promotion.welcome-credit",
    store: "promotion",
    keyFrom: "WELCOME_CREDIT_COUPON_CODE",
    why:
      "every first-time WhatsApp customer is granted this coupon for 30 days at " +
      "onboarding and it is applied automatically at checkout. If the promotion " +
      "does not exist, the grant still succeeds and the failure surfaces a month " +
      "later as a rejected code at the moment of payment — for the customers the " +
      "restaurant most wants to keep.",
    declaredBy: [
      {
        capability: null,
        site: "apps/api/src/whatsapp/session.ts#setWelcomeCredit",
        usage: "writes the code into Redis with a 30-day TTL at onboarding",
      },
      {
        capability: "order.checkout.create",
        site: "packages/tools/src/cart/create-checkout.ts",
        usage: "consumes the granted code and applies it to the Medusa cart",
      },
    ],
  },
  {
    id: "promotion.loyalty-reward",
    store: "promotion",
    keyFrom: "LOYALTY_REWARD_COUPON_CODE",
    why:
      "the punch-card program promises this code in pt-BR prose the moment a " +
      "customer's tenth stamp lands (a NATS-driven WhatsApp message) and repeats " +
      "it on every balance check. A missing promotion turns an earned reward into " +
      "a broken promise the system keeps making.",
    declaredBy: [
      {
        capability: null,
        site: "apps/api/src/subscribers/cart-intelligence.ts",
        usage: "announces the reward on order.placed when the tenth stamp lands",
      },
      {
        capability: null,
        site: "packages/tools/src/intelligence/get-loyalty-balance.ts",
        usage: "repeats the code whenever a customer asks for their balance",
      },
    ],
  },
]
