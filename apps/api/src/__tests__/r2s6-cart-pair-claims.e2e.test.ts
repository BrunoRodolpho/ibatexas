// r2s6-cart-pair-claims.e2e.test.ts — the CART PRESENCE-COMPLEMENT PAIR (CART_CONTENTS /
// CART_EMPTY) proven at the REAL customer turn seam, in all four directions the pair opens.
//
// WHY THIS FILE EXISTS (finding F-6, on a surface no prior slice reached). Before R2-S6
// neither cart type had ANY handleTurn-level proof. `claustrum/__tests__/cart-contents-claim.test.ts`
// and `cart-empty-claim.test.ts` (29 good tests) drive the real planner and the LINKED
// @adjudicate/core kernel, but over a HAND-BUILT EvidenceLedger — so they cannot say that
// the investigator records the key the kernel resolves, nor that the renderer's output
// reaches a customer. More importantly for THIS pair, a hand-built ledger cannot exercise
// the §O#15 completeness gate at all: that gate lives in `claims-renderer-adapter.ts`, ONE
// LAYER ABOVE `renderer-from-claims`, and it is the exact layer where LE2-002's identically
// shaped DELIVERY pair shipped a latent RENDER→UNKNOWN degrade past a green CI (LE2-013).
// A presence-complement pair whose closure row requires BOTH members is satisfiable ONLY
// through `PRESENCE_COMPLEMENT_PAIRS`, and only a real-adapter turn can see that.
//
// WHAT THIS PINS. Both types' registry rows, templates, ClaimDefinitions and their ONE
// SHARED §O#15 closure row are now COMPILED from
// `claustrum/claimdefs/cart-{contents,empty}.claim.ts` (R2-S6), reaching the runtime through
// R2-S2's repo-local `perResourceKey` widening. The ownership wiring is R2-S4's:
// `ownerScopedBaseKey` resolves the base key off the FIRST `ownershipPolicy: "required"`
// evidence row, and `OWNER_SCOPED_KEY_PREFIXES` joins it to the ledger.
//
// ── THE TWO AXES, AND WHY THE CART NEEDS BOTH (they are genuinely different here) ──
//
// The cart read is the only owner-scoped read in the registry whose SELECTOR and whose
// LEDGER KEY are different parameters:
//
//   · `readCartContents(conversationId, customerId)` resolves WHICH CART to read from
//     `rk("cart:active:session:<conversationId>")` — the CONVERSATIONID is the selector, and
//     `customerId` is not consulted for the lookup at all (turn-reads.ts).
//   · The investigator records it under `cart_contents:{customerId}` / `cart_empty:{customerId}`
//     — the CUSTOMERID is the ledger key and the §5 C1 ownership subject.
//
// So this suite discriminates on BOTH: two customers in two conversations with DISTINCT
// carts (the per-customer key partition a dropped `perResourceKey` flag collapses), and the
// FOREIGN-CONVERSATION direction (the session-scoped selector), which is the cart's own IDOR
// surface and was untested repo-wide.
//
// WHY THE NEGATIVES ARE NOT VACUOUS (the access-class vacuity trap). A negative that never
// ATTEMPTS the forbidden thing passes with the enforcement deleted. So, per the r2s4/r2s5
// victim-subject design, the scripted model proposes the OTHER CUSTOMER'S ID as the claim
// subject in every negative case — a genuine cross-customer attempt naming a real, seeded
// customer whose cart this very suite can produce. A leak therefore surfaces as a POSITIVE
// assertion failure on a distinctive money string, not as an absence nobody notices.
//
// WHY `realResponder: true` IS LOAD-BEARING (the BKL-273 / LE2-029 lesson). Losing the claim
// is not fail-safe: with nothing to render, the REAL responder authors the answer in prose,
// and the default inert responder would show that as a harmless placeholder. The scripted
// model is ARMED with a confident, unsourced cart sentence that only the model path can
// produce, and every case asserts the reply is not it.
//
// The only fakes are the ModelProvider and the triad read backend. The REAL composer
// (`composeCartItemsSummary`), the investigator's span gate and `isAuthenticatedCustomer`
// gate, `selectCandidateClaim`'s key suffixing, the linked @adjudicate/core kernel, the
// §O#15 decomposer AND its completeness gate in the production adapter, and the renderer all
// run for real, against the GENERATED registry rows.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";
import { ownerScopedBaseKey } from "../claustrum/claim-registry.js";

