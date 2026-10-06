/**
 * F-10 — A BARE STATUS QUESTION RENDERS INSTEAD OF ESCALATING, AT THE REAL TURN SEAM.
 *
 * THE DEFECT (recorded by R2-S7, re-measured here before the fix). A bare "qual o
 * status?" — no order/payment/reservation discriminator — hits the hand-written
 * bare-"status" fallback in `../claustrum/required-claim-decomposer.ts`, which
 * deliberately OVER-INCLUDES both span classes (`ORDER_STATUS_Q` + `PAYMENT_STATUS_Q`)
 * rather than silently drop a companion. §O#15 completeness then requires BOTH
 * `ORDER_FULFILLMENT_STAGE` and `PAYMENT_STATUS`; for a customer with ONE owned order
 * both resolve on the SAME subject (that orderId — both types are `perResourceKey`).
 * The pair was UNDECLARED in the P2 table, so §O#1 default-deny suppressed BOTH
 * VALIDATED members and the turn terminated ESCALATE. The fix is ONE declared row
 * (`STATUS_COMPANIONS_COMPATIBLE` in `../claustrum/ibatexas-claims-kernel-deps.ts`) —
 * the BKL-234 class on a new pair.
 *
 * ── WHY THIS FILE EXISTS ALONGSIDE THE KERNEL-LEVEL CASES ────────────────────
 *
 * `../claustrum/__tests__/ibatexas-claims-kernel-deps.test.ts` drives the published
 * `checkConsistency` directly and pins what the TABLE says. That is necessary and not
 * sufficient: it cannot show that a real utterance reaches that table with those two
 * types on one subject. Everything upstream — the bare-status fallback firing, §O#15
 * requiring both companions, FIX 2 resolving the single owned order as the subject of
 * BOTH, both owner-scoped reads landing PRESENT and VALIDATING — is what turns a table
 * row into a customer-visible answer, and only a `handleTurn` drive exercises it. A
 * renderer- or kernel-level green over a feature that is dead through the gate is
 * exactly the failure this file is here to rule out.
 *
 * ── BOTH ROUTES, BECAUSE BOTH WERE MEASURED BROKEN ───────────────────────────
 *
 * Measured on this branch before the declaration landed, same utterance, same fixture:
 *
 *   - CLASSIFY-ONLY (`ENABLE_CLASSIFY_ONLY_READS=true`) — both types are
 *     `CLASSIFY_ONLY_ELIGIBLE_TYPES`, so a bare status ask resolves DETERMINISTICALLY
 *     with the model never proposing a claim  → ESCALATE copy.
 *   - MODEL PATH (flag off) — the planner proposes both types on the one subject
 *                                                          → the SAME ESCALATE copy.
 *
 * Both now render both facts. Testing only one route would leave the other's regression
 * uncovered, and they fail independently: the classify-only route can break at
 * `classifyOnlyRequiredTypes` while the model route still works, and vice versa.
 *
 * Deterministic: mocked reads, a scripted model, no clock dependence, no network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";
import { CLASSIFY_ONLY_READS_ENABLED_ENV } from "../claustrum/classify-only-reads.js";

/**
 * ONE owned order carrying BOTH facts, and they are deliberately NOT the same word: a
 * stage of `preparing` with a payment of `paid`. A fixture where the two rendered
 * strings coincided could not tell "both facts rendered" from "one rendered twice".
 *
 * `vi.hoisted` because the `vi.mock` factory below is hoisted above every ordinary
 * top-level binding (see the R2-S7 sibling suite's note).
 */
const { ORDER } = vi.hoisted(() => ({
  ORDER: {
    id: "ord_f10_status",
    displayId: 50771,
    fulfillmentStatus: "preparing",
    paymentStatus: "paid",
  } as const,
}));

/**
 * The reservation used ONLY by the directional control. Its id is deliberately the SAME
 * string as the order's: P2 partitions by SUBJECT, so an undeclared pair only reaches
 * the default-deny when both members land on ONE subject. Two different ids would fall
 * into different buckets and the case would pass without testing anything.
 */
