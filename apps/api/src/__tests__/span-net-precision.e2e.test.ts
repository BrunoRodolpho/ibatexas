// span-net-precision.e2e.test.ts — BKL-205 / BKL-221 / BKL-222 at the REAL
// customer turn seam.
//
// WHAT THIS PINS. Three span-net gaps that all cost the same thing — a question
// the system could answer deterministically did not reach its read — driven
// through the real `handleTurn` with the real responder, with
// ENABLE_CLASSIFY_ONLY_READS ON so the ROUTE is part of what is asserted:
//
//   · BKL-205 — "o que vêm no combo?" (the ACCENTED plural) matched nothing, and
//     "o que tem no BRISKET?" matched the WHOLE-MENU span, so an item question was
//     answered with the entire catalogue. Note the second is not a degrade: it
//     rendered CONFIDENTLY, off a VALIDATED claim, to a different question.
//   · BKL-221 — a BARE delivery-progress ask ("está a caminho?") matched nothing,
//     so classify-only declined, the model's extraction leg REFUSED, and the
//     customer got `system.extraction_failure` instead of the ≥2-owned candidates
//     CLARIFY that BKL-203/204 built for exactly this turn.
//   · BKL-222 — the day-specific hours family was not classify-only eligible, so
//     it rode the 4B read-dispatch and inherited its variance (SCN-002 degraded on
//     one pass). Here the ROUTE is the deliverable, so it is asserted directly.
//
// HOW THE ROUTE IS PROVEN. `claimProposalForbiddenModel` throws if the planner ever
// requests `propose_claim` — the same BY-CONSTRUCTION instrument the harness's own
// `throwingModel` / `plannerThrowingModel` use, and for the stated reason: a
// counting spy lets a regression pass with a wrong number nobody asserted. It is
// NOT `plannerThrowingModel`, because a read turn still makes the planner's
// EXTRACTION call (tool-bearing, `express_intent`) even when classify-only handles
// the claim; only the claim-proposal leg is retired, so only that leg may throw.
//
// WHY `realResponder: true`. The BKL-273 / BKL-271 lesson: losing a span is not
// fail-safe — with no span the REAL responder authors the answer in prose, and the
// default inert responder shows that as a harmless placeholder. The scripted model
// is ARMED with confident, unsourced prose (`MODEL_PROSE`) that only the model path
// could produce, and every case asserts the reply is not it.
//
// DIRECTIONAL BY CONSTRUCTION: revert any one of the three net changes and that
// row's cases go red — the read vanishes and the armed prose (or the wrong-family
// render) takes the turn.
//
// Probes are FRESH pt-BR authored here; none is lifted from the extraction corpus,
// the eval fixtures, or another suite. Order numbers are scrubbed (12345/12346).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";
import { CLASSIFY_ONLY_READS_ENABLED_ENV } from "../claustrum/classify-only-reads.js";
import { resolveQueriedScheduleDate } from "../claustrum/schedule-date-resolver.js";

/** Per-drive switches the mocked backend reads. Reset before every drive. */
const { st } = vi.hoisted(() => ({
  st: {
    orderIds: [] as string[],
    catalogQueries: [] as string[],
  },
}));

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  // Two products with DISTINCT descriptions, so an item render can be told apart
  // from a whole-menu render by its text alone (the BKL-205 half-2 assertion).
  const titles: Record<string, string> = {
    brisket: "Brisket Americano",
    combo: "Combo Família",
  };
  const described: Record<string, string> = {
    brisket: "Peito bovino defumado 12h no carvalho, servido em fatias.",
    combo: "Serve 4 pessoas: costela, linguiça, arroz biro-biro e vinagrete.",
  };
  const product = (key: string, title: string) => ({
    id: `prod_${key}`,
    title,
    price: 8900,
    description: described[key] ?? `${title} defumado.`,
    categoryHandle: "carnes-defumadas",
    inStock: true,
    tags: [] as string[],
  });
  return {
    ...actual,
    searchProducts: vi.fn(async (input: { query?: string }) => {
      const q = (input.query ?? "").trim().toLowerCase();
      st.catalogQueries.push(q);
      if (q === "" || q === "*") {
        return { products: Object.entries(titles).map(([k, t]) => product(k, t)) };
      }
      for (const [key, title] of Object.entries(titles)) {
        if (q.includes(key)) return { products: [product(key, title)] };
      }
      return { products: [] };
    }),
    medusaAdmin: vi.fn(async () => ({ stores: [] })),
  };
});

