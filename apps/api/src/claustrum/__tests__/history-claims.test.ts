/**
 * FE-D03 slice C — the ORDER_HISTORY / PAYMENT_HISTORY list-shaped claim types.
 * Clones the CART_CONTENTS test shape (cart-contents-claim.test.ts) EXACTLY — both
 * are owner-scoped by the authenticated customerId with a DETERMINISTICALLY
 * PRE-COMPOSED bounded most-recent-N summary scalar (historySummaryText). Covers:
 *
 *   1. Registry row shape + STEP 3 key-lockstep (recorded key == the REAL
 *      selectCandidateClaim parameterized key — the #277/BKL-006 discipline).
 *   2. Proposable/renderable subset membership.
 *   3. A customer WITH history VALIDATES + renders the pre-composed summary — driven
 *      through the REAL planner + the LINKED @adjudicate/core kernel.
 *   4. No history → SAFE_UNKNOWN (honest-abstain, never a fabricated summary).
 *   5. Recording states (present / absent / error) + the *_HISTORY_Q span gate + the
 *      guest fail-closed.
 *   6. The DETERMINISTIC composers (integer centavos + canonical labels; no
 *      model-authored digit or label).
 *
 * Pure unit tests — a hand-built ModelProvider mock + real EvidenceLedger; no DB.
 */

import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  runClaimsKernel,
  type CandidateClaim,
} from "@adjudicate/core";
import type {
  ClaimPlannerInput,
  CognitiveState,
  Completion,
  InvestigateInput,
  ModelProvider,
  Plan,
} from "@claustrum/core";
import { normalizeClaimPlannerResult } from "@claustrum/core";
import { ORDER_STATUS_LABELS_PT, PAYMENT_STATUS_LABELS_PT } from "@ibatexas/types";
import {
  CLAIM_REGISTRY,
  REGISTRY_SPECS,
  selectCandidateClaim,
} from "../claim-registry.js";
import { VALIDATED_TEMPLATES } from "../slot-grammar.js";
import { createIbatexasPlanner, PROPOSE_CLAIM_TOOL } from "../ibatexas-planner.js";
import { createIbatexasClaimPlanner } from "../ibatexas-claim-planner.js";
import {
  buildPerTurnOwnsFromLedger,
  createPerTurnClaimsKernelDeps,
} from "../ibatexas-claims-kernel-deps.js";
import { render } from "../renderer-from-claims.js";
import {
  createFirstPartyTurnReads,
  createIbatexasInvestigator,
} from "../ibatexas-investigator.js";
import {
  composeOrderHistorySummary,
  composePaymentHistorySummary,
  formatCentavosBRL,
  type TriadReadBackend,
} from "../turn-reads.js";

const NOW = 20_000;
const ORDER_HISTORY_SUMMARY = "Pedido #1042 (entregue, R$89,00) — mostrando o mais recente";
const PAYMENT_HISTORY_SUMMARY = "Pagamento de R$89,00 (pix, pago) — mostrando o mais recente";

function mockModel(toolCalls: Completion["toolCalls"]): ModelProvider {
  return {
    async complete(): Promise<Completion> {
      return { model: "mock", stopReason: "tool_use", text: "", toolCalls, inputTokens: 1, outputTokens: 1 };
    },
    stream() {
      throw new Error("not used");
    },
    async embed() {
      return [];
    },
  };
}

function state(text: string): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-07-18T00:00:00.000Z" },
    memory: {} as CognitiveState["memory"],
    retrieval: {} as CognitiveState["retrieval"],
    tenantId: "t1",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  };
}

function claimCall(input: unknown): NonNullable<Completion["toolCalls"]>[number] {
  return { id: "tc-1", name: PROPOSE_CLAIM_TOOL, input };
}

function planner(toolCalls: Completion["toolCalls"]) {
  return createIbatexasPlanner({ model: mockModel(toolCalls), modelId: "mock", capabilityPlanners: [] });
}

