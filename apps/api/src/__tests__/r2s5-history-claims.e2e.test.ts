// r2s5-history-claims.e2e.test.ts — the HISTORIES pair (ORDER_HISTORY / PAYMENT_HISTORY)
// proven at the REAL customer turn seam, in BOTH directions, for BOTH types.
//
// WHY THIS FILE EXISTS (finding F-6). Before R2-S5 neither history type had ANY
// handleTurn-level proof. `claustrum/__tests__/history-claims.test.ts` drives the real
// planner and the LINKED @adjudicate/core kernel — 23 good tests — but over a HAND-BUILT
// EvidenceLedger, so it cannot say that the investigator records the key the kernel
// resolves, nor that the renderer's output reaches a customer. The only three
// `apps/api/src/__tests__` hits on these types were: the ADVERTISED READ TOOL name
// `get_payment_history` (tool-roster-integrity, ibatexas-planner) and a pre-baked
// `ORDER_HISTORY` claim VALUE injected into the reorder workflow
// (workflow-runtime.e2e.test.ts) — none of them the read→claim→render chain. So the
// adoption's runtime is exercised end-to-end here for the first time.
//
// WHAT THIS PINS. Both types' registry rows, templates, ClaimDefinitions and §O#15
// closure rows are now COMPILED from `claustrum/claimdefs/{order,payment}-history.claim.ts`
// (R2-S5), reaching the runtime through R2-S2's repo-local `perResourceKey` widening. The
// ownership wiring is R2-S4's: `ownerScopedBaseKey` (claim-registry.ts) resolves the base
// key off the FIRST `ownershipPolicy: "required"` evidence row, and
// `OWNER_SCOPED_KEY_PREFIXES` joins it to the ledger.
//
// THE DISCRIMINATING AXIS IS TWO DISTINCT CUSTOMERS, not two resources. That is the
// structural difference from R2-S4's reservation proof, and it is forced by the type: the
// subject of a history claim is the AUTHENTICATED customerId (one history per customer),
// so `:{subject}` partitions the ledger BY CUSTOMER. A dropped `perResourceKey` flag here
// does not merely fail to find one entry — it collapses EVERY customer's history onto one
// bare `order_history` key, and whichever history was read last answers for everyone. Two
// customers with disjoint, distinctive histories through the SAME conductor is the only
// shape that catches it: each must render ITS OWN summary and never the other's.
//
// WHY THE NEGATIVES ARE NOT VACUOUS (the access-class vacuity trap). A negative that
// never ATTEMPTS the forbidden thing passes with the enforcement deleted. So, per the
// r2s4-owner-scoped-claim.e2e.test.ts victim-subject design, the scripted model proposes
// the OTHER CUSTOMER'S ID as the claim subject in every negative case — a genuine
// cross-customer attempt naming a real, seeded customer whose history this very suite can
// produce. A leak therefore surfaces as a POSITIVE assertion failure on a distinctive
// string, not as an absence nobody notices.
//
// WHY `realResponder: true` IS LOAD-BEARING (the BKL-273 / LE2-029 lesson). Losing the
// claim is not fail-safe: with nothing to render, the REAL responder authors the answer in
// prose, and the default inert responder would show that as a harmless placeholder. The
// scripted model is ARMED with confident, unsourced history sentences that only the model
// path can produce, and every case asserts the reply is not them.
//
// The only fakes are the ModelProvider and the triad read backend. The REAL composers
// (`composeOrderHistorySummary` / `composePaymentHistorySummary`), the investigator's
// span gate and owner-scope gate, `selectCandidateClaim`'s key suffixing, the linked
// @adjudicate/core kernel, the §O#15 decomposer and the renderer all run for real, against
// the GENERATED registry rows.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";