vi.mock("../claustrum/turn-reads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claustrum/turn-reads.js")>();
  // Dynamic import: a `vi.mock` factory is hoisted above this file's static imports,
  // so it cannot close over one. The builder is type-only against turn-reads.js, so
  // this drags no infrastructure into the factory (see the helper's header).
  const { buildTriadReadBackend } = await import("./helpers/triad-backend-builder.js");
  return {
    ...actual,
    // Every read NOT declared below defaults to a `notUsed` thrower naming itself, so
    // an unexpected read fails loudly instead of returning a fabricated value.
    createDomainTriadReadBackend: () =>
      buildTriadReadBackend({
        readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
        readScheduleOverride: async () => null,
        readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
        readHoliday: async () => null,
        // Deliberately DIFFERENT from readStoreHours: an assertion on this string
        // cannot be satisfied by the today-hours read, so "the DATE claim rendered"
        // is distinguishable from "some hours claim rendered".
        readHoursForDate: async () => ({ hoursText: "12h–16h" }),
        readHolidayForDate: async () => null,
        readScheduleOverrideForDate: async () => null,
        readOrderFulfillment: async (orderId) => ({
          orderId,
          displayId: orderId === "order-2" ? 12346 : 12345,
          fulfillmentStatus: "preparing",
        }),
        listActiveOrderIds: async () => [...st.orderIds],
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
const { __resetMenuItemMemoForTest, __resetMenuOverviewMemoForTest } = await import(
  "../claustrum/menu-item-resolver.js"
);

/** What a real 4B does once one of these turns leaves the deterministic path.
 *  Names a composition and a schedule NO read produced, so its arrival is a
 *  failure rather than a silent regression. */
const MODEL_PROSE =
  "Claro! O combo vem com pão de alho, farofa especial e refrigerante, e aos " +
  "domingos a gente abre das 9h às 22h direto. Seu pedido já saiu, chega em 15 minutos!";

/**
 * A model that SERVES the planner's extraction leg and the responder, but THROWS
 * if the claim-proposal leg is ever requested. That leg is precisely what
 * classify-only retires, so reaching it means the turn took the model path — and
 * the failure is structural rather than a count somebody has to remember to assert.
 */
function claimProposalForbiddenModel(label: string): ModelProvider {
  return {
    complete: vi.fn(async (req: CompletionRequest): Promise<Completion> => {
      const toolNames = (req.tools ?? []).map((t) => t.name);
      if (toolNames.includes(PROPOSE_CLAIM_TOOL)) {
        throw new Error(
          `[span-net-precision] propose_claim was requested — ${label} must ride the ` +
            `DETERMINISTIC classify-only path, not the model claim proposal`,
        );
      }
      // Non-empty on purpose: an empty completion trips the planner's
      // extraction-failure REFUSE and would short-circuit before the claims
      // render, making every assertion below pass for the wrong reason.
      return {
        model: "mock",
        stopReason: "end_turn",
        text: MODEL_PROSE,
        toolCalls: [],
        inputTokens: 5,
        outputTokens: 4,
      };
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
const OWNER_ID = "cust-span-net-owner";
let seq = 0;

async function drive(text: string, label: string): Promise<string> {
  seq += 1;
  const harness = composeCustomerConductor({
    model: claimProposalForbiddenModel(label),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
    realResponder: true,
    scheduleSignal: { isClosed: false, mealPeriod: "dinner" } as never,
  });
  const out = await runCustomerTurn(harness, {
    customerId: OWNER_ID,
    conversationId: `conv-span-net-${seq}`,
    text,
  });
  return out.response;
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  process.env[CLASSIFY_ONLY_READS_ENABLED_ENV] = "true";
  __resetMenuItemMemoForTest();
  __resetMenuOverviewMemoForTest();
  st.orderIds = [];
  st.catalogQueries = [];
});

// ── BKL-205 ─────────────────────────────────────────────────────────────────

describe("BKL-205 e2e — an item-contents ask reaches the ITEM read", () => {
  it("the ACCENTED plural 'o que vêm no combo família?' renders the combo's own description", async () => {
    // Before this ticket the accented `vêm` matched NO span (measured ∅), so the
    // turn left the deterministic path and the armed prose took it.
    const response = await drive("o que vêm no combo família?", "BKL-205 accented vêm");

    expect(response).toContain("Combo Família");
    expect(response).toContain("arroz biro-biro");
    expect(response).not.toBe(MODEL_PROSE);
    // The model's invented composition never reaches the customer.
    expect(response).not.toMatch(/p[ãa]o de alho|farofa especial/i);
    // …and the turn genuinely went to the catalog for it.
    expect(st.catalogQueries).toContain("o que vêm no combo família?");
  });

  it("'o que tem no brisket?' answers about the BRISKET, not with the whole menu", async () => {
    // THE REGISTERED DEFECT. Before this ticket the overview span shadowed the
    // per-item one, so this rendered the entire catalogue — confidently, off a
    // VALIDATED claim, to a question nobody asked.
    const response = await drive("o que tem no brisket?", "BKL-205 overview shadow");

    expect(response).toContain("Brisket Americano");
    expect(response).toContain("Peito bovino defumado");
    // THE DIRECTIONAL HALF: the OTHER product must not appear. A whole-menu render
    // lists every product, so naming the combo here is the exact old behaviour —
    // without this assertion the test would pass on the defect it exists to close.
    expect(response).not.toContain("Combo Família");
    expect(response).not.toBe(MODEL_PROSE);
  });

  it("THE CONTROL: a genuine whole-menu ask still gets the whole menu", async () => {
    // Without this, the two cases above would pass on a family that simply broke.
    const response = await drive("o que tem no cardápio?", "BKL-205 overview control");

    expect(response).toContain("Brisket Americano");
    expect(response).toContain("Combo Família");
    expect(response).not.toBe(MODEL_PROSE);
  });
});

// ── BKL-221 ─────────────────────────────────────────────────────────────────

describe("BKL-221 e2e — a BARE delivery-progress ask reaches the order read", () => {
  it("'está a caminho?' with ONE owned order renders that order's stage", async () => {
    st.orderIds = ["order-1"];
    const response = await drive("está a caminho?", "BKL-221 bare progress");

    expect(response).toMatch(/etapa|prepar/i);
    expect(response).not.toBe(MODEL_PROSE);
    // The model's invented ETA never reaches the customer.
    expect(response).not.toMatch(/15 minutos/);
  });

  it("'já foi entregue?' likewise reaches the read (the participle form)", async () => {
    st.orderIds = ["order-1"];
    const response = await drive("já foi entregue?", "BKL-221 entregue");

    expect(response).toMatch(/etapa|prepar/i);
    expect(response).not.toBe(MODEL_PROSE);
  });

  // THE ROW'S OWN ACCEPTANCE CRITERION. With ≥2 owned orders the deterministic path
  // refuses to guess WHICH order and forces the BKL-189 candidates CLARIFY. The
  // registered defect was that the turn never got this far: no span fired,
  // classify-only declined, and the extraction leg REFUSED instead.
  it("with ≥2 owned orders it reaches the CANDIDATES CLARIFY, not an extraction failure", async () => {
    st.orderIds = ["order-1", "order-2"];
    const response = await drive("falta muito para chegar?", "BKL-221 ambiguous");

    // The customer is ASKED WHICH ORDER, by the display numbers the ledger carries.
    expect(response).toContain("12345");
    expect(response).toContain("12346");
    expect(response).not.toBe(MODEL_PROSE);
  });

  // The BKL-204 boundary at the SEAM, not merely in the span unit test: a question
  // about what the STORE does must not be answered from this customer's own order.
  it("THE CONTROL: a delivery CAPABILITY ask does not answer from the customer's order", async () => {
    st.orderIds = ["order-1"];
    const response = await drive("vocês entregam em Ibaté?", "BKL-221 capability control");

    expect(response).not.toMatch(/etapa/i);
    expect(response).not.toBe(MODEL_PROSE);
  });
});

// ── BKL-222 ─────────────────────────────────────────────────────────────────

describe("BKL-222 e2e — day-specific hours ride the DETERMINISTIC path", () => {
  it("'qual o horário de domingo?' renders the DATE hours with NO claim-proposal call", async () => {
    // THE ROUTE IS THE DELIVERABLE HERE, and it is asserted twice over: the
    // propose_claim leg would THROW if reached (so merely completing proves the
    // deterministic route), and the rendered string is the date-specific one the
    // today-hours read cannot produce.
    const text = "qual o horário de domingo?";
    // The date is computed with the SAME resolver the investigator uses rather
    // than hardcoded — a hardcoded date would rot the moment the suite runs in a
    // different week.
    const resolved = resolveQueriedScheduleDate(text, "America/Sao_Paulo", new Date());
    expect(resolved, "the probe must actually anchor a date").not.toBeNull();

    const response = await drive(text, "BKL-222 day-specific hours");

    expect(response).toContain("12h–16h");
    // …and NOT the today-hours string, which is what a STORE_HOURS render would say.
    expect(response).not.toContain("11h–15h");
    expect(response).not.toBe(MODEL_PROSE);
    expect(response).not.toMatch(/9h [àa]s 22h/);
  });

  it("'vocês abrem amanhã no feriado?' also rides it (the date span alone)", async () => {
    const response = await drive("vocês abrem amanhã no feriado?", "BKL-222 feriado");

    expect(response).toContain("12h–16h");
    expect(response).not.toBe(MODEL_PROSE);
  });

  // THE SCOPE BOUNDARY, at the seam. A BARE schedule question must STILL take the
  // model path — STORE_OPEN_NOW is eligible only as the date family's companion.
  // Driving it through the propose_claim-FORBIDDEN model would throw, so this case
  // asserts the decline at the gate instead, which is where the decision is made.
  it("THE BOUNDARY: a bare schedule question is NOT admitted to the deterministic path", async () => {
    const { classifyOnlyRequiredTypes } = await import(
      "../claustrum/classify-only-reads.js"
    );
    expect(classifyOnlyRequiredTypes("vocês estão abertos agora?")).toBeUndefined();
    expect(classifyOnlyRequiredTypes("que horas fecham?")).toBeUndefined();
    // …and a PICKUP ask stays on the model path even WITH a date anchor, because
    // the #8 guest carve-out cannot run at that gate.
    expect(classifyOnlyRequiredTypes("que horas posso retirar amanhã?")).toBeUndefined();
  });
});

// ── The BKL-270 posture, on the families this ticket MOVED ───────────────────
//
// These additions change WHICH turns take the deterministic path, not what renders
// — but that is a claim, and BKL-270's whole point is that per-family dietary
// behaviour must be OBSERVED rather than assumed. One diet-qualified variant per
// touched family, against its RATIFIED posture (dietary-posture.test.ts holds the
// owner-signed table). The allergen-vocabulary cases live in dietary-posture.e2e —
// these use the NON-allergen condition vocabulary on purpose, because that is the
// half that does NOT trip the classify-only route decline (`isAllergenFamilyAsk`),
// and so is the half that actually exercises the newly-deterministic path.

describe("BKL-205/221/222 — the moved families still honour their declared posture", () => {
  it("MENU_ITEM_CONTENTS (`abstain`) — a diabetic's item ask does NOT get a food answer", async () => {
    const response = await drive(
      "sou diabético, o que tem no brisket?",
      "BKL-205 posture",
    );
    // `abstain` means the read returns nothing → honest UNKNOWN. The product's
    // composition must not be described to someone who named a condition.
    expect(response).not.toContain("Peito bovino defumado");
    expect(response).not.toBe(MODEL_PROSE);
  });

  it("ORDER_FULFILLMENT_STAGE (`answer-anyway`) — a diabetic still gets their order stage", async () => {
    // The over-abstain direction is a real failure too: refusing here would be pure
    // loss for exactly the customer who most needs to know when food arrives.
    st.orderIds = ["order-1"];
    const response = await drive(
      "sou diabético, está a caminho?",
      "BKL-221 posture",
    );
    expect(response).toMatch(/etapa|prepar/i);
    expect(response).not.toBe(MODEL_PROSE);
  });

  it("STORE_HOURS_FOR_DATE (`answer-anyway`) — a diabetic still gets Sunday's hours", async () => {
    const response = await drive(
      "sou diabético, qual o horário de domingo?",
      "BKL-222 posture",
    );
    expect(response).toContain("12h–16h");
    expect(response).not.toBe(MODEL_PROSE);
  });
});
