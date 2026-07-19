// store-info-claim.test.ts — BKL-136: the STORE_INFO public address/parking claim.
//
//   1. Registry row shape (public single-key, cacheable, W6-complete with the
//      deliberately-unread `store:info_changed` arm, C6-bound `infoText`).
//   2. Proposable AND renderable (validated single-proposition template).
//   3. composeStoreInfoText — the deterministic pt-BR scalar composer (address
//      anchor; parking appended only when present; blank → undefined).
//   4. Resolver: per-turn memo + fail-closed-to-undefined on an unreadable store.
//   5. Investigator recording: span-gated PRESENT read; absent metadata → no key;
//      non-info turn → no key (the resolver seam is mocked — the ONE IO edge).
//
// The end-to-end VALIDATED render follows the MENU_OVERVIEW precedent
// (fixed-subject public read + bindValueFromLedger); the kernel mechanics are
// already exercised by menu-claims.test.ts / cart-empty-claim.test.ts, so the
// investigator-layer recording + registry/template pins are the load-bearing
// additions here.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceLedger } from "@adjudicate/core";
import type { CognitiveState, InvestigateInput, Plan } from "@claustrum/core";
import { CLAIM_REGISTRY, REGISTRY_SPECS } from "../claim-registry.js";
import { VALIDATED_TEMPLATES } from "../slot-grammar.js";
import { composeStoreInfoText } from "../store-info-resolver.js";
import {
  createFirstPartyTurnReads,
  createIbatexasInvestigator,
} from "../ibatexas-investigator.js";
import type { TriadReadBackend } from "../turn-reads.js";

// Mock ONLY the resolver seam the investigator/planner consume (the single IO
// edge — a Medusa admin read); everything else in the module stays real.
vi.mock("../store-info-resolver.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../store-info-resolver.js")>();
  return { ...orig, resolveStoreInfoText: vi.fn(async () => undefined as string | undefined) };
});
import { resolveStoreInfoText } from "../store-info-resolver.js";

const NOW = 20_000;
const INFO_TEXT =
  "Estamos em Rua Santa Cruz, 456 — Centro, Ibaté/SP. Temos estacionamento próprio gratuito ao lado do restaurante.";

function state(text: string): CognitiveState {
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

function stubBackend(): TriadReadBackend {
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
  };
}

function investigateInput(
  ledger: EvidenceLedger,
  text: string,
): InvestigateInput {
  return {
    cognition: state(text),
    plan: { envelopes: [] } as Plan,
    customerId: "guest:abc",
    channel: "web",
    ledger,
  };
}

beforeEach(() => {
  vi.mocked(resolveStoreInfoText).mockReset();
  vi.mocked(resolveStoreInfoText).mockResolvedValue(undefined);
});

// ── (1) Registry row shape ─────────────────────────────────────────────────────

describe("BKL-136 — STORE_INFO registry row", () => {
  it("is a registered proposable type", () => {
    expect(CLAIM_REGISTRY).toContain("STORE_INFO");
  });

  it("declares the PUBLIC fixed-key cacheable read_claim shape (the MENU_OVERVIEW twin)", () => {
    const spec = REGISTRY_SPECS.STORE_INFO;
    expect(spec.kind).toBe("read_claim");
    expect(spec.customerScoped).toBe(false);
    expect("perResourceKey" in spec).toBe(false);
    const evidence = spec.requiredEvidence[0];
    expect(evidence?.key).toBe("store:info");
    expect(evidence?.ownershipPolicy).toBe("not_applicable");
    expect(evidence?.freshnessPolicy).toEqual({ kind: "cacheable", ttl: 300_000 });
  });

  it("declares honest falsifier-completeness with the deliberately-unread store:info_changed arm", () => {
    const spec = REGISTRY_SPECS.STORE_INFO;
    expect(spec.falsifierComplete).toBe(true);
    expect(spec.falsifiers?.map((f) => f.key)).toEqual(["store:info_changed"]);
  });

  it("binds the rendered scalar to the read's `infoText` (C6)", () => {
    expect(REGISTRY_SPECS.STORE_INFO.valueBinding).toEqual({
      key: "store:info",
      path: ["infoText"],
    });
  });
});

