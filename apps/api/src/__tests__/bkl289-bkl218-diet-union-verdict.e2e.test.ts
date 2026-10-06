// BKL-289 / BKL-218 — the DIET-family verdict on the never-omit-required union,
// plus the BKL-270 posture regression guard, at the REAL customer turn seam.
//
// TWO QUESTIONS THIS FILE ANSWERS, BY MEASUREMENT RATHER THAN ARGUMENT:
//
//  1. BKL-270 (must NOT regress). A diet-qualified variant must still ABSTAIN per
//     its declared `dietaryPosture`. The union adds candidates, so it could in
//     principle re-open a read the BKL-270 read-push suppression closed. It cannot,
//     and the reason is STRUCTURAL rather than incidental: the union's only subject
//     source for a public per-item type is `presentPublicItemIds` over THIS turn's
//     ledger, and the suppression (ibatexas-investigator.ts:1202-1204) removes those
//     very reads BEFORE the ledger is settled. No ledger entry ⇒ no deterministic
//     subject ⇒ the union declines. The suppression is strictly upstream of it.
//
//  2. BKL-218 (expected side benefit — VERIFIED, NOT ASSUMED). The BKL-184
//     abstain+offer copy lives on the claims-kernel render path. BKL-289's RCA
//     hypothesised the union might make the required diet read reachable and so fix
//     BKL-218's symptom. The measurement below shows WHERE that holds and where it
//     does not, so the boundary is recorded rather than guessed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";
import {
  classifyRequestSpans,
  decomposeRequiredClaims,
  isAllergenFamilyAsk,
} from "../claustrum/required-claim-decomposer.js";

