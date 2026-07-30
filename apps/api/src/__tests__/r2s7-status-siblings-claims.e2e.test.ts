/**
 * R2-S7 — THE STATUS SIBLINGS AT THE REAL TURN SEAM (F-6).
 *
 * ORDER_FULFILLMENT_STAGE and PAYMENT_STATUS are now GENERATED from
 * `../claustrum/claimdefs/order-fulfillment-stage.claim.ts` /
 * `payment-status.claim.ts`. This file is the proof that the generated specs render
 * through the REAL adapter — `composeCustomerConductor` + `runCustomerTurn`, the real
 * planner, investigator, claims kernel and renderer-from-claims — and not merely that
 * the compiled objects have the right fields.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS: PAYMENT_STATUS HAD NO handleTurn PROOF AT ALL
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED before writing it, because "add a turn-seam proof" is only worth doing where
 * one is missing:
 *
 *   - ORDER_FULFILLMENT_STAGE already renders at L3 in TWO suites, both UNEDITED by this
 *     slice: `./span-net-precision.e2e.test.ts` (the BKL-221 bare-progress asks — "está a
 *     caminho?" / "falta muito para chegar?" → `/etapa|prepar/`, plus the BKL-204
 *     capability control and the ≥2-owned CLARIFY) and `./dietary-posture.e2e.test.ts`
 *     (the `answer-anyway` posture: an allergy-disclosing customer still gets their
 *     order's stage). Both keep passing unedited, which is the migration's central claim
 *     for that type.
 *   - PAYMENT_STATUS rendered at L3 NOWHERE. `dietary-posture`'s backend even implements
 *     `readPaymentStatus`, but no case in that file drives a payment-status turn; and
 *     `span-net-precision` wires it to a `notUsed()` THROW. So the MONEY read — SDD §E's
 *     worked safety-critical type, the one with the `first_party_verified` floor and the
 *     `first_party_only` provenance — had its deepest coverage at the kernel seam.
 *   - NEITHER type had a DISCRIMINATION proof at any depth. `span-net-precision` does
 *     drive two owned orders, but both carry the IDENTICAL `fulfillmentStatus:
 *     "preparing"`, and it asserts the ≥2-owned CLARIFY rather than which order answered.
 *     A suite where every order has the same status cannot tell "rendered THIS order" from
 *     "rendered SOME order", which is exactly the failure a dropped `perResourceKey` causes.
 *
 * ── THE DISCRIMINATION AXIS, AND WHY IT IS TWO ORDERS AND NOT TWO CUSTOMERS ──────
 *
 * R2-S5's histories are subjected by the AUTHENTICATED customerId (one history per
 * customer), so their turn-seam proof discriminates by CUSTOMER. BOTH types here are
 * subjected by the ORDER id — `order_fulfillment_stage:{orderId}` /
 * `payment_status:{orderId}`, and payment status is per ORDER (one active payment per
 * order) — so the axis is R2-S4's: TWO RESOURCES OF ONE OWNER. That is also the STRONGER
 * axis for these two, because the cross-customer wall is enforced upstream by the
 * investigator's customerId-keyed enumeration, while WHICH OF MY OWN ORDERS answered is
 * decided by the suffixed key alone. Every order below therefore carries a DISTINCT status
 * and a DISTINCT display number, and each discriminating case asserts BOTH directions: the
 * named order's value present AND the sibling's absent.
 *
 * The customer names one order by its DISPLAY NUMBER, which is the BKL-203
 * `resolveNamedOwnedOrderSubject` path — and that path is gated on
 * `ORDER_SUBJECT_BASE_KEYS` (`classify-only-reads.ts`), the hand-written set listing
 * `order_fulfillment_stage` and `payment_status`. Those two names are `ownerScopedBaseKey`
 * derivations off the GENERATED specs now, so these cases are also the end-to-end witness
 * that the derivation survived adoption: a base key that drifted would silently drop the
 * turn back to the ambiguity CLARIFY.
 *
 * Deterministic: mocked reads, a scripted model, no clock dependence, no network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { ownerScopedBaseKey } from "../claustrum/claim-registry.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";

/**
 * The two owned orders. EVERY field distinct — the fulfillment stage, the payment status
 * and the display number — so no assertion below can be satisfied by the wrong order's
 * read. `ORDER_A` is deliberately NOT `paid`: if both orders were `paid`, the payment
 * discrimination cases would pass on a system that always renders the same value.
 *
 * Declared inside `vi.hoisted` because the `vi.mock` factory below is hoisted above every
 * ordinary top-level binding — a plain `const` here is a `ReferenceError: Cannot access
 * 'ORDER_A' before initialization` at module load, surfaced as a mocking error rather than
 * a test failure. The hoisted block is the one place both the factory and the cases can
 * read the SAME fixture, which is what keeps the backend's rows and the assertions from
 * drifting into two transcriptions.
 */
