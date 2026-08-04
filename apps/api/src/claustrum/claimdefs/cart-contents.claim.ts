/**
 * CART_CONTENTS — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S6).
 *
 * THIS is the single editable artifact for the CART_CONTENTS claim type. It UNIONS what
 * was previously scattered across four files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[CART_CONTENTS]      (~48 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[CART_CONTENTS] (~9 lines)
 *   - `claim-definition-registry.ts` TRIAD_SCOPED_TYPES membership
 *   - `required-claim-decomposer.ts` the CART_CONTENTS_Q closure row + its pt-BR marker
 *
 * See `./store-open-now.claim.ts` for the full compile contract; the generated image is
 * `./cart-contents.generated.ts` (`@generated` — DO NOT EDIT), kept in sync by the
 * `./__tests__/generated-drift.test.ts` drift guard.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 *  THE SHARED CLOSURE ROW — where a PRESENCE-COMPLEMENT PAIR's one row lives
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Every prior slice (R2-S1..R2-S5) picked types whose closure contribution was SELF-ONLY,
 * and each of their headers named THIS shape as the one they were excluding: CART_CONTENTS
 * and CART_EMPTY share ONE closure row. `CART_CONTENTS_Q` requires BOTH — they read
 * COMPLEMENTARY keys (`cart_contents:` vs `cart_empty:`) off the SAME owner-scoped cart
 * read, so exactly one can ever be PRESENT — which means the invariant those five slices
 * relied on ("a compiled source contributes exactly one closure row, and that row's
 * required set is the source's own type") cannot hold for both sources naively.
 *
 * THE RULE THIS SLICE ADOPTS, and the one the status siblings inherit:
 *
 *   > A closure row is declared by the source that OWNS THE SPAN. A type that owns no
 *   > span of its own declares NO `decomposition` and is reached through its owner's row.
 *   > The agreement between the two halves is enforced by the EXISTING generic INV-4,
 *   > fail-closed, in BOTH directions.
 *
 * WHY CART_CONTENTS IS THE SPAN OWNER — measured, not preferred. `CART_CONTENTS_Q` is
 * named after this type, and the span's marker net is THE cart-word net that gates THIS
 * type's read (`ibatexas-investigator.ts` gates `cart_contents:{customerId}` on a
 * `CART_CONTENTS_Q` span). CART_EMPTY has NO marker net anywhere in the repo — grep the
 * pre-migration `classifyRequestSpans` and there is exactly ONE cart net, the `cartRef`
 * const, and it is this one. So "who owns the span" is a fact about the code, not a
 * casting call.
 *
 * WHY `requires: ["CART_CONTENTS", "CART_EMPTY"]` NEEDED NO WIDENING — measured. The
 * published `DecompositionSource.requires` is `NonEmpty<string>`, NOT a self-reference,
 * and `toRegistrySpec`'s sibling `toClosure` passes the array through BY REFERENCE
 * (`compiled.closure.requires === source.decomposition.requires` — asserted in
 * `./__tests__/per-resource-claim.test.ts`). So the two-type row is expressible in the
 * PUBLISHED schema exactly as the hand-written row spelled it, and
 * `per-resource-claim.ts` is UNCHANGED by this slice: the only facet the published
 * compiler cannot express remains R2-S2's `perResourceKey`.
 *
 * WHY THE AGREEMENT CHECK IS ALREADY THERE, in both directions (both MEASURED against the
 * real validator, and both proven by revert-to-red):
 *
 *   - Drop `"CART_EMPTY"` from the `requires` below and CART_EMPTY — whose
 *     `triadScoped: true` is DECLARED in its own source — appears in no closure value, so
 *     INV-4's FORWARD direction fails `DECOMPOSITION_UNREACHABLE` and
 *     `assertClaimDefinitionRegistryValid` REFUSES TO BOOT the claims pipeline.
 *   - Remove CART_EMPTY from the registry while this row still names it and INV-4's
 *     REVERSE direction fails with the same code ("closure … references type … which has
 *     no registered ClaimDefinition").
 *
 * That is why this slice adds NO new repo-local facility for the pair: a bespoke symmetry
 * check would be a SECOND mechanism enforcing what the generic one already enforces
 * fail-closed, and the failure mode it would guard is unreachable.
 *
 * WHAT WAS REJECTED, and why (each measured, not argued):
 *
 *   - BOTH sources declaring the SAME full row. Duplicates the cart marker net into two
 *     files — a second copy of a regex is precisely what R2-S1..R2-S5 spent five slices
 *     removing — and buys nothing: the per-unit validator round-trip fails for the
 *     symmetric twin too (it names an unregistered partner), so the harness generalization
 *     below is needed either way.
 *   - EACH source declaring `requires: [self]`, with the ROW assembled as the union at the
 *     splice site. It passes the per-unit round-trip unchanged, which is its whole appeal,
 *     and it is the one shape that WEAKENS the guarantee: each generated
 *     `requires: ["CART_CONTENTS"]` would be a published assertion that the
 *     `CART_CONTENTS_Q` span requires only this type, which is FALSE — and the uniform
 *     splice idiom every other row uses (`[X_CLOSURE.spanClass]: X_CLOSURE.requires`)
 *     would then install a row missing CART_EMPTY, silently un-enrolling it from the
 *     classify-only candidate set and from RELEVANCE_GOVERNED_TYPES, with every per-unit
 *     round-trip still green. It also duplicates the marker net.
 *   - The row staying HAND-WRITTEN (the splice precedent). A source that declares
 *     `markers` cannot decline to declare `requires` — the compiler emits the closure as
 *     one block — so this leaves a GENERATED `requires` that nothing consumes and that
 *     contradicts the live row: a dead, false artifact, which is the
 *     sound-by-construction→sound-by-convention decay inv.18 v2 exists to prevent.
 *
 * THE ONE HARNESS CONSEQUENCE, and why it STRENGTHENS rather than relaxes. The drift
 * guard's per-unit validator round-trip validated each unit against a SYNTHETIC
 * single-type universe (`registryEnum: [type]`). For a shared row that universe is
 * ill-formed in both directions (measured: this unit fails the reverse direction, its twin
 * the forward one). The round-trip is therefore quantified over the CLOSURE CLUSTER —
 * DERIVED from the compiled closures, never hand-listed — with `registryEnum` still
 * restricted to the cluster's own types. All nine pre-existing units are singleton
 * clusters, so their assertion is unchanged; and because the clustering is derived, a
 * de-synced `requires` DISSOLVES the cluster and the twin fails as a singleton — which is
 * exactly the revert-to-red this slice proves.
 *
 * ── WHAT MADE THE CART PAIR NEXT ────────────────────────────────────────────────
 *
 * On every facet the compiler models, both types are the RESERVATION_STATUS /
 * ORDER_HISTORY row R2-S4 and R2-S5 already proved: ONE `must_read_this_turn`
 * required-evidence row at floor `structured`, provenance `preserve`,
 * `ownershipPolicy: "required"`; ONE declared-but-deliberately-unread W6 falsifier;
 * `perResourceKey` subjected by the AUTHENTICATED customerId; and a single-C6-field render
 * off a deterministically PRE-COMPOSED scalar (this type ORIGINATED that idiom — BKL-185
 * cites it as the CART_CONTENTS idiom). What is new is the shared row above, and the
 * POSTURE below.
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at REGISTRY_SPECS —
 * an owner ruling, not a projection, and for THIS type the registry's only
 * `answer-with-abstention` value), the span GUARD conjunction (`!mutationImperative`, the
 * BKL-201 read-vs-mutation split — the compiler models which markers classify INTO a span,
 * never which contexts must suppress it), the PRESENCE_COMPLEMENT_PAIRS registration (a
 * SET-level relation between two types, not a per-type facet — and the row's satisfiability
 * depends on it: BKL-163 / LE2-002 / LE2-019 / LE2-029), classify-only eligibility
 * (`classify-only-reads.ts`), the read binding (`turn-reads.ts` `composeCartItemsSummary` +
 * the investigator's session-scoped cart resolution), the owner-scope prefix list
 * (`ibatexas-claims-kernel-deps.ts`), the P2 pair table and the planner personas.
 *
 * pt-BR markers + literals live HERE as DATA, never in the interpreter as code.
 */

