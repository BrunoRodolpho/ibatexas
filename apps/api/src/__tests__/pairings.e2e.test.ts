// pairings.e2e.test.ts — LE2-029 at the REAL customer turn seam.
//
// Ticket 29's acceptance criteria, asserted where they are actually decidable:
// through a real `handleTurn` over `composeCustomerConductor({ withClaims: true })`
// — real planner, real resolver, real tool registry, real claims seams
// (investigator → claim planner → claims kernel → render-from-claims → the
// precedence lattice). The only fakes are the ModelProvider, the triad read
// backend, and `searchProducts` (the ONE catalog egress the pairing read makes).
//
// WHY THE SEAM AND NOT THE RESOLVER. `pairing-resolver.test.ts` already pins the
// resolver's four branches. What it cannot see is the §O#15 required-completeness
// gate, which lives in `createIbatexasClaimsRenderer` — one layer ABOVE the pure
// renderer, and the exact layer where LE2-002 shipped a structurally-dead feature
// with green renderer-level tests (its complementary pair was missing from
// PRESENCE_COMPLEMENT_PAIRS, so every coverage turn silently degraded
// RENDER→UNKNOWN). A pairing turn that renders HERE is a pairing turn that renders
// in production.
//
// THE CASES (ticket 29 + the brief's directional pairs):
//   1. a grounded pairing render naming LIVE product titles, never kebab handles
//   2. an UNKNOWN item → the honest abstain, asserting no suggestion
//   3. EMPTY pairing data for the asked relation → the same honest abstain
//   4. AC-3: the colloquial alias renders IDENTICALLY to the canonical handle
//   5. the SAFETY negative + its control (see the §O#9 note on that describe block)

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";

// ── The catalog egress (the pairing read's ONE IO edge) ───────────────────────

/**
 * The seed catalog's own titles, keyed by the DE-KEBABED handle — which is how
 * `pairing-resolver.ts` queries (`mandioca-frita` → "mandioca frita"). Keying on
 * the handle instead would silently miss every lookup and degrade all five cases
 * to UNKNOWN for the wrong reason.
 */
const { catalog } = vi.hoisted(() => ({
  catalog: {
    titles: {
      "brisket americano": "Brisket Americano",
      "mandioca frita": "Mandioca Frita",
      "limonada suica": "Limonada Suíça",
      "brownie com sorvete": "Brownie com Sorvete",
      "costela bovina defumada": "Costela Bovina Defumada",
      "costela defumada congelada": "Costela Defumada Congelada",
      "farofa de bacon defumado": "Farofa de Bacon Defumado",
      "molho barbecue artesanal": "Molho Barbecue Artesanal",
      "pulled pork": "Pulled Pork",
      "pulled pork congelado": "Pulled Pork Congelado",
      "linguica artesanal defumada": "Linguiça Artesanal Defumada",
      "feijao tropeiro": "Feijão Tropeiro",
      "coleslaw da casa": "Coleslaw da Casa",
      "frango defumado inteiro": "Frango Defumado Inteiro",
      "barriga de porco defumada": "Barriga de Porco Defumada",
    } as Record<string, string>,
    /** Every query the turn made — the proof that the read happened at all. */
    queries: [] as string[],
  },
}));

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return {
    ...actual,
    // The pairing read's only egress. An unknown query returns NO product, which
    // is exactly what the live store does for an item it does not sell.
    searchProducts: vi.fn(async (input: { query: string }) => {
      catalog.queries.push(input.query);
      const title = catalog.titles[input.query];
      if (title === undefined) return { products: [] };
      return {
        products: [
          {
            id: `prod_${input.query.replace(/\W+/g, "_")}`,
            title,
            price: 1000,
            description: null,
            categoryHandle: "carnes",
            inStock: true,
            tags: [] as string[],
          },
        ],
      };
    }),
  };
});