const { catalog } = vi.hoisted(() => ({
  catalog: {
    titles: {
      brownie: "Brownie com Sorvete",
      brisket: "Brisket Americano",
    } as Record<string, string>,
  },
}));

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  const product = (key: string, title: string) => ({
    id: `prod_${key}`,
    title,
    price: 8900,
    description: `${title} feito na casa.`,
    categoryHandle: "carnes",
    inStock: true,
    tags: ["vegetariano"] as string[],
  });
  return {
    ...actual,
    searchProducts: vi.fn(async (input: { query?: string }) => {
      const q = (input.query ?? "").trim().toLowerCase();
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

// ── R5-S10 / F-18 — this backend is AMBIENT here, by declared design ──────────
// Every assertion in this file is read-INDEPENDENT of the triad backend. The
// subjects are the span net (`classifyRequestSpans` / `decomposeRequiredClaims`,
// called directly), the BKL-184 abstain copy, and first-party menu contents that
// come from the `searchProducts` mock above — never from a read below.
//
// Wholesale-neutering this backend (every read throws) leaves all 4 tests green.
// That is MEASURED and EXPECTED, not a coverage gap: the seed's only role is
// keeping turns on the RESOLVE path. The hours/schedule reads and the three
// §O#15 companion signals run on essentially every turn, and letting them fail
// closed would degrade turns out from under the diet verdict this file exists to
// measure. Deleting the seed is therefore NOT free, and it stays.
//
// The read-DERIVED coverage of this double lives in the suites whose subject IS
// its content — customer-hours-claims / r2s8-hours-for-date-claims /
// ops-hours-read / ops-store-open-claims — which fail hard under the same
// neutering. A read-driven assertion belongs there, not bolted onto a diet suite.
//
// The declared set is exactly the reads these turns actually reach (measured):
// the `*ForDate` trio is never invoked here, so it is not declared.
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

/** The BKL-184 abstain + staff handoff — the copy BKL-218 reports as not firing. */
const ALLERGEN_ABSTAIN_RENDER =
  "Não localizei essa informação de alérgenos confirmada agora — por segurança, " +
  "prefiro não arriscar uma resposta. Quer que eu peça para um atendente " +
  "confirmar com a cozinha?";

/** What a real 4B does once the turn leaves the deterministic path. Armed so a
 *  regression to model prose is a failure, never a silent pass. */
const MODEL_DIET_PROSE =
  "Sim! O Brownie com Sorvete não leva amendoim, pode pedir tranquilo.";

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
async function runTurn(
  text: string,
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>,
): Promise<string> {
  turnSeq += 1;
  const harness = composeCustomerConductor({
    model: scriptedModel(claims),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
    // Production's responder — without it a prose regression is invisible.
    realResponder: true,
    scheduleSignal: { isClosed: false, mealPeriod: "dinner" } as never,
  });
  const out = await runCustomerTurn(harness, {
    customerId: `cust-b289diet-${turnSeq}`,
    conversationId: `conv-b289diet-${turnSeq}`,
    text,
  });
  return out.response;
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  __resetMenuItemMemoForTest();
  __resetMenuOverviewMemoForTest();
  __resetMenuDietaryMemoForTest();
});

describe("BKL-270 — the union does NOT defeat the dietaryPosture read-push abstain", () => {
  // The posture guard the BKL-289 brief requires: a diet-qualified variant must
  // still abstain per its declared posture. If the union could invent a subject for
  // a read the BKL-270 push suppressed, this would turn into an answer (or model
  // prose) — both are failures here. It cannot: the union's ONLY subject source for
  // a public per-item type is `presentPublicItemIds` over this turn's ledger, and
  // the suppression removes those reads before the ledger settles.
  it("a diet-qualified contents ask still ABSTAINS per its declared posture", async () => {
    const response = await runTurn("o que vem no brisket sem glúten?", [
      { type: "MENU_ITEM_CONTENTS", subject: "prod_brisket" },
    ]);

    expect(response).toBe(ALLERGEN_ABSTAIN_RENDER);
    expect(response).not.toBe(MODEL_DIET_PROSE);
    // The reply asserts the dietary fact in NEITHER direction.
    expect(response).not.toMatch(/sem gl[úu]ten|sem lactose|n[ãa]o cont[ée]m/i);
  });

  // The non-vacuity control: the SAME machinery, marker removed, still answers. If
  // the union had broken the menu read outright, this would go red too and the
  // abstain above would be passing for the wrong reason.
  it("THE CONTROL: the same ask WITHOUT the marker still renders first-party contents", async () => {
    const response = await runTurn("o que vem no brisket?", [
      { type: "MENU_ITEM_CONTENTS", subject: "prod_brisket" },
    ]);

    expect(response).toContain("Brisket Americano");
    expect(response).not.toBe(ALLERGEN_ABSTAIN_RENDER);
    expect(response).not.toBe(MODEL_DIET_PROSE);
  });
});

// ── BKL-218 VERDICT: the union CANNOT reach it, and the reason is upstream ────
//
// The BKL-289 brief asked whether the union makes BKL-218's unreachable abstain+offer
// copy reachable. MEASURED ANSWER: NO — and not because of any gate this ticket
// chose. BKL-218's literal utterance classifies to ZERO spans, so the §O#15 required
// set is EMPTY. The union adds REQUIRED types only; an empty required set gives it
// nothing to add, no matter what the model proposes. The blocker sits one layer
// upstream of the union, in the span net (BKL-205/221/222 territory) — not in
// proposal completeness, which is all BKL-289 governs.
describe("BKL-218 — the union cannot reach it: the required set is EMPTY", () => {
  it("MECHANISM: 'tem amendoim no brownie?' fires NO span ⇒ nothing is required", () => {
    const spans = classifyRequestSpans("tem amendoim no brownie?");

    // No span ⇒ no closure row ⇒ nothing for the union (or §O#15) to demand.
    expect(spans).toEqual([]);
    expect([...decomposeRequiredClaims(spans)]).toEqual([]);

    // NON-VACUITY — the diet/allergen nets DO match this sentence. They gate read
    // SUPPRESSION and COPY SELECTION, not span creation, so a recognised allergen
    // marker still yields no claim to make. That asymmetry is precisely BKL-218.
    expect(isAllergenFamilyAsk("tem amendoim no brownie?")).toBe(true);

    // THE CONTROL: add an explicit menu-contents span and the same allergen marker
    // now DOES produce a required claim — proving the gap is the span, not the
    // marker, and pinning the shape a future BKL-218 fix has to produce.
    const withSpan = classifyRequestSpans("o que vem no brownie com amendoim?");
    expect(withSpan).toContain("MENU_ITEM_CONTENTS_Q");
    expect([...decomposeRequiredClaims(withSpan)]).toContain("MENU_ITEM_CONTENTS");
  });

  // The end-to-end consequence, pinned so a future span-net fix flips it visibly:
  // with nothing required, the turn never reaches the claims-kernel render path
  // where the BKL-184 abstain+offer copy lives — exactly BKL-218's report.
  it("CONSEQUENCE: the turn does not reach the BKL-184 abstain+offer copy", async () => {
    const response = await runTurn("tem amendoim no brownie?", [
      { type: "MENU_ITEM_CONTENTS", subject: "prod_brownie" },
    ]);

    expect(response).not.toBe(ALLERGEN_ABSTAIN_RENDER);
  });
});