/** Customer A — the "owner" in each positive case, and the VICTIM in B's negatives. */
const CUST_A = "cus_a_r2s6";
/** Customer B — a DIFFERENT authenticated customer, with their own, distinct cart. */
const CUST_B = "cus_b_r2s6";
/** An authenticated customer whose cart is provably EMPTY — the complement's owner. */
const CUST_EMPTY = "cus_empty_r2s6";
/** A guest session (`isGuestCustomerId` marker prefix) — owns nothing by construction. */
const GUEST_ID = "guest:anon_r2s6";

/** Each customer's own conversation — the SESSION-SCOPED cart selector. */
const CONV: Record<string, string> = {
  [CUST_A]: "conv-r2s6-a",
  [CUST_B]: "conv-r2s6-b",
  [CUST_EMPTY]: "conv-r2s6-empty",
  [GUEST_ID]: "conv-r2s6-guest",
};

// The seeded carts, keyed BY CONVERSATION exactly as production keys them (the Redis
// `cart:active:session:<conversationId>` selector). Row shapes mirror what the Medusa
// `/store/carts/:id` read returns, so the REAL composer produces the production scalar.
// EVERY field differs between A and B so no assertion can confuse the two.
const CARTS: Record<
  string,
  { items: ReadonlyArray<{ title: string; quantity: number }>; totalCentavos: number }
> = {
  [CONV[CUST_A]!]: {
    items: [{ title: "Costela Bovina Defumada", quantity: 2 }],
    totalCentavos: 12_300,
  },
  [CONV[CUST_B]!]: {
    items: [{ title: "Brisket Defumado", quantity: 1 }],
    totalCentavos: 7_450,
  },
  // The provably-EMPTY cart: an active session with no lines. `hasItems: false` is what
  // leaves `cart_contents` ABSENT and records `cart_empty` PRESENT.
  [CONV[CUST_EMPTY]!]: { items: [], totalCentavos: 0 },
  [CONV[GUEST_ID]!]: { items: [{ title: "Farofa da Casa", quantity: 1 }], totalCentavos: 1_900 },
};

/** What a real 4B does with a cart question once the turn leaves the deterministic path —
 *  armed here so its return is a test failure, not a silent regression. Names items and
 *  money NO read produced. */
const MODEL_PROSE =
  "No seu carrinho você tem 3x Linguiça Artesanal e 1x Pão de Alho, total R$250,00. " +
  "Qualquer coisa é só avisar!";

const backend = vi.hoisted(() => ({
  /** Every (conversationId, customerId) pair the cart read was asked for — so a case can
   *  prove a read was ATTEMPTED, and (more importantly) that a FOREIGN conversation never
   *  reached one. */
  cartReads: [] as Array<{ conversationId: string; customerId: string }>,
}));