/** Customer A — the "owner" in each positive case, and the VICTIM in B's negatives. */
const CUST_A = "cus_a_r2s5";
/** Customer B — a DIFFERENT authenticated customer. Owns their own, distinct history. */
const CUST_B = "cus_b_r2s5";
/** A guest session (`isGuestCustomerId` marker prefix) — owns nothing by construction. */
const GUEST_ID = "guest:anon_r2s5";
/** An authenticated customer seeded with NO history at all — the honest-abstain control
 *  that separates "the wall held" from "this suite cannot produce a history". */
const CUST_EMPTY = "cus_empty_r2s5";

// The seeded histories. Row shapes mirror what the domain `listByCustomer` returns, so the
// REAL composers produce the production scalar. EVERY field differs between A and B so no
// assertion can confuse the two.
const ORDER_ROWS: Record<
  string,
  ReadonlyArray<{ displayId: number; fulfillmentStatus: string; totalInCentavos: number }>
> = {
  [CUST_A]: [{ displayId: 1042, fulfillmentStatus: "delivered", totalInCentavos: 8900 }],
  [CUST_B]: [{ displayId: 7731, fulfillmentStatus: "preparing", totalInCentavos: 12300 }],
  [CUST_EMPTY]: [],
};
const PAYMENT_ROWS: Record<
  string,
  ReadonlyArray<{ amountInCentavos: number; method: string; status: string }>
> = {
  [CUST_A]: [{ amountInCentavos: 8900, method: "pix", status: "paid" }],
  [CUST_B]: [{ amountInCentavos: 12300, method: "credit_card", status: "refunded" }],
  [CUST_EMPTY]: [],
};

/** What a real 4B does with a history question once the turn leaves the deterministic
 *  path — armed here so its return is a test failure, not a silent regression. Names order
 *  numbers, money and statuses NO read produced. */
const MODEL_ORDER_PROSE =
  "Seus últimos pedidos foram o #9001 (entregue, R$250,00) e o #8997 (entregue, R$310,00). " +
  "Qualquer coisa é só avisar!";
const MODEL_PAYMENT_PROSE =
  "Seus últimos pagamentos foram R$250,00 no cartão (aprovado) e R$310,00 no pix (aprovado). " +
  "Qualquer coisa é só avisar!";

const backend = vi.hoisted(() => ({
  /** Every customerId the owner-scoped history reads were asked for — so a case can prove
   *  a read was ATTEMPTED, and (more importantly) that a FOREIGN id never reached one. */
  orderReads: [] as string[],
  paymentReads: [] as string[],
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
      readCartContents: notUsed("readCartContents"),
      readReservation: notUsed("readReservation"),

      // THE OWNER-SCOPED HISTORY READS. Keyed ONLY by the customerId the investigator
      // passes — which is the authenticated one, never the model's proposed subject. That
      // is the wall these negatives measure. An empty history returns `hasHistory: false`
      // (the key stays ABSENT → honest UNKNOWN), matching turn-reads.ts.
      readOrderHistory: async (customerId: string) => {
        backend.orderReads.push(customerId);
        const rows = ORDER_ROWS[customerId] ?? [];
        return {
          hasHistory: rows.length > 0,
          // The REAL composer — the C6-bound scalar is production's, not the test's.
          historySummaryText:
            rows.length > 0 ? actual.composeOrderHistorySummary(rows) : "",
        };
      },
      readPaymentHistory: async (customerId: string) => {
        backend.paymentReads.push(customerId);
        const rows = PAYMENT_ROWS[customerId] ?? [];
        return {
          hasHistory: rows.length > 0,
          historySummaryText:
            rows.length > 0 ? actual.composePaymentHistorySummary(rows) : "",
        };
      },

      // A history question owns no in-flight order/payment/reservation; present-with-0
      // keeps §O#15 from force-requiring a singular companion.
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
  prose: string,
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
      // REFUSE and would short-circuit before the claims render, making the assertions
      // pass for the wrong reason.
      return { ...base, text: prose, toolCalls: [] };
    }),
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  } as unknown as ModelProvider;
}

let turnSeq = 0;