import { lit, prop } from "@adjudicate/core";
import { definePerResourceClaim } from "./per-resource-claim.js";

// BKL-139 / FE-D03 — CART_CONTENTS: the authenticated customer's IN-PROGRESS cart. The
// RESERVATION_STATUS idiom (owner-scoped, per-resource, must_read_this_turn,
// falsifier-complete), BUT its C6 value is a DETERMINISTICALLY PRE-COMPOSED summary scalar
// (`itemsSummaryText`), following the STORE_HOURS_FOR_DATE `hoursText` precedent: a
// list-shaped read (N cart lines) rendered as ONE C6-bound string under the frozen
// single-scalar kernel (FE-D09). The subject is the AUTHENTICATED customerId (the cart is
// 1-per-customer, resolved server-side from the session's conversationId — never a
// model-extracted id), so the investigator records `cart_contents:{customerId}` and the
// owner-scope wiring lists `cart_contents:` in OWNER_SCOPED_KEY_PREFIXES
// (ibatexas-claims-kernel-deps.ts). A guest owns no cart → the read is skipped
// (isAuthenticatedCustomer gate) → the claim resolves ABSENT → honest UNKNOWN (the
// fail-closed ownership ruling). The money in `itemsSummaryText` is composed in code from
// integer centavos (Hard Rule 2), NEVER model-authored (FE-D04 / BKL-149).
export const CART_CONTENTS_SOURCE = definePerResourceClaim({
  type: "CART_CONTENTS",
  version: 1,
  kind: "read_claim",
  // An owner-scoped live read: INV-4 REQUIRES it to appear in some REQUIRED_CLAIM_CLOSURE
  // row, which the `decomposition` block below supplies (the CART_CONTENTS_Q row).
  // Declared HERE rather than inferred from `TRIAD_SCOPED_TYPES` membership, so boot no
  // longer depends on two sources agreeing.
  triadScoped: true,
  customerScoped: true,
  minSourceIntegrity: "structured",

  // The repo-local widening (R2-S2). The keys below stay BARE BASES — the runtime suffixes
  // them. The subject is the AUTHENTICATED customerId (one cart per customer), not a
  // resource id, so the ledger key is `cart_contents:{customerId}` — the ORDER_HISTORY
  // shape, and the reason the turn-seam proof discriminates by CUSTOMER.
  perResourceKey: true,

  requiredEvidence: [
    {
      key: "cart_contents",
      // Ownership required — the cart is the authenticated customer's own
      // (session-resolved, never a model id); the owner-scope wiring gates it.
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // W6 — the `cart_cleared` falsifier is DECLARED (so CART_CONTENTS escapes the W6
  // UNKNOWN-only cap and can VALIDATE), but DELIBERATELY UNREAD by the investigator — the
  // SAME disposition as ORDER_FULFILLMENT_STAGE's `order_cancelled` /
  // RESERVATION_STATUS's `reservation_cancelled` after their review-fix: a same-cart-row
  // "cleared" signal is tautological AND inert (a cleared/checked-out cart already reads
  // `hasItems: false` ⇒ `cart_contents` ABSENT ⇒ no present base to demote).
  // Declaring-without-reading is sound: the runtime arm resolves an always-absent key ⇒
  // never fires ⇒ demote-only safety is preserved.
  falsifierComplete: true,
  falsifiers: [
    {
      key: "cart_cleared",
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered summary to the read's PRE-COMPOSED `itemsSummaryText` field
  // (ledger-sourced, deterministic; never model-authored). INV-7 is a COMPILE error here:
  // the key is typed as the literal union of this def's own requiredEvidence keys, and it
  // is suffixed by the SAME `:{subject}` as its requiredEvidence member at select time, so
  // it stays a member of that set and the kernel's C6 structural guard never throws.
  valueBinding: { key: "cart_contents", path: ["itemsSummaryText"] },

  // BKL-139 — the cart-contents validated template. ONE proposition slot binding 1:1 to
  // the C6 valueBinding FIELD. The value is a DETERMINISTICALLY PRE-COMPOSED pt-BR summary
  // ("2x Costela — total R$123,00"), evidence-bound from the owner-scoped cart read
  // (turn-reads.ts `composeCartItemsSummary`) — never an enum (so no claims-labels
  // localization), never model-authored (FE-D04 / BKL-149). NOT multi-field: a second
  // proposition slot reading a sibling field of the read would ALWAYS be UNFILLABLE
  // post-mint under the frozen single-scalar kernel, aborting the whole template to UNKNOWN
  // (Inv 6 is all-or-nothing per template).
  render: {
    validated: [lit("No seu carrinho: "), prop("itemsSummaryText"), lit(".")],
  },

  // The §O#15 decomposition contribution — THE SHARED ROW (see the header).
  //
  // BKL-139 — a cart-contents question requires the cart claim. Like RESERVATION_STATUS_Q,
  // CART_CONTENTS is required ONLY by its own span (no unrelated span force-requires it),
  // so this row also auto-enrols CART_CONTENTS into the claim-planner's
  // RELEVANCE_GOVERNED_TYPES (ibatexas-claim-planner.ts BKL-110) via the closure-value
  // union — an over-proposed cart claim is DEMOTED on a turn whose cart span did not fire,
  // yet KEPT when it did.
  //
  // BKL-163 — the row ALSO requires CART_EMPTY, the provable-empty complement: the two
  // claims read COMPLEMENTARY keys (`cart_contents:` vs `cart_empty:` — exactly one is
  // PRESENT after a successful owner-scoped cart read), so exactly one validates and the
  // other resolves honest UNKNOWN and is dropped by the kernel's §D filter — never a
  // rendered contradiction. Requiring both here is what auto-enrols CART_EMPTY into the
  // classify-only candidate set (an empty-cart question deterministically frames the claim
  // that CAN validate) and into RELEVANCE_GOVERNED_TYPES (an over-proposed CART_EMPTY
  // demotes on a non-cart turn). It is ALSO what makes the row unsatisfiable WITHOUT the
  // PRESENCE_COMPLEMENT_PAIRS registration — that pairing is a set-level relation and
  // stays hand-written beside the completeness check (BKL-163 reopened; LE2-002 shipped
  // the same closure row for DELIVERY without the registration and degraded every
  // coverage turn RENDER→UNKNOWN).
  //
  // THE MARKER. ONE arm — the pre-migration `cartRef` const was a SINGLE regex literal, so
  // `markers.some((m) => m.test(t))` is that same `.test(t)` and the migration is a
  // relocation with no alternation-splitting step (the R2-S4 disposition, with an arm count
  // of one). Pinned byte-for-byte by `__SPAN_NET_SOURCES_FOR_TEST.cartContents`.
  //
  // ANCHORED on the LEFT (`(?<![a-z])`) so a cart word never matches mid-word. THAT is the
  // net's one load-bearing property, and it is proven behaviourally (revert-to-red: drop the
  // lookbehind and both the byte pin AND a must-not-fire case go red).
  //
  // THE PLURAL ALTERNATIVES ARE BYTE-PRESERVED BUT BEHAVIOURALLY REDUNDANT — measured, and
  // recorded here rather than assumed the other way. The net has NO RIGHT anchor, so
  // `carrinho` already matches inside "carrinhos"; deleting `carrinhos`/`cestas`/`sacolas`
  // changes NO row of the 10-utterance corpus in the decomposer tests, and a
  // `(carrinho|cesta|sacola)s?` rewrite is equivalent too. So this is the R2-S5
  // "byte-pin-only arm" shape recurring: the explicit plurals survive by the byte pin alone,
  // and a behavioural test cannot make them load-bearing without also adding a right anchor
  // — which would be a BEHAVIOUR change (it would stop matching "carrinhozinho" and other
  // suffixed forms) and is out of an adoption slice's remit. Kept verbatim because
  // byte-identity is the migration's contract; documented because the alternative was to
  // ship a comment claiming a safety property the measurement denies.
  //
  // The read-vs-mutation exclusion that accompanies this net is a GUARD, not a marker, and
  // stays at the classifier: the compiler models which markers classify INTO a span, never
  // which contexts must suppress it. Without that guard classify-only would skip the model
  // path for a mutation turn ("adicione uma coca ao carrinho", "tira o refrigerante do
  // carrinho" — BKL-201) and mis-frame it as a read.
  decomposition: {
    spanClass: "CART_CONTENTS_Q",
    markers: [/(?<![a-z])(carrinho|carrinhos|cesta|cestas|sacola|sacolas)/],
    requires: ["CART_CONTENTS", "CART_EMPTY"],
  },
});