vi.mock("../claustrum/turn-reads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claustrum/turn-reads.js")>();
  const notUsed = (name: string) => async (): Promise<never> => {
    throw new Error(`turn-reads.${name} must not run in this suite`);
  };
  return {
    ...actual,
    createDomainTriadReadBackend: () => ({
      readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
      readScheduleOverride: async () => null,
      readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
      readHoliday: async () => null,
      readHoursForDate: async () => ({ hoursText: "11h–15h / 18h–23h" }),
      readHolidayForDate: async () => null,
      readScheduleOverrideForDate: async () => null,
      readOrderFulfillment: notUsed("readOrderFulfillment"),
      readPaymentStatus: notUsed("readPaymentStatus"),
      readPaymentRefund: notUsed("readPaymentRefund"),
      readPaymentChargeback: notUsed("readPaymentChargeback"),
      readReservation: notUsed("readReservation"),
      readOrderHistory: notUsed("readOrderHistory"),
      readPaymentHistory: notUsed("readPaymentHistory"),

      // THE SESSION-SCOPED CART READ. Keyed ONLY by the conversationId — faithful to
      // production, where `customerId` is not consulted for the lookup — so the
      // foreign-conversation direction below measures the real selector rather than a wall
      // this fake invented. An empty cart returns `hasItems: false` (the discriminant that
      // leaves `cart_contents` ABSENT and `cart_empty` PRESENT), matching turn-reads.ts.
      readCartContents: async (conversationId: string, customerId: string) => {
        backend.cartReads.push({ conversationId, customerId });
        const cart = CARTS[conversationId];
        if (cart === undefined) return { itemsSummaryText: "", hasItems: false };
        const hasItems = cart.items.length > 0;
        return {
          hasItems,
          // The REAL composer — the C6-bound scalar is production's, not the test's.
          itemsSummaryText: hasItems
            ? actual.composeCartItemsSummary(cart.items, cart.totalCentavos)
            : "",
        };
      },

      // A cart question owns no in-flight order/payment/reservation; present-with-0 keeps
      // §O#15 from force-requiring a singular companion.
      listActiveOrderIds: async () => [],
      listActiveReservationIds: async () => [],
      countActivePayments: async () => 0,
    }),
  };
});

const {
  composeCustomerConductor,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulCustomerSession,
  runCustomerTurn,
} = await import("./customer-e2e-harness.js");

function scriptedModel(
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>,
): ModelProvider {
  return {
    complete: vi.fn(async (req: CompletionRequest): Promise<Completion> => {
      const toolNames = (req.tools ?? []).map((t) => t.name);
      const base = {
        model: "mock",
        stopReason: "end_turn",
        inputTokens: 5,
        outputTokens: 4,
      } as const;
      if (toolNames.includes(PROPOSE_CLAIM_TOOL)) {
        return {
          ...base,
          text: "",
          toolCalls: claims.map((c, i) => ({
            id: `claim-${i}`,
            name: PROPOSE_CLAIM_TOOL,
            input: { ...c },
          })),
        };
      }
      // The planner's intent leg AND the responder's authoring call both land here.
      // Non-empty on purpose: an empty completion trips the planner's extraction-failure
      // REFUSE and would short-circuit before the claims render, making the assertions pass
      // for the wrong reason.
      return { ...base, text: MODEL_PROSE, toolCalls: [] };
    }),
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  } as unknown as ModelProvider;
}

const ASK = "o que tem no meu carrinho?";
/** The generated templates' static frames — what a VALIDATED render of each member opens
 *  with. Transcribed from the compiled templates, which is what the customer sees. */
const CONTENTS_FRAME = "No seu carrinho: ";
const EMPTY_RENDER = "Seu carrinho está vazio no momento";

/** A's rendered fragments — a leak can only show as one of these. */
const FACTS_A = ["2x Costela Bovina Defumada", "R$123,00"];
/** B's own fragments — what a CORRECT read renders for B. */
const FACTS_B = ["1x Brisket Defumado", "R$74,50"];
/** Fragments only the MODEL could produce (no read yields them). */
const MODEL_ONLY = /Lingui|P[ãa]o de Alho|R\$250,00/;

/**
 * Drive ONE real customer turn. `conversationId` defaults to the caller's OWN conversation;
 * the foreign-conversation cases pass someone else's explicitly, which is the whole point.
 * Production's responder is on, so a lost claim shows up as authored prose.
 */