// ── (2) Renderable ─────────────────────────────────────────────────────────────

describe("BKL-136 — STORE_INFO is proposable AND renderable", () => {
  it("has a validated single-proposition template keyed to the type", () => {
    const template = VALIDATED_TEMPLATES.STORE_INFO;
    expect(template?.claimType).toBe("STORE_INFO");
    expect(template?.posture).toBe("validated");
    const props = template?.slots.filter((s) => s.kind === "PROPOSITION") ?? [];
    expect(props).toHaveLength(1);
  });
});

// ── (3) The deterministic composer ─────────────────────────────────────────────

describe("BKL-136 — composeStoreInfoText (deterministic pt-BR scalar)", () => {
  it("composes address + parking into one complete sentence pair", () => {
    expect(
      composeStoreInfoText({
        address: "Rua Santa Cruz, 456 — Centro, Ibaté/SP",
        parking: "Temos estacionamento próprio gratuito ao lado do restaurante",
      }),
    ).toBe(INFO_TEXT);
  });

  it("address alone → address sentence only", () => {
    expect(composeStoreInfoText({ address: "Rua A, 1 — Ibaté/SP" })).toBe(
      "Estamos em Rua A, 1 — Ibaté/SP.",
    );
  });

  it("does not double the final period when parking already carries one", () => {
    expect(
      composeStoreInfoText({ address: "Rua A, 1", parking: "Estacionamento na lateral." }),
    ).toBe("Estamos em Rua A, 1. Estacionamento na lateral.");
  });

  it("blank/absent/non-string address → undefined (an address-less answer is a non-answer)", () => {
    expect(composeStoreInfoText({})).toBeUndefined();
    expect(composeStoreInfoText({ address: "   " })).toBeUndefined();
    expect(composeStoreInfoText({ address: 42, parking: "x" })).toBeUndefined();
    expect(composeStoreInfoText({ parking: "Estacionamento próprio" })).toBeUndefined();
  });
});

// ── (4/5) Investigator recording (the mocked resolver seam) ────────────────────

describe("BKL-136 — investigator store:info recording states", () => {
  it("records store:info PRESENT with the resolved scalar on a STORE_INFO_Q turn (guests included)", async () => {
    vi.mocked(resolveStoreInfoText).mockResolvedValue(INFO_TEXT);
    const ledger = new EvidenceLedger("t-info-a");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend()),
      now: () => NOW,
    });
    await investigator.investigate(
      investigateInput(ledger, "onde fica o restaurante?"),
    );
    const entry = ledger.resolve("store:info");
    expect(entry.state).toBe("present");
    expect(entry.entry?.value).toEqual({ infoText: INFO_TEXT });
    // The SHARED per-turn resolver was consulted with THIS turn's id (byte-equal C6).
    expect(vi.mocked(resolveStoreInfoText)).toHaveBeenCalledWith("turn-1");
  });

  it("absent/blank store metadata (resolver undefined) → NO key → honest UNKNOWN", async () => {
    vi.mocked(resolveStoreInfoText).mockResolvedValue(undefined);
    const ledger = new EvidenceLedger("t-info-b");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend()),
      now: () => NOW,
    });
    await investigator.investigate(investigateInput(ledger, "qual o endereço?"));
    expect(ledger.resolve("store:info").state).toBe("absent");
  });

  it("a NON-info turn never consults the resolver and records NO key (the span gate)", async () => {
    const ledger = new EvidenceLedger("t-info-c");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend()),
      now: () => NOW,
    });
    await investigator.investigate(investigateInput(ledger, "vocês estão abertos?"));
    expect(ledger.resolve("store:info").state).toBe("absent");
    expect(vi.mocked(resolveStoreInfoText)).not.toHaveBeenCalled();
  });
});