async function runHistoryTurn(args: {
  readonly customerId: string;
  readonly text: string;
  readonly claimType: string;
  /** The subject the MODEL proposes — the foreign customerId under cross-customer test. */
  readonly proposedSubject: string;
  readonly prose: string;
}): Promise<string> {
  turnSeq += 1;
  const harness = composeCustomerConductor({
    model: scriptedModel(
      [{ type: args.claimType, subject: args.proposedSubject }],
      args.prose,
    ),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
    // Production's responder — without it the prose regression is invisible.
    realResponder: true,
    scheduleSignal: { isClosed: false, mealPeriod: "dinner" } as never,
  });
  const out = await runCustomerTurn(harness, {
    customerId: args.customerId,
    conversationId: `conv-r2s5-${turnSeq}`,
    text: args.text,
  });
  return out.response;
}

/** The per-type fixtures. Written as a table so BOTH types get the identical five-case
 *  treatment and neither can pass on the other's evidence. */
const TYPES = [
  {
    label: "ORDER_HISTORY",
    claimType: "ORDER_HISTORY",
    ask: "qual meu histórico de pedidos?",
    frame: "Seu histórico de pedidos:",
    prose: MODEL_ORDER_PROSE,
    /** The rendered fragments unique to A's history — a leak can only show as one of these.
     *  Labels are CAPITALIZED because that is what the canonical `ORDER_STATUS_LABELS_PT`
     *  map yields; they were transcribed from the composer's MEASURED output, not from
     *  `composeOrderHistorySummary`'s own docstring, which shows them lowercase
     *  ("entregue"/"preparando") and is wrong about its function's live behaviour. */
    factsA: ["Pedido #1042", "Entregue", "R$89,00"],
    /** B's own fragments — what a CORRECT read renders for B. */
    factsB: ["Pedido #7731", "Preparando", "R$123,00"],
    /** Fragments only the MODEL could produce (no read yields them). */
    modelOnly: /#9001|#8997|R\$250,00|R\$310,00/,
    reads: () => backend.orderReads,
  },
  {
    label: "PAYMENT_HISTORY",
    claimType: "PAYMENT_HISTORY",
    ask: "qual meu histórico de pagamentos?",
    frame: "Seu histórico de pagamentos:",
    prose: MODEL_PAYMENT_PROSE,
    factsA: ["Pagamento de R$89,00", "pix", "Pago"],
    factsB: ["Pagamento de R$123,00", "credit_card", "Reembolsado"],
    modelOnly: /R\$250,00|R\$310,00|cartão/,
    reads: () => backend.paymentReads,
  },
] as const;

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  backend.orderReads.length = 0;
  backend.paymentReads.length = 0;
});