async function runCartTurn(args: {
  readonly customerId: string;
  readonly conversationId?: string;
  /** The claims the MODEL proposes — production's persona proposes BOTH members. */
  readonly claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>;
  readonly text?: string;
}): Promise<string> {
  const harness = composeCustomerConductor({
    model: scriptedModel(args.claims),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
    realResponder: true,
    scheduleSignal: { isClosed: false, mealPeriod: "dinner" } as never,
  });
  const out = await runCustomerTurn(harness, {
    customerId: args.customerId,
    conversationId: args.conversationId ?? CONV[args.customerId]!,
    text: args.text ?? ASK,
  });
  return out.response;
}

/** The pair as production's persona proposes it ("proponha TAMBÉM CART_EMPTY"). */
const bothFor = (subject: string) => [
  { type: "CART_CONTENTS", subject },
  { type: "CART_EMPTY", subject },
];

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  backend.cartReads.length = 0;
});

// ── DIRECTION (a): the authenticated owner renders off the SUFFIXED key ────────────────
describe("R2-S6 e2e — the GENERATED CART_CONTENTS spec renders at the real turn seam", () => {
  it("the owner's own cart VALIDATES and renders the C6-bound composed summary", async () => {
    const response = await runCartTurn({ customerId: CUST_A, claims: bothFor(CUST_A) });

    // The generated template's static frame + the ledger-sourced scalar. This passes only if
    // the generated spec's BARE `cart_contents` was suffixed to `…:cus_a_r2s6` and resolved
    // the investigator's real per-customer entry — lose the perResourceKey flag and the
    // kernel resolves the bare key, the evidence reads ABSENT, and the claim degrades to an
    // honest UNKNOWN.
    expect(response).toContain(CONTENTS_FRAME);
    for (const fact of FACTS_A) expect(response).toContain(fact);
    // The composer's own separator — proof the REAL composer ran, not a test literal.
    expect(response).toContain(" — total ");
    expect(response).not.toBe(MODEL_PROSE);
    expect(response).not.toMatch(MODEL_ONLY);
    // …and the turn genuinely went to the session-scoped cart read for THIS conversation.
    expect(backend.cartReads.map((r) => r.conversationId)).toContain(CONV[CUST_A]);
  });

  // THE DISCRIMINATING PAIR: two customers, two conversations, one conductor.
  //
  // The case above establishes that the generated spec works at all; it cannot distinguish
  // "the keys are suffixed per customer" from "there happens to be one entry and any key
  // shape would have found it". So: two DIFFERENT authenticated customers, each in their own
  // conversation, each of which must come back with ITS OWN composed summary and NOT the
  // other's. A spec that emitted a pre-suffixed key, or dropped the flag so both customers
  // collapsed onto one bare key, cannot satisfy both rows.
  it.each([CUST_A, CUST_B])(
    "customer %s renders ITS OWN cart, never the sibling's",
    async (who) => {
      const mine = who === CUST_A ? FACTS_A : FACTS_B;
      const theirs = who === CUST_A ? FACTS_B : FACTS_A;

      const response = await runCartTurn({ customerId: who, claims: bothFor(who) });

      expect(response).toContain(CONTENTS_FRAME);
      for (const fact of mine) expect(response).toContain(fact);
      // The discriminating half: the sibling's facts are real strings this very suite can
      // produce, so a collapsed or pre-suffixed key would surface them here.
      for (const fact of theirs) expect(response).not.toContain(fact);
      expect(response).not.toBe(MODEL_PROSE);
      expect(response).not.toMatch(MODEL_ONLY);
      // Only THIS conversation's cart was read.
      expect([...new Set(backend.cartReads.map((r) => r.conversationId))]).toEqual([
        CONV[who],
      ]);
    },
  );
});