vi.mock("../claustrum/turn-reads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claustrum/turn-reads.js")>();
  const { buildTriadReadBackend } = await import(
    "./helpers/triad-backend-builder.js"
  );
  return {
    ...actual,
    createDomainTriadReadBackend: () =>
      buildTriadReadBackend({
        readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
        readScheduleOverride: async () => null,
        readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
        readHoliday: async () => null,
        readHoursForDate: async () => ({ hoursText: "11h–15h / 18h–23h" }),
        readHolidayForDate: async () => null,
        readScheduleOverrideForDate: async () => null,
        // Someone asking what goes with the brisket owns nothing relevant;
        // present-with-0 keeps §O#15 from force-requiring an order companion.
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
const { clearPairingMemoForTests } = await import("../claustrum/pairing-resolver.js");
const { __resetMenuItemMemoForTest } = await import(
  "../claustrum/menu-item-resolver.js"
);

/** The grounded pairing reply, verbatim — the customer-facing contract ticket 29
 *  ships. The sentence is composed IN CODE from the authored graph's edges and the
 *  LIVE titles those edges resolved to; the trailing offer is the template's own
 *  static frame. */
const BRISKET_PAIRINGS_RENDER =
  "Com Brisket Americano, aqui na casa a gente costuma servir " +
  "Mandioca Frita, Limonada Suíça e Brownie com Sorvete. " +
  "Quer que eu adicione algum ao pedido?";

const SAFE_UNKNOWN_RENDER =
  "Não localizei essa informação confirmada agora. Quer que eu verifique?";

/** The BKL-184 / BKL-143 ALLERGEN abstain: honest self-report plus a REAL staff
 *  handoff offer — the ratified conservative policy copy for anything carrying an
 *  allergen or dietary marker. */
const ALLERGEN_ABSTAIN_RENDER =
  "Não localizei essa informação de alérgenos confirmada agora — por segurança, " +
  "prefiro não arriscar uma resposta. Quer que eu peça para um atendente " +
  "confirmar com a cozinha?";

/** The kebab handles the graph holds internally. NONE may reach a customer
 *  (Hard Rule 4 — the store's own pt-BR product names, never an identifier). */
const KEBAB_HANDLES = [
  "brisket-americano",
  "mandioca-frita",
  "limonada-suica",
  "brownie-com-sorvete",
  "costela-bovina-defumada",
  "pulled-pork",
];

/** Claim-planner-only scripted model: the intent leg proposes nothing, and the
 *  claim leg proposes the pairing PAIR. The VALUES are derived first-party by the
 *  planner from the same per-turn read the investigator recorded — never from
 *  anything in this array. */
function claimsScriptedModel(
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
      return { ...base, text: "ok (mock planner pass — nothing to propose)", toolCalls: [] };
    }),
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  } as unknown as ModelProvider;
}

/** The pairing PAIR, proposed on every turn — a presence complement, so at most
 *  one can ever be PRESENT and the other resolves UNKNOWN and is dropped. */
const PAIRING_PAIR = [
  { type: "MENU_PAIRINGS", subject: "" },
  { type: "MENU_SUBSTITUTIONS", subject: "" },
] as const;

let turnSeq = 0;

async function runPairingTurn(text: string): Promise<string> {
  turnSeq += 1;
  const harness = composeCustomerConductor({
    model: claimsScriptedModel([...PAIRING_PAIR]),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
  });
  const out = await runCustomerTurn(harness, {
    customerId: `cust-pair-${turnSeq}`,
    conversationId: `conv-pair-${turnSeq}`,
    text,
  });
  return out.response;
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  clearPairingMemoForTests();
  __resetMenuItemMemoForTest();
  catalog.queries.length = 0;
});

// ── (1) The grounded render ──────────────────────────────────────────────────

