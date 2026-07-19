// cart-empty-claim.test.ts — BKL-163: the CART_EMPTY provably-empty cart claim.
//
// The presence-complement of CART_CONTENTS (cart-contents-claim.test.ts is the
// sibling suite): the investigator records `cart_empty:{customerId}` PRESENT ONLY
// when the owner-scoped cart read proved `hasItems: false`, so exactly one of the
// pair can validate in a turn and the empty cart now renders the friendly
// VALIDATED "vazio" template instead of the honest-UNKNOWN degrade (PR #291
// deviation (a)) — without weakening soundness:
//
//   1. Registry row shape (owner-scoped, must-read, per-resource, W6-complete).
//   2. Proposable AND renderable (validated template, C6-bound `emptinessText`).
//   3. Investigator recording states: PRESENT iff provably empty; ABSENT when the
//      cart has items; fail-closed ERROR when unavailable; span/guest gates hold.
//   4. End-to-end: EMPTY cart + both complements proposed → CART_EMPTY VALIDATED
//      render, CART_CONTENTS honest-UNKNOWN dropped (never a contradiction);
//      NON-EMPTY cart → CART_CONTENTS renders, CART_EMPTY drops.

import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "@adjudicate/core";
import { runClaimsKernel } from "@adjudicate/core";
import type {
  ClaimPlannerInput,
  CognitiveState,
  Completion,
  InvestigateInput,
  ModelProvider,
  Plan,
} from "@claustrum/core";
import { normalizeClaimPlannerResult } from "@claustrum/core";
import { CLAIM_REGISTRY, REGISTRY_SPECS } from "../claim-registry.js";
import { VALIDATED_TEMPLATES } from "../slot-grammar.js";
import { createIbatexasPlanner, PROPOSE_CLAIM_TOOL } from "../ibatexas-planner.js";
import { createIbatexasClaimPlanner } from "../ibatexas-claim-planner.js";
import {
  buildPerTurnOwnsFromLedger,
  createPerTurnClaimsKernelDeps,
  OWNER_SCOPED_KEY_PREFIXES,
} from "../ibatexas-claims-kernel-deps.js";
import { render } from "../renderer-from-claims.js";
import {
  createFirstPartyTurnReads,
  createIbatexasInvestigator,
} from "../ibatexas-investigator.js";
import type { TriadReadBackend } from "../turn-reads.js";

// ── Test doubles (the cart-contents-claim.test.ts harness, verbatim shape) ─────

const NOW = 20_000;
const CART_SUMMARY = "2x Costela, 1x Farofa — total R$123,00";
const EMPTY_RENDER =
  "Seu carrinho está vazio no momento — quer dar uma olhada no cardápio?";

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

function claimCall(
  input: unknown,
  id = "tc-1",
): NonNullable<Completion["toolCalls"]>[number] {
  return { id, name: PROPOSE_CLAIM_TOOL, input };
}

