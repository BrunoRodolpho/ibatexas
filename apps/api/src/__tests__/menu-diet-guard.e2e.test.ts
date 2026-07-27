// menu-diet-guard.e2e.test.ts — BKL-273 at the REAL customer turn seam.
//
// WHAT THIS PINS. A dietary- or allergen-marked MENU question must reach the
// customer as the ratified BKL-184 abstain + staff handoff, rendered
// DETERMINISTICALLY, for all three families whose span-suppression this ticket
// removed: MENU_ITEM_CONTENTS, MENU_OVERVIEW and MENU_DIETARY. MENU_PAIRINGS
// rides along as the already-correct control (LE2-029's read guard).
//
// WHY AT THE SEAM, AND WHY WITH THE REAL RESPONDER. The defect BKL-273 fixes was
// invisible to every renderer- and resolver-level test that existed. Suppressing
// the SPAN left the turn with no read at all, so §O#15 had nothing to complete,
// no claims render fired, and the REAL responder authored the dietary answer in
// prose. A harness with the default INERT responder shows that as a harmless
// placeholder; only `realResponder: true` shows what the customer hears. So the
// scripted model here is armed with a confident, unsourced dietary sentence
// (`MODEL_DIET_PROSE`) and every case asserts the reply is NOT it.
//
// That makes the suite directional against the exact regression: restore any of
// the three `!ALLERGEN_FAMILY_RE` span conditions, or drop a read guard, and the
// turn falls to the model and these tests go red on the prose.
//
// The only fakes are the ModelProvider, the triad read backend, and the ONE
// catalog egress (`searchProducts`) the menu reads make.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";

