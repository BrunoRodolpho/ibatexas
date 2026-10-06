// alias-safety-routing.e2e.test.ts — F-3 at the REAL customer turn seam.
//
// WHAT THIS PINS. The owner ruled (2026-08-04) that a SAFETY MARKER OUTRANKS ALIAS
// AMBIGUITY. Before the fix, the LE2-025b ALIAS short-circuit
// (`ibatexas-planner.ts`, inside `propose`) claimed the turn for ANY
// declared-ambiguous catalog surface: it stamped the ALIAS tier, and because
// `tierAuthorsOwnReply("ALIAS")` is TRUE, `proposeClaims` then returned the EMPTY
// claim plan — so the §O#9 closed-taxonomy safety router and the BKL-270 dietary
// read-suppression NEVER RAN. Measured on the real composition, `"a costela tem
// amendoim?"` — a direct allergen question — proposed ZERO claims and answered with
// the bare catalog disambiguation.
//
// The fix gates ONLY the short-circuit. Canonicalization still runs, and on the
// ambiguous branch `canonicalizeAliases` returns the customer's text BYTE-IDENTICAL,
// so the parse text, the retrieval query and the L1 key surface are untouched.
//
// THE FOUR CLASSES, and why all four are here:
//
//   (a) ambiguous + ALLERGEN ask      — the live gap. Must reach the ratified
//                                        BKL-184 abstain, zero claims asserted.
//   (b) ambiguous + MEDICAL marker    — same, via the BKL-270 diet net (celíaco).
//   (b′) ambiguous + DISTRESS marker  — the §O#9 ESCALATE proper (BKL-209 net).
//   (c) ambiguous, NO marker          — CONTROL. The existing alias CLARIFY, pinned
//                                        BYTE-FOR-BYTE. Without it the fix could
//                                        have deleted the ALIAS tier outright and
//                                        every assertion above would still pass.
//   (d) NON-ambiguous + marker        — CONTROL. The turns that were ALREADY
//                                        safety-routed must be untouched.
//
// WHY `realResponder: true` + `withClaims: true`: this is a ROUTING change, and the
// only honest observation of a routing change is what the customer hears out of the
// real `handleTurn`. The scripted model is ARMED with confident dietary prose, so a
// turn that falls off the deterministic path shows up as that prose rather than as a
// harmless placeholder.
//
// THE SECOND OBSERVABLE is the funnel's own `aliasCounters().clarified` — the
// counter `stampAliasClarify` increments. It is read on a funnel instance this file
// passes EXPLICITLY (the harness otherwise builds its own, which nothing could
// inspect), and it distinguishes "the safe reply happened to be right" from "the
// short-circuit did not fire". A reply assertion alone cannot tell those apart.
//
// Probes are FRESH pt-BR, authored here.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";

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
  const { buildTriadReadBackend } = await import("./helpers/triad-backend-builder.js");
  return {
    ...actual,
    // A safety-marker question can route to almost any span, so — exactly as the
    // BKL-270 e2e argues — no read is provably unreachable here and none may fall
    // through to the builder's `notUsed` thrower.
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
          hasItems: true,
        }),
        readOrderHistory: async () => ({
          historySummaryText: "pedido 12345 — R$ 178,00, entregue",
          hasHistory: true,
        }),
        readPaymentHistory: async () => ({
          historySummaryText: "pagamento de R$ 178,00 via PIX, aprovado",
          hasHistory: true,
        }),
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
const { createParseFunnel } = await import("../claustrum/funnel-tier.js");
const {
  __resetMenuItemMemoForTest,
  __resetMenuOverviewMemoForTest,
  __resetMenuDietaryMemoForTest,
} = await import("../claustrum/menu-item-resolver.js");

// ── THE BYTE PINS ───────────────────────────────────────────────────────────
//
// All three are HAND-WRITTEN, never derived from the module under test. Deriving
// the alias question from `renderAliasClarify(canonicalizeAliases(text).ambiguous)`
// would make the control a projection of the very code path it is supposed to
// certify unchanged — it would still pass if the question's wording changed, and it
// would still pass if `costela` stopped being ambiguous at all.