describe("LE2-029 e2e — a pairing ask renders GROUNDED suggestions", () => {
  it("names the LIVE product titles the authored edges resolve to", async () => {
    const response = await runPairingTurn("o que combina com brisket?");

    expect(response).toBe(BRISKET_PAIRINGS_RENDER);
    // The three edges `PAIRING_GRAPH` declares out of `brisket-americano`, each
    // spoken as the product's OWN catalog title.
    expect(response).toContain("Mandioca Frita");
    expect(response).toContain("Limonada Suíça");
    expect(response).toContain("Brownie com Sorvete");
    // …and the turn genuinely went to the catalog for them.
    expect(catalog.queries).toContain("mandioca frita");
  });

  it("NO kebab handle reaches the customer (Hard Rule 4)", async () => {
    const response = await runPairingTurn("o que combina com brisket?");
    for (const handle of KEBAB_HANDLES) {
      expect(response).not.toContain(handle);
    }
    // Directional: the LIVE titles for those same handles ARE there, so the
    // negative above is about the spelling and not an empty reply.
    expect(response).toContain("Brisket Americano");
  });

  it("the §O#15 gate did NOT degrade the turn (the LE2-002 failure, asserted directly)", async () => {
    const response = await runPairingTurn("o que combina com brisket?");
    expect(response).not.toBe(SAFE_UNKNOWN_RENDER);
  });
});

// ── (2) An unknown item ──────────────────────────────────────────────────────

describe("LE2-029 e2e — an UNKNOWN item degrades to the honest unknown", () => {
  it("asserts NO suggestion for an item the house does not sell", async () => {
    const response = await runPairingTurn("o que combina com sushi?");

    expect(response).toBe(SAFE_UNKNOWN_RENDER);
    // The load-bearing negatives: no invented suggestion, in any frame.
    expect(response).not.toContain("costuma servir");
    expect(response).not.toContain("a casa indica");
    for (const title of ["Mandioca Frita", "Limonada Suíça", "Brownie com Sorvete"]) {
      expect(response).not.toContain(title);
    }
  });

  it("the SAME frame with a known item still renders (the abstain is not universal)", async () => {
    expect(await runPairingTurn("o que combina com brisket?")).toBe(
      BRISKET_PAIRINGS_RENDER,
    );
  });
});

// ── (3) Empty pairing data for the asked relation ────────────────────────────

describe("LE2-029 e2e — EMPTY pairing data degrades to the honest unknown", () => {
  it("a known subject with NO edges of the ASKED relation asserts nothing", async () => {
    // `brisket-americano` carries three `pairs-with` edges and ZERO
    // `substitutes-for` ones. The graph is an avowedly PARTIAL authored seed, so
    // "no edge recorded" must reach the customer as "I could not check", never as
    // "nothing stands in for it".
    const response = await runPairingTurn("não tem brisket, o que peço no lugar?");

    expect(response).toBe(SAFE_UNKNOWN_RENDER);
    expect(response).not.toContain("a casa indica");
    expect(response).not.toMatch(/não temos nada|nada substitui|não há substituto/i);
  });

  it("the SAME subject, asked about the relation it DOES carry, answers", async () => {
    // The directional control that makes the case above non-vacuous: the unknown
    // is the empty RELATION, not a dead subject, a dead catalog or a dead feature.
    expect(await runPairingTurn("o que combina com brisket?")).toBe(
      BRISKET_PAIRINGS_RENDER,
    );
  });
});

// ── (4) AC-3 — the alias reaches the read canonicalized ──────────────────────

describe("LE2-029 e2e — AC-3: the colloquial alias renders like the canonical handle", () => {
  it("'brisket' and 'brisket-americano' produce the IDENTICAL reply", async () => {
    const colloquial = await runPairingTurn("o que combina com brisket?");
    const canonical = await runPairingTurn("o que combina com brisket-americano?");

    expect(colloquial).toBe(canonical);
    expect(colloquial).toBe(BRISKET_PAIRINGS_RENDER);
    // Byte-identical AND grounded — an equality that both sides degraded to the
    // abstain would also satisfy, which is why the second assertion is here.
    expect(colloquial).not.toBe(SAFE_UNKNOWN_RENDER);
  });
});

// ── (4b) A BOTH-ask degrades at the seam ─────────────────────────────────────

