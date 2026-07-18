/**
 * BKL-139 / FE-D03 — the CART_CONTENTS claim type: registry row + validator +
 * template + honest-abstain, built over the session-scoped cart read. Mirrors the
 * FE-T17 RESERVATION_STATUS test shape (reservation-status-claim.test.ts) exactly,
 * with the ONE structural difference that the cart SUBJECT is the authenticated
 * customerId (the cart is 1-per-customer, resolved server-side from the session's
 * conversationId — never a model cart id), so FIX 2 resolves the subject from the
 * present `cart_contents:{customerId}` owner-scoped read.
 *
 *   1. Registry row shape + STEP 3 key-alignment (cart_contents / cart_cleared).
 *   2. Proposable/renderable subset membership.
 *   3. A non-empty owned cart VALIDATES + renders the pre-composed summary — driven
 *      through the REAL planner + the LINKED @adjudicate/core kernel, not a stub.
 *   4. Empty / no cart → SAFE_UNKNOWN (honest-abstain, never a fabricated summary).
 *   5. Investigator recording states (present / absent / error) + the span gate +
 *      the guest fail-closed.
 *   6. The DETERMINISTIC money composer (integer centavos; no model-authored digit).
 *
 * Pure unit tests — a hand-built ModelProvider mock + real EvidenceLedger; no DB /
 * no live model / no Medusa (the cart backend is stubbed).
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
import {
  CLAIM_REGISTRY,
  REGISTRY_SPECS,
  selectCandidateClaim,
} from "../claim-registry.js";
import { VALIDATED_TEMPLATES } from "../slot-grammar.js";
import {
  createIbatexasPlanner,
  PROPOSE_CLAIM_TOOL,
} from "../ibatexas-planner.js";
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
  composeCartItemsSummary,
  formatCentavosBRL,
  type TriadReadBackend,
} from "../turn-reads.js";

// ── Test doubles ──────────────────────────────────────────────────────────────

const NOW = 20_000;
const CART_SUMMARY = "2x Costela, 1x Farofa — total R$123,00";

function mockModel(toolCalls: Completion["toolCalls"]): ModelProvider {
  return {
    async complete(): Promise<Completion> {
      return {
        model: "mock",
        stopReason: "tool_use",
        text: "",
        toolCalls,
        inputTokens: 1,
        outputTokens: 1,
      };
    },
    stream() {
      throw new Error("not used");
    },
    async embed() {
      return [];
    },
  };
}

/** A cart-QUESTION cognition (so the investigator's CART_CONTENTS_Q span gate fires). */
function state(text = "o que tem no meu carrinho?"): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-07-17T00:00:00.000Z" },
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
  return createIbatexasPlanner({
    model: mockModel(toolCalls),
    modelId: "mock",
    capabilityPlanners: [],
  });
}

/** A full TriadReadBackend stub (no DB / no Medusa). Only the cart read varies per
 *  test; the rest are inert safe defaults (the schedule methods always run). */
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
    readPaymentRefund: async (orderId) => ({
      orderId,
      refunded: false,
      refundedAmountCentavos: 0,
      status: "",
    }),
    readPaymentChargeback: async (orderId) => ({ orderId, disputed: false, status: "" }),
    // Default: an empty cart (inert). Tests override this.
    readCartContents: async () => ({ itemsSummaryText: "", hasItems: false }),
    listActiveOrderIds: async () => [],
    listActiveReservationIds: async () => [],
    countActivePayments: async () => 0,
    ...over,
  };
}

function investigateInput(
  ledger: EvidenceLedger,
  customerId: string,
  text = "o que tem no meu carrinho?",
): InvestigateInput {
  return {
    cognition: state(text),
    plan: { envelopes: [] } as Plan,
    customerId,
    channel: "web",
    ledger,
  };
}

// ── (1) Registry row shape ──────────────────────────────────────────────────────

