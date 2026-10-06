// dietary-posture.e2e.test.ts — BKL-270 at the REAL customer turn seam.
//
// WHAT THIS PINS. One case per POSTURE CLASS, driven through the real `handleTurn`
// with the real responder, because the whole ticket is about what the CUSTOMER
// hears:
//
//   · `abstain`                — MENU_ITEM_PRICE, newly gated by this ticket, must
//                                reach the customer as the ratified BKL-184 abstain.
//   · `answer-anyway`          — STORE_HOURS / DELIVERY_COVERAGE must STILL ANSWER
//                                under a dietary qualifier. This is the half a
//                                safety ticket normally forgets, and it is exactly
//                                as load-bearing: over-abstaining is the failure
//                                mode that makes the assistant useless to the people
//                                the gate exists to protect.
//   · `answer-with-abstention` — CART_CONTENTS must deliver BOTH halves: the
//                                customer's own cart AND the refusal to filter it.
//
// Plus the three families the BKL-270 audit never drove (MENU_ITEM_ALLERGENS,
// STORE_HOURS_FOR_DATE, CART_EMPTY), and the diabetes/celiac vocabulary that
// bypassed EVERY gate before this ticket.
//
// WHY `realResponder: true`. The pre-BKL-273 failure mode was the turn falling off
// the deterministic path so the model authored the dietary sentence itself. With the
// default inert responder that shows up as a harmless placeholder. So the scripted
// model here is ARMED with confident dietary prose and every abstain case asserts
// the reply is not it — the suite is directional against the real regression.
//
// Probes are FRESH pt-BR, authored here; none is lifted from a corpus, a fixture, or
// the audit's own probe files.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";
import { resolveQueriedScheduleDate } from "../claustrum/schedule-date-resolver.js";