describe.each(TYPES)(
  "R2-S5 e2e — the GENERATED $label spec renders at the real turn seam",
  // `label` is consumed by vitest's `$label` title interpolation off the table row, so it
  // is deliberately NOT destructured here.
  ({ claimType, ask, frame, prose, factsA, factsB, modelOnly, reads }) => {
    // ── DIRECTION (a): the authenticated owner ──────────────────────────────────────
    it("the owner's own history VALIDATES and renders the C6-bound composed summary", async () => {
      const response = await runHistoryTurn({
        customerId: CUST_A,
        text: ask,
        claimType,
        proposedSubject: CUST_A,
        prose,
      });

      // The generated template's static frame + the ledger-sourced scalar. This passes
      // only if the generated spec's BARE `order_history`/`payment_history` was suffixed
      // to `…:cus_a_r2s5` and resolved the investigator's real per-customer entry — lose
      // the perResourceKey flag and the kernel resolves the bare key, the evidence reads
      // ABSENT, and the claim degrades to an honest UNKNOWN.
      expect(response).toContain(frame);
      for (const fact of factsA) expect(response).toContain(fact);
      // The composer's own tail — proof the REAL composer ran, not a test literal.
      expect(response).toContain("mostrando o mais recente");
      expect(response).not.toBe(prose);
      expect(response).not.toMatch(modelOnly);
      // …and the turn genuinely went to the owner-scoped read for this customer.
      expect(reads()).toContain(CUST_A);
    });

    // ── THE DISCRIMINATING PAIR: two customers, one conductor ───────────────────────
    //
    // The case above establishes that the generated spec works at all; it cannot
    // distinguish "the keys are suffixed per customer" from "there happens to be one
    // entry and any key shape would have found it". So: two DIFFERENT authenticated
    // customers, each asking the same question, each of which must come back with ITS OWN
    // composed summary and NOT the other's. A spec that emitted a pre-suffixed key, or
    // dropped the flag so both customers collapsed onto one bare key, cannot satisfy both
    // rows.
    it.each([CUST_A, CUST_B])(
      "customer %s renders ITS OWN history, never the sibling's",
      async (who) => {
      const mine = who === CUST_A ? factsA : factsB;
      const theirs = who === CUST_A ? factsB : factsA;

      const response = await runHistoryTurn({
        customerId: who,
        text: ask,
        claimType,
        proposedSubject: who,
        prose,
      });

      expect(response).toContain(frame);
      for (const fact of mine) expect(response).toContain(fact);
      // The discriminating half: the sibling's facts are real strings this very suite can
      // produce, so a collapsed or pre-suffixed key would surface them here.
      for (const fact of theirs) expect(response).not.toContain(fact);
      expect(response).not.toBe(prose);
      expect(response).not.toMatch(modelOnly);
        // Only THIS customer's history was read — the read set is keyed by the
        // authenticated id, so a foreign id appearing here would itself be the defect.
        expect(reads()).toEqual([who]);
      },
    );

    // ── DIRECTION (b): the cross-customer / IDOR direction ──────────────────────────
    it("an AUTHENTICATED customer naming the OTHER customer's id gets THEIR OWN, never the other's", async () => {
      // B asks, but the MODEL proposes A's customerId as the claim subject — a genuine
      // cross-customer attempt naming a real, seeded customer.
      const response = await runHistoryTurn({
        customerId: CUST_B,
        text: ask,
        claimType,
        proposedSubject: CUST_A,
        prose,
      });

      // THE DISCRIMINATING ASSERTION. The model named A's id; B gets a fact about
      // THEMSELVES or nothing.
      for (const fact of factsA) expect(response).not.toContain(fact);
      expect(response).not.toBe(prose);
      expect(response).not.toMatch(modelOnly);
      if (response.includes(frame)) {
        for (const fact of factsB) expect(response).toContain(fact);
      }

      // WHERE THE WALL ACTUALLY IS — measured, not assumed. A's id is NEVER READ AT ALL
      // for this turn: the investigator calls `readOrderHistory(customerId)` /
      // `readPaymentHistory(customerId)` with the AUTHENTICATED customerId only, and a
      // `propose_claim` SUBJECT feeds neither. So the model cannot get a foreign customer's
      // history into the ledger by naming it — a strictly stronger wall than "the read is
      // attempted and refused".
      //
      // WHAT THIS PAIR DOES NOT PROVE, measured rather than assumed. Both revert-to-red
      // probes for this slice (swap the unit to the published compiler so `perResourceKey`
      // is dropped; neuter `ownershipPolicy: "required"` to `"not_applicable"` — each with
      // a REGENERATE before measuring) leave THIS case GREEN. The reason is structural: the
      // investigator calls `readOrderHistory(customerId)` / `readPaymentHistory(customerId)`
      // with the AUTHENTICATED id and nothing else, so which read RUNS does not depend on
      // the spec at all — only which KEY the kernel then resolves does. So the cross-customer
      // wall here is genuinely independent of the ownership facets, and the ownership
      // conjunct (§5 C1) is proven where it actually lives: the kernel-level
      // control/treatment pair in `claustrum/claimdefs/__tests__/per-resource-claim.test.ts`,
      // which BOTH probes move. The two seams are complementary, and saying so precisely is
      // what keeps this case from being read as an ownership proof it is not.
      expect(reads()).not.toContain(CUST_A);
      expect(reads()).toEqual([CUST_B]);
      // A's history IS producible by this suite — so the absence above is scoping, not a
      // suite-wide inability to render it (the case that would make this vacuous).
      expect(ORDER_ROWS[CUST_A]!.length + PAYMENT_ROWS[CUST_A]!.length).toBeGreaterThan(0);
    });

    it("a GUEST naming a real customer's id gets NO history fact and records NO owner-scoped read", async () => {
      const response = await runHistoryTurn({
        customerId: GUEST_ID,
        text: ask,
        claimType,
        proposedSubject: CUST_A,
        prose,
      });

      // The wall: `isAuthenticatedCustomer` gates the whole owner-scoped read block
      // (ibatexas-investigator.ts), so a guest records NO history entry — hence no owned
      // resource, hence `owns → false`, hence REFUSED. "No owner" ≠ "any owner" (Inv 2).
      expect(response).not.toContain(frame);
      for (const fact of factsA) expect(response).not.toContain(fact);
      // And not via the OTHER escape hatch either — the model must not author it.
      expect(response).not.toBe(prose);
      expect(response).not.toMatch(modelOnly);
      // The owner-scoped read was never even ATTEMPTED for a guest (gated upstream),
      // which is what makes this the strongest of the walls rather than the weakest.
      expect(reads()).toHaveLength(0);
    });

    // The honest-abstain control. Without it, every negative above is satisfiable by a
    // system that can never render a history at all — and the positives could in principle
    // be passing on a different mechanism. This case proves the ABSENT-evidence path
    // degrades to a proposition-free UNKNOWN rather than to a fabricated summary, for an
    // authenticated customer whose read genuinely RAN and returned nothing.
    it("an authenticated customer with NO history gets an honest abstain, never a fabricated summary", async () => {
      const response = await runHistoryTurn({
        customerId: CUST_EMPTY,
        text: ask,
        claimType,
        proposedSubject: CUST_EMPTY,
        prose,
      });

      expect(response).not.toContain(frame);
      // No other customer's facts leak into the abstain.
      for (const fact of [...factsA, ...factsB]) expect(response).not.toContain(fact);
      expect(response).not.toBe(prose);
      expect(response).not.toMatch(modelOnly);
      // The read RAN — this is an ABSENT-evidence degrade, not a skipped read (which is
      // what the guest case proves separately). The two negatives therefore exercise
      // DIFFERENT mechanisms and neither subsumes the other.
      expect(reads()).toEqual([CUST_EMPTY]);
    });
  },
);