const { ORDER_A, ORDER_B } = vi.hoisted(() => ({
  ORDER_A: {
    id: "ord_r2s7_a",
    displayId: 40771,
    fulfillmentStatus: "preparing",
    paymentStatus: "payment_pending",
  } as const,
  ORDER_B: {
    id: "ord_r2s7_b",
    displayId: 40772,
    fulfillmentStatus: "in_delivery",
    paymentStatus: "paid",
  } as const,
}));

/** The pt-BR CUSTOMER register (`@ibatexas/types`, via claims-labels.ts). Byte-pinned
 *  here rather than imported, so a silently-dropped localization renders raw English and
 *  these assertions catch it — the whole point of the `${claimType}.${field}` key the
 *  generated render slot feeds. */
const PT = {
  aFulfillment: "em preparo",
  bFulfillment: "saiu para entrega",
  aPayment: "pagamento pendente",
  bPayment: "pago",
} as const;

/** Per-drive switches the mocked backend reads. Reset before every drive. */
const { st } = vi.hoisted(() => ({
  st: {
    orderIds: [] as string[],
    /** Which owner-scoped read keys the backend was ASKED for, in order. */
    reads: [] as string[],
    /** Flip a refund on (the W6 falsifier that CAN actually fire on this type). */
    refundedOrders: [] as string[],
    /** Flip a chargeback/dispute on — the SECOND W6 falsifier, and the arm unique to
     *  this type (no other adopted type has two). */
    disputedOrders: [] as string[],
  },
}));

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return {
    ...actual,
    searchProducts: vi.fn(async () => ({ products: [] })),
    medusaAdmin: vi.fn(async () => ({ stores: [] })),
  };
});