function stubBackend(over: Partial<TriadReadBackend> = {}): TriadReadBackend {
  return {
    readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
    readScheduleOverride: async () => null,
    readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
    readHoliday: async () => null,
    readHoursForDate: async () => ({ hoursText: "11h–15h / 18h–23h" }),
    readHolidayForDate: async () => null,
    readScheduleOverrideForDate: async () => null,
    readOrderFulfillment: async () => null,
    readPaymentStatus: async () => null,
    readReservation: async () => null,
    readPaymentRefund: async (orderId) => ({ orderId, refunded: false, refundedAmountCentavos: 0, status: "" }),
    readPaymentChargeback: async (orderId) => ({ orderId, disputed: false, status: "" }),
    readCartContents: async () => ({ itemsSummaryText: "", hasItems: false }),
    // Default: no history (inert). Tests override the relevant one.
    readOrderHistory: async () => ({ historySummaryText: "", hasHistory: false }),
    readPaymentHistory: async () => ({ historySummaryText: "", hasHistory: false }),
    listActiveOrderIds: async () => [],
    listActiveReservationIds: async () => [],
    countActivePayments: async () => 0,
    ...over,
  };
}

function investigateInput(ledger: EvidenceLedger, customerId: string, text: string): InvestigateInput {
  return { cognition: state(text), plan: { envelopes: [] } as Plan, customerId, channel: "web", ledger };
}

/** One table-driven description per history type — everything else is identical. */
const CASES = [
  {
    type: "PAYMENT_HISTORY" as const,
    key: "payment_history",
    falsifier: "payment_history_changed",
    utterance: "meu histórico de pagamentos",
    summary: PAYMENT_HISTORY_SUMMARY,
    field: "historySummaryText",
    renderPrefix: "Seu histórico de pagamentos: ",
    backend: (summary: string, has: boolean): Partial<TriadReadBackend> => ({
      readPaymentHistory: async () => ({ historySummaryText: summary, hasHistory: has }),
    }),
  },
  {
    type: "ORDER_HISTORY" as const,
    key: "order_history",
    falsifier: "order_history_changed",
    utterance: "meu histórico de pedidos",
    summary: ORDER_HISTORY_SUMMARY,
    field: "historySummaryText",
    renderPrefix: "Seu histórico de pedidos: ",
    backend: (summary: string, has: boolean): Partial<TriadReadBackend> => ({
      readOrderHistory: async () => ({ historySummaryText: summary, hasHistory: has }),
    }),
  },
];