describe("BKL-139 — CART_CONTENTS registry row", () => {
  it("is a registered proposable type", () => {
    expect(CLAIM_REGISTRY).toContain("CART_CONTENTS");
  });

  it("declares the owner-scoped, must-read-this-turn read_claim shape", () => {
    const spec = REGISTRY_SPECS.CART_CONTENTS;
    expect(spec.kind).toBe("read_claim");
    expect(spec.customerScoped).toBe(true);
    expect(spec.perResourceKey).toBe(true);
    expect(spec.requiredEvidence).toHaveLength(1);
    expect(spec.requiredEvidence[0]?.key).toBe("cart_contents");
    expect(spec.requiredEvidence[0]?.ownershipPolicy).toBe("required");
    expect(spec.requiredEvidence[0]?.freshnessPolicy).toBe("must_read_this_turn");
  });

  it("declares honest falsifier-completeness (the W6 eligibility cap requirement)", () => {
    const spec = REGISTRY_SPECS.CART_CONTENTS;
    // Without falsifierComplete the kernel caps CART_CONTENTS to UNKNOWN-only forever;
    // the cart_cleared falsifier is declared (but deliberately UNREAD — see the
    // investigator + registry comment).
    expect(spec.falsifierComplete).toBe(true);
    expect(spec.falsifiers?.map((f) => f.key)).toEqual(["cart_cleared"]);
  });

  it("binds the rendered summary to the read's `itemsSummaryText` field (ledger-sourced)", () => {
    expect(REGISTRY_SPECS.CART_CONTENTS.valueBinding).toEqual({
      key: "cart_contents",
      path: ["itemsSummaryText"],
    });
    // valueBinding.key stays a member of requiredEvidence (the C6 structural guard).
    expect(
      REGISTRY_SPECS.CART_CONTENTS.requiredEvidence.map((e) => e.key),
    ).toContain(REGISTRY_SPECS.CART_CONTENTS.valueBinding?.key);
  });

  it("KEY-LOCKSTEP: parameterizes evidence/falsifier/value-binding by the customerId subject", () => {
    // The REAL production parameterization (selectCandidateClaim → parameterizeKeysBySubject).
    // A suffix mismatch on either side (registry base OR investigator key builder) would
    // leave the arm silently inert; the investigator records cart_contents:{customerId}.
    const candidate = selectCandidateClaim({
      type: "CART_CONTENTS",
      subject: "cust-42",
      actor: "cust-42",
      value: undefined,
    }) as CandidateClaim;
    expect(candidate.soundness.requiredEvidence[0]?.key).toBe("cart_contents:cust-42");
    expect(candidate.soundness.valueBinding?.key).toBe("cart_contents:cust-42");
    expect(candidate.soundness.falsifiers?.map((f) => f.key)).toEqual([
      "cart_cleared:cust-42",
    ]);
  });
});

// ── (2) Proposable / renderable subset membership ───────────────────────────────

describe("BKL-139 — CART_CONTENTS is proposable AND renderable", () => {
  it("has a validated template keyed to the type (renderable, no drift)", () => {
    expect(Object.keys(VALIDATED_TEMPLATES)).toContain("CART_CONTENTS");
    const template = VALIDATED_TEMPLATES.CART_CONTENTS;
    expect(template?.posture).toBe("validated");
    // ONE proposition slot bound 1:1 to the C6 field (Inv 6).
    const props = (template?.slots ?? []).filter((s) => s.kind === "PROPOSITION");
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ claimType: "CART_CONTENTS", field: "itemsSummaryText" });
  });
});

// ── (3) End-to-end: a non-empty owned cart VALIDATES + renders the summary ───────

describe("BKL-139 — end-to-end (investigator → planner → kernel → renderer)", () => {
  it("(a) an owned non-empty cart, model supplies NO subject → FIX 2 auto-binds customerId → VALIDATED render", async () => {
    const CUSTOMER = "cust-cart-a";
    const backend = stubBackend({
      readCartContents: async (_conversationId, customerId) =>
        customerId === CUSTOMER ? { itemsSummaryText: CART_SUMMARY, hasItems: true } : null,
    });

    // Step 1 — the REAL investigator records cart_contents:{customerId} (span-gated).
    const ledger = new EvidenceLedger("turn-cart-a");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(backend),
      now: () => NOW,
    });
    await investigator.investigate(investigateInput(ledger, CUSTOMER));
    const entry = ledger.resolve(`cart_contents:${CUSTOMER}`);
    expect(entry.state).toBe("present");
    expect(entry.entry?.value).toEqual({ itemsSummaryText: CART_SUMMARY });

    // Step 2 — the REAL claim-planner adapter. The model proposes CART_CONTENTS with an
    // EMPTY subject; FIX 2 resolves it from the present cart_contents read = customerId.
    const adapter = createIbatexasClaimPlanner(
      planner([claimCall({ type: "CART_CONTENTS", subject: "" })]),
    );
    const input: ClaimPlannerInput = {
      cognition: state(),
      plan: { envelopes: [] } as Plan,
      customerId: CUSTOMER,
      ledger,
    };
    const { candidates, forcedTerminal } = normalizeClaimPlannerResult(
      await adapter.propose(input),
    );
    expect(forcedTerminal).toBeUndefined();
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0] as CandidateClaim;
    expect(candidate.subject).toBe(CUSTOMER);
    expect(candidate.value).toMatchObject({ itemsSummaryText: CART_SUMMARY });

    // Step 3 — the REAL per-turn owns, derived from THIS ledger (not hand-built).
    const base = createPerTurnClaimsKernelDeps({
      now: NOW,
      ownership: { principal: CUSTOMER, ownedResources: new Set() },
      outcomes: [],
    });
    const deps = buildPerTurnOwnsFromLedger({ ledger, customerId: CUSTOMER, base });
    const result = runClaimsKernel(ledger, candidates, deps);

    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
    expect(result.terminal).toBe("RENDER");
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).toBe(`No seu carrinho: ${CART_SUMMARY}.`);
  });

  it("(b) an EMPTY cart → no cart_contents entry → honest SAFE_UNKNOWN (never a fabricated summary)", async () => {
    const CUSTOMER = "cust-cart-b";
    const backend = stubBackend({
      readCartContents: async () => ({ itemsSummaryText: "", hasItems: false }),
    });

    const ledger = new EvidenceLedger("turn-cart-b");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(backend),
      now: () => NOW,
    });
    await investigator.investigate(investigateInput(ledger, CUSTOMER));
    // hasItems:false → ABSENT_READ → the key is never recorded (never a fabricated summary).
    expect(ledger.resolve(`cart_contents:${CUSTOMER}`).state).toBe("absent");

    const adapter = createIbatexasClaimPlanner(
      planner([claimCall({ type: "CART_CONTENTS", subject: "" })]),
    );
    const input: ClaimPlannerInput = {
      cognition: state(),
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
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).toBe(
      "Não localizei essa informação confirmada agora. Quer que eu verifique?",
    );
  });
});