function planner(toolCalls: Completion["toolCalls"]) {
  return createIbatexasPlanner({
    model: mockModel(toolCalls),
    modelId: "mock",
    capabilityPlanners: [],
  });
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
    readPaymentRefund: async (orderId) => ({
      orderId,
      refunded: false,
      refundedAmountCentavos: 0,
      status: "",
    }),
    readPaymentChargeback: async (orderId) => ({ orderId, disputed: false, status: "" }),
    readCartContents: async () => ({ itemsSummaryText: "", hasItems: false }),
    readOrderHistory: async () => ({ historySummaryText: "", hasHistory: false }),
    readPaymentHistory: async () => ({ historySummaryText: "", hasHistory: false }),
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

/** Drive the REAL investigator → claim-planner adapter → kernel for one turn. */
async function driveTurn(args: {
  customerId: string;
  backend: TriadReadBackend;
  proposals: unknown[];
}) {
  const ledger = new EvidenceLedger(`turn-${args.customerId}`);
  const investigator = createIbatexasInvestigator({
    gatherReads: createFirstPartyTurnReads(args.backend),
    now: () => NOW,
  });
  await investigator.investigate(investigateInput(ledger, args.customerId));

  const adapter = createIbatexasClaimPlanner(
    planner(args.proposals.map((p, i) => claimCall(p, `tc-${i + 1}`))),
  );
  const input: ClaimPlannerInput = {
    cognition: state(),
    plan: { envelopes: [] } as Plan,
    customerId: args.customerId,
    ledger,
  };
  const { candidates } = normalizeClaimPlannerResult(await adapter.propose(input));

  const base = createPerTurnClaimsKernelDeps({
    now: NOW,
    ownership: { principal: args.customerId, ownedResources: new Set() },
    outcomes: [],
  });
  const deps = buildPerTurnOwnsFromLedger({
    ledger,
    customerId: args.customerId,
    base,
  });
  return { ledger, candidates, result: runClaimsKernel(ledger, candidates, deps) };
}

// ── (1) Registry row shape ─────────────────────────────────────────────────────

describe("BKL-163 — CART_EMPTY registry row", () => {
  it("is a registered proposable type", () => {
    expect(CLAIM_REGISTRY).toContain("CART_EMPTY");
  });

  it("declares the owner-scoped, must-read-this-turn read_claim shape (the CART_CONTENTS twin)", () => {
    const spec = REGISTRY_SPECS.CART_EMPTY;
    expect(spec.kind).toBe("read_claim");
    expect(spec.customerScoped).toBe(true);
    expect(spec.perResourceKey).toBe(true);
    const evidence = spec.requiredEvidence[0];
    expect(evidence?.key).toBe("cart_empty");
    expect(evidence?.ownershipPolicy).toBe("required");
    expect(evidence?.freshnessPolicy).toBe("must_read_this_turn");
  });

  it("declares honest falsifier-completeness with the deliberately-unread cart_item_added arm", () => {
    const spec = REGISTRY_SPECS.CART_EMPTY;
    expect(spec.falsifierComplete).toBe(true);
    expect(spec.falsifiers?.map((f) => f.key)).toEqual(["cart_item_added"]);
  });

  it("binds the rendered scalar to the read's code-composed `emptinessText` (C6)", () => {
    expect(REGISTRY_SPECS.CART_EMPTY.valueBinding).toEqual({
      key: "cart_empty",
      path: ["emptinessText"],
    });
  });

  it("`cart_empty:` is an owner-scoped key prefix (FIX 2 subject + owns attribution)", () => {
    expect(OWNER_SCOPED_KEY_PREFIXES).toContain("cart_empty:");
  });
});

// ── (2) Renderable ─────────────────────────────────────────────────────────────

describe("BKL-163 — CART_EMPTY is proposable AND renderable", () => {
  it("has a validated single-proposition template keyed to the type", () => {
    const template = VALIDATED_TEMPLATES.CART_EMPTY;
    expect(template?.claimType).toBe("CART_EMPTY");
    expect(template?.posture).toBe("validated");
    const props = template?.slots.filter((s) => s.kind === "PROPOSITION") ?? [];
    expect(props).toHaveLength(1);
  });
});

// ── (3) Investigator recording states ──────────────────────────────────────────

describe("BKL-163 — investigator cart_empty recording states", () => {
  it("records cart_empty:{customerId} PRESENT with the code-composed scalar when the cart is provably empty", async () => {
    const CUSTOMER = "cust-empty-a";
    const ledger = new EvidenceLedger("t-empty-a");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({
          readCartContents: async () => ({ itemsSummaryText: "", hasItems: false }),
        }),
      ),
      now: () => NOW,
    });
    await investigator.investigate(investigateInput(ledger, CUSTOMER));
    const entry = ledger.resolve(`cart_empty:${CUSTOMER}`);
    expect(entry.state).toBe("present");
    expect(entry.entry?.value).toEqual({ emptinessText: "vazio" });
    // The complement stays ABSENT — the pair is complementary by construction.
    expect(ledger.resolve(`cart_contents:${CUSTOMER}`).state).toBe("absent");
  });

  it("a cart WITH items leaves cart_empty ABSENT (the complement records instead)", async () => {
    const CUSTOMER = "cust-empty-b";
    const ledger = new EvidenceLedger("t-empty-b");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({
          readCartContents: async () => ({
            itemsSummaryText: CART_SUMMARY,
            hasItems: true,
          }),
        }),
      ),
      now: () => NOW,
    });
    await investigator.investigate(investigateInput(ledger, CUSTOMER));
    expect(ledger.resolve(`cart_empty:${CUSTOMER}`).state).toBe("absent");
    expect(ledger.resolve(`cart_contents:${CUSTOMER}`).state).toBe("present");
  });

  it("an UNAVAILABLE cart read records a fail-closed ERROR, never a value (Inv 7)", async () => {
    const CUSTOMER = "cust-empty-c";
    const ledger = new EvidenceLedger("t-empty-c");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({ readCartContents: async () => null }),
      ),
      now: () => NOW,
    });
    await investigator.investigate(investigateInput(ledger, CUSTOMER));
    expect(ledger.resolve(`cart_empty:${CUSTOMER}`).state).toBe("error");
  });

  it("a NON-cart turn records NO cart_empty key (the CART_CONTENTS_Q span gate)", async () => {
    const CUSTOMER = "cust-empty-d";
    const ledger = new EvidenceLedger("t-empty-d");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend()),
      now: () => NOW,
    });
    await investigator.investigate(
      investigateInput(ledger, CUSTOMER, "vocês estão abertos?"),
    );
    expect(ledger.resolve(`cart_empty:${CUSTOMER}`).state).toBe("absent");
  });

  it("a GUEST turn records NO cart_empty key (owner-scoped fail-closed → honest UNKNOWN)", async () => {
    const ledger = new EvidenceLedger("t-empty-e");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend()),
      now: () => NOW,
    });
    await investigator.investigate(investigateInput(ledger, "guest:abc"));
    expect(ledger.resolve("cart_empty:guest:abc").state).toBe("absent");
  });
});

