/**
 * CART_EMPTY — the ClaimDefinition SOURCE (inv.18 v2 adoption batch R2-S6).
 *
 * THIS is the single editable artifact for the CART_EMPTY claim type. It UNIONS what was
 * previously scattered across three files:
 *
 *   - `claim-registry.ts`            REGISTRY_SPECS[CART_EMPTY]      (~44 lines)
 *   - `slot-grammar.ts`              VALIDATED_TEMPLATES[CART_EMPTY] (~9 lines)
 *   - `claim-definition-registry.ts` TRIAD_SCOPED_TYPES membership
 *
 * — THREE, not four: this type contributes NO closure row. See below.
 *
 * The generated image is `./cart-empty.generated.ts` (`@generated` — DO NOT EDIT), kept in
 * sync by the `./__tests__/generated-drift.test.ts` drift guard.
 *
 * ── WHY THIS SOURCE DECLARES NO `decomposition` ─────────────────────────────────
 *
 * CART_EMPTY is the PRESENCE-COMPLEMENT twin of CART_CONTENTS, and the two SHARE ONE
 * closure row. That row — `CART_CONTENTS_Q` → `["CART_CONTENTS", "CART_EMPTY"]` — is
 * declared by the SPAN-OWNING source, `./cart-contents.claim.ts`, whose header carries the
 * full design decision, the shapes that were rejected, and the measurements behind them.
 * Read that header before editing either file.
 *
 * The short form of why the ownership falls that way: a `decomposition` block is
 * `spanClass` + `markers` + `requires`, and CART_EMPTY has no span and no marker net. There
 * is exactly ONE cart-word net in `classifyRequestSpans` (the pre-migration `cartRef`
 * const), it is CART_CONTENTS_Q's, and it gates CART_CONTENTS's read. Declaring a
 * `decomposition` here would mean either a second copy of that net (a drift surface the
 * five prior slices existed to remove) or a `requires: ["CART_EMPTY"]` row that no runtime
 * table contains. Either way the generated file would assert a span this type does not own.
 *
 * WHAT KEEPS THE TWO HALVES IN AGREEMENT — the EXISTING generic INV-4, fail-closed, no new
 * facility (both directions MEASURED against the real validator and proven by
 * revert-to-red):
 *
 *   - `triadScoped: true` is DECLARED below, so if CART_CONTENTS's `requires` ever loses
 *     `"CART_EMPTY"`, THIS type appears in no `REQUIRED_CLAIM_CLOSURE` value and INV-4's
 *     FORWARD direction fails `DECOMPOSITION_UNREACHABLE` —
 *     `assertClaimDefinitionRegistryValid` REFUSES TO BOOT the claims pipeline. The flag is
 *     therefore not documentation: it is the half of the pair agreement that lives here.
 *   - Conversely, removing this type from the registry while the owner's row still names it
 *     fails INV-4's REVERSE direction with the same code.
 *
 * ── WHAT THE COMPILER DOES MODEL FOR THIS TYPE ──────────────────────────────────
 *
 * Everything else: it is the RESERVATION_STATUS / ORDER_HISTORY row on every modelled facet
 * (ONE `must_read_this_turn` owner-scoped evidence row at floor `structured`, provenance
 * `preserve`; ONE declared-but-deliberately-unread W6 falsifier; `perResourceKey` subjected
 * by the AUTHENTICATED customerId; a single-C6-field render off a code-composed scalar).
 *
 * NOT COVERED BY THE COMPILER, and therefore still hand-written at their own sites
 * (unchanged by this migration): the BKL-270 `dietaryPosture` (spliced at REGISTRY_SPECS —
 * `answer-anyway` here, DIFFERENT from its twin's `answer-with-abstention`, which is exactly
 * why the posture is an owner ruling and not a projection of the pair), the
 * PRESENCE_COMPLEMENT_PAIRS registration (a SET-level relation, and the reason the shared
 * row is satisfiable at all), classify-only eligibility (`classify-only-reads.ts`, where
 * CART_EMPTY joins in LOCKSTEP with its twin), the read binding (the investigator's
 * `cart_empty:{customerId}` arm off the shared per-turn cart memo), the owner-scope prefix
 * list (`ibatexas-claims-kernel-deps.ts`), the P2 pair table and the planner personas.
 *
 * pt-BR literals live HERE as DATA, never in the interpreter as code.
 */