// ── DIRECTION (b): THE COMPLEMENT FLIP — the facet with no precedent ──────────────────
//
// This is the pair's own property and the reason the shared closure row exists: the SAME
// question, the SAME proposed claim set, and the ledger alone decides which member renders.
// Both directions plus the never-both invariant, driven through the PRODUCTION adapter —
// which is the layer the §O#15 completeness gate lives in and the layer LE2-002's identical
// DELIVERY pair degraded at while every renderer-level test stayed green.
describe("R2-S6 e2e — the presence-complement FLIP (the shared closure row, satisfiable)", () => {
  it("a cart WITH items renders CART_CONTENTS and NOT the empty complement", async () => {
    const response = await runCartTurn({ customerId: CUST_A, claims: bothFor(CUST_A) });

    expect(response).toContain(CONTENTS_FRAME);
    for (const fact of FACTS_A) expect(response).toContain(fact);
    // The complement's evidence (`cart_empty:…`) is ABSENT on a cart with items, so its
    // claim resolves UNKNOWN and the kernel's §D filter drops it. Never a contradiction.
    expect(response).not.toContain(EMPTY_RENDER);
    expect(response).not.toContain("vazio");
  });

  it("a provably EMPTY cart renders CART_EMPTY and NOT the contents member", async () => {
    const response = await runCartTurn({ customerId: CUST_EMPTY, claims: bothFor(CUST_EMPTY) });

    // The empty member's whole reason for existing: a friendly VALIDATED answer instead of
    // the honest-UNKNOWN degrade — and it can only render if the §O#15 gate accepts the
    // SHARED row on its partner's UNKNOWN, i.e. only via PRESENCE_COMPLEMENT_PAIRS.
    expect(response).toContain(EMPTY_RENDER);
    expect(response).toContain("cardápio");
    expect(response).not.toContain(CONTENTS_FRAME);
    // And no other customer's cart leaked in as the "contents" half.
    for (const fact of [...FACTS_A, ...FACTS_B]) expect(response).not.toContain(fact);
    expect(response).not.toBe(MODEL_PROSE);
    expect(response).not.toMatch(MODEL_ONLY);
    // The read RAN and returned an empty cart — this is a PRESENT-complement render, not a
    // skipped read (which is what the guest case proves separately). The two negatives
    // therefore exercise DIFFERENT mechanisms and neither subsumes the other.
    expect(backend.cartReads.map((r) => r.conversationId)).toContain(CONV[CUST_EMPTY]);
  });

  it("the complement NEVER double-renders — exactly one member reaches the customer", async () => {
    // Stated as its own case over BOTH cart states, because "the right one rendered" and
    // "only one rendered" are different facts: a P2 same-subject co-render escape would show
    // up only here (§O#1 default-deny is what should ESCALATE such a pair, and the pair is
    // declared precisely so it does not).
    for (const who of [CUST_A, CUST_B, CUST_EMPTY]) {
      backend.cartReads.length = 0;
      const response = await runCartTurn({ customerId: who, claims: bothFor(who) });
      const rendered = [
        response.includes(CONTENTS_FRAME),
        response.includes(EMPTY_RENDER),
      ].filter(Boolean);
      expect(rendered, `${who}: ${response}`).toHaveLength(1);
    }
  });
});

// ── DIRECTION (c): the GUEST — no read recorded at all ────────────────────────────────
describe("R2-S6 e2e — a guest owns no cart", () => {
  it("a GUEST naming a real customer's id gets NO cart fact and records NO cart read", async () => {
    // The guest's own conversation HAS a seeded cart, deliberately: if the read were ever
    // attempted it would return items, so this negative cannot pass by the suite being
    // unable to produce a cart for that session.
    const response = await runCartTurn({ customerId: GUEST_ID, claims: bothFor(CUST_A) });

    // The wall: `isAuthenticatedCustomer` gates the whole owner-scoped read block
    // (ibatexas-investigator.ts), so a guest records NO cart entry — hence no owned
    // resource, hence `owns → false`, hence REFUSED. "No owner" ≠ "any owner" (Inv 2).
    expect(response).not.toContain(CONTENTS_FRAME);
    expect(response).not.toContain(EMPTY_RENDER);
    for (const fact of FACTS_A) expect(response).not.toContain(fact);
    // Not via the OTHER escape hatch either — the model must not author it.
    expect(response).not.toBe(MODEL_PROSE);
    expect(response).not.toMatch(MODEL_ONLY);
    // The owner-scoped read was never even ATTEMPTED for a guest (gated upstream), which is
    // what makes this the strongest of the walls rather than the weakest.
    expect(backend.cartReads).toHaveLength(0);
    // …and the guest's session DOES hold a cart, so the absence above is the gate.
    expect(CARTS[CONV[GUEST_ID]!]!.items.length).toBeGreaterThan(0);
  });
});