/** LE2-025b's catalog disambiguation. The thing a safety turn must NEVER get. */
const ALIAS_CLARIFY =
  'Só pra eu não errar: quando você diz "costela", você quer a bovina ou a congelada?';

/** The ratified BKL-184 abstain (slot-grammar `SAFE_UNKNOWN_ALLERGEN_TEMPLATE`). */
const ABSTAIN =
  "Não localizei essa informação de alérgenos confirmada agora — por segurança, " +
  "prefiro não arriscar uma resposta. Quer que eu peça para um atendente " +
  "confirmar com a cozinha?";

/** The §O#9 emergency ESCALATE (slot-grammar `SAFE_ESCALATE_EMERGENCY_TEMPLATE`). */
const EMERGENCY =
  "Isto parece uma emergência médica e eu não posso orientar sobre isso. " +
  "Se você ou alguém aí está passando mal, procure atendimento médico de " +
  "emergência imediatamente. Vou avisar nossa equipe para ajudar.";

/** What a real 4B does with a safety question off the deterministic path. */
const MODEL_DIET_PROSE =
  "Pode comer sim! Nossa Costela Bovina Defumada não leva glúten nem amendoim, " +
  "é totalmente segura pra você.";

/** Every DOMAIN FACT the mocked catalog could leak. A safety reply asserts none. */
const DOMAIN_FACT_RE =
  /89,00|R\$|Costela Bovina Defumada|n[ãa]o cont[ée]m|n[ãa]o leva|sem gl[úu]ten|pode comer/i;

function scriptedModel(
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>,
): ModelProvider & {
  readonly calls: () => number;
  readonly parseSurfaces: () => readonly string[];
} {
  let calls = 0;
  const parseSurfaces: string[] = [];
  const complete = vi.fn(async (req: CompletionRequest): Promise<Completion> => {
    calls += 1;
    // The EXACT bytes that reached the wire. `parseText` is what the L1 key digests,
    // so this is the observable for the funnel key-surface contract.
    parseSurfaces.push(JSON.stringify(req.messages ?? []));
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
    // extraction-failure REFUSE and short-circuits before the claims render, which
    // would make every assertion below pass for the wrong reason.
    return { ...base, text: MODEL_DIET_PROSE, toolCalls: [] };
  });
  return {
    complete,
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
    calls: () => calls,
    parseSurfaces: () => parseSurfaces,
  } as unknown as ModelProvider & {
    readonly calls: () => number;
    readonly parseSurfaces: () => readonly string[];
  };
}

/** NOT a `guest:`/`anon:` id — the investigator gates owner reads on this. */
const OWNER_ID = "cust-f3-owner";
let seq = 0;

interface Driven {
  readonly response: string;
  /** How many times `stampAliasClarify` ran — i.e. did the ALIAS tier claim the turn. */
  readonly aliasClarified: number;
  /** Zero ⟹ the turn never reached the wire (the ALIAS/L0 short-circuit shape). */
  readonly modelCalls: number;
  /** Every wire payload this turn produced — the surface the L1 key digests. */
  readonly parseSurfaces: readonly string[];
}

async function drive(
  text: string,
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>,
): Promise<Driven> {
  seq += 1;
  // EXPLICIT funnel: the harness would otherwise build a `createParseFunnel({})` it
  // keeps to itself, and `aliasCounters()` — the direct observation of whether the
  // short-circuit fired — would be unreachable. Tiers armed are exactly production's
  // minus L1/L2 (no parse-cache store, no retriever): L0 and ALIAS.
  const funnel = createParseFunnel({});
  const model = scriptedModel(claims);
  const harness = composeCustomerConductor({
    model,
    funnel,
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
    realResponder: true,
    scheduleSignal: { isClosed: false, mealPeriod: "dinner" } as never,
  });
  const out = await runCustomerTurn(harness, {
    customerId: OWNER_ID,
    conversationId: `conv-f3-${seq}`,
    text,
  });
  return {
    response: out.response,
    aliasClarified: funnel.aliasCounters().clarified,
    modelCalls: model.calls(),
    parseSurfaces: model.parseSurfaces(),
  };
}

const ALLERGENS = [{ type: "MENU_ITEM_ALLERGENS", subject: "prod_costela" }] as const;

