/**
 * ORDER_FULFILLMENT_STAGE — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S7).
 *
 * THIS is the single editable artifact for the ORDER_FULFILLMENT_STAGE claim type. It
 * UNIONS what was previously scattered across four files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[ORDER_FULFILLMENT_STAGE]      (~56 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[ORDER_FULFILLMENT_STAGE] (~16 lines)
 *   - `claim-definition-registry.ts` TRIAD_SCOPED_TYPES membership
 *   - `required-claim-decomposer.ts` the ORDER_STATUS_Q closure row + its pt-BR marker net
 *     (the flat strong-token literal, the BKL-221 arrival pair, and the composed ETA net)
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./order-fulfillment-stage.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by
 * the `./__tests__/generated-drift.test.ts` drift guard.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 *  THE SHARED-ROW RULE, APPLIED TO A SPAN THIS TYPE DOES *NOT* OWN
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * R2-S6 settled where a shared closure row lives, and stated the rule the status siblings
 * inherit:
 *
 *   > A source declares a closure row iff it OWNS THE SPAN. Rows for spans NO type owns
 *   > stay HAND-WRITTEN.
 *
 * This type is the first to exercise BOTH halves of that rule at once, which is why it is
 * worth writing down rather than inferring:
 *
 *   - `ORDER_STATUS_Q` → `["ORDER_FULFILLMENT_STAGE"]` is OWNED by this type (the span is
 *     named after it, and the span's marker net is the net that gates THIS type's read), so
 *     the `decomposition` block below declares it — self-only, exactly like
 *     RESERVATION_STATUS's row (R2-S4) and the two histories' rows (R2-S5).
 *   - `PICKUP_Q` → `["STORE_OPEN_NOW", "ORDER_FULFILLMENT_STAGE"]` ALSO requires this type,
 *     and it stays HAND-WRITTEN beside the table. PICKUP_Q is the §O#15 worked example: its
 *     marker net (`/retir|buscar|pegar/`) is its OWN, it is named after no type, and it
 *     requires TWO types neither of which is "the pickup type". No source owns it, so no
 *     source may declare it — a `decomposition` block asserting `spanClass: "PICKUP_Q"` on
 *     this source would publish a claim that a pickup question is an order-stage question,
 *     which is exactly the false-artifact decay inv.18 v2 exists to prevent.
 *
 * ── INV-4 WITH TWO ROWS NAMING ONE TYPE: GREEN, BUT *MASKED* IN ONE DIRECTION ────
 *
 * MEASURED against the real validator (`@adjudicate/core` `validateClaimDefinitions`), not
 * inferred, because the answer is NOT the same as R2-S6's:
 *
 *   - INV-4 stays GREEN. The forward direction quantifies over the UNION of every closure
 *     VALUE (`closureTypes` accumulates across all rows before the per-def check), so a
 *     Triad-scoped type named by TWO rows is reachable, and nothing about the generated row
 *     sitting beside a hand-written one is treated specially. The reverse direction is
 *     satisfied because this type has a registered ClaimDefinition.
 *   - BUT the forward direction is NOT a de-sync detector FOR THIS TYPE. For R2-S6's
 *     CART_EMPTY the shared row was the ONLY row naming it, so a `requires` that stopped
 *     naming it fell straight into `DECOMPOSITION_UNREACHABLE`. Here, PICKUP_Q names
 *     ORDER_FULFILLMENT_STAGE independently — so if the generated ORDER_STATUS_Q row ever
 *     stopped naming this type, INV-4 would stay GREEN on the REAL registry. (It cannot
 *     stop naming it by deletion: `requires` is `NonEmpty<string>` and this row's only
 *     member is self, so an empty row is a TYPE error. The reachable de-sync is the row
 *     naming a DIFFERENT type, which the drift harness's cluster derivation catches instead
 *     — the cluster dissolves and the round-trip fails the reverse direction.)
 *
 * That asymmetry is a FINDING, not a defect introduced here: it is a pre-existing property
 * of a type required by two spans, and it is why R2-S4 excluded this very type from being
 * the first owner-scoped adoption ("a self-only closure row that NO OTHER SPAN references"
 * was its selection criterion, and this type failed it). It is pinned by test in both
 * directions — green-with-one-row-de-synced and red-with-both — so the masking is a
 * recorded measurement rather than an assumption a future reader has to re-derive.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 *  THE MARKER / GUARD DECOMPOSITION (the load-bearing decision of this slice)
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * The ORDER_STATUS_Q predicate in `classifyRequestSpans` is COMPOSED from five parts. Only
 * the ones that are MARKERS — patterns whose match, on its own, classifies a request INTO
 * the span — can be compiled. The rest are GUARDS (suppression contexts) and SEQUENCING
 * facts, and they stay hand-written, exactly as every span guard has since R2-S1.
 *
 *   COMPILED (the 8 `markers` arms below) — `markers.some((m) => m.test(t))` is
 *   character-for-character the old `orderStatusStrong`:
 *     (1-5) the flat strong-token literal `/pedido|preparo|sa[ií]u|chegou|cad[êe]/`, SPLIT at
 *           its top-level alternation into five arms. `A|B|C|D|E` under `.test` is true iff
 *           some alternative matches, which is what `.some` spells out — behaviour-preserving
 *           by construction, and the five arms REJOIN to the literal byte-for-byte.
 *     (6-7) the BKL-221 arrival pair (`a caminho` / the `entregue` question frame). These
 *           were ALREADY separate regex literals `||`-ed at the use site (the Sonar S5843
 *           split), so this is the R2-S4 relocation-with-no-splitting case: each arm is
 *           pinned INDIVIDUALLY, and the two rejoin to the pre-migration `orderArrival` pin.
 *     (8)   the composed arrival-ETA net. Still composed HERE from its four named parts
 *           (below) rather than spelled as one literal — same reason it was composed at the
 *           decomposer: the sequence has no top-level split point, and distributing the head
 *           over the tail would copy the destination lookahead three times, which is the
 *           "second, drifting regex" this codebase refuses everywhere. Its `.source` is
 *           pinned against the pre-migration `orderEta` value.
 *
 *   NOT COMPILED, and why each is a GUARD rather than a marker:
 *     · the DUAL-USE `entrega` branch — `/entrega/.test(t) && !capabilityQuestion`. The
 *       token alone does NOT classify: BKL-204 established that "vocês entregam no CEP X?"
 *       / "qual a taxa de entrega?" carry it while being questions about what the STORE
 *       offers, not about the customer's own order. What classifies is the token CONJOINED
 *       with the absence of the capability shape, and a `markers` arm cannot express an
 *       absence. Folding `entrega` in as a bare arm would fire the owner-scoped ORDER read
 *       on every coverage/fee question and dead-end a ≥2-order customer in the candidates
 *       CLARIFY — the exact defect BKL-204 closed.
 *     · `!mutationImperative` — the BKL-206 read-vs-mutation split, shared by every
 *       classify-only-eligible read span. A suppression context, never a marker.
 *     · the BARE-"status" fallback — a DISJUNCTION over the ABSENCE of both discriminators
 *       (`/status/ && !paymentPhrasing && !orderPhrasing && !reservationRef`), which pushes
 *       this span class from OUTSIDE this type's own net. It reads three other spans'
 *       predicates, so it is a sequencing fact about the classifier, not a per-type facet.
 *     · the FE-D03 history SUPPRESSION — `ORDER_HISTORY_Q` firing SPLICES this span class
 *       out of the accumulated array. R2-S5 already ruled that splice hand-written (a
 *       source contributes its own span, never which classes another span must REMOVE); the
 *       only change here is that the class key it names is now this source's generated
 *       `spanClass` rather than a hand-written table key.
 *
 * ── WHAT MADE THE STATUS SIBLINGS NEXT ──────────────────────────────────────────
 *
 * On every facet the compiler models this type is the RESERVATION_STATUS row R2-S4 proved:
 * ONE `must_read_this_turn` required-evidence row at floor `structured`, provenance
 * `preserve`, `ownershipPolicy: "required"`; ONE declared-but-deliberately-unread W6
 * falsifier; `perResourceKey` subjected by the ORDER id; and a single-C6-field render off a
 * live enum value. What is new is the two-row closure situation above, the marker
 * decomposition above, and — on the sibling — the registry firsts (`first_party_verified`
 * floor, `first_party_only` provenance, TWO falsifiers): see `./payment-status.claim.ts`.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at REGISTRY_SPECS —
 * an owner ruling, not a projection), every span GUARD named above, the PICKUP_Q closure
 * row, the `ORDER_SUBJECT_BASE_KEYS` voicing/display-id set (`classify-only-reads.ts` — a
 * property of which BASE KEYS carry a numeric `displayId`, not a per-type facet), the
 * claims-labels enum register (`claims-labels.ts` `ORDER_FULFILLMENT_STAGE.fulfillmentStatus`
 * → the 7-member CUSTOMER register — a DISPLAY map keyed by `${claimType}.${field}`, which
 * this source's C6 field and render slot must keep agreeing with), classify-only eligibility
 * (`classify-only-reads.ts`), the read binding (`turn-reads.ts` + the investigator's
 * owner-scoped `getById` memo shared with PAYMENT_STATUS), the owner-scope prefix list
 * (`ibatexas-claims-kernel-deps.ts`), the P2 pair table and the planner personas.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { lit, prop } from "@adjudicate/core";
import { definePerResourceClaim } from "./per-resource-claim.js";

/**
 * BKL-221 — the arrival-ETA net, COMPOSED from named parts rather than written as one
 * literal. Moved VERBATIM from `required-claim-decomposer.ts`, parts and rationale
 * together, because the composition is the part of this net a reviewer must be able to see:
 * the pattern is a SEQUENCE and not an alternation, so there is no top-level split point to
 * cut at, and the alternative — distributing the head over the tail as three literals —
 * would copy the destination lookahead three times, so a future edit to the travel-sense
 * exclusion could silently be applied to one copy and not the others (the BKL-184 / LE2-002
 * one-net idiom). Naming the four parts costs nothing and says what each one is for.
 *
 * The composed `.source` is asserted BYTE-IDENTICAL to the pre-migration literal in
 * `required-claim-decomposer.test.ts` (`__SPAN_NET_SOURCES_FOR_TEST.orderEta`), so neither
 * the original restructure nor this relocation can have changed the pattern.
 */