const { catalog } = vi.hoisted(() => ({
  catalog: {
    /** Single-word handles; the per-item read passes the RAW utterance as its query. */
    titles: {
      brisket: "Brisket Americano",
      brownie: "Brownie com Sorvete",
      costela: "Costela Bovina Defumada",
      mandioca: "Mandioca Frita",
      limonada: "Limonada Suíça",
    } as Record<string, string>,
    queries: [] as string[],
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
  return {
    ...actual,
    searchProducts: vi.fn(async (input: { query?: string }) => {
      const q = (input.query ?? "").trim().toLowerCase();
      catalog.queries.push(q);
      if (q === "" || q === "*") {
        return { products: Object.entries(catalog.titles).map(([k, t]) => product(k, t)) };
      }
      // Exact handle first (the pairing read queries a de-kebabed handle), then a
      // substring match for the raw-utterance queries the per-item read makes.
      const exact = catalog.titles[q];
      if (exact !== undefined) return { products: [product(q, exact)] };
      for (const [key, title] of Object.entries(catalog.titles)) {
        if (q.includes(key)) return { products: [product(key, title)] };
      }
      return { products: [] };
    }),
  };
});

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
      readReservation: notUsed("readReservation"),
      readPaymentRefund: notUsed("readPaymentRefund"),
      readPaymentChargeback: notUsed("readPaymentChargeback"),
      readCartContents: notUsed("readCartContents"),
      readOrderHistory: notUsed("readOrderHistory"),
      readPaymentHistory: notUsed("readPaymentHistory"),
      // Someone asking a menu question owns nothing relevant; present-with-0 keeps
      // §O#15 from force-requiring an order companion.
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
const {
  __resetMenuItemMemoForTest,
  __resetMenuOverviewMemoForTest,
  __resetMenuDietaryMemoForTest,
} = await import("../claustrum/menu-item-resolver.js");
const { clearPairingMemoForTests } = await import("../claustrum/pairing-resolver.js");

/** The BKL-184 / BKL-143 abstain: honest self-report plus a REAL staff handoff —
 *  the ratified conservative copy for anything carrying an allergen/dietary marker.
 *  Byte-pinned so any future change to this routing is a visible copy decision. */
const ALLERGEN_ABSTAIN_RENDER =
  "Não localizei essa informação de alérgenos confirmada agora — por segurança, " +
  "prefiro não arriscar uma resposta. Quer que eu peça para um atendente " +
  "confirmar com a cozinha?";

/** What a real 4B does with a dietary question once the turn leaves the
 *  deterministic path — the pre-BKL-273 behaviour, armed here so its return is a
 *  test failure and not a silent regression. */
const MODEL_DIET_PROSE =
  "Sim! Nosso Brisket Americano é preparado sem glúten e o Brownie com Sorvete " +
  "tem versão sem lactose. Pode pedir tranquilo.";

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
      // Non-empty on purpose: an empty completion trips the planner's
      // extraction-failure REFUSE and would short-circuit before the claims render,
      // making every assertion below pass for the wrong reason.
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

let turnSeq = 0;

async function runMenuTurn(
  text: string,
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>,
): Promise<string> {
  turnSeq += 1;
  const harness = composeCustomerConductor({
    model: scriptedModel(claims),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
    // Production's responder — without it the prose regression is invisible.
    realResponder: true,
    scheduleSignal: { isClosed: false, mealPeriod: "dinner" } as never,
  });
  const out = await runCustomerTurn(harness, {
    customerId: `cust-diet-${turnSeq}`,
    conversationId: `conv-diet-${turnSeq}`,
    text,
  });
  return out.response;
}

/** Every abstain case asserts the SAME three things, so a family that starts
 *  answering — in template OR in prose — cannot pass. */
function expectAbstain(response: string): void {
  expect(response).toBe(ALLERGEN_ABSTAIN_RENDER);
  // The model's dietary sentence never reaches the customer.
  expect(response).not.toBe(MODEL_DIET_PROSE);
  // …and the reply asserts the dietary fact in NEITHER direction.
  expect(response).not.toMatch(/sem gl[úu]ten|sem lactose|n[ãa]o cont[ée]m/i);
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  __resetMenuItemMemoForTest();
  __resetMenuOverviewMemoForTest();
  __resetMenuDietaryMemoForTest();
  clearPairingMemoForTests();
  catalog.queries.length = 0;
});

// ── MENU_ITEM_CONTENTS ───────────────────────────────────────────────────────

describe("BKL-273 e2e — MENU_ITEM_CONTENTS", () => {
  const CLAIMS = [{ type: "MENU_ITEM_CONTENTS", subject: "prod_brisket" }] as const;

  it("a 'sem glúten' contents ask renders the abstain, not model prose", async () => {
    expectAbstain(await runMenuTurn("o que vem no brisket sem glúten?", [...CLAIMS]));
  });

  it("an 'alérgico a amendoim' contents ask renders the abstain", async () => {
    expectAbstain(
      await runMenuTurn("sou alérgico a amendoim, o que vem no brisket?", [...CLAIMS]),
    );
  });

  it("THE CONTROL: the same question WITHOUT the marker renders the first-party contents", async () => {
    const response = await runMenuTurn("o que vem no brisket?", [...CLAIMS]);
    expect(response).toContain("Brisket Americano");
    expect(response).toContain("defumado 12h no carvalho");
    expect(response).not.toBe(ALLERGEN_ABSTAIN_RENDER);
    expect(response).not.toBe(MODEL_DIET_PROSE);
  });
});

// ── MENU_OVERVIEW ────────────────────────────────────────────────────────────

describe("BKL-273 e2e — MENU_OVERVIEW", () => {
  const CLAIMS = [{ type: "MENU_OVERVIEW", subject: "" }] as const;

  it("a 'sem lactose' menu ask renders the abstain, not model prose", async () => {
    expectAbstain(await runMenuTurn("o que tem no cardápio sem lactose?", [...CLAIMS]));
  });

  it("a 'não contém leite' menu ask renders the abstain", async () => {
    expectAbstain(
      await runMenuTurn("o que tem no cardápio que não contém leite?", [...CLAIMS]),
    );
  });

  it("THE CONTROL: the unmarked menu ask still lists the catalog", async () => {
    const response = await runMenuTurn("o que tem no cardápio?", [...CLAIMS]);
    expect(response).toContain("No nosso cardápio:");
    expect(response).toContain("Brisket Americano");
    expect(response).not.toBe(ALLERGEN_ABSTAIN_RENDER);
    expect(response).not.toBe(MODEL_DIET_PROSE);
  });
});

// ── MENU_DIETARY ─────────────────────────────────────────────────────────────

describe("BKL-273 e2e — MENU_DIETARY", () => {
  const CLAIMS = [{ type: "MENU_DIETARY", subject: "vegetariano" }] as const;

  it("a MIXED vegetarian+'sem glúten' ask renders the abstain, not half an answer", async () => {
    // The sharp case: answering the vegetarian half alone would pass a partial
    // answer off as a whole one on exactly the turn whose unanswered half is medical.
    const response = await runMenuTurn("tem opção vegetariana sem glúten?", [...CLAIMS]);
    expectAbstain(response);
    expect(response).not.toContain("Temos estas opções vegetarianas");
  });

  it("an 'alérgico a amendoim' dietary ask renders the abstain", async () => {
    expectAbstain(
      await runMenuTurn("sou alérgico a amendoim, tem opção vegetariana?", [...CLAIMS]),
    );
  });

  it("THE CONTROL: the unmarked dietary ask still lists the tagged options", async () => {
    const response = await runMenuTurn("tem opção vegetariana?", [...CLAIMS]);
    expect(response).toContain("Temos estas opções vegetarianas");
    expect(response).not.toBe(ALLERGEN_ABSTAIN_RENDER);
    expect(response).not.toBe(MODEL_DIET_PROSE);
  });
});

// ── MENU_PAIRINGS — the already-correct control (LE2-029) ────────────────────

describe("BKL-273 e2e — MENU_PAIRINGS stays gated (the LE2-029 read guard)", () => {
  const CLAIMS = [
    { type: "MENU_PAIRINGS", subject: "" },
    { type: "MENU_SUBSTITUTIONS", subject: "" },
  ] as const;

  it("a 'sem glúten' pairing ask renders the abstain", async () => {
    expectAbstain(
      await runMenuTurn("o que combina com brisket que seja sem glúten?", [...CLAIMS]),
    );
  });

  it("THE CONTROL: the unmarked pairing ask still suggests", async () => {
    const response = await runMenuTurn("o que combina com brisket?", [...CLAIMS]);
    expect(response).toContain("costuma servir");
    expect(response).not.toBe(ALLERGEN_ABSTAIN_RENDER);
    expect(response).not.toBe(MODEL_DIET_PROSE);
  });
});