// ── (4) Investigator recording states + span gate + guest fail-closed ───────────

describe("BKL-139 — investigator cart recording states", () => {
  it("records cart_contents:{customerId} PRESENT with the pre-composed summary when the cart has items", async () => {
    const CUSTOMER = "cust-rec-1";
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({
          readCartContents: async () => ({ itemsSummaryText: CART_SUMMARY, hasItems: true }),
        }),
      ),
      now: () => NOW,
    });
    await investigator.investigate(investigateInput(ledger, CUSTOMER));

    const entry = ledger.resolve(`cart_contents:${CUSTOMER}`);
    expect(entry.state).toBe("present");
    expect(entry.entry?.taint).toBe("TRUSTED");
    expect(entry.entry?.originProvenance).toBe("FIRST_PARTY");
    expect(entry.entry?.value).toEqual({ itemsSummaryText: CART_SUMMARY });
    // The provable-empty marker rides along (observability parity).
    expect(ledger.resolve(`active_cart:${CUSTOMER}`).entry?.value).toEqual({ hasItems: true });
  });

  it("an UNAVAILABLE cart read (backend null) records a fail-closed ERROR, never a value (Inv 7)", async () => {
    const CUSTOMER = "cust-rec-2";
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({ readCartContents: async () => null }),
      ),
      now: () => NOW,
    });
    await investigator.investigate(investigateInput(ledger, CUSTOMER));

    const entry = ledger.resolve(`cart_contents:${CUSTOMER}`);
    expect(entry.state).toBe("error");
    expect(entry.entry).toBeUndefined();
  });

  it("a NON-cart turn records NO cart keys (the CART_CONTENTS_Q span gate)", async () => {
    const CUSTOMER = "cust-rec-3";
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({
          readCartContents: async () => ({ itemsSummaryText: CART_SUMMARY, hasItems: true }),
        }),
      ),
      now: () => NOW,
    });
    // A greeting — no cart word → the span gate keeps the cart read from running.
    await investigator.investigate(investigateInput(ledger, CUSTOMER, "oi, bom dia"));
    const cartKeys = [...ledger.keys()].filter(
      (k) => k.startsWith("cart_contents:") || k.startsWith("active_cart:"),
    );
    expect(cartKeys).toEqual([]);
  });

  it("a GUEST turn records NO cart keys (owner-scoped fail-closed → honest UNKNOWN)", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({
          readCartContents: async () => ({ itemsSummaryText: CART_SUMMARY, hasItems: true }),
        }),
      ),
      now: () => NOW,
    });
    await investigator.investigate(investigateInput(ledger, "guest:abc"));
    expect(ledger.resolve("cart_contents:guest:abc").state).toBe("absent");
    expect(ledger.resolve("active_cart:guest:abc").state).toBe("absent");
  });
});

// ── (5) The DETERMINISTIC money composer (no model-authored digit; Hard Rule 2) ─

describe("BKL-139 — deterministic cart-summary composer (integer centavos)", () => {
  it("formats integer centavos as pt-BR R$ (integer-only, no float money)", () => {
    expect(formatCentavosBRL(12300)).toBe("R$123,00");
    expect(formatCentavosBRL(12345)).toBe("R$123,45");
    expect(formatCentavosBRL(5)).toBe("R$0,05");
    expect(formatCentavosBRL(0)).toBe("R$0,00");
  });

  it("composes the item summary from first-party titles/quantities + the integer total", () => {
    const summary = composeCartItemsSummary(
      [
        { title: "Costela", quantity: 2 },
        { title: "Farofa", quantity: 1 },
      ],
      12300,
    );
    expect(summary).toBe("2x Costela, 1x Farofa — total R$123,00");
  });

  it("skips zero-quantity / untitled lines (never emits a malformed proposition)", () => {
    const summary = composeCartItemsSummary(
      [
        { title: "Costela", quantity: 2 },
        { title: "", quantity: 3 },
        { title: "Farofa", quantity: 0 },
      ],
      12300,
    );
    expect(summary).toBe("2x Costela — total R$123,00");
  });
});