for (const c of CASES) {
  describe(`FE-D03 slice C — ${c.type} registry + wiring`, () => {
    it("is a registered proposable type", () => {
      expect(CLAIM_REGISTRY).toContain(c.type);
    });

    it("declares the owner-scoped, must-read-this-turn read_claim shape", () => {
      const spec = REGISTRY_SPECS[c.type];
      expect(spec.kind).toBe("read_claim");
      expect(spec.customerScoped).toBe(true);
      expect(spec.perResourceKey).toBe(true);
      expect(spec.requiredEvidence[0]?.key).toBe(c.key);
      expect(spec.requiredEvidence[0]?.ownershipPolicy).toBe("required");
      expect(spec.requiredEvidence[0]?.freshnessPolicy).toBe("must_read_this_turn");
      expect(spec.falsifierComplete).toBe(true);
      expect(spec.falsifiers?.map((f) => f.key)).toEqual([c.falsifier]);
      expect(spec.valueBinding).toEqual({ key: c.key, path: ["historySummaryText"] });
      expect(spec.requiredEvidence.map((e) => e.key)).toContain(spec.valueBinding?.key);
    });

    it("KEY-LOCKSTEP: parameterizes evidence/falsifier/value-binding by the customerId subject", () => {
      const candidate = selectCandidateClaim({
        type: c.type,
        subject: "cust-42",
        actor: "cust-42",
        value: undefined,
      }) as CandidateClaim;
      expect(candidate.soundness.requiredEvidence[0]?.key).toBe(`${c.key}:cust-42`);
      expect(candidate.soundness.valueBinding?.key).toBe(`${c.key}:cust-42`);
      expect(candidate.soundness.falsifiers?.map((f) => f.key)).toEqual([`${c.falsifier}:cust-42`]);
    });

    it("has a validated template with ONE proposition slot bound to historySummaryText", () => {
      expect(Object.keys(VALIDATED_TEMPLATES)).toContain(c.type);
      const template = VALIDATED_TEMPLATES[c.type];
      expect(template?.posture).toBe("validated");
      const props = (template?.slots ?? []).filter((s) => s.kind === "PROPOSITION");
      expect(props).toHaveLength(1);
      expect(props[0]).toMatchObject({ claimType: c.type, field: "historySummaryText" });
    });

    it("end-to-end: a customer WITH history VALIDATES + renders the pre-composed summary", async () => {
      const CUSTOMER = `cust-${c.key}-a`;
      const backend = stubBackend(c.backend(c.summary, true));
      const ledger = new EvidenceLedger(`turn-${c.key}-a`);
      const investigator = createIbatexasInvestigator({
        gatherReads: createFirstPartyTurnReads(backend),
        now: () => NOW,
      });
      await investigator.investigate(investigateInput(ledger, CUSTOMER, c.utterance));
      const entry = ledger.resolve(`${c.key}:${CUSTOMER}`);
      expect(entry.state).toBe("present");
      expect(entry.entry?.value).toEqual({ historySummaryText: c.summary });

      const adapter = createIbatexasClaimPlanner(planner([claimCall({ type: c.type, subject: "" })]));
      const input: ClaimPlannerInput = {
        cognition: state(c.utterance),
        plan: { envelopes: [] } as Plan,
        customerId: CUSTOMER,
        ledger,
      };
      const { candidates, forcedTerminal } = normalizeClaimPlannerResult(await adapter.propose(input));
      expect(forcedTerminal).toBeUndefined();
      expect(candidates).toHaveLength(1);
      expect((candidates[0] as CandidateClaim).subject).toBe(CUSTOMER);

      const base = createPerTurnClaimsKernelDeps({
        now: NOW,
        ownership: { principal: CUSTOMER, ownedResources: new Set() },
        outcomes: [],
      });
      const deps = buildPerTurnOwnsFromLedger({ ledger, customerId: CUSTOMER, base });
      const result = runClaimsKernel(ledger, candidates, deps);
      expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
      expect(result.terminal).toBe("RENDER");
      expect(render(result.renderableCanonical, result.terminal).text).toBe(
        `${c.renderPrefix}${c.summary}.`,
      );
    });

    it("NON-VACUITY: NO history → key absent → honest SAFE_UNKNOWN (never a fabricated summary)", async () => {
      const CUSTOMER = `cust-${c.key}-b`;
      const backend = stubBackend(c.backend("", false));
      const ledger = new EvidenceLedger(`turn-${c.key}-b`);
      const investigator = createIbatexasInvestigator({
        gatherReads: createFirstPartyTurnReads(backend),
        now: () => NOW,
      });
      await investigator.investigate(investigateInput(ledger, CUSTOMER, c.utterance));
      expect(ledger.resolve(`${c.key}:${CUSTOMER}`).state).toBe("absent");

      const adapter = createIbatexasClaimPlanner(planner([claimCall({ type: c.type, subject: "" })]));
      const input: ClaimPlannerInput = {
        cognition: state(c.utterance),
        plan: { envelopes: [] } as Plan,
        customerId: CUSTOMER,
        ledger,
      };
      const { candidates } = normalizeClaimPlannerResult(await adapter.propose(input));
      const base = createPerTurnClaimsKernelDeps({
        now: NOW,
        ownership: { principal: CUSTOMER, ownedResources: new Set() },
        outcomes: [],
      });
      const deps = buildPerTurnOwnsFromLedger({ ledger, customerId: CUSTOMER, base });
      const result = runClaimsKernel(ledger, candidates, deps);
      expect(result.perClaim[0]?.verdict).toBe("UNKNOWN");
      expect(render(result.renderableCanonical, result.terminal).text).toBe(
        "Não localizei essa informação confirmada agora. Quer que eu verifique?",
      );
    });

    it("recording: a FAILED read records state error (Inv 7), never a value", async () => {
      const CUSTOMER = `cust-${c.key}-err`;
      const failing =
        c.type === "PAYMENT_HISTORY"
          ? { readPaymentHistory: async () => { throw new Error("db down"); } }
          : { readOrderHistory: async () => { throw new Error("db down"); } };
      const ledger = new EvidenceLedger("t");
      const investigator = createIbatexasInvestigator({
        gatherReads: createFirstPartyTurnReads(stubBackend(failing as Partial<TriadReadBackend>)),
        now: () => NOW,
      });
      await investigator.investigate(investigateInput(ledger, CUSTOMER, c.utterance));
      const entry = ledger.resolve(`${c.key}:${CUSTOMER}`);
      expect(entry.state).toBe("error");
      expect(entry.entry).toBeUndefined();
    });

    it("SPAN GATE: a non-history turn records NO history key", async () => {
      const CUSTOMER = `cust-${c.key}-gate`;
      const ledger = new EvidenceLedger("t");
      const investigator = createIbatexasInvestigator({
        gatherReads: createFirstPartyTurnReads(stubBackend(c.backend(c.summary, true))),
        now: () => NOW,
      });
      await investigator.investigate(investigateInput(ledger, CUSTOMER, "oi, bom dia"));
      expect(ledger.resolve(`${c.key}:${CUSTOMER}`).state).toBe("absent");
    });

    it("GUEST: a guest turn records NO history key (owner-scoped fail-closed)", async () => {
      const ledger = new EvidenceLedger("t");
      const investigator = createIbatexasInvestigator({
        gatherReads: createFirstPartyTurnReads(stubBackend(c.backend(c.summary, true))),
        now: () => NOW,
      });
      await investigator.investigate(investigateInput(ledger, "guest:abc", c.utterance));
      expect(ledger.resolve(`${c.key}:guest:abc`).state).toBe("absent");
    });
  });
}