describe("LE2-029 e2e — a TWO-question utterance degrades instead of half-answering", () => {
  it("neither key is recorded, so the turn says so out loud", async () => {
    // `costela-bovina-defumada` carries edges of BOTH relations, so the old
    // precedence would have answered the substitution half confidently and
    // dropped the pairing half in silence — a reply that reads as a complete
    // answer to a question that was only half heard.
    const response = await runPairingTurn(
      "o que combina com a costela bovina e o que posso pôr no lugar?",
    );

    expect(response).toBe(SAFE_UNKNOWN_RENDER);
    expect(response).not.toContain("costuma servir");
    expect(response).not.toContain("a casa indica");
    expect(response).not.toContain("Costela Defumada Congelada");
  });

  it("THE CONTROL: the same subject as a SINGLE question answers", async () => {
    const response = await runPairingTurn(
      "o que combina com costela-bovina-defumada?",
    );
    expect(response).toBe(
      "Com Costela Bovina Defumada, aqui na casa a gente costuma servir " +
        "Farofa de Bacon Defumado e Molho Barbecue Artesanal. " +
        "Quer que eu adicione algum ao pedido?",
    );
  });
});

// ── (5) The SAFETY negative, and its control ─────────────────────────────────

describe("LE2-029 e2e — an allergen/dietary marker never gets a pairing suggestion", () => {
  // THE BRIEF SAID §O#9 HANDLES THIS. MEASURED, IT DID NOT — and this is the
  // finding this describe block exists to record.
  //
  // Ticket 29 and `pairing-graph.ts`'s header both state that "o que combina com
  // brisket que seja sem glúten?" is routed to ESCALATE by §O#9's closed-taxonomy
  // safety routing "before this read is consulted". It is not. §O#9's
  // DETERMINISTIC contribution is `detectMedicalEmergencyMarkers`, which keys on
  // ACTIVE DISTRESS ("reação alérgica", "não consigo respirar") and is
  // deliberately DISJOINT from merely naming a diet — correctly so, because the
  // ratified BKL-143/123/184 policy for an allergen INFO question is honest
  // self-report plus a staff offer, NOT a human handoff for every "tem
  // amendoim?". The only other §O#9 input is the 4B's `safetyMarkers` array, i.e.
  // model luck. So this utterance flagged no marker, `routeSafety` returned
  // `undefined`, and this test — RUN FIRST, before any fix — rendered
  // BRISKET_PAIRINGS_RENDER verbatim: the customer asked which of these is
  // gluten-free and got the list.
  //
  // `pairing-resolver.ts` now carries its own `isAllergenFamilyAsk` guard (the
  // argument for putting it on the READ rather than on the PAIRING_Q SPAN is
  // written out there — suppressing the span would drop the turn to the prose
  // path, which is worse). The span still fires, §O#15 still accounts for the
  // question, both claims resolve UNKNOWN, and the render seam selects the
  // BKL-184 allergen variant: honest self-report plus a REAL staff handoff.
  it("a 'sem glúten' pairing ask renders NO suggestion", async () => {
    const response = await runPairingTurn(
      "o que combina com brisket que seja sem glúten?",
    );

    expect(response).not.toContain("costuma servir");
    expect(response).not.toContain("Mandioca Frita");
    expect(response).not.toBe(BRISKET_PAIRINGS_RENDER);
    // And it never asserts the dietary fact in the other direction either.
    expect(response).not.toMatch(/sem gl[úu]ten|n[ãa]o cont[ée]m/i);
    // What it DOES say: the ratified conservative copy, with the staff offer —
    // pinned so any future change to this routing is a visible copy decision.
    expect(response).toBe(ALLERGEN_ABSTAIN_RENDER);
    expect(response).toContain("atendente");
  });

  it("THE CONTROL: the same question WITHOUT the marker does render", async () => {
    expect(await runPairingTurn("o que combina com brisket?")).toBe(
      BRISKET_PAIRINGS_RENDER,
    );
  });
});