/**
 * The three things EVERY safety-routed turn in this file must satisfy, whatever
 * terminal it lands on: the catalog disambiguation did not claim the turn, the
 * reply asserts no domain fact, and the model's prose never reached the customer.
 */
function expectSafetyRouted(driven: Driven): void {
  // The CUSTOMER-VISIBLE property first, deliberately: this is the assertion the
  // revert-to-red is read off, and "you received the bare disambiguation again" is
  // the finding — not "a counter moved".
  expect(driven.response).not.toBe(ALIAS_CLARIFY);
  expect(driven.aliasClarified).toBe(0);
  expect(driven.response).not.toMatch(/quando voc[êe] diz/i);
  expect(driven.response).not.toBe(MODEL_DIET_PROSE);
  expect(driven.response).not.toMatch(DOMAIN_FACT_RE);
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  __resetMenuItemMemoForTest();
  __resetMenuOverviewMemoForTest();
  __resetMenuDietaryMemoForTest();
});

// ── (a) ambiguous + ALLERGEN ────────────────────────────────────────────────

describe("F-3 e2e — an ALLERGEN question over an ambiguous surface is safety-routed", () => {
  it("'a costela tem amendoim?' abstains instead of asking bovina-ou-congelada", async () => {
    // THE LIVE GAP, verbatim. `costela` names two products, so before the fix this
    // turn was claimed by the ALIAS tier and the customer's Hard-Rule-#1 allergen
    // question was answered with a catalog disambiguation and zero claims.
    const driven = await drive("a costela tem amendoim?", [...ALLERGENS]);
    expectSafetyRouted(driven);
    expect(driven.response).toBe(ABSTAIN);
  });

  it("the turn actually REACHED the claim plane — it did not merely reply safely", async () => {
    // The reply above is also what a broken planner that answered nothing would
    // produce. A model call PROVES the short-circuit released the turn: the ALIAS
    // tier's whole contract is "zero model calls are made" (funnel-tier.ts).
    const driven = await drive("a costela tem amendoim?", [...ALLERGENS]);
    expect(driven.modelCalls).toBeGreaterThan(0);
  });

  it("THE FUNNEL KEY-SURFACE CONTRACT: the parser saw the customer's OWN words", async () => {
    // The fix gates the SHORT-CIRCUIT, never the canonicalization — so the text the
    // parse is a function of (and therefore the L1 cache key that digests it) must
    // be byte-identical to the utterance. `canonicalizeAliases` guarantees this on
    // the ambiguous branch by returning the ORIGINAL text; this asserts it survived
    // all the way to the wire, which is where the contract actually binds.
    const driven = await drive("a costela tem amendoim?", [...ALLERGENS]);
    expect(driven.parseSurfaces.length).toBeGreaterThan(0);
    for (const surface of driven.parseSurfaces) {
      expect(surface).toContain("a costela tem amendoim?");
      // No canonical handle reached the parse. If a future change made the
      // deferred turn canonicalize a half-resolved surface, THIS is what catches
      // it — the L1 key would then be digesting a string the customer never said.
      expect(surface).not.toContain("costela-bovina-defumada");
      expect(surface).not.toContain("costela-defumada-congelada");
    }
  });
});

// ── (b) ambiguous + MEDICAL marker ──────────────────────────────────────────

describe("F-3 e2e — a declared MEDICAL condition over an ambiguous surface", () => {
  it("'sou celíaco, posso comer a costela?' abstains — §O#9's non-emergency half", async () => {
    // Celiac is the BKL-270 diet net, NOT the BKL-209 distress net, and that
    // separation is deliberate: the ratified BKL-143/123/184 policy for an INFO
    // question is honest self-report + a staff offer, never a handoff for every
    // "tem amendoim?". So the correct terminal here is the abstain, not ESCALATE.
    const driven = await drive("sou celíaco, posso comer a costela?", [...ALLERGENS]);
    expectSafetyRouted(driven);
    expect(driven.response).toBe(ABSTAIN);
  });

  it("'sou diabético, o que tem na costela?' abstains too", async () => {
    const driven = await drive("sou diabético, o que tem na costela?", [
      { type: "MENU_ITEM_CONTENTS", subject: "prod_costela" },
    ]);
    expectSafetyRouted(driven);
    expect(driven.response).toBe(ABSTAIN);
  });
});