// ── The DETERMINISTIC composers (integer centavos + canonical labels) ────────────

describe("FE-D03 slice C — deterministic history composers", () => {
  it("composeOrderHistorySummary: display numbers + integer-centavos + canonical labels, bounded", () => {
    const one = composeOrderHistorySummary([
      { displayId: 1042, fulfillmentStatus: "delivered", totalInCentavos: 8900 },
    ]);
    expect(one).toBe(`Pedido #1042 (${ORDER_STATUS_LABELS_PT.delivered}, R$89,00) — mostrando o mais recente`);
    const two = composeOrderHistorySummary([
      { displayId: 1042, fulfillmentStatus: "delivered", totalInCentavos: 8900 },
      { displayId: 1039, fulfillmentStatus: "preparing", totalInCentavos: 12300 },
    ]);
    expect(two).toBe(
      `Pedido #1042 (${ORDER_STATUS_LABELS_PT.delivered}, R$89,00), Pedido #1039 (${ORDER_STATUS_LABELS_PT.preparing}, R$123,00) — mostrando os 2 mais recentes`,
    );
  });

  it("composeOrderHistorySummary: caps at 5 (bounded most-recent-N)", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      displayId: 1000 + i,
      fulfillmentStatus: "delivered",
      totalInCentavos: 100,
    }));
    const out = composeOrderHistorySummary(rows);
    expect(out).toContain("mostrando os 5 mais recentes");
    expect(out.match(/Pedido #/g)).toHaveLength(5);
  });

  it("composePaymentHistorySummary: money + method + canonical status label", () => {
    const out = composePaymentHistorySummary([
      { amountInCentavos: 8900, method: "pix", status: "paid" },
    ]);
    expect(out).toBe(`Pagamento de R$89,00 (pix, ${PAYMENT_STATUS_LABELS_PT.paid}) — mostrando o mais recente`);
  });

  it("falls back to the raw status when a label is missing (never a fabricated label)", () => {
    expect(composeOrderHistorySummary([{ displayId: 1, fulfillmentStatus: "weird_status", totalInCentavos: 0 }])).toBe(
      "Pedido #1 (weird_status, R$0,00) — mostrando o mais recente",
    );
  });

  it("formatCentavosBRL is integer-only (the shared money composer)", () => {
    expect(formatCentavosBRL(12345)).toBe("R$123,45");
  });
});
