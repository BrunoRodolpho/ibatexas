/**
 * PAYMENT_STATUS — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S7).
 *
 * THIS is the single editable artifact for the PAYMENT_STATUS claim type. It UNIONS what
 * was previously scattered across four files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[PAYMENT_STATUS]      (~42 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[PAYMENT_STATUS] (~9 lines)
 *   - `claim-definition-registry.ts` TRIAD_SCOPED_TYPES membership
 *   - `required-claim-decomposer.ts` the PAYMENT_STATUS_Q closure row + its pt-BR marker net
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./payment-status.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 *  THE REGISTRY FIRSTS — three facets no adopted type has carried before
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * This is the MONEY read (SDD §E's worked safety-critical type, §N P0), so it is the first
 * source to exercise three parts of the published `EvidenceRequirement` schema. Each is
 * verified to survive the compile BY THE COMPILER'S OWN MECHANISM rather than assumed —
 * R2-S4's reference-pass argument, extended field by field and asserted per field in
 * `./__tests__/per-resource-claim.test.ts`:
 *
 *   1. TWO FALSIFIERS (`payment_refund` + `payment_chargeback`). Every predecessor declared
 *      exactly one. `toRegistrySpec` spreads `{ falsifierComplete: true, falsifiers:
 *      def.falsifiers }` — the WHOLE TUPLE, BY REFERENCE, with no per-row rebuild and no
 *      arity assumption — and the source type is `NonEmpty<EvidenceRequirement>`, which is a
 *      lower bound, not a cap. So a two-row set is expressible with NO widening. (The
 *      published `isFalsifierSetMonotone` reads the same array, so the designed-in
 *      "a newer version is only ever safer" guard covers both rows automatically.)
 *   2. THE `first_party_verified` INTEGRITY FLOOR. `minSourceIntegrity` is projected as a
 *      plain scalar (`minSourceIntegrity: def.minSourceIntegrity`) and
 *      `first_party_verified` is a member of the published `SourceIntegrity` union — the
 *      same union `structured` comes from, and the two are the `≈` TIE at the top of the
 *      order (`free_text < human_report < trusted_service < structured ≈
 *      first_party_verified`). Nothing narrows it on the way through.
 *   3. THE `first_party_only` PROVENANCE POLICY, on ALL THREE rows (evidence + both
 *      falsifiers). `provenancePolicy` is a REQUIRED field of `EvidenceRequirement`
 *      (INV-5 default-deny — there is no absent state to default), and the rows travel BY
 *      REFERENCE inside `requiredEvidence` / `falsifiers`, so the policy cannot be dropped
 *      the way `perResourceKey` is. This is the conjunct that makes a `TRUSTED_THIRD_PARTY`
 *      origin REFUSE rather than validate (Inv 3): a PSP webhook echo is not a first-party
 *      money fact, and the investigator's read is what stamps `FIRST_PARTY`.
 *
 * The measured control for all three is the same one R2-S2 established and every slice since
 * has re-run: the PUBLISHED `compileClaimDefinition` on THIS source differs from the widened
 * one in EXACTLY `perResourceKey` and nothing else. If any of the three were being supplied
 * by the repo-local wrapper rather than by the published compiler, that control would fail.
 *
 * ── WHY THE FLOOR AND THE PROVENANCE ARE NOT INTERCHANGEABLE ─────────────────────
 *
 * Worth stating in the source because collapsing them is a Section-P-class misreading:
 * `sourceIntegrity` is EVIDENCE QUALITY (C2, the channel shape) and `provenancePolicy` is
 * ORIGIN TRUST (C3, a separate axis). A `first_party_verified` row with `provenancePolicy:
 * "preserve"` would accept a TRUSTED_THIRD_PARTY origin at full quality; a `structured` row
 * with `first_party_only` would demand first-party origin but accept a lower-quality
 * channel. The money read needs BOTH, and declares both on every row.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 *  THE MARKER / GUARD DECOMPOSITION
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * The PAYMENT_STATUS_Q predicate in `classifyRequestSpans` is COMPOSED from four parts, and
 * only ONE of them is a marker net. The split here is SHARPER than on the order sibling —
 * two of this span's three phrasing sources are guard-conjoined — so it is written out:
 *
 *   COMPILED (the 5 `markers` arms below): the flat STRONG-token literal
 *   `/pago|cobran[çc]a|pagar|paguei|aprovad/`, SPLIT at its top-level alternation into five
 *   arms. `A|B|C|D|E` under `.test` is true iff some alternative matches, which is what
 *   `markers.some((m) => m.test(t))` spells out — behaviour-preserving by construction, and
 *   the five arms REJOIN to the literal byte-for-byte. These are the tokens that are
 *   unambiguously about an EXISTING payment, so they fire regardless of the BKL-204
 *   capability shape.
 *
 *   NOT COMPILED, and why each is a GUARD rather than a marker:
 *     · `pagamento` — `/pagamento/.test(t) && !paymentMethodsQuestion`. `pagamento` is a
 *       STRONG status token EXCEPT in "formas / opções de pagamento", where it names the
 *       CONCEPT rather than the customer's payment (a payment-METHODS acceptance question is
 *       a CAPABILITY question). What classifies is the token CONJOINED with the absence of
 *       that frame, and a `markers` arm cannot express an absence. Folding it in as a bare
 *       arm would fire the owner-scoped money read on every "quais as formas de pagamento?"
 *       and dead-end a ≥2-order customer in the candidates CLARIFY.
 *     · `pix` — `/pix/.test(t) && !capabilityQuestion`. The other DUAL-USE token (BKL-204):
 *       "vocês aceitam pix?" is about what the STORE accepts. Same guard shape, same reason
 *       it cannot be an arm. BKL-238 is the live cost of getting this wrong from the other
 *       side: a bare `pix` push made "quero fechar o pedido e pagar com pix" fire this span,
 *       and the unsatisfiable PAYMENT_STATUS closure degraded RENDER→UNKNOWN on every
 *       checkout turn (SCN-049) until the checkout roots joined the mutation net.
 *     · `!mutationImperative` — the BKL-206 read-vs-mutation split, shared by every
 *       classify-only-eligible read span. A suppression context, never a marker.
 *     · the BARE-"status" fallback and the FE-D03 PAYMENT_HISTORY SUPPRESSION — both are
 *       SEQUENCING facts about the classifier (the fallback reads three other spans'
 *       predicates and pushes this class from outside this type's net; the suppression
 *       SPLICES this class out of the accumulated array when the history span fires).
 *       R2-S5 already ruled the splice hand-written; the only change here is that the class
 *       key it names is now this source's generated `spanClass`.
 *
 * ── WHAT ELSE IS NEW, AND WHAT IS THE ESTABLISHED ROW ───────────────────────────
 *
 * F-6 CLOSED BY THIS SLICE: PAYMENT_STATUS had NO handleTurn-level proof anywhere in the
 * repo (its deepest coverage was kernel/seam level), which for the MONEY read is the gap
 * worth closing first. `../../__tests__/r2s7-status-siblings-claims.e2e.test.ts` drives the
 * real adapter: the owner renders the real composed status off the SUFFIXED key; TWO owned
 * orders of ONE customer discriminate (payment status is per ORDER, so this is R2-S4's
 * two-resources-one-owner axis, not R2-S5's two-customers axis); a victim-subject case
 * proves a foreign order id cannot bind; and a guest records no owner-scoped read at all.
 *
 * Otherwise this is the RESERVATION_STATUS row R2-S4 proved: ONE `must_read_this_turn`
 * required-evidence row, `ownershipPolicy: "required"`, `perResourceKey` subjected by the
 * ORDER id (this type's subject is the ORDER, not the payment — one active payment per
 * order), and a single-C6-field render off a live enum value.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at REGISTRY_SPECS —
 * an owner ruling, not a projection), every span GUARD named above, the
 * `ORDER_SUBJECT_BASE_KEYS` voicing/display-id set (`classify-only-reads.ts`, which lists
 * `payment_status` beside `order_fulfillment_stage` — a property of which BASE KEYS carry a
 * numeric `displayId`, not a per-type facet), the claims-labels enum register
 * (`claims-labels.ts` `PAYMENT_STATUS.status` → the 12-member CUSTOMER register, a DISPLAY
 * map keyed by `${claimType}.${field}` that this source's C6 field and render slot must keep
 * agreeing with), classify-only eligibility (`classify-only-reads.ts`), the read binding
 * (`turn-reads.ts` — the owner-scoped `getById` memo SHARED with ORDER_FULFILLMENT_STAGE,
 * which is what closed the payment IDOR, plus the two falsifier reads), the owner-scope
 * prefix list (`ibatexas-claims-kernel-deps.ts`), the P2 pair table and the planner
 * personas.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { lit, prop } from "@adjudicate/core";
import { definePerResourceClaim } from "./per-resource-claim.js";

// PAYMENT_STATUS — a customer-scoped, live, FIRST-PARTY money read (ownership required via
// OrderProjection-join, `must_read_this_turn`, `first_party_verified`, `first_party_only` —
// SDD §E's worked type, §N P0). Subjected by the ORDER id: the investigator records
// `payment_status:{orderId}` and the owner-scope wiring lists `payment_status:` in
// OWNER_SCOPED_KEY_PREFIXES (ibatexas-claims-kernel-deps.ts). Its owner-scoped read shares
// the IDENTICAL `getById(orderId, { customerId })` memo with ORDER_FULFILLMENT_STAGE
// (turn-reads.ts), which is the mechanism that closed the payment IDOR: a cross-owner read
// is a fail-closed error, never a value. A guest owns no order → the read is skipped → the
// claim resolves ABSENT → honest UNKNOWN. The rendered value is a CLOSED 12-MEMBER ENUM
// localized by the claims-labels CUSTOMER register, never model-authored.
export const PAYMENT_STATUS_SOURCE = definePerResourceClaim({
  type: "PAYMENT_STATUS",
  version: 1,
  kind: "read_claim",
  // An owner-scoped live read: INV-4 REQUIRES it to appear in some REQUIRED_CLAIM_CLOSURE
  // row, which the `decomposition` block below supplies (the PAYMENT_STATUS_Q row). UNLIKE
  // its order sibling, this type is required by NO other span — PICKUP_Q pairs the store
  // hours with the ORDER stage, never with money — so for THIS type INV-4's forward
  // direction is a live de-sync detector exactly as it is for every R2-S1..R2-S5 type.
  // Declared HERE rather than inferred from `TRIAD_SCOPED_TYPES` membership, so boot no
  // longer depends on two sources agreeing.
  triadScoped: true,
  customerScoped: true,
  // C2 — the MONEY floor. `first_party_verified` sits at the TOP of the integrity order
  // (tied with `structured`), so a `human_report` or `free_text` payment fact can never
  // validate this claim. See the header for why this is NOT interchangeable with the
  // provenance policy below.
  minSourceIntegrity: "first_party_verified",

  // The repo-local widening (R2-S2). The keys below stay BARE BASES — the runtime suffixes
  // them. STEP 3 key-alignment: the investigator records `payment_status:{orderId}`, so the
  // subject is the ORDER id and the turn-seam proof discriminates by two owned ORDERS of one
  // customer.
  perResourceKey: true,

  requiredEvidence: [
    {
      key: "payment_status",
      // Ownership required via OrderProjection-join; first-party only money read.
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "first_party_verified",
      provenancePolicy: "first_party_only",
    },
  ],

  // W6 — a `paid` payment status is falsified by a present refund OR chargeback
  // (opposite money direction). BOTH are enumerated (honest completeness) — and unlike every
  // predecessor's single deliberately-unread falsifier, BOTH of these are genuinely READ by
  // the investigator off INDEPENDENT owner-scoped queries (turn-reads.ts: `refunded` iff any
  // refund on the order's payments; the chargeback/dispute read likewise). So this is the
  // first adopted type whose W6 arm can actually FIRE, which is why the two-row set is a
  // registry first that had to be proven expressible rather than merely permitted.
  falsifierComplete: true,
  falsifiers: [
    {
      key: "payment_refund",
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "first_party_verified",
      provenancePolicy: "first_party_only",
    },
    {
      key: "payment_chargeback",
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "first_party_verified",
      provenancePolicy: "first_party_only",
    },
  ],

  // C6 — bind the rendered status to the read's `status` field (ledger-sourced). INV-7 is a
  // COMPILE error here: the key is typed as the literal union of this def's own
  // requiredEvidence keys, and it is suffixed `:{subject}` in LOCKSTEP with its
  // requiredEvidence member, so it stays a member of that set and the kernel's C6 structural
  // guard never throws. Note the FALSIFIER keys are deliberately NOT in that union — a
  // falsifier is by design a DIFFERENT (cross-) key, and the runtime cross-key arm is what
  // gates them.
  valueBinding: { key: "payment_status", path: ["status"] },

  // The payment-status validated template. ONE proposition slot bound 1:1 to the C6
  // valueBinding FIELD. The rendered scalar is an ENUM MEMBER, so `claims-labels.ts`
  // localizes it to pt-BR off the key `PAYMENT_STATUS.status` — a DISPLAY map keyed by
  // `${claimType}.${field}`, EXHAUSTIVE over the 12 `PaymentStatus` members. That key is
  // assembled from this type name and THIS slot's field, so renaming either half here would
  // silently drop the localization and ship a raw English money status to a customer (Hard
  // Rule 4). NOT multi-field: a second proposition slot reading a sibling field of the read
  // would ALWAYS be UNFILLABLE post-mint under the frozen single-scalar kernel, aborting the
  // whole template to UNKNOWN (Inv 6 is all-or-nothing per template).
  render: {
    validated: [lit("O status do seu pagamento é: "), prop("status"), lit(".")],
  },

  // The §O#15 decomposition contribution — the SELF-ONLY row this type OWNS.
  //
  // `PAYMENT_STATUS_Q` ("meu pagamento foi aprovado?") requires ONLY the payment claim. Like
  // RESERVATION_STATUS_Q — and UNLIKE its order sibling — no unrelated span force-requires
  // PAYMENT_STATUS, so this row is the type's sole reachability witness. It is also what
  // auto-enrols PAYMENT_STATUS into the claim-planner's RELEVANCE_GOVERNED_TYPES
  // (ibatexas-claim-planner.ts BKL-110) via the closure-value union — an over-proposed money
  // claim is DEMOTED on a turn whose payment span did not fire, yet KEPT when it did.
  //
  // THE MARKERS — 5 arms, the STRONG-token literal split at its top-level alternation and
  // pinned byte-for-byte by `__SPAN_NET_SOURCES_FOR_TEST.paymentStatusStrong`. The two
  // DUAL-USE tokens (`pagamento`, `pix`) are GUARD-CONJOINED and stay at the classifier; see
  // the header for the full decomposition and the BKL-204/BKL-238 evidence behind each.
  //
  // F2 — this span exists because the polysemous bare word "status" used to map
  // UNCONDITIONALLY to ORDER_STATUS_Q, so "qual o status do meu pagamento?" MISROUTED to
  // ORDER (the order companion would resolve from the WRONG resource, or drop the payment
  // companion). The discriminator is what routes it: payment phrasing → here; order/delivery
  // phrasing → the order span; a BARE "status" with NEITHER → over-include BOTH companions
  // (conservative-over-decomposing — the decomposer is a TCB member, so over-include is safe
  // and under-include is not). That fallback is a classifier SEQUENCING fact, not a marker.
  decomposition: {
    spanClass: "PAYMENT_STATUS_Q",
    markers: [/pago/, /cobran[çc]a/, /pagar/, /paguei/, /aprovad/],
    requires: ["PAYMENT_STATUS"],
  },
});