/** Per-family switches the mocked backend reads. Reset before every drive. */
const { st } = vi.hoisted(() => ({
  st: {
    orderIds: [] as string[],
    reservationIds: [] as string[],
    activePayments: 0,
    hasCartItems: true,
  },
}));

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  const product = (key: string, title: string) => ({
    id: `prod_${key}`,
    title,
    price: 8900,
    description: `${title} defumado 12h no carvalho.`,
    categoryHandle: "carnes",
    inStock: true,
    tags: ["vegetariano"] as string[],
  });
  const titles: Record<string, string> = {
    costela: "Costela Bovina Defumada",
    brownie: "Brownie com Sorvete",
  };
  return {
    ...actual,
    searchProducts: vi.fn(async (input: { query?: string }) => {
      const q = (input.query ?? "").trim().toLowerCase();
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
    // This suite deliberately declares ALL 18 reads: a dietary question can route to
    // almost any span, so no read is provably unreachable here and none may default
    // to the builder's `notUsed` thrower.
    createDomainTriadReadBackend: () =>
      buildTriadReadBackend({
        readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
        readScheduleOverride: async () => null,
        readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
        readHoliday: async () => null,
        readHoursForDate: async () => ({ hoursText: "12h–16h" }),
        readHolidayForDate: async () => null,
        readScheduleOverrideForDate: async () => null,
        readOrderFulfillment: async (orderId) => ({
          orderId,
          displayId: 12345,
          fulfillmentStatus: "preparing",
        }),
        readPaymentStatus: async (orderId) => ({
          orderId,
          displayId: 12345,
          status: "paid",
          method: "pix",
        }),
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
        readReservation: async (reservationId) => ({
          reservationId,
          status: "confirmed",
          partySize: 4,
          statusLine: "confirmada — 20/07 às 19:30, para 4 pessoas",
        }),
        readCartContents: async () => ({
          itemsSummaryText: "2x Costela Bovina Defumada — total R$ 178,00",
          hasItems: st.hasCartItems,
        }),
        readOrderHistory: async () => ({
          historySummaryText: "pedido 12345 — R$ 178,00, entregue",
          hasHistory: true,
        }),
        readPaymentHistory: async () => ({
          historySummaryText: "pagamento de R$ 178,00 via PIX, aprovado",
          hasHistory: true,
        }),
        listActiveOrderIds: async () => [...st.orderIds],
        listActiveReservationIds: async () => [...st.reservationIds],
        countActivePayments: async () => st.activePayments,
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
const {
  __resetMenuItemMemoForTest,
  __resetMenuOverviewMemoForTest,
  __resetMenuDietaryMemoForTest,
} = await import("../claustrum/menu-item-resolver.js");

/** The ratified BKL-184 abstain. Byte-pinned: a change here is a copy DECISION. */
const ABSTAIN =
  "Não localizei essa informação de alérgenos confirmada agora — por segurança, " +
  "prefiro não arriscar uma resposta. Quer que eu peça para um atendente " +
  "confirmar com a cozinha?";

/** The GENERIC unknown. A diet-qualified turn must never land here — that would be
 *  an abstain with no handoff offer, i.e. worse than the allergen path. */
const GENERIC_UNKNOWN =
  "Não localizei essa informação confirmada agora. Quer que eu verifique?";

/** What a real 4B does with a dietary question off the deterministic path. */
const MODEL_DIET_PROSE =
  "Pode comer sim! Nossa Costela Bovina Defumada não leva glúten nem açúcar, " +
  "é totalmente segura pra você.";

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
      // Non-empty on purpose: an empty completion trips the planner's
      // extraction-failure REFUSE and short-circuits before the claims render,
      // which would make every assertion below pass for the wrong reason.
      return { ...base, text: MODEL_DIET_PROSE, toolCalls: [] };
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
const OWNER_ID = "cust-bkl270-owner";
let seq = 0;

async function drive(
  text: string,
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>,
): Promise<string> {
  seq += 1;
  const harness = composeCustomerConductor({
    model: scriptedModel(claims),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
    realResponder: true,
    scheduleSignal: { isClosed: false, mealPeriod: "dinner" } as never,
  });
  const out = await runCustomerTurn(harness, {
    customerId: OWNER_ID,
    conversationId: `conv-bkl270-${seq}`,
    text,
  });
  return out.response;
}

/** Every abstain case asserts the same three things. */
function expectAbstain(response: string): void {
  expect(response).toBe(ABSTAIN);
  expect(response).not.toBe(MODEL_DIET_PROSE);
  expect(response).not.toMatch(/sem gl[úu]ten|sem lactose|sem a[çc][úu]car|n[ãa]o cont[ée]m/i);
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  __resetMenuItemMemoForTest();
  __resetMenuOverviewMemoForTest();
  __resetMenuDietaryMemoForTest();
  st.orderIds = [];
  st.reservationIds = [];
  st.activePayments = 0;
  st.hasCartItems = true;
});

// ── POSTURE 1: abstain ──────────────────────────────────────────────────────

// ── R1-S2 · WHY THESE UTTERANCES NAME THE PRODUCT IN FULL ────────────────────
//
// Every ask below used to say the bare word "costela". That word is a
// DECLARED-AMBIGUOUS alias surface (the store sells two: `costela-bovina-defumada`
// and `costela-defumada-congelada`), and the customer plane arms alias
// canonicalization unconditionally — so in PRODUCTION a bare-"costela" ask is
// short-circuited into the alias CLARIFY question ("a bovina ou a congelada?")
// BEFORE any dietary logic runs. These tests were green only because the e2e
// harness had no alias seam; once it became the production composer's second
// adapter, they were measuring a parse path production never takes.
//
// The fix keeps each case's product question intact and only disambiguates the
// product word: bare "costela" becomes `"costela bovina"`. Bovina, not congelada, in
// all five — the claims name `prod_costela` and the control expects "Costela Bovina
// Defumada", so the fresh cut is each case's original product intent. The
// diet/medical phrasing is untouched, so every ask-net still fires.
//
// ── F-2 IS CLOSED · THE R1-S2 WART NO LONGER EXISTS ──────────────────────────
//
// R1-S2 recorded, and this header used to PIN, a duplicated modifier in the parse
// text these utterances build:
//
//   "qual é o preço da costela bovina?"
//     v1 -> "qual é o preço da costela-bovina-defumada bovina?"   ← the wart
//     v2 -> "qual é o preço da costela-bovina-defumada?"          ← today
//
// The rewrite consumed "costela" to select the reading and left behind the "bovina"
// that selected it. It is fixed in `claustrum/alias-canonicalization.ts`
// (`ALIAS_CANONICALIZATION_VERSION` 1 -> 2): a disambiguator ADJACENT to the surface
// is now spliced out with it. Pinning the warted string was deliberate while the
// defect was live — it was production's real parse surface, and certifying a posture
// over a cleaner surface nobody ran would have certified nothing. That reason is now
// spent, so the record below is the FIXED surface, and `THE F-1 RE-MEASURE` at the
// foot of this file makes it an executable pin rather than a comment.
//
// ── THE F-1 RE-MEASURE (measured, not assumed) ───────────────────────────────
//
// Per driven utterance: raw -> canonicalized parse text, v1 vs v2. 14 utterances,
// 5 changed, 9 byte-identical. NO span or candidate outcome moved — every posture
// assertion in this file passed unedited across the change, which is the actual
// claim: the fix removed a dangling token from the parse INPUT and changed nothing
// about what the customer hears.
//
//  1. "qual é o preço da costela bovina sem lactose?"
//       v1: "…da costela-bovina-defumada bovina sem lactose?"   v2: "…da costela-bovina-defumada sem lactose?"      CHANGED
//  2. "sou diabético, qual é o preço da costela bovina?"
//       v1: "…preço da costela-bovina-defumada bovina?"          v2: "…preço da costela-bovina-defumada?"            CHANGED
//  3. "sou celíaco, qual é o preço da costela bovina?"
//       v1: "…preço da costela-bovina-defumada bovina?"          v2: "…preço da costela-bovina-defumada?"            CHANGED
//  4. "qual é o preço da costela bovina?"
//       v1: "…preço da costela-bovina-defumada bovina?"          v2: "…preço da costela-bovina-defumada?"            CHANGED
//  5. "a costela bovina tem amendoim?"
//       v1: "a costela-bovina-defumada bovina tem amendoim?"     v2: "a costela-bovina-defumada tem amendoim?"       CHANGED
//  6–14. "sou diabético, vocês estão abertos agora?" · "sou celíaco, qual o horário
//       de vocês no domingo?" · "sou alérgico a amendoim, em que etapa está o meu
//       pedido?" · "sou diabético, o meu carrinho tem alguma coisa?" · "sou celíaco,
//       quais itens estão no meu carrinho agora?" · "sou alérgico a amendoim, quais
//       itens estão no meu carrinho agora?" · "quais itens estão no meu carrinho
//       agora?" · "sou diabético, quais itens estão no meu carrinho agora?" · "minha
//       reserva está de pé? e preciso de algo sem glúten"
//       — no alias surface, so BYTE-IDENTICAL under both revisions.  unchanged
//
// ⚠ ONE OPEN TICKET REMAINS UPSTREAM OF THESE STRINGS:
//   F-3 — whether alias ambiguity should outrank a declared dietary/medical marker
//         at all. This suite pins NEITHER answer; it asks only "does a
//         diet-qualified ask get the ratified posture?", which is separable.

describe("BKL-270 e2e — `abstain` (MENU_ITEM_PRICE, newly gated by this ticket)", () => {
  const CLAIMS = [{ type: "MENU_ITEM_PRICE", subject: "prod_costela" }] as const;

  it("a 'sem lactose' price ask abstains instead of pricing the ordinary product", async () => {
    // The failure this closes is not mere implicature: the resolver resolves
    // "costela sem lactose" to the ORDINARY costela and prices THAT, so answering
    // both invents a variant and misprices it.
    // R1-S2 — "bovina" disambiguates; bare "costela" alias-clarifies first (F-3).
    // F-2 is CLOSED: the parse text is now "…da costela-bovina-defumada…", with the
    // selecting modifier consumed. See the header's re-measure record.
    expectAbstain(await drive("qual é o preço da costela bovina sem lactose?", [...CLAIMS]));
  });

  it("a 'sou diabético' price ask abstains — the vocabulary that bypassed every gate", async () => {
    // R1-S2 — "bovina" disambiguates; bare "costela" alias-clarifies first (F-3).
    // F-2 is CLOSED: the parse text is now "…da costela-bovina-defumada…", with the
    // selecting modifier consumed. See the header's re-measure record.
    expectAbstain(await drive("sou diabético, qual é o preço da costela bovina?", [...CLAIMS]));
  });

  it("a 'sou celíaco' price ask abstains — the gap the audit never named", async () => {
    // R1-S2 — "bovina" disambiguates; bare "costela" alias-clarifies first (F-3).
    // F-2 is CLOSED: the parse text is now "…da costela-bovina-defumada…", with the
    // selecting modifier consumed. See the header's re-measure record.
    expectAbstain(await drive("sou celíaco, qual é o preço da costela bovina?", [...CLAIMS]));
  });

  it("THE CONTROL: the same ask with no dietary marker still renders the price", async () => {
    // Without this, every assertion above would pass on a family that simply broke.
    // R1-S2 — "bovina" disambiguates; bare "costela" alias-clarifies first (F-3).
    // F-2 is CLOSED: the parse text is now "…da costela-bovina-defumada…", with the
    // selecting modifier consumed. See the header's re-measure record.
    const response = await drive("qual é o preço da costela bovina?", [...CLAIMS]);
    expect(response).toContain("Costela Bovina Defumada");
    expect(response).toContain("89,00");
    expect(response).not.toBe(ABSTAIN);
  });
});

// ── POSTURE 2: answer-anyway ────────────────────────────────────────────────

describe("BKL-270 e2e — `answer-anyway` still ANSWERS under a dietary qualifier", () => {
  it("STORE_OPEN_NOW answers a diabetic — refusing would be a pure loss, no safety gain", async () => {
    const response = await drive("sou diabético, vocês estão abertos agora?", [
      { type: "STORE_OPEN_NOW", subject: "loja" },
    ]);
    // The closed 3-member enum, localized. Nothing a dietary qualifier can attach to.
    expect(response).toMatch(/jantar/i);
    expect(response).not.toBe(ABSTAIN);
    expect(response).not.toBe(GENERIC_UNKNOWN);
  });

  it("STORE_HOURS_FOR_DATE answers a celiac (a family the audit never drove)", async () => {
    // The subject is the RESOLVED ISO date, so it is computed with the same resolver
    // the investigator uses rather than hardcoded — a hardcoded date would rot the
    // moment the suite runs in a different week.
    const text = "sou celíaco, qual o horário de vocês no domingo?";
    const resolved = resolveQueriedScheduleDate(text, "America/Sao_Paulo", new Date());
    expect(resolved, "the probe must actually anchor a date").not.toBeNull();
    const response = await drive(text, [
      { type: "STORE_OPEN_NOW", subject: "loja" },
      { type: "STORE_HOURS_FOR_DATE", subject: resolved!.isoDate },
    ]);
    expect(response).toContain("12h–16h");
    expect(response).not.toBe(ABSTAIN);
  });

  it("ORDER_FULFILLMENT_STAGE answers — the customer who disclosed an allergy MOST needs this", async () => {
    st.orderIds = ["order-1"];
    const response = await drive(
      "sou alérgico a amendoim, em que etapa está o meu pedido?",
      [{ type: "ORDER_FULFILLMENT_STAGE", subject: "order-1" }],
    );
    expect(response).not.toBe(ABSTAIN);
    expect(response).toMatch(/etapa/i);
    expect(response).not.toBe(GENERIC_UNKNOWN);
  });

  it("CART_EMPTY answers (a family the audit never drove): the render names no food at all", async () => {
    st.hasCartItems = false;
    const response = await drive("sou diabético, o meu carrinho tem alguma coisa?", [
      { type: "CART_CONTENTS", subject: OWNER_ID },
      { type: "CART_EMPTY", subject: OWNER_ID },
    ]);
    expect(response).toMatch(/vazio/i);
    expect(response).not.toBe(ABSTAIN);
  });
});

// ── POSTURE 3: answer-with-abstention ───────────────────────────────────────

describe("BKL-270 e2e — `answer-with-abstention` (CART_CONTENTS): BOTH halves reach the customer", () => {
  const CART = [
    { type: "CART_CONTENTS", subject: OWNER_ID },
    { type: "CART_EMPTY", subject: OWNER_ID },
  ] as const;

  it("delivers the customer's OWN cart AND refuses the dietary filter, in one reply", async () => {
    const response = await drive(
      "sou celíaco, quais itens estão no meu carrinho agora?",
      [...CART],
    );
    // HALF 1 — the fact is theirs to have. Refusing it would be a severe
    // degradation for exactly the customer who most needs to check.
    expect(response).toContain("2x Costela Bovina Defumada");
    expect(response).toContain("178,00");
    // HALF 2 — but the FILTER is not ours to answer.
    expect(response).toContain(ABSTAIN);
    // …and the model's dietary prose never reaches them.
    expect(response).not.toContain("não leva glúten");
  });

  it("the same both-halves shape for an allergen qualifier", async () => {
    const response = await drive(
      "sou alérgico a amendoim, quais itens estão no meu carrinho agora?",
      [...CART],
    );
    expect(response).toContain("2x Costela Bovina Defumada");
    expect(response).toContain(ABSTAIN);
  });

  it("THE CONTROL: with no dietary marker the cart renders ALONE — no unsolicited handoff", async () => {
    // The append must be a response to the qualifier, not noise on every cart read.
    const response = await drive("quais itens estão no meu carrinho agora?", [...CART]);
    expect(response).toContain("2x Costela Bovina Defumada");
    expect(response).not.toContain(ABSTAIN);
  });

  it("never silently downgrades to a plain abstain (the owner's third posture, pinned)", async () => {
    // If CART_CONTENTS' read were ever added to the suppression index, this is the
    // assertion that catches it: the reply would become the bare abstain.
    const response = await drive(
      "sou diabético, quais itens estão no meu carrinho agora?",
      [...CART],
    );
    expect(response).not.toBe(ABSTAIN);
    expect(response).toContain("2x Costela Bovina Defumada");
  });
});

// ── The two-span case (borderline B5) ───────────────────────────────────────

describe("BKL-270 e2e — `answer-anyway` never silently swallows a co-present diet span", () => {
  it("RESERVATION_STATUS answers its own span, and the diet half is not answered as if accepted", async () => {
    st.reservationIds = ["resv-1"];
    const response = await drive(
      "minha reserva está de pé? e preciso de algo sem glúten",
      [{ type: "RESERVATION_STATUS", subject: "resv-1" }],
    );
    // The reservation span answers. NOTE the assertion is on the party-size detail,
    // NOT on the word "confirmada": the ratified abstain copy contains "confirmada"
    // too ("informação de alérgenos CONFIRMADA agora"), so matching that word would
    // pass on the very abstain this case exists to rule out — a vacuous assertion.
    expect(response).not.toBe(ABSTAIN);
    expect(response).toMatch(/4 pessoas/);
    // …and nothing in the reply asserts the dietary request was satisfied.
    expect(response).not.toMatch(/sem gl[úu]ten.*(dispon|garantid|ok|sim)/i);
    expect(response).not.toBe(MODEL_DIET_PROSE);
  });
});

// ── The family that structurally cannot render ──────────────────────────────

describe("BKL-270 e2e — MENU_ITEM_ALLERGENS (never driven by the audit)", () => {
  it("cannot render an allergen answer at all — BKL-123's UNKNOWN-only ruling, at the seam", async () => {
    // It has no VALIDATED_TEMPLATES entry, so even a validated claim abstains. The
    // `abstain` posture declaration is documentation of a property that already
    // holds; this test is what makes that property observable rather than asserted.
    // R1-S2 — "bovina" disambiguates; bare "costela" alias-clarifies before the
    // allergen ask is read at all (F-3). F-2 is CLOSED: the parse text is now
    // "a costela-bovina-defumada tem amendoim?".
    const response = await drive("a costela bovina tem amendoim?", [
      { type: "MENU_ITEM_ALLERGENS", subject: "prod_costela" },
    ]);
    expect(response).toBe(ABSTAIN);
    expect(response).not.toMatch(/n[ãa]o cont[ée]m|n[ãa]o tem amendoim|pode comer/i);
  });
});

// ── THE F-1 RE-MEASURE, AS A PIN ────────────────────────────────────────────
//
// The header's re-measure record used to be prose, and prose is what let the F-2
// wart sit in this file certified-and-green: nothing in the suite ever asserted
// what parse surface these utterances build, so the defect could neither red a
// test nor be noticed drifting. This turns the record into a change-detector.
//
// It pins the PARSE SURFACE only. What the customer hears is every other case in
// this file, and the F-1 claim — "no span or candidate outcome moved" — is
// discharged by those cases passing unedited, not by anything asserted here.

describe("F-1 re-measure — the canonicalized parse surface of every driven utterance", () => {
  // HAND-WRITTEN, in this file's own drive order. Deriving it from the suite would
  // make a deleted case delete its own coverage; the roll-call count below is a
  // NAME-level guard against a case being driven that nobody re-measured.
  const RE_MEASURE: ReadonlyArray<readonly [string, string]> = [
    // ── alias-bearing (5): the F-2 fire set ──
    [
      "qual é o preço da costela bovina sem lactose?",
      "qual é o preço da costela-bovina-defumada sem lactose?",
    ],
    [
      "sou diabético, qual é o preço da costela bovina?",
      "sou diabético, qual é o preço da costela-bovina-defumada?",
    ],
    [
      "sou celíaco, qual é o preço da costela bovina?",
      "sou celíaco, qual é o preço da costela-bovina-defumada?",
    ],
    ["qual é o preço da costela bovina?", "qual é o preço da costela-bovina-defumada?"],
    ["a costela bovina tem amendoim?", "a costela-bovina-defumada tem amendoim?"],
    // ── alias-free (9): byte-identical under both revisions ──
    ["sou diabético, vocês estão abertos agora?", "sou diabético, vocês estão abertos agora?"],
    [
      "sou celíaco, qual o horário de vocês no domingo?",
      "sou celíaco, qual o horário de vocês no domingo?",
    ],
    [
      "sou alérgico a amendoim, em que etapa está o meu pedido?",
      "sou alérgico a amendoim, em que etapa está o meu pedido?",
    ],
    [
      "sou diabético, o meu carrinho tem alguma coisa?",
      "sou diabético, o meu carrinho tem alguma coisa?",
    ],
    [
      "sou celíaco, quais itens estão no meu carrinho agora?",
      "sou celíaco, quais itens estão no meu carrinho agora?",
    ],
    [
      "sou alérgico a amendoim, quais itens estão no meu carrinho agora?",
      "sou alérgico a amendoim, quais itens estão no meu carrinho agora?",
    ],
    ["quais itens estão no meu carrinho agora?", "quais itens estão no meu carrinho agora?"],
    [
      "sou diabético, quais itens estão no meu carrinho agora?",
      "sou diabético, quais itens estão no meu carrinho agora?",
    ],
    [
      "minha reserva está de pé? e preciso de algo sem glúten",
      "minha reserva está de pé? e preciso de algo sem glúten",
    ],
  ];

  it("covers every utterance this file drives — no case is re-measured by omission", () => {
    const driven = new Set(RE_MEASURE.map(([raw]) => raw));
    expect(driven.size).toBe(RE_MEASURE.length);
    expect(RE_MEASURE).toHaveLength(14);
  });

  it.each(RE_MEASURE)("%s", async (raw, expected) => {
    const { canonicalizeAliases } = await import("../claustrum/alias-canonicalization.js");
    const r = canonicalizeAliases(raw);
    expect(r.text).toBe(expected);
    // None of these may CLARIFY — a clarify would short-circuit the turn before any
    // dietary logic ran, which is the R1-S2 failure this file's phrasing exists to
    // avoid, and it would make every posture assertion above vacuous.
    expect(r.ambiguous).toEqual([]);
  });

  it("the alias-bearing asks resolve, and NONE leaves a residual modifier", async () => {
    // Asserts against the LIVE canonicalizer, never against the table above — a
    // check that read `RE_MEASURE`'s own right-hand column would be a statement
    // about this file's literals and would hold with the fix reverted.
    //
    // Two halves, and the first is what stops the second being vacuous: without it,
    // "no residual modifier" would also be satisfied by a canonicalizer that stopped
    // resolving "costela bovina" at all.
    const { canonicalizeAliases } = await import("../claustrum/alias-canonicalization.js");
    const aliasBearing = RE_MEASURE.filter(([raw]) => /costela/.test(raw));
    expect(aliasBearing).toHaveLength(5);
    for (const [raw] of aliasBearing) {
      const r = canonicalizeAliases(raw);
      expect(r.resolutions).toEqual([
        {
          surface: "costela",
          canonical: "costela-bovina-defumada",
          disambiguatedBy: "bovina",
          disambiguatorConsumed: true,
        },
      ]);
      expect(r.text).toContain("costela-bovina-defumada");
      expect(r.text).not.toMatch(/costela-bovina-defumada\s+bovina/i);
    }
  });
});