// ── The SPLICE at the turn seam ────────────────────────────────────────────────────
//
// The singular-sibling splice is the one facet of this adoption that stayed HAND-WRITTEN
// (see either `.claim.ts` header). It is pinned exhaustively at the classifier in
// `claustrum/__tests__/required-claim-decomposer.test.ts`; what CANNOT be seen there is
// its consequence for a real turn, which is the whole reason it exists: the investigator
// gates its reads on the span list, so splicing `ORDER_STATUS_Q` is what stops a history
// turn from ALSO force-requiring a singular-order companion the customer may not have.
describe("R2-S5 e2e — the SPLICE keeps a history turn off the singular read", () => {
  it("a history ask reads ONLY the history, never the singular order/payment read", async () => {
    // `readOrderFulfillment` / `readPaymentStatus` are wired to THROW in this suite's
    // backend, so if the splice stopped working and the singular span survived, the
    // investigator would attempt them and this turn would surface that rather than a
    // clean render. Driven with the phrasing that trips the singular net FIRST
    // ("status … meus pedidos"), so the splice is genuinely load-bearing here.
    const response = await runHistoryTurn({
      customerId: CUST_A,
      text: "qual o status dos meus pedidos?",
      claimType: "ORDER_HISTORY",
      proposedSubject: CUST_A,
      prose: MODEL_ORDER_PROSE,
    });

    expect(response).toContain("Seu histórico de pedidos:");
    expect(response).toContain("Pedido #1042");
    expect(backend.orderReads).toEqual([CUST_A]);
  });
});
