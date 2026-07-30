// bkl271-pulled-pork-read.e2e.test.ts — BKL-271 at the REAL customer turn seam.
//
// WHAT THIS PINS. A MENU read about `pulled pork` must reach the customer as a
// DETERMINISTIC render off a validated claim. The defect: MUTATION_EDIT_ROOTS
// carried a `p[õo]r` branch whose `(?<![a-z])` left guard is satisfied by the
// SPACE in "pulled pork" (and the hyphen in the `pulled-pork` handle), so the
// prefix "por" inside "pork" set `mutationImperative` on every such utterance.
// Every classify-only READ span is gated on `!mutationImperative`, so the turn
// lost ALL its spans and fell off the deterministic path entirely — for a core
// product of a BBQ restaurant.
//
// WHY AT THE SEAM, AND WHY WITH THE REAL RESPONDER. This is the BKL-273 /
// LE2-029 lesson: losing the SPAN is not fail-safe. With no span, §O#15 has
// nothing to complete, no claims render fires, and the REAL responder authors
// the answer in prose. The default INERT responder shows that as a harmless
// placeholder, so `realResponder: true` is load-bearing — and the scripted model
// is ARMED with a confident, unsourced pulled-pork sentence (`MODEL_PORK_PROSE`)
// that only the model path could produce. Every case asserts the reply is not it.
//
// DIRECTIONAL: restore the `p[õo]r` branch and both cases go red — the price and
// contents renders vanish and the armed prose takes the turn.
//
// The only fakes are the ModelProvider, the triad read backend, and the ONE
// catalog egress (`searchProducts`) the menu reads make. `resolveMenuItem` and
// `composeMenuPriceText` / `composeMenuContentsText` all run for real.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";

const { catalog } = vi.hoisted(() => ({
  catalog: {
    /** Keyed on the token the RAW utterance carries; the per-item read passes the
     *  whole utterance as its query. `pork` (not `pulled pork`) keeps the derived
     *  product id free of a space. */
    titles: {
      pork: "Pulled Pork",
      brisket: "Brisket Americano",
    } as Record<string, string>,
    queries: [] as string[],
  },
}));

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  // Prices/descriptions mirror the seeded record (apps/commerce/src/seed-data.ts)
  // so the rendered scalar is the one production would compose.
  const priced: Record<string, number> = { pork: 4800, brisket: 8900 };
  const described: Record<string, string> = {
    pork: "Paleta suína desfiada defumada por 10 horas. Servida com coleslaw da casa em cima para um contraste perfeito.",
    brisket: "Brisket Americano defumado 12h no carvalho.",
  };
  const product = (key: string, title: string) => ({
    id: `prod_${key}`,
    title,
    price: priced[key] ?? 8900,
    description: described[key] ?? `${title} defumado.`,
    categoryHandle: "carnes-defumadas",
    inStock: true,
    tags: ["popular"] as string[],
  });
  return {
    ...actual,
    searchProducts: vi.fn(async (input: { query?: string }) => {
      const q = (input.query ?? "").trim().toLowerCase();
      catalog.queries.push(q);
      if (q === "" || q === "*") {
        return { products: Object.entries(catalog.titles).map(([k, t]) => product(k, t)) };
      }
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
const { __resetMenuItemMemoForTest, __resetMenuOverviewMemoForTest } = await import(
  "../claustrum/menu-item-resolver.js"
);

/** What a real 4B does with a pulled-pork question once the turn leaves the
 *  deterministic path — armed here so its return is a test failure, not a silent
 *  regression. Names a price and a composition that NO read produced. */
const MODEL_PORK_PROSE =
  "O Pulled Pork sai por R$ 52,00 e vem com pão brioche, molho barbecue da casa " +
  "e batata rústica. É o carro-chefe, pode pedir sem medo!";

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
      // making the assertions pass for the wrong reason.
      return { ...base, text: MODEL_PORK_PROSE, toolCalls: [] };
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
    customerId: `cust-pork-${turnSeq}`,
    conversationId: `conv-pork-${turnSeq}`,
    text,
  });
  return out.response;
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  __resetMenuItemMemoForTest();
  __resetMenuOverviewMemoForTest();
  catalog.queries.length = 0;
});