const { SHARED_SUBJECT_RESERVATION } = vi.hoisted(() => ({
  SHARED_SUBJECT_RESERVATION: {
    status: "confirmada",
    partySize: 2,
    // The ASSERTABLE token carries a distinctive suffix rather than the bare status word.
    // "confirmada" on its own is a FALSE NEGATIVE trap: the UNKNOWN copy is literally
    // "Não localizei essa informação confirmada agora…", so `not.toContain("confirmada")`
    // fails on a turn that leaked nothing. Measured, not guessed — the first draft of the
    // control below failed exactly that way.
    statusLine: "confirmada — mesa 7",
  } as const,
}));

/** The pt-BR CUSTOMER register, byte-pinned rather than imported so a dropped
 *  localization renders raw English and these assertions catch it. */
const PT = {
  fulfillment: "em preparo",
  payment: "pago",
} as const;

/** The §O#1 / ESCALATE copy — the exact staff-handoff string F-10 is about. Pinned as a
 *  fragment so the positive cases can assert its ABSENCE and the control its PRESENCE,
 *  which is what makes "renders instead of escalating" a measured claim rather than an
 *  inference from some other string being present. */
const ESCALATE_FRAGMENT = "encaminhar para um atendente";

/** Per-drive switches the mocked backend reads. Reset before every drive. */
const { st } = vi.hoisted(() => ({
  st: {
    orderIds: [] as string[],
    reservationIds: [] as string[],
    /** Which owner-scoped read keys the backend was ASKED for, in order. */
    reads: [] as string[],
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
  // Dynamic import: a `vi.mock` factory is hoisted above this file's static imports, so
  // it cannot close over one. The builder is type-only against turn-reads.js.
  const { buildTriadReadBackend } = await import("./helpers/triad-backend-builder.js");
  return {
    ...actual,
    // Every read NOT declared below defaults to a `notUsed` thrower naming itself, so an
    // unexpected read fails loudly instead of returning a fabricated value.
    createDomainTriadReadBackend: () =>
      buildTriadReadBackend({
        readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
        readScheduleOverride: async () => null,
        readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
        readHoliday: async () => null,
        readHoursForDate: async () => ({ hoursText: "12h–16h" }),
        readHolidayForDate: async () => null,
        readScheduleOverrideForDate: async () => null,
        readOrderFulfillment: async (orderId) => {
          st.reads.push(`order_fulfillment_stage:${orderId}`);
          return orderId === ORDER.id
            ? {
                orderId,
                displayId: ORDER.displayId,
                fulfillmentStatus: ORDER.fulfillmentStatus,
              }
            : null;
        },
        readPaymentStatus: async (orderId) => {
          st.reads.push(`payment_status:${orderId}`);
          return orderId === ORDER.id
            ? {
                orderId,
                displayId: ORDER.displayId,
                status: ORDER.paymentStatus,
                method: "pix",
              }
            : null;
        },
        // Both W6 falsifiers default to "no falsifying fact" so the base reads VALIDATE.
        // A refund or a chargeback would demote PAYMENT_STATUS to UNKNOWN and it would be
        // dropped BEFORE the consistency table is consulted — which would make every
        // co-render assertion below vacuous rather than red.
        readPaymentRefund: async (orderId) => ({
          orderId,
          refunded: false,
          refundedAmountCentavos: 0,
          status: "",
        }),
        readPaymentChargeback: async (orderId) => ({
          orderId,
          disputed: false,
          status: "",
        }),
        readReservation: async (reservationId) => {
          st.reads.push(`reservation_status:${reservationId}`);
          return st.reservationIds.includes(reservationId)
            ? {
                reservationId,
                status: SHARED_SUBJECT_RESERVATION.status,
                partySize: SHARED_SUBJECT_RESERVATION.partySize,
                statusLine: SHARED_SUBJECT_RESERVATION.statusLine,
              }
            : null;
        },
        listActiveOrderIds: async () => [...st.orderIds],
        listActiveReservationIds: async () => [...st.reservationIds],
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
 * asserts a stage AND a payment state NO read produced, so its arrival is a FAILURE
 * rather than a silent regression — and it names a stage neither fixture carries, so it
 * cannot be mistaken for a correct render.
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
const OWNER_ID = "cust-f10-owner";
let seq = 0;

async function drive(args: {
  readonly text: string;
  readonly claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>;
  /** ON drives the DETERMINISTIC route (the model never proposes); OFF the model route. */
  readonly classifyOnly?: boolean;
}): Promise<string> {
  seq += 1;
  if (args.classifyOnly === true) {
    process.env[CLASSIFY_ONLY_READS_ENABLED_ENV] = "true";
  } else {
    delete process.env[CLASSIFY_ONLY_READS_ENABLED_ENV];
  }
  const harness = composeCustomerConductor({
    model: scriptedModel(args.claims),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
    realResponder: true,
    scheduleSignal: { isClosed: false, mealPeriod: "dinner" } as never,
  });
  const out = await runCustomerTurn(harness, {
    customerId: OWNER_ID,
    conversationId: `conv-f10-${seq}`,
    text: args.text,
  });
  return out.response;
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  delete process.env[CLASSIFY_ONLY_READS_ENABLED_ENV];
  st.orderIds = [];
  st.reservationIds = [];
  st.reads = [];
});

// ════════════════════════════════════════════════════════════════════════════════
//  THE FIX — a bare status question renders BOTH facts on BOTH routes.
// ════════════════════════════════════════════════════════════════════════════════

describe("F-10 e2e — a bare status ask co-renders both companions instead of escalating", () => {
  it("CLASSIFY-ONLY route: 'qual o status?' renders the stage AND the payment", async () => {
    st.orderIds = [ORDER.id];
    const response = await drive({
      text: "qual o status?",
      // The DETERMINISTIC route: the model proposes nothing, so a render here can only
      // have come from the classify-only reads.
      claims: [],
      classifyOnly: true,
    });

    // BOTH facts, each off its own VALIDATED claim's C6-bound field, localized.
    expect(response).toContain(PT.fulfillment);
    expect(response).toContain(PT.payment);
    // …and NOT the staff handoff. This is the assertion the whole ticket is about: before
    // the declared row, this exact drive produced the escalation copy.
    expect(response).not.toContain(ESCALATE_FRAGMENT);
    // Never the model's prose, and never the raw English enum members (a dropped
    // localization is otherwise invisible — the render still "works").
    expect(response).not.toBe(MODEL_PROSE);
    expect(response).not.toContain("preparing");
    expect(response).not.toContain("paid");
    // Both owner-scoped reads genuinely RAN, which is what makes this a co-render of two
    // grounded facts rather than one fact plus a coincidence.
    expect(st.reads).toContain(`order_fulfillment_stage:${ORDER.id}`);
    expect(st.reads).toContain(`payment_status:${ORDER.id}`);
  });

  it("MODEL route: the planner's two same-subject claims co-render", async () => {
    st.orderIds = [ORDER.id];
    const response = await drive({
      text: "qual o status?",
      claims: [
        { type: "ORDER_FULFILLMENT_STAGE", subject: ORDER.id },
        { type: "PAYMENT_STATUS", subject: ORDER.id },
      ],
    });

    expect(response).toContain(PT.fulfillment);
    expect(response).toContain(PT.payment);
    expect(response).not.toContain(ESCALATE_FRAGMENT);
    expect(response).not.toBe(MODEL_PROSE);
    expect(st.reads).toContain(`order_fulfillment_stage:${ORDER.id}`);
    expect(st.reads).toContain(`payment_status:${ORDER.id}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
//  THE DIRECTIONAL CONTROL — the net did NOT widen.
// ════════════════════════════════════════════════════════════════════════════════

describe("F-10 e2e — an UNDECLARED same-subject pair still default-denies", () => {
  it("ORDER_FULFILLMENT_STAGE + RESERVATION_STATUS on ONE subject still ESCALATES", async () => {
    // WITHOUT this case the two above are satisfiable by a system that stopped applying
    // §O#1 altogether — the fix and a deleted safety net look identical from the render.
    //
    // The UTTERANCE is what makes this reachable: "…do meu pedido e da minha reserva?"
    // classifies to ORDER_STATUS_Q + RESERVATION_STATUS_Q (the bare-"status" fallback is
    // suppressed here — `reservationRef` de-shadows it, BKL-224), so §O#15 requires
    // ORDER_FULFILLMENT_STAGE + RESERVATION_STATUS. That pair is UNDECLARED and
    // deliberately left so. A bare "qual o status?" cannot express this control: it
    // requires the two companions the fix just declared.
    //
    // The subject is SHARED on purpose (the reservation id IS the order id): P2 partitions
    // by SUBJECT, so distinct ids would land in different buckets, no pair would ever be
    // examined, and this case would pass green with the gate removed.
    st.orderIds = [ORDER.id];
    st.reservationIds = [ORDER.id];
    const response = await drive({
      text: "qual o status do meu pedido e da minha reserva?",
      claims: [
        { type: "ORDER_FULFILLMENT_STAGE", subject: ORDER.id },
        { type: "RESERVATION_STATUS", subject: ORDER.id },
      ],
    });

    // Default-deny suppresses BOTH members — so neither fact may appear…
    expect(response).not.toContain(PT.fulfillment);
    expect(response).not.toContain("mesa 7");
    // …and the turn takes the safe terminal rather than the model's prose.
    expect(response).toContain(ESCALATE_FRAGMENT);
    expect(response).not.toBe(MODEL_PROSE);
    // Both reads RAN, so both members were genuinely available to co-render — which is
    // what makes the suppression above the P2 gate firing rather than a missing fact.
    expect(st.reads).toContain(`order_fulfillment_stage:${ORDER.id}`);
    expect(st.reads).toContain(`reservation_status:${ORDER.id}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
//  THE SINGLE-COMPANION CONTROLS — unchanged by the declaration.
// ════════════════════════════════════════════════════════════════════════════════

describe("F-10 e2e — the single-companion asks are untouched", () => {
  // These two never reached the pair gate (one claim cannot form a pair), so they must be
  // byte-for-byte what they were before. They also make the co-render cases meaningful: a
  // suite where neither type could render on its own would prove nothing about a pair.
  it("a payment-only ask still renders ONLY the payment fact", async () => {
    st.orderIds = [ORDER.id];
    const response = await drive({
      text: "meu pagamento foi aprovado?",
      claims: [{ type: "PAYMENT_STATUS", subject: ORDER.id }],
    });

    expect(response).toContain("O status do seu pagamento é");
    expect(response).toContain(PT.payment);
    // The declaration must not have made the OTHER companion start riding along on a
    // single-companion ask — the over-render direction of the same defect.
    expect(response).not.toContain(PT.fulfillment);
    expect(response).not.toContain(ESCALATE_FRAGMENT);
    expect(response).not.toBe(MODEL_PROSE);
  });

  it("a fulfillment-only ask still renders ONLY the stage fact", async () => {
    st.orderIds = [ORDER.id];
    const response = await drive({
      text: "cadê meu pedido?",
      claims: [{ type: "ORDER_FULFILLMENT_STAGE", subject: ORDER.id }],
    });

    expect(response).toContain("Seu pedido está na etapa");
    expect(response).toContain(PT.fulfillment);
    expect(response).not.toContain(PT.payment);
    expect(response).not.toContain(ESCALATE_FRAGMENT);
    expect(response).not.toBe(MODEL_PROSE);
  });
});