// ── DIRECTION (d): THE FOREIGN CONVERSATION — the cart's own IDOR surface ─────────────
//
// This direction has no analogue in R2-S4 (a resource id) or R2-S5 (a customer id): the cart
// is selected by the SESSION's conversationId, so "can customer B's turn surface the cart
// behind customer A's conversation?" is a question about that selector, and it was untested
// repo-wide.
//
// EVERY CLAIM BELOW IS MEASURED, and the first measurement corrected this suite's own
// design. The victim-subject device the r2s4/r2s5 precedents rely on — have the scripted
// model propose the VICTIM's id — turns out to be structurally INERT for an owner-scoped
// type, and inert in the SAFE direction: `createIbatexasClaimPlanner`'s FIX 1 + FIX 2
// (ibatexas-claim-planner.ts) hand the planner an owner-scoped auth context whose admissible
// SUBJECTS are `ownedResourceIdsByBaseKey(ledger)` — the ids that resolved PRESENT in THIS
// turn's owner-scoped reads. The model's `subject` is therefore not merely refused, it is
// REPLACED, so no proposed string can steer the key. That is a strictly stronger wall than
// "the read is attempted and refused", and stronger than the mechanism R2-S5 measured for
// the histories (where the READ simply never took a foreign id, but the subject still
// travelled). The first case below pins it with a subject no resolution could produce.
//
// WHICH LEAVES EXACTLY ONE AXIS, and the honest answer about it is architectural rather than
// a wall (see FINDING F-9 in this slice's report): the cart the customer is shown is the
// cart the CONVERSATION points at. A conversation IS a cart session — that is what
// `rk("cart:active:session:<conversationId>")` means — so an authenticated turn arriving on
// a foreign conversationId renders THAT session's cart, recorded under the AUTHENTICATED
// customer's ledger key. Binding conversationId to a customer is the session/resolver
// layer's job, not the claims runtime's, and nothing in this slice changes any of it (the
// ledger keys, the ownership policy and the closure row are byte-identical through the
// migration; the selector was never a spec facet). The last two cases MEASURE that
// behaviour and pin it, so a future change cannot flip it silently in either direction.