describe("BKL-271 e2e — a pulled-pork READ reaches its deterministic read", () => {
  it("MENU_ITEM_PRICE — the price render names the product and the CATALOG price", async () => {
    const response = await runMenuTurn("quanto custa o pulled pork?", [
      { type: "MENU_ITEM_PRICE", subject: "prod_pork" },
    ]);

    expect(response).toContain("Pulled Pork");
    // R$ 48,00 is the seeded 4800 centavos. The armed prose says R$ 52,00 — a
    // number no read produced — so the two can never both be satisfied.
    expect(response).toContain("48,00");
    expect(response).not.toBe(MODEL_PORK_PROSE);
    expect(response).not.toContain("52,00");
    // …and the turn genuinely went to the catalog for it.
    expect(catalog.queries).toContain("quanto custa o pulled pork?");
  });

  it("MENU_ITEM_CONTENTS — the contents render names the first-party description", async () => {
    const response = await runMenuTurn("o que vem no pulled pork?", [
      { type: "MENU_ITEM_CONTENTS", subject: "prod_pork" },
    ]);

    expect(response).toContain("Pulled Pork");
    expect(response).toContain("Paleta suína desfiada");
    expect(response).not.toBe(MODEL_PORK_PROSE);
    // The model's invented composition never reaches the customer.
    expect(response).not.toMatch(/p[ãa]o brioche|batata r[úu]stica/i);
    expect(catalog.queries).toContain("o que vem no pulled pork?");
  });
});

// ── inv.18 v2 / R2-S2 — the same seam, asked of the GENERATED spec ─────────────────
//
// MENU_ITEM_PRICE's registry row is now compiled from `menu-item-price.claim.ts` through
// the repo-local `perResourceKey` widening (claimdefs/per-resource-claim.ts). The two
// cases above ALREADY prove the end-to-end chain and are the handleTurn-level proof this
// adoption inherits — they pass only if the generated spec's BARE `menu:item_price` is
// suffixed to `menu:item_price:{subject}` and resolves the investigator's real per-subject
// ledger entry. Lose the flag and there is nothing to see: the kernel resolves the bare
// key, the entry reads ABSENT, the claim degrades to an honest UNKNOWN and the armed prose
// takes the turn.
//
// This block adds what those two cannot say on their own: that the suffixing is
// SUBJECT-DISCRIMINATING rather than incidentally right for one product. Two distinct
// subjects are driven through the same conductor and each must come back with ITS OWN
// catalog price — a per-resource claim's whole reason for existing. A widening that
// emitted a pre-suffixed key, or dropped the flag so both subjects collapsed onto one bare
// key, cannot satisfy both cases.
describe("R2-S2 e2e — the GENERATED per-resource spec resolves PER-SUBJECT evidence", () => {
  it.each([
    ["quanto custa o pulled pork?", "prod_pork", "Pulled Pork", "48,00", "89,00"],
    ["quanto custa o brisket?", "prod_brisket", "Brisket Americano", "89,00", "48,00"],
  ] as const)(
    "%s → the subject's OWN price renders, never the sibling's",
    async (text, subject, title, ownPrice, siblingPrice) => {
      const response = await runMenuTurn(text, [
        { type: "MENU_ITEM_PRICE", subject },
      ]);

      expect(response).toContain(title);
      expect(response).toContain(ownPrice);
      // The discriminating half: the OTHER product's price is a real number this very
      // suite can produce, so a collapsed/unsuffixed key would surface it here.
      expect(response).not.toContain(siblingPrice);
      expect(response).not.toBe(MODEL_PORK_PROSE);
    },
  );
});