// ── (4) End-to-end: the complementary pair ─────────────────────────────────────

describe("BKL-163 — end-to-end (investigator → planner → kernel → renderer)", () => {
  it("(a) an EMPTY cart, both complements proposed → CART_EMPTY VALIDATED render; CART_CONTENTS drops honestly", async () => {
    const CUSTOMER = "cust-e2e-empty";
    const { result } = await driveTurn({
      customerId: CUSTOMER,
      backend: stubBackend({
        readCartContents: async (_conv, customerId) =>
          customerId === CUSTOMER
            ? { itemsSummaryText: "", hasItems: false }
            : null,
      }),
      proposals: [
        { type: "CART_CONTENTS", subject: "" },
        { type: "CART_EMPTY", subject: "" },
      ],
    });

    const byType = new Map(result.perClaim.map((c) => [c.type, c.verdict]));
    expect(byType.get("CART_EMPTY")).toBe("VALIDATED");
    // The complement resolves honest UNKNOWN and is DROPPED by the kernel's §D
    // filter — never rendered, never a contradiction.
    expect(byType.get("CART_CONTENTS")).toBe("UNKNOWN");
    expect(result.terminal).toBe("RENDER");
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).toBe(EMPTY_RENDER);
  });

  it("(b) a NON-EMPTY cart, both complements proposed → CART_CONTENTS renders; CART_EMPTY drops honestly", async () => {
    const CUSTOMER = "cust-e2e-full";
    const { result } = await driveTurn({
      customerId: CUSTOMER,
      backend: stubBackend({
        readCartContents: async (_conv, customerId) =>
          customerId === CUSTOMER
            ? { itemsSummaryText: CART_SUMMARY, hasItems: true }
            : null,
      }),
      proposals: [
        { type: "CART_CONTENTS", subject: "" },
        { type: "CART_EMPTY", subject: "" },
      ],
    });

    const byType = new Map(result.perClaim.map((c) => [c.type, c.verdict]));
    expect(byType.get("CART_CONTENTS")).toBe("VALIDATED");
    expect(byType.get("CART_EMPTY")).toBe("UNKNOWN");
    expect(result.terminal).toBe("RENDER");
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).toBe(`No seu carrinho: ${CART_SUMMARY}.`);
  });

  it("(c) a GUEST with both proposed → neither validates → honest SAFE_UNKNOWN (fail-closed ownership)", async () => {
    const { result } = await driveTurn({
      customerId: "guest:abc",
      backend: stubBackend(),
      proposals: [
        { type: "CART_CONTENTS", subject: "" },
        { type: "CART_EMPTY", subject: "" },
      ],
    });
    expect(result.perClaim.every((c) => c.verdict !== "VALIDATED")).toBe(true);
    expect(result.terminal).toBe("UNKNOWN");
  });
});