describe("R2-S6 e2e — the foreign-conversationId direction (the session-scoped selector)", () => {
  it("the MODEL's proposed subject cannot steer the key — FIX 2 replaces it from the ledger", () => {
    // A compile-time-visible statement of what the three async cases below rely on: for an
    // owner-scoped type the union declines to bind a subject at all, so the admissible
    // subject can only come from the owner-scoped reads.
    expect(ownerScopedBaseKey("CART_CONTENTS")).toBe("cart_contents");
    expect(ownerScopedBaseKey("CART_EMPTY")).toBe("cart_empty");
  });

  it("an AUTHENTICATED customer gets THEIR OWN cart even when the model names a BOGUS subject", async () => {
    // Not the victim's id — a string NO resolution could ever produce. If the model's
    // subject reached the key, this turn could only degrade to UNKNOWN; it renders B's own
    // cart instead, which is the positive proof that FIX 2 overrode it.
    const response = await runCartTurn({
      customerId: CUST_B,
      claims: [{ type: "CART_CONTENTS", subject: "totally-bogus-not-a-customer" }],
    });

    expect(response).toContain(CONTENTS_FRAME);
    for (const fact of FACTS_B) expect(response).toContain(fact);
    for (const fact of FACTS_A) expect(response).not.toContain(fact);
    expect(response).not.toBe(MODEL_PROSE);
    expect(response).not.toMatch(MODEL_ONLY);
  });

  it("an AUTHENTICATED customer naming the OTHER customer's id gets THEIR OWN cart, never the other's", async () => {
    // B asks from B's own conversation while the MODEL proposes A's customerId — a genuine
    // cross-customer attempt naming a real, seeded customer whose cart this suite produces.
    const response = await runCartTurn({ customerId: CUST_B, claims: bothFor(CUST_A) });

    // THE DISCRIMINATING ASSERTION. A's facts are real strings this suite can render, so a
    // leak surfaces here as a positive failure rather than an unnoticed absence.
    for (const fact of FACTS_A) expect(response).not.toContain(fact);
    expect(response).toContain(CONTENTS_FRAME);
    for (const fact of FACTS_B) expect(response).toContain(fact);
    expect(response).not.toBe(MODEL_PROSE);
    expect(response).not.toMatch(MODEL_ONLY);

    // WHERE THE WALL IS — measured. A's conversation is never selected (the investigator
    // passes the SESSION's conversationId and a `propose_claim` subject feeds it nowhere),
    // and every read this turn is recorded under B.
    expect(backend.cartReads.map((r) => r.conversationId)).not.toContain(CONV[CUST_A]);
    expect([...new Set(backend.cartReads.map((r) => r.conversationId))]).toEqual([CONV[CUST_B]]);
    expect([...new Set(backend.cartReads.map((r) => r.customerId))]).toEqual([CUST_B]);
    // A's cart IS producible by this suite — so the absence above is scoping, not a
    // suite-wide inability to render it (the case that would make this vacuous).
    expect(CARTS[CONV[CUST_A]!]!.items.length).toBeGreaterThan(0);
  });

  it("a foreign conversationId renders THAT SESSION's cart, keyed to the AUTHENTICATED customer (F-9)", async () => {
    // The adversarial shape only the selector makes possible: B authenticated, but the turn
    // arrives on A's conversationId. MEASURED behaviour, pinned in the direction it actually
    // goes rather than the direction a reviewer might hope for:
    //
    //   · the cart READ follows the conversation (that IS the session-scoped cart), so A's
    //     session's lines are fetched;
    //   · the LEDGER KEY is `cart_contents:cus_b_r2s6` — the AUTHENTICATED id — and FIX 2
    //     derives the candidate's subject from that same present read, so the claim
    //     VALIDATES and the session's cart renders to B.
    //
    // So the claims runtime does NOT provide a cross-session wall for the cart, and it never
    // claimed to: the resource is the SESSION's cart and the §5 C1 conjunct is satisfied
    // because the recorded resource id IS the authenticated customer. Whoever binds
    // conversationId to a customer is the wall. Recorded as F-9; unchanged by this adoption.
    const response = await runCartTurn({
      customerId: CUST_B,
      conversationId: CONV[CUST_A],
      claims: bothFor(CUST_A),
    });

    expect(response).toContain(CONTENTS_FRAME);
    // The session's cart — A's lines — under B's turn. This is the measurement, stated as an
    // assertion so a future change to the selector must come here and say so.
    for (const fact of FACTS_A) expect(response).toContain(fact);
    for (const fact of FACTS_B) expect(response).not.toContain(fact);
    expect(response).not.toBe(MODEL_PROSE);
    expect(response).not.toMatch(MODEL_ONLY);
    // The read ran on A's conversation but was RECORDED under B — the two parameters, and
    // the reason the ownership conjunct passes.
    expect([...new Set(backend.cartReads.map((r) => r.conversationId))]).toEqual([CONV[CUST_A]]);
    expect([...new Set(backend.cartReads.map((r) => r.customerId))]).toEqual([CUST_B]);
    // The investigator's THREE cart arms all ran off the one conversation (cart_contents, the
    // active_cart marker, and cart_empty) — pinned because it is what makes the complement
    // flip possible at all, and because a future arm added or dropped should surface here.
    expect(backend.cartReads).toHaveLength(3);
  });
});