import { lit, prop } from "@adjudicate/core";
import { definePerResourceClaim } from "./per-resource-claim.js";

// BKL-163 — CART_EMPTY: the provably-empty cart twin of CART_CONTENTS. The SAME
// owner-scoped, must_read_this_turn, perResourceKey shape (subject = the authenticated
// customerId), but its evidence key `cart_empty:{customerId}` is recorded PRESENT by the
// investigator ONLY when the cart read resolved `hasItems: false` — presence IS the
// provable-empty proposition, so the pair is complementary by construction (a cart with
// items leaves `cart_empty` ABSENT ⇒ this claim resolves UNKNOWN ⇒ dropped when
// CART_CONTENTS validates; an empty cart leaves `cart_contents` ABSENT ⇒ CART_CONTENTS
// drops and THIS renders). The C6 proposition is a DETERMINISTIC code-composed scalar
// (`emptinessText`, the literal "vazio") — never model-authored.
export const CART_EMPTY_SOURCE = definePerResourceClaim({
  type: "CART_EMPTY",
  version: 1,
  kind: "read_claim",
  // An owner-scoped live read: INV-4 REQUIRES it to appear in some REQUIRED_CLAIM_CLOSURE
  // row. This source declares NO row of its own — the obligation is discharged by the
  // SHARED `CART_CONTENTS_Q` row declared in `./cart-contents.claim.ts`, and this flag is
  // what makes a de-synced pair a BOOT REFUSAL rather than a silent un-enrolment (see the
  // header). Declared HERE rather than inferred from `TRIAD_SCOPED_TYPES` membership, so
  // boot no longer depends on two sources agreeing.
  triadScoped: true,
  customerScoped: true,
  minSourceIntegrity: "structured",

  // The repo-local widening (R2-S2). The keys below stay BARE BASES — the runtime suffixes
  // them by `:{subject}`, matching the investigator's `cart_empty:{customerId}`.
  perResourceKey: true,

  requiredEvidence: [
    {
      key: "cart_empty",
      // Ownership required — the (empty) cart is the authenticated customer's own
      // (session-resolved, never a model id); the owner-scope wiring gates it.
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // W6 — `cart_item_added` is DECLARED (so CART_EMPTY escapes the W6 UNKNOWN-only cap and
  // can VALIDATE) but DELIBERATELY UNREAD — the exact CART_CONTENTS `cart_cleared`
  // disposition: a same-cart-row "item added" signal is tautological AND inert (a cart that
  // gained an item already reads `hasItems: true` ⇒ `cart_empty` ABSENT ⇒ no present base
  // to demote). Declaring-without-reading is sound: the runtime arm resolves an
  // always-absent key ⇒ never fires ⇒ demote-only safety preserved.
  falsifierComplete: true,
  falsifiers: [
    {
      key: "cart_item_added",
      ownershipPolicy: "required",
      freshnessPolicy: "must_read_this_turn",
      sourceIntegrity: "structured",
      provenancePolicy: "preserve",
    },
  ],

  // C6 — bind the rendered scalar to the read's code-composed `emptinessText` field
  // (ledger-sourced, deterministic; never model-authored). INV-7 is a COMPILE error here:
  // the key is typed as the literal union of this def's own requiredEvidence keys.
  valueBinding: { key: "cart_empty", path: ["emptinessText"] },

  // BKL-163 — the provably-empty cart template. ONE proposition slot bound 1:1 to the C6
  // valueBinding FIELD — the code-composed literal "vazio" the investigator records ONLY
  // when the owner-scoped cart read proved `hasItems: false`. Friendly VALIDATED answer for
  // the empty cart (replacing the honest-UNKNOWN degrade of PR #291 deviation (a)); the
  // menu pointer is STATIC literal text (an OFFER, not a proposition — Inv 6 permits
  // offers/requests, and the em-dash clause asserts nothing about the world).
  render: {
    validated: [
      lit("Seu carrinho está "),
      prop("emptinessText"),
      lit(" no momento — quer dar uma olhada no cardápio?"),
    ],
  },

  // NO `decomposition` — see the header. The shared CART_CONTENTS_Q row is declared by
  // `./cart-contents.claim.ts`; `triadScoped: true` above is what makes INV-4 refuse boot
  // if that row ever stops naming this type.
});