vi.mock("../claustrum/turn-reads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claustrum/turn-reads.js")>();
  const notUsed = (name: string) => async (): Promise<never> => {
    throw new Error(`turn-reads.${name} must not run in this suite`);
  };
  // The two orders, keyed for the per-order lookups. A read for an id NOT in this map is
  // a cross-owner / bogus id: it must return null (the owner-scoped `getById` miss), never
  // a fabricated row — that null is what the victim-subject cases below measure.
  const OWNED: Record<
    string,
    { displayId: number; fulfillmentStatus: string; paymentStatus: string }
  > = {
    [ORDER_A.id]: {
      displayId: ORDER_A.displayId,
      fulfillmentStatus: ORDER_A.fulfillmentStatus,
      paymentStatus: ORDER_A.paymentStatus,
    },
    [ORDER_B.id]: {
      displayId: ORDER_B.displayId,
      fulfillmentStatus: ORDER_B.fulfillmentStatus,
      paymentStatus: ORDER_B.paymentStatus,
    },
  };
  return {
    ...actual,
    createDomainTriadReadBackend: () => ({
      readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
      readScheduleOverride: async () => null,
      readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
      readHoliday: async () => null,
      readHoursForDate: async () => ({ hoursText: "12h–16h" }),
      readHolidayForDate: async () => null,
      readScheduleOverrideForDate: async () => null,
      readOrderFulfillment: async (orderId: string) => {
        st.reads.push(`order_fulfillment_stage:${orderId}`);
        const row = OWNED[orderId];
        return row === undefined
          ? null
          : { orderId, displayId: row.displayId, fulfillmentStatus: row.fulfillmentStatus };
      },
      readPaymentStatus: async (orderId: string) => {
        st.reads.push(`payment_status:${orderId}`);
        const row = OWNED[orderId];
        return row === undefined
          ? null
          : {
              orderId,
              displayId: row.displayId,
              status: row.paymentStatus,
              method: "pix",
            };
      },
      // The TWO W6 falsifiers — genuinely read for this type (unlike every predecessor's
      // single deliberately-unread one), which is why the two-row set had to be proven
      // expressible. Both default to "no falsifying fact", so the base read can VALIDATE.
      readPaymentRefund: async (orderId: string) => ({
        orderId,
        refunded: st.refundedOrders.includes(orderId),
        refundedAmountCentavos: st.refundedOrders.includes(orderId) ? 1000 : 0,
        status: st.refundedOrders.includes(orderId) ? "refunded" : "",
      }),
      // THE FIELD NAME IS `disputed`, AND THE TWO ARE NOT INTERCHANGEABLE. The investigator
      // reads `v.disputed ? v : ABSENT_READ` (ibatexas-investigator.ts) against the published
      // `PaymentChargebackRead { orderId, disputed, status }` shape (turn-reads.ts). A double
      // returning some other spelling — this one said `hasChargeback` until the review caught
      // it — leaves `v.disputed` UNDEFINED, which is falsy, so the arm reads exactly like "no
      // dispute" and every positive case stays green while the falsifier is unprovable. tsc
      // cannot catch it either: a `vi.mock` factory's return is loosely typed, so neither
      // excess- nor missing-property checking applies. That is the class where a double proves
      // a port was CALLED but never that its output is USABLE — so the switch below is what
      // makes this arm load-bearing rather than merely correctly spelled.
      readPaymentChargeback: async (orderId: string) => ({
        orderId,
        disputed: st.disputedOrders.includes(orderId),
        status: st.disputedOrders.includes(orderId) ? "disputed" : "",
      }),
      readReservation: notUsed("readReservation"),
      readCartContents: notUsed("readCartContents"),
      readOrderHistory: notUsed("readOrderHistory"),
      readPaymentHistory: notUsed("readPaymentHistory"),
      listActiveOrderIds: async () => [...st.orderIds],
      listActiveReservationIds: async () => [],
      countActivePayments: async () => st.orderIds.length,
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

/**
 * What a real 4B does with a status question once the turn leaves the grounded path. It
 * asserts a stage AND a payment state NO read produced, so its arrival is a FAILURE rather
 * than a silent regression — and it names values from neither order, so it cannot be
 * mistaken for a discrimination miss.
 */
const MODEL_PROSE =
  "Boa notícia! Seu pedido já saiu para entrega e o pagamento foi aprovado no cartão, " +
  "deve chegar em uns 15 minutos.";

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
      // Non-empty on purpose: an empty completion trips the planner's extraction-failure
      // REFUSE and short-circuits before the claims render, which would make every
      // assertion below pass for the wrong reason.
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

/** NOT a `guest:`/`anon:` id — the investigator gates owner reads on this. */
const OWNER_ID = "cust-r2s7-owner";
const GUEST_ID = "guest:anon_r2s7";
let seq = 0;

async function drive(args: {
  readonly text: string;
  readonly claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>;
  readonly customerId?: string;
}): Promise<string> {
  seq += 1;
  const harness = composeCustomerConductor({
    model: scriptedModel(args.claims),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
    realResponder: true,
    scheduleSignal: { isClosed: false, mealPeriod: "dinner" } as never,
  });
  const out = await runCustomerTurn(harness, {
    customerId: args.customerId ?? OWNER_ID,
    conversationId: `conv-r2s7-${seq}`,
    text: args.text,
  });
  return out.response;
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  st.orderIds = [];
  st.reads = [];
  st.refundedOrders = [];
  st.disputedOrders = [];
});

// ════════════════════════════════════════════════════════════════════════════════
//  PAYMENT_STATUS — F-6, closed. The MONEY read's first handleTurn proof.
// ════════════════════════════════════════════════════════════════════════════════

describe("R2-S7 e2e — the GENERATED PAYMENT_STATUS spec renders at the real turn seam", () => {
  it("the owner's own payment VALIDATES and renders the C6-bound status, localized", async () => {
    st.orderIds = [ORDER_B.id];
    const response = await drive({
      text: "meu pagamento foi aprovado?",
      claims: [{ type: "PAYMENT_STATUS", subject: ORDER_B.id }],
    });

    // The generated template's frame literal + the C6-bound `status` field, localized off
    // `PAYMENT_STATUS.status`. All three come from the ONE source: the frame from
    // `render.validated`, the field from `valueBinding.path`, the localization key from the
    // type name plus the slot's field.
    expect(response).toContain("O status do seu pagamento é");
    expect(response).toContain(PT.bPayment);
    // Never the model's prose, and never the raw English enum member (a dropped
    // localization is otherwise invisible — the render still "works").
    expect(response).not.toBe(MODEL_PROSE);
    expect(response).not.toContain("paid");
    expect(response).not.toMatch(/cart[ãa]o/i);
    // …and the owner-scoped read genuinely RAN against the suffixed key the generated spec
    // declares. Without this the render could be satisfied by any path that produced the
    // string, which is what a value-binding regression looks like from outside.
    expect(st.reads).toContain(`payment_status:${ORDER_B.id}`);
    expect(ownerScopedBaseKey("PAYMENT_STATUS")).toBe("payment_status");
  });

  it("TWO owned orders: the NAMED order's payment renders and the sibling's NEVER does", async () => {
    // THE DISCRIMINATION AXIS. Two orders, one owner, DISTINCT payment statuses. A dropped
    // `perResourceKey` collapses both onto the bare `payment_status` key, so whichever
    // order was read last answers for both — the customer is told the wrong order's money
    // state with entirely correct-looking provenance.
    // PHRASING NOTE, measured rather than guessed. The natural wording "o pagamento DO
    // PEDIDO 40772 foi aprovado?" fires BOTH status spans (`pedido` is an ORDER strong
    // token), so §O#15 completeness then requires ORDER_FULFILLMENT_STAGE too and a turn
    // proposing only the payment claim degrades to the honest UNKNOWN — which would make
    // this case red for a reason that has nothing to do with discrimination. The wording
    // below fires PAYMENT_STATUS_Q ALONE (asserted in the decomposer suite), so the axis
    // under test is isolated. The display NUMBER still does its work: with two owned orders
    // and no name, FIX 2 cannot pick a subject and the turn is the ambiguity CLARIFY.
    st.orderIds = [ORDER_A.id, ORDER_B.id];
    const response = await drive({
      text: `o pagamento ${ORDER_B.displayId} foi aprovado?`,
      claims: [{ type: "PAYMENT_STATUS", subject: ORDER_B.id }],
    });

    expect(response).toContain(PT.bPayment);
    // THE DIRECTIONAL HALF — without it the case passes on a system that renders any
    // owned order's status.
    expect(response).not.toContain(PT.aPayment);
    expect(response).not.toBe(MODEL_PROSE);
    // BOTH reads are present in the ledger, so the render CHOSE rather than only having
    // one option. This is what makes the negative above meaningful.
    expect(st.reads).toContain(`payment_status:${ORDER_A.id}`);
    expect(st.reads).toContain(`payment_status:${ORDER_B.id}`);
  });

  it("…and the MIRROR: naming the OTHER order renders ITS status, not the first one's", async () => {
    // The same drive with the subjects swapped. Without the mirror, a system hardcoded to
    // render ORDER_B would pass the case above.
    st.orderIds = [ORDER_A.id, ORDER_B.id];
    const response = await drive({
      text: `o pagamento ${ORDER_A.displayId} foi aprovado?`,
      claims: [{ type: "PAYMENT_STATUS", subject: ORDER_A.id }],
    });

    expect(response).toContain(PT.aPayment);
    expect(response).not.toContain(PT.bPayment);
    expect(response).not.toBe(MODEL_PROSE);
  });

  it("a VICTIM-SUBJECT proposal cannot bind: a foreign order id yields NO money fact", async () => {
    // The model proposes an id this customer does not own. The owner-scoped `getById`
    // misses, the evidence resolves ABSENT, and the claim degrades to honest UNKNOWN —
    // it must NEVER render a status, and must never fall through to the armed prose.
    st.orderIds = [ORDER_A.id];
    const response = await drive({
      text: "o pagamento do pedido 99999 foi aprovado?",
      claims: [{ type: "PAYMENT_STATUS", subject: "ord_someone_elses_order" }],
    });

    expect(response).not.toContain("O status do seu pagamento é");
    for (const leaked of [PT.aPayment, PT.bPayment, "paid", "payment_pending"]) {
      expect(response, `must not leak ${leaked}`).not.toContain(leaked);
    }
    expect(response).not.toBe(MODEL_PROSE);
  });

  it("a GUEST gets no money fact and records NO owner-scoped payment read at all", async () => {
    // The strongest form of the negative: not "attempted and refused" but the read never
    // running. The investigator gates owner-scoped reads on `isAuthenticatedCustomer`, so a
    // guest naming a real order id cannot even reach the query.
    st.orderIds = [ORDER_B.id];
    const response = await drive({
      text: "meu pagamento foi aprovado?",
      claims: [{ type: "PAYMENT_STATUS", subject: ORDER_B.id }],
      customerId: GUEST_ID,
    });

    expect(response).not.toContain(PT.bPayment);
    expect(st.reads.filter((k) => k.startsWith("payment_status:"))).toEqual([]);
  });

  it("THE HONEST-ABSTAIN CONTROL: authenticated, read RAN, no owned order ⇒ no status", async () => {
    // The mechanism this control isolates is DISTINCT from the guest case: here the
    // customer IS authenticated, so nothing is gated off — the read simply finds nothing.
    // Without it, every negative above is satisfiable by a system that can never render a
    // payment status at all.
    st.orderIds = [];
    const response = await drive({
      text: "meu pagamento foi aprovado?",
      claims: [{ type: "PAYMENT_STATUS", subject: ORDER_B.id }],
    });

    expect(response).not.toContain(PT.bPayment);
    expect(response).not.toBe(MODEL_PROSE);
    // And the positive case above proves the same wiring DOES render when a read lands —
    // so this abstain is honest ignorance, not a broken family.
  });

  it("the W6 REFUND falsifier DEMOTES a paid status (the two-row set, at the seam)", async () => {
    // PAYMENT_STATUS is the first adopted type whose falsifiers are genuinely READ, and
    // the arity is a registry first — so the demote is proven at the turn seam, not just as
    // a suffixed key. CONTROL first: the same order with no refund RENDERS (asserted in the
    // first case above); TREATMENT: a present refund contradicts "pago" and the claim must
    // not assert it.
    st.orderIds = [ORDER_B.id];
    st.refundedOrders = [ORDER_B.id];
    const response = await drive({
      text: "meu pagamento foi aprovado?",
      claims: [{ type: "PAYMENT_STATUS", subject: ORDER_B.id }],
    });

    expect(response).not.toContain(PT.bPayment);
    expect(response).not.toBe(MODEL_PROSE);
  });

  it("the W6 CHARGEBACK falsifier DEMOTES a paid status — the SECOND row, proven", async () => {
    // THE ARM UNIQUE TO THIS TYPE. The refund case above would pass identically on a
    // one-falsifier spec, so on its own it proves the SET fires, not that BOTH rows do — and
    // this source's header asserts both are genuinely read. This is that claim's directional
    // proof, and it is the case the field-name defect made unwritable: while the double
    // returned `hasChargeback`, `v.disputed` read undefined ⇒ falsy ⇒ ABSENT_READ, so the arm
    // could never fire and a test like this one would have been silently vacuous.
    //
    // The two falsifiers are VALUE-DISTINCT signals, not redundant ones (turn-reads.ts): a
    // refund is money returned; a dispute is a chargeback the customer or bank raised against
    // a row still reading `paid`. Either contradicts a confident "pago".
    st.orderIds = [ORDER_B.id];
    st.disputedOrders = [ORDER_B.id];
    // NO refund on this drive — so the demote below can only be the chargeback arm. Without
    // this the case would be satisfiable by the row the previous test already exercises.
    expect(st.refundedOrders).toEqual([]);

    const response = await drive({
      text: "meu pagamento foi aprovado?",
      claims: [{ type: "PAYMENT_STATUS", subject: ORDER_B.id }],
    });

    expect(response).not.toContain(PT.bPayment);
    expect(response).not.toContain("paid");
    expect(response).not.toBe(MODEL_PROSE);
    // The CONTROL is the first case in this describe: the SAME order, the SAME utterance, the
    // SAME claim, with both switches off, renders "pago". So the only varying input between a
    // render and this abstain is the dispute — which is what makes this the falsifier and not
    // some other conjunct failing.
    expect(st.reads).toContain(`payment_status:${ORDER_B.id}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
//  ORDER_FULFILLMENT_STAGE — ONLY the axis its L3 suites lack.
// ════════════════════════════════════════════════════════════════════════════════

describe("R2-S7 e2e — ORDER_FULFILLMENT_STAGE: the discrimination axis its L3 suites lack", () => {
  // This type already renders at L3 in span-net-precision (BKL-221) and dietary-posture
  // (BKL-270), both UNEDITED. What neither has is a pair of owned orders with DIFFERENT
  // stages: span-net-precision's two orders are both `preparing`, so it can prove a stage
  // rendered but not WHICH order's. These two cases add exactly that and nothing else.
  it("TWO owned orders: the NAMED order's stage renders and the sibling's NEVER does", async () => {
    st.orderIds = [ORDER_A.id, ORDER_B.id];
    const response = await drive({
      text: `em que etapa está o pedido ${ORDER_A.displayId}?`,
      claims: [{ type: "ORDER_FULFILLMENT_STAGE", subject: ORDER_A.id }],
    });

    expect(response).toContain("Seu pedido está na etapa");
    expect(response).toContain(PT.aFulfillment);
    expect(response).not.toContain(PT.bFulfillment);
    expect(response).not.toBe(MODEL_PROSE);
    expect(response).not.toContain("preparing");
    // Both reads present ⇒ the render CHOSE.
    expect(st.reads).toContain(`order_fulfillment_stage:${ORDER_A.id}`);
    expect(st.reads).toContain(`order_fulfillment_stage:${ORDER_B.id}`);
    expect(ownerScopedBaseKey("ORDER_FULFILLMENT_STAGE")).toBe("order_fulfillment_stage");
  });

  it("…and the MIRROR: naming the OTHER order renders ITS stage", async () => {
    st.orderIds = [ORDER_A.id, ORDER_B.id];
    const response = await drive({
      text: `em que etapa está o pedido ${ORDER_B.displayId}?`,
      claims: [{ type: "ORDER_FULFILLMENT_STAGE", subject: ORDER_B.id }],
    });

    expect(response).toContain(PT.bFulfillment);
    expect(response).not.toContain(PT.aFulfillment);
    expect(response).not.toBe(MODEL_PROSE);
  });
});