/** A time-pressure head: "quanto TEMPO", "FALTA muito", "DEMORA". */
const ETA_HEAD = "(?:falta|demora|tempo)";
/** …within a short window, clause-bounded so it cannot reach across sentences. */
const ETA_WINDOW = "[^.!?]{0,20}";
/** …of the arrival phrase itself. */
const ETA_ARRIVAL_PHRASE = "(?:para|pra)\\s+chegar";
/**
 * …NOT followed by a second-person destination. "chegar aí" / "chegar até vocês" / "chegar
 * no restaurante" is the CUSTOMER travelling; bare "chegar" is the food arriving. Measured:
 * without this the net fires on "quanto tempo para chegar aí de carro?".
 */
const ETA_NOT_TRAVEL = "(?!\\s+(?:a[íi]|at[ée]|no\\s+restaurante|na\\s+loja))";

// ORDER_FULFILLMENT_STAGE — a customer-scoped, live STATUS read (owner-scoped
// `must_read_this_turn` — SDD §E / §N P1). The RESERVATION_STATUS idiom (owner-scoped,
// per-resource, falsifier-complete), subjected by the ORDER id: the investigator records
// `order_fulfillment_stage:{orderId}` and the owner-scope wiring lists
// `order_fulfillment_stage:` in OWNER_SCOPED_KEY_PREFIXES
// (ibatexas-claims-kernel-deps.ts). A guest owns no order → the read is skipped → the claim
// resolves ABSENT → honest UNKNOWN (the fail-closed ownership ruling). The rendered value is
// a CLOSED 7-MEMBER ENUM localized by the claims-labels CUSTOMER register, never
// model-authored.
export const ORDER_FULFILLMENT_STAGE_SOURCE = definePerResourceClaim({
  type: "ORDER_FULFILLMENT_STAGE",
  version: 1,
  kind: "read_claim",
  // An owner-scoped live read: INV-4 REQUIRES it to appear in some REQUIRED_CLAIM_CLOSURE
  // row, which the `decomposition` block below supplies (the ORDER_STATUS_Q row) — and
  // which the hand-written PICKUP_Q row ALSO supplies, so see the header for why the
  // forward direction is green here but MASKED as a de-sync detector. Declared HERE rather
  // than inferred from `TRIAD_SCOPED_TYPES` membership, so boot no longer depends on two
  // sources agreeing.
  triadScoped: true,
  customerScoped: true,
  minSourceIntegrity: "structured",

  // The repo-local widening (R2-S2). The keys below stay BARE BASES — the runtime suffixes
  // them. The subject is the ORDER id (the RESERVATION_STATUS shape, not the histories'
  // customerId), which is why the turn-seam proof discriminates by two owned ORDERS of ONE
  // customer rather than by two customers.
  perResourceKey: true,

  requiredEvidence: [
    {
      // STEP 3 key-alignment: the BASE name matches the investigator's
      // `ORDER_FULFILLMENT_KEY` base (`order_fulfillment_stage`);
      // `selectCandidateClaim` appends `:{subject}` (perResourceKey) so the kernel
      // resolves the actual per-order entry.
      key: "order_fulfillment_stage",
      // Customer-scoped — owner-scoped `getById` (SDD §E / §N P1).
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // W6 — a present order CANCELLATION falsifies any in-progress fulfillment stage.
  // DELIBERATELY UNREAD (review ruling 2026-07-17, post-#277): no investigator
  // read populates `order_cancelled` — the only available read derives from the
  // SAME per-turn order row as the base ORDER_FULFILLMENT_STAGE read, so firing
  // it is a tautology that demotes every TRUTHFUL "cancelado" render to UNKNOWN
  // while catching zero staleness the base misses. The declaration stays for a
  // future INDEPENDENT cancellation signal (e.g. the order-events stream);
  // rendering cancellation as a first-class claim is tracked as BKL-160.
  // Declaring-without-reading is sound: the runtime arm resolves an always-absent key ⇒
  // never fires ⇒ demote-only safety is preserved, and the declaration is what lets this
  // type escape the W6 UNKNOWN-only cap and VALIDATE at all.
  falsifierComplete: true,
  falsifiers: [
    {
      key: "order_cancelled",
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered stage to the read's ACTUAL field (ledger-sourced).
  // Wall-2 reconcile (fix 4a): the OrderFulfillmentRead shape field is
  // `fulfillmentStatus` (turn-reads.ts), NOT `stage` — the old `["stage"]` path
  // projected `undefined` on both sides → C6 ABSTAIN → the claim demoted UNKNOWN
  // even for the legit owner. The path matches the read field so C6 compares
  // a real scalar (the claim-planner adapter, `ibatexas-claim-planner.ts`, binds
  // the owner-scoped candidate value to the SAME present ledger entry →
  // claimSide === evidenceSide → C6 PASSes by construction, without skipping any
  // conjunct: ownership/freshness/falsifiers all still run). INV-7 is a COMPILE error
  // here: the key is typed as the literal union of this def's own requiredEvidence keys,
  // and it is suffixed `:{subject}` in LOCKSTEP with its requiredEvidence member, so it
  // stays a member of that set and the kernel's C6 structural guard never throws.
  valueBinding: { key: "order_fulfillment_stage", path: ["fulfillmentStatus"] },

  // F1 — the order-stage validated template. ONE proposition slot binding 1:1 to the C6
  // valueBinding FIELD. The kernel validates this claim's value at
  // `valueBinding.path = ["fulfillmentStatus"]` against the ledger; the OrderFulfillmentRead
  // shape's field is `fulfillmentStatus`, NOT `stage`. The old `stage` slot read a field the
  // validated value never carries → the proposition was UNFILLABLE and a
  // legitimately-VALIDATED ORDER claim abstained to UNKNOWN. Reading the ACTUAL value field
  // makes a VALIDATED ORDER claim render.
  //
  // The rendered scalar is an ENUM MEMBER, so `claims-labels.ts` localizes it to pt-BR off
  // the key `ORDER_FULFILLMENT_STAGE.fulfillmentStatus` — a DISPLAY map keyed by
  // `${claimType}.${field}`. That key is assembled from this type name and THIS slot's
  // field, so renaming either half here would silently drop the localization and ship a raw
  // English enum member to a customer (Hard Rule 4). The map stays hand-written at its own
  // site; what this source owes it is the field name, unchanged.
  render: {
    validated: [lit("Seu pedido está na etapa: "), prop("fulfillmentStatus"), lit(".")],
  },

  // The §O#15 decomposition contribution — the SELF-ONLY row this type OWNS.
  //
  // `ORDER_STATUS_Q` ("cadê meu pedido?") requires ONLY the order-stage claim. This row is
  // also what auto-enrols ORDER_FULFILLMENT_STAGE into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES (ibatexas-claim-planner.ts BKL-110) via the closure-value
  // union — an over-proposed order claim is DEMOTED on a turn whose order span did not
  // fire, yet KEPT when it did.
  //
  // UNLIKE every predecessor's row, this type is ALSO required by a span it does not own
  // (PICKUP_Q — the §O#15 worked example: a pickup question needs BOTH an open store and a
  // ready order). That row stays HAND-WRITTEN beside the closure table. See the header for
  // the rule and for what it costs INV-4's forward direction here.
  //
  // THE MARKERS — 8 arms, three provenances, all byte-pinned. See the header for the full
  // marker/guard decomposition and for why `entrega`, `!mutationImperative`, the
  // bare-"status" fallback and the history splice are all NOT here.
  //
  //   arms 1-5  the flat strong-token literal, SPLIT at its top-level alternation. These are
  //             the tokens that are unambiguously about an EXISTING order, so they fire
  //             regardless of the BKL-204 capability shape.
  //   arms 6-7  BKL-221 — DELIVERY-PROGRESS phrasing: the way a customer asks where their
  //             order has got to WITHOUT naming it. The existing strong tokens all require
  //             an order NOUN or a verb in the preterite, so a BARE progress question
  //             matched nothing, `classifyOnlyRequiredTypes` declined, the turn fell to the
  //             model, and the extraction leg REFUSED with `system.extraction_failure` — an
  //             ugly degrade in place of the ≥2-owned candidates CLARIFY that BKL-203/204
  //             built for exactly this customer. STRONG tokens (they fire regardless of the
  //             capability shape) because none of them is capability vocabulary: a question
  //             about what the STORE does is phrased "vocês entregam …" / "fazem entrega",
  //             never "está a caminho?". Verified in BOTH directions by the must-fire /
  //             must-not-fire lists in required-claim-decomposer.test.ts.
  //             Over-firing is bounded, not merely "fail-safe": the #8 ownership gate DROPS
  //             the ORDER_FULFILLMENT_STAGE companion for a customer who provably owns no
  //             order, so a stray match on a guest cannot degrade an otherwise-answerable
  //             turn.
  //     · `a caminho` (arm 6) — "meu lanche está a caminho?", "já está a caminho?". Anchored
  //       on BOTH sides so it is the standalone preposition+noun, never a substring. Swept:
  //       ZERO occurrences in the 201-row live catalog vocabulary and ZERO in the 1039-row
  //       in-repo utterance corpus.
  //     · `(?:foi|est[áa]|j[áa])\s+entregue` (arm 7) — the STATUS PARTICIPLE IN ITS QUESTION
  //       FRAME ("já foi entregue?"). The frame is load-bearing and measured: a bare
  //       `entregue` fires on "quero uma picanha ENTREGUE agora", which is a customer
  //       PLACING an order (and `quero` is deliberately not a mutation root, so nothing
  //       upstream suppresses it), and on the ops-plane status VALUE "já entregou, marca
  //       como ENTREGUE" — the dominant sense of this word in this repo is the fulfillment
  //       enum, not a customer question. Requiring foi/está/já immediately before it keeps
  //       the question and drops both. Note `entregue` does NOT contain the substring
  //       `entrega`, so it is invisible to `notOrderScoped` / `notResourceScoped` and to the
  //       dual-use `entrega` GUARD branch: a genuinely new token, not a widening of an
  //       existing one.
  //   arm 8     `(?:falta|demora|tempo)…(?:para|pra)\s+chegar`, MINUS a second-person
  //             destination — the arrival frame, composed from the four named parts above.
  //             BOTH halves of that shape are measured, not guessed, and this is the
  //             BKL-271 embedded-match lesson arriving twice:
  //     – A BARE `cheg` stem was tried FIRST and is WRONG: `como chegar` is the STORE_INFO_Q
  //       directions vocabulary (`/como (chego|chegar)/`). In-repo the DIRECTIONS frame
  //       outnumbers the arrival frame 4:2, so a bare stem would have fired an owner-scoped
  //       ORDER read on a customer asking for the ADDRESS — a wrong-FAMILY answer, which is
  //       NOT demote-only.
  //     – The head anchor alone still leaked, and the sweep caught it: "quanto tempo para
  //       chegar AÍ de carro?" satisfies `tempo … para chegar` while asking how long the
  //       CUSTOMER takes to travel. The destination is what separates the two senses —
  //       "chegar aí"/"chegar até vocês" is the customer moving, bare "chegar" is the food
  //       arriving — so the trailing lookahead drops exactly that. Both directions are
  //       pinned by test.
  //
  // REJECTED ARMS, with the measured reason, so nobody re-proposes them:
  //   · a bare `cheg` stem — see above; collides with the STORE_INFO directions net.
  //   · a bare `entregue` — see above; fires on an order-PLACING utterance.
  //   · `pronto` ("já está pronto?") — the adjective is not order-specific: a RESERVATION
  //     ("minha mesa já está pronta?") and a generic readiness ask carry it too, so it would
  //     force an ORDER companion onto a reservation turn.
  //   · `demorar` alone ("vai demorar muito?") — genuinely subject-free. It is also the
  //     exact wording of the delivery-ETA CAPABILITY ask the BKL-204 boundary keeps OUT of
  //     the owner-scoped read ("quanto tempo demora a entrega?"), so a bare stem would fire
  //     the customer's own order read on a store-policy question. Left to the model path,
  //     which is the fail-SAFE direction.
  decomposition: {
    spanClass: "ORDER_STATUS_Q",
    markers: [
      /pedido/,
      /preparo/,
      /sa[ií]u/,
      /chegou/,
      /cad[êe]/,
      /(?<![a-z])a\s+caminho(?![a-z])/,
      /(?<![a-z])(?:foi|est[áa]|j[áa])\s+entregue(?![a-z])/,
      new RegExp(ETA_HEAD + ETA_WINDOW + ETA_ARRIVAL_PHRASE + ETA_NOT_TRAVEL),
    ],
    requires: ["ORDER_FULFILLMENT_STAGE"],
  },
});