// ── (b′) ambiguous + ACTIVE DISTRESS → the §O#9 ESCALATE proper ─────────────

describe("F-3 e2e — active DISTRESS over an ambiguous surface reaches §O#9 ESCALATE", () => {
  it("'comi a costela e estou tendo uma reação alérgica' escalates, and never asks which costela", async () => {
    // This is the class where surfacing the ambiguity would be actively HARMFUL:
    // "a bovina ou a congelada?" is the wrong question for someone in distress. The
    // §O#9 ESCALATE outranks every clarification by construction, and the deferred
    // ambiguity is subsumed by a terminal that is the same for both readings.
    const driven = await drive("comi a costela e estou tendo uma reação alérgica", [
      ...ALLERGENS,
    ]);
    expectSafetyRouted(driven);
    expect(driven.response).toBe(EMERGENCY);
  });
});

// ── (c) CONTROL: ambiguous, NO marker — the ALIAS tier is UNCHANGED ─────────

describe("F-3 e2e — CONTROL: an ambiguous surface with NO safety marker", () => {
  it("still gets the LE2-025b catalog disambiguation, byte-for-byte", async () => {
    // THE CONTROL THAT MUST VALIDATE. Deleting the ALIAS short-circuit entirely
    // would satisfy every assertion above; only this one fails on that mutation.
    const driven = await drive("quanto custa a costela?", [
      { type: "MENU_ITEM_PRICE", subject: "prod_costela" },
    ]);
    expect(driven.response).toBe(ALIAS_CLARIFY);
    expect(driven.aliasClarified).toBe(1);
  });

  it("and is STILL a zero-model-call turn — the tier's cost contract is intact", async () => {
    const driven = await drive("quanto custa a costela?", [
      { type: "MENU_ITEM_PRICE", subject: "prod_costela" },
    ]);
    expect(driven.modelCalls).toBe(0);
  });

  it("a marker-free ambiguous surface in a DIFFERENT frame also still clarifies", async () => {
    // Guards against the gate accidentally keying on question shape rather than on
    // the marker: no diet word, no distress word, same surface.
    const driven = await drive("me fala da costela", []);
    expect(driven.response).toBe(ALIAS_CLARIFY);
    expect(driven.aliasClarified).toBe(1);
  });
});

// ── (d) CONTROL: NON-ambiguous + marker — already safety-routed, untouched ──

describe("F-3 e2e — CONTROL: a marker over a NON-ambiguous surface is unchanged", () => {
  it("'a costela bovina tem amendoim?' still abstains, and never touched the ALIAS tier", async () => {
    // The turns that ALREADY worked. `costela bovina` carries its disambiguator, so
    // canonicalization RESOLVES rather than clarifies and the short-circuit was
    // never in play — the gate must be invisible here.
    const driven = await drive("a costela bovina tem amendoim?", [...ALLERGENS]);
    expect(driven.response).toBe(ABSTAIN);
    expect(driven.aliasClarified).toBe(0);
  });

  it("'sou celíaco, o que tem na costela bovina?' is unchanged as well", async () => {
    const driven = await drive("sou celíaco, o que tem na costela bovina?", [
      { type: "MENU_ITEM_CONTENTS", subject: "prod_costela" },
    ]);
    expect(driven.response).toBe(ABSTAIN);
    expect(driven.aliasClarified).toBe(0);
  });

  it("and this surface DOES canonicalize on the wire — which is what makes the key-surface pin directional", async () => {
    // WITHOUT THIS the `not.toContain("costela-bovina-defumada")` assertion in the
    // key-surface test above could be vacuous: if no utterance ever put a canonical
    // handle on the wire, that assertion would pass with the canonicalizer deleted.
    // `costela bovina` carries its disambiguator, so it RESOLVES — and the resolved
    // handle really does reach the parse. Same probe, opposite expectation.
    const driven = await drive("sou celíaco, o que tem na costela bovina?", [
      { type: "MENU_ITEM_CONTENTS", subject: "prod_costela" },
    ]);
    expect(driven.parseSurfaces.length).toBeGreaterThan(0);
    expect(driven.parseSurfaces.some((s) => s.includes("costela-bovina-defumada"))).toBe(
      true,
    );
  });
});
