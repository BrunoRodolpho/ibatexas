/**
 * B-PR1 — the ibatexas INVESTIGATE stage host (`ibatexas-investigator.ts`).
 * Implements the published `@claustrum/core` `InvestigatorPort`: it WRITES this
 * turn's resolved reads into the per-turn Evidence Ledger.
 *
 * These tests pin the LOAD-BEARING contract:
 *
 *   - Inv 7 (error ≠ absence; fail CLOSED): a read that ERRORS is recorded via
 *     `ledger.recordError` — a DISTINCT ledger `state: "error"`, NOT a silent
 *     omission (which resolves `state: "absent"`). NON-VACUOUS: the same snapshot
 *     carries a `present` read, an `error` read, AND an `absent` (never-recorded)
 *     key — and all three resolve to DIFFERENT states.
 *   - Origin labelling at mint: a first-party DB read → `"TRUSTED"`, a free-text
 *     read → `"UNTRUSTED_DATA"` (the published 2-value `LedgerTaint`; the 3-value
 *     FIRST_PARTY is PENDING the published R1 kernel — see the module TODO).
 *   - The investigator owns the clock: `fetchedAt` is stamped from the injected
 *     `now()` (the ledger is clockless).
 *
 * Pure unit tests — a real `EvidenceLedger` + hand-built inputs; no DB / model.
 */

import { describe, expect, it } from "vitest";
import { EvidenceLedger, runClaimsKernel } from "@adjudicate/core";
import type { CognitiveState, Plan } from "@claustrum/core";
import type { InvestigateInput } from "@claustrum/core";
import {
  createFirstPartyTurnReads,
  createIbatexasInvestigator,
  defaultTurnReads,
  type TurnRead,
} from "../ibatexas-investigator.js";
import { selectCandidateClaim } from "../claim-registry.js";
import { createPerTurnClaimsKernelDeps } from "../ibatexas-claims-kernel-deps.js";
import type { TriadReadBackend } from "../turn-reads.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function cognition(): CognitiveState {
  return {
    perception: { text: "oi", channel: "web", receivedAt: "2026-06-26T00:00:00.000Z" },
    memory: {} as CognitiveState["memory"],
    retrieval: {} as CognitiveState["retrieval"],
    tenantId: "t1",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  };
}

function input(reads: ReadonlyArray<TurnRead>, ledger: EvidenceLedger): InvestigateInput {
  return {
    cognition: cognition(),
    plan: { envelopes: [] } satisfies Plan,
    customerId: "cust-1",
    channel: "web",
    ledger,
  };
}

// ── Inv 7 — error ≠ absence (fail CLOSED) ────────────────────────────────────

describe("ibatexas-investigator — Inv 7 (read error ≠ absence)", () => {
  it("records a FAILED read via recordError (state error), distinct from absence", async () => {
    const ledger = new EvidenceLedger("turn-1");
    const reads: TurnRead[] = [
      // A successful first-party read.
      {
        key: "order-status:order-42",
        source: "order.getStatus",
        origin: "TRUSTED",
        read: () => ({ status: "preparing" }),
      },
      // A read that THROWS — must be recorded as an ERROR, never omitted (Inv 7).
      {
        key: "payment-status:order-42",
        source: "payment.getStatus",
        origin: "TRUSTED",
        read: () => {
          throw new Error("payment service unavailable");
        },
      },
    ];

    const investigator = createIbatexasInvestigator({
      gatherReads: () => reads,
      now: () => 1_700_000_000_000,
    });
    await investigator.investigate(input(reads, ledger));

    // present read → concrete value.
    const present = ledger.resolve("order-status:order-42");
    expect(present.state).toBe("present");
    expect(present.entry?.value).toEqual({ status: "preparing" });

    // errored read → state "error" (NOT "absent"), with the reason preserved.
    const errored = ledger.resolve("payment-status:order-42");
    expect(errored.state).toBe("error");
    expect(errored.entry).toBeUndefined();
    expect(ledger.errorReason("payment-status:order-42")).toBe(
      "payment service unavailable",
    );

    // a never-recorded key → state "absent" — the DISTINCT third state (Inv 7).
    const missing = ledger.resolve("never-read:order-42");
    expect(missing.state).toBe("absent");

    // The three states are genuinely distinct (non-vacuity).
    expect(present.state).not.toBe(errored.state);
    expect(errored.state).not.toBe(missing.state);
  });

  it("a rejected async read is also recorded as an error, never silently omitted", async () => {
    const ledger = new EvidenceLedger();
    const reads: TurnRead[] = [
      {
        key: "reservation:r-1",
        source: "reservation.get",
        origin: "TRUSTED",
        read: async () => {
          return Promise.reject(new Error("db timeout"));
        },
      },
    ];
    const investigator = createIbatexasInvestigator({ gatherReads: () => reads });
    await investigator.investigate(input(reads, ledger));

    expect(ledger.resolve("reservation:r-1").state).toBe("error");
    // The key IS present in the snapshot's key set — an error is representable,
    // not a hole.
    expect(ledger.keys()).toContain("reservation:r-1");
  });
});

// ── Reads run CONCURRENTLY, ledger stays deterministic ───────────────────────

describe("ibatexas-investigator — concurrent reads", () => {
  it("executes the reads in parallel (a later-array read can unblock an earlier one)", async () => {
    const ledger = new EvidenceLedger("t");
    // `a` (FIRST in the array) blocks on a gate that only `b` (SECOND) releases.
    // If the loop were SERIAL, `a` would await forever and the turn would hang;
    // concurrency lets `b` run and release the gate — a timer-free concurrency proof.
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const reads: TurnRead[] = [
      {
        key: "a",
        source: "sa",
        origin: "TRUSTED",
        read: async () => {
          await gate;
          return { v: "a" };
        },
      },
      {
        key: "b",
        source: "sb",
        origin: "TRUSTED",
        read: async () => {
          release();
          return { v: "b" };
        },
      },
    ];
    const investigator = createIbatexasInvestigator({
      gatherReads: () => reads,
      now: () => 7,
    });
    await investigator.investigate(input(reads, ledger));

    expect(ledger.resolve("a").entry?.value).toEqual({ v: "a" });
    expect(ledger.resolve("b").entry?.value).toEqual({ v: "b" });
    // fetchedAt is stamped at read completion from the injected clock.
    expect(ledger.resolve("a").entry?.fetchedAt).toBe(7);
    // DETERMINISM: `b` completed FIRST (it released the gate `a` was awaiting), yet
    // ledger writes are applied in the ORIGINAL reads order — so the stable
    // insertion order is ["a","b"], NOT the completion order ["b","a"].
    expect(ledger.keys()).toEqual(["a", "b"]);
  });
});

// ── Origin labelling at mint (published 2-value LedgerTaint) ──────────────────

describe("ibatexas-investigator — origin labelling at mint", () => {
  it("labels a first-party read TRUSTED and a free-text read UNTRUSTED_DATA", async () => {
    const ledger = new EvidenceLedger();
    const reads: TurnRead[] = [
      {
        key: "first-party",
        source: "order.getById",
        origin: "TRUSTED",
        read: () => "db-value",
      },
      {
        key: "free-text",
        source: "llm.note",
        origin: "UNTRUSTED_DATA",
        read: () => "customer typed this",
      },
    ];
    const investigator = createIbatexasInvestigator({
      gatherReads: () => reads,
      now: () => 42,
    });
    await investigator.investigate(input(reads, ledger));

    const first = ledger.resolve("first-party").entry;
    expect(first?.taint).toBe("TRUSTED");
    // EGRESS-BRAND wave bumps the kernel to the 3-value OriginProvenance: a
    // read-layer "TRUSTED" taint maps FAIL-CLOSED to TRUSTED_THIRD_PARTY (never
    // FIRST_PARTY) — see originProvenanceOf in ibatexas-investigator.ts.
    expect(first?.originProvenance).toBe("TRUSTED_THIRD_PARTY");
    // The investigator owns the clock — fetchedAt is the injected now().
    expect(first?.fetchedAt).toBe(42);
    expect(first?.sourceMode).toBe("live");

    const free = ledger.resolve("free-text").entry;
    expect(free?.taint).toBe("UNTRUSTED_DATA");
    expect(free?.originProvenance).toBe("UNTRUSTED_DATA");
  });
});

// ── default gatherer derives reads from plan.readToolCalls ────────────────────

describe("ibatexas-investigator — default read gatherer", () => {
  it("derives one UNTRUSTED_DATA read per plan.readToolCall", () => {
    const reads = defaultTurnReads({
      cognition: cognition(),
      plan: {
        envelopes: [],
        readToolCalls: [
          { name: "menu.search", input: { q: "linguiça" } },
          { name: "order.history", input: {} },
        ],
      },
      customerId: "cust-1",
      channel: "web",
      ledger: new EvidenceLedger(),
    });
    expect(reads).toHaveLength(2);
    expect(reads[0]?.source).toBe("menu.search");
    expect(reads[0]?.origin).toBe("UNTRUSTED_DATA");
    expect(reads.every((r) => r.origin === "UNTRUSTED_DATA")).toBe(true);
  });

  it("an empty plan yields no reads (no synthetic evidence)", () => {
    expect(
      defaultTurnReads({
        cognition: cognition(),
        plan: { envelopes: [] },
        customerId: "c",
        channel: "web",
        ledger: new EvidenceLedger(),
      }),
    ).toHaveLength(0);
  });
});

// ── first-party gatherer — REAL owner-scoped triad reads ─────────────────────

/** A controllable stub TriadReadBackend (no DB). */
function stubBackend(over: Partial<TriadReadBackend> = {}): TriadReadBackend {
  return {
    readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
    // Default: no ScheduleOverride today (the falsifier does not fire).
    readScheduleOverride: async () => null,
    // BKL-121 — default: today's hours present; no holiday today (falsifier inert).
    readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
    readHoliday: async () => null,
    // BKL-138 — default: the queried date's hours present; no holiday/override on it
    // (the per-date falsifiers are inert). Tests that exercise the date-hours chain
    // override these.
    readHoursForDate: async () => ({ hoursText: "11h–15h / 18h–23h" }),
    readHolidayForDate: async () => null,
    readScheduleOverrideForDate: async () => null,
    readOrderFulfillment: async (orderId) => ({ orderId, displayId: 42, fulfillmentStatus: "preparing" }),
    readPaymentStatus: async (orderId) => ({ orderId, displayId: 42, status: "paid", method: "pix" }),
    readReservation: async (reservationId) => ({
      reservationId,
      status: "confirmed",
      partySize: 4,
      statusLine: "confirmada",
    }),
    // BKL-006 — default: the owner-scoped FALSIFIER reads all resolve owned + NOT
    // fired (no refund / no dispute / not cancelled), so the falsifier keys stay
    // ABSENT and a clean claim VALIDATES. Tests that exercise a firing falsifier
    // override the relevant one; a cross-owner test returns `null`.
    readPaymentRefund: async (orderId) => ({
      orderId,
      refunded: false,
      refundedAmountCentavos: 0,
      status: "",
    }),
    readPaymentChargeback: async (orderId) => ({ orderId, disputed: false, status: "" }),
    // BKL-139 — default: an empty cart (inert). Tests that exercise the cart read
    // override this; the read is only invoked on a CART_CONTENTS_Q-span turn.
    readCartContents: async () => ({ itemsSummaryText: "", hasItems: false }),
    // FE-D03 slice C — default: empty history (inert); only invoked on a *_HISTORY_Q turn.
    readOrderHistory: async () => ({ historySummaryText: "", hasHistory: false }),
    readPaymentHistory: async () => ({ historySummaryText: "", hasHistory: false }),
    // FIX 2 — default: no auto-enumerated active orders (tests that exercise the
    // owner-order enumeration override this).
    listActiveOrderIds: async () => [],
    // FE-T17b — default: no auto-enumerated active reservations (tests that
    // exercise the owner-reservation discovery fallback override this).
    listActiveReservationIds: async () => [],
    // BKL-079 — default: 0 payments (a provable-empty payment; tests that exercise
    // the payment marker override this).
    countActivePayments: async () => 0,
    ...over,
  };
}

function triadInput(
  plan: Plan,
  ledger: EvidenceLedger,
  customerId = "cust-1",
): InvestigateInput {
  return { cognition: cognition(), plan, customerId, channel: "web", ledger };
}

describe("ibatexas-investigator — first-party triad gatherer", () => {
  it("always records the schedule read as a first-party (FIRST_PARTY) present value", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend()),
      now: () => 999,
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger));

    const sched = ledger.resolve("schedule:store_open_now");
    expect(sched.state).toBe("present");
    expect(sched.entry?.taint).toBe("TRUSTED");
    // Plan 1 Phase 3: a genuine first-party config read now carries the 3-value
    // FIRST_PARTY origin (the new kernel is linked) — not the fail-closed fallback.
    expect(sched.entry?.originProvenance).toBe("FIRST_PARTY");
    expect(sched.entry?.fetchedAt).toBe(999);
    expect(sched.entry?.value).toEqual({ isClosed: false, mealPeriod: "dinner" });
  });

  it("reads owner-scoped ORDER_FULFILLMENT_STAGE + PAYMENT_STATUS for a plan orderId", async () => {
    const ledger = new EvidenceLedger("t");
    const plan: Plan = {
      envelopes: [
        {
          kind: "order.cancel",
          payload: { orderId: "order-42" },
        } as unknown as Plan["envelopes"][number],
      ],
    };
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend()),
    });
    await investigator.investigate(triadInput(plan, ledger));

    const pay = ledger.resolve("payment_status:order-42");
    expect(pay.state).toBe("present");
    expect(pay.entry?.taint).toBe("TRUSTED");
    expect(pay.entry?.value).toEqual({ orderId: "order-42", displayId: 42, status: "paid", method: "pix" });

    const ful = ledger.resolve("order_fulfillment_stage:order-42");
    expect(ful.state).toBe("present");
    expect(ful.entry?.value).toEqual({ orderId: "order-42", displayId: 42, fulfillmentStatus: "preparing" });
  });

  it("a CROSS-OWNER payment read (backend null) records a fail-closed ERROR, never a value", async () => {
    const ledger = new EvidenceLedger("t");
    const plan: Plan = {
      envelopes: [
        { kind: "order.cancel", payload: { orderId: "order-99" } } as unknown as Plan["envelopes"][number],
      ],
    };
    const investigator = createIbatexasInvestigator({
      // The backend refuses the cross-owner read (null) — the IDOR close.
      gatherReads: createFirstPartyTurnReads(
        stubBackend({
          readPaymentStatus: async () => null,
          readOrderFulfillment: async () => null,
        }),
      ),
    });
    await investigator.investigate(triadInput(plan, ledger));

    const pay = ledger.resolve("payment_status:order-99");
    // Refused/empty — state error, NO concrete value exposed (Inv 7, fail closed).
    expect(pay.state).toBe("error");
    expect(pay.entry).toBeUndefined();
    expect(ledger.errorReason("payment_status:order-99")).toContain("not owned or absent");
  });

  it("skips owner-scoped resource reads for a guest turn (schedule only)", async () => {
    const ledger = new EvidenceLedger("t");
    const plan: Plan = {
      envelopes: [
        { kind: "order.cancel", payload: { orderId: "order-42" } } as unknown as Plan["envelopes"][number],
      ],
    };
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend()),
    });
    await investigator.investigate(triadInput(plan, ledger, "guest:abc"));

    expect(ledger.resolve("schedule:store_open_now").state).toBe("present");
    // No owner-scoped resource reads for an unauthenticated customer.
    expect(ledger.resolve("payment_status:order-42").state).toBe("absent");
    expect(ledger.resolve("order_fulfillment_stage:order-42").state).toBe("absent");
  });

  it("reads owner-scoped reservation status for a plan reservationId", async () => {
    const ledger = new EvidenceLedger("t");
    const plan: Plan = {
      envelopes: [],
      readToolCalls: [{ name: "reservation.lookup", input: { reservationId: "r-7" } }],
    };
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend()),
    });
    await investigator.investigate(triadInput(plan, ledger));

    const res = ledger.resolve("reservation_status:r-7");
    expect(res.state).toBe("present");
    expect(res.entry?.value).toEqual({ reservationId: "r-7", status: "confirmed", partySize: 4, statusLine: "confirmada" });
  });
});

// ── BKL-073: the PROVABLE-EMPTY enumeration marker ────────────────────────────
//
// The investigator records a signal-only `active_orders:{customerId}` marker whose
// 4-state ledger disposition is the provable-empty witness: a SUCCESSFUL empty
// enumeration → PRESENT {count:0} (the seam's Rule B DROPS the order companion); an
// ERRORED enumeration → state "error" ("could not check", NOT provably empty → the
// companion is KEPT → honest UNKNOWN). The union behavior is unchanged on both paths.
describe("ibatexas-investigator — BKL-073 provable-empty marker", () => {
  it("a SUCCESSFUL empty enumeration records the marker PRESENT with {count:0}", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend({ listActiveOrderIds: async () => [] })),
      now: () => 999,
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger));

    const marker = ledger.resolve("active_orders:cust-1");
    expect(marker.state).toBe("present"); // count 0 is a PRESENT provable-empty, not absence.
    expect(marker.entry?.value).toEqual({ count: 0 });
    expect(marker.entry?.taint).toBe("TRUSTED");
    expect(marker.entry?.originProvenance).toBe("FIRST_PARTY");
  });

  it("N≥1 owned active orders records the marker PRESENT with the count, and reads each order", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({ listActiveOrderIds: async () => ["o1", "o2"] }),
      ),
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger));

    const marker = ledger.resolve("active_orders:cust-1");
    expect(marker.state).toBe("present");
    expect(marker.entry?.value).toEqual({ count: 2 });
    // The union carried the owner's real orders into owner-scoped reads (unchanged).
    expect(ledger.resolve("order_fulfillment_stage:o1").state).toBe("present");
    expect(ledger.resolve("order_fulfillment_stage:o2").state).toBe("present");
  });

  it("an ERRORED enumeration records the marker as state \"error\" (Inv 7), and the union still reads the model-extracted order", async () => {
    const ledger = new EvidenceLedger("t");
    // The model DID extract a real orderId into the plan, but the owner-enumeration
    // ERRORS — the union must degrade to the model-extracted ids exactly as before.
    const plan: Plan = {
      envelopes: [
        { kind: "order.cancel", payload: { orderId: "order-42" } } as unknown as Plan["envelopes"][number],
      ],
    };
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({
          listActiveOrderIds: async () => {
            throw new Error("enumeration backend down");
          },
        }),
      ),
    });
    await investigator.investigate(triadInput(plan, ledger));

    const marker = ledger.resolve("active_orders:cust-1");
    expect(marker.state).toBe("error"); // "could not check" — NOT a provable empty.
    expect(marker.entry).toBeUndefined();
    expect(ledger.errorReason("active_orders:cust-1")).toBe("enumeration backend down");
    // Union unchanged: the model-extracted order was still read owner-scoped.
    expect(ledger.resolve("order_fulfillment_stage:order-42").state).toBe("present");
  });

  it("a GUEST turn records NO marker (the enumeration short-circuits before it)", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend()),
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger, "guest:abc"));
    expect(ledger.resolve("active_orders:guest:abc").state).toBe("absent");
  });
});

// ── BKL-079: the PROVABLE-EMPTY PAYMENT enumeration marker (mirror of BKL-073) ─────
//
// The EXACT MIRROR of the order marker for the PAYMENT dimension. The investigator
// records a signal-only `active_payments:{customerId}` marker whose 4-state ledger
// disposition is the provable-empty witness: a SUCCESSFUL count-0 enumeration →
// PRESENT {count:0} (the seam's Rule B′ DROPS the payment companion); a count>0 →
// PRESENT {count:N} (NOT provably empty); an ERRORED count → state "error" ("could
// not check" → the companion is KEPT → honest UNKNOWN, NEVER a wrong drop).
describe("ibatexas-investigator — BKL-079 provable-empty PAYMENT marker", () => {
  it("a SUCCESSFUL count-0 enumeration records the marker PRESENT with {count:0}", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend({ countActivePayments: async () => 0 })),
      now: () => 999,
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger));

    const marker = ledger.resolve("active_payments:cust-1");
    expect(marker.state).toBe("present"); // count 0 is a PRESENT provable-empty, not absence.
    expect(marker.entry?.value).toEqual({ count: 0 });
    expect(marker.entry?.taint).toBe("TRUSTED");
    expect(marker.entry?.originProvenance).toBe("FIRST_PARTY");
    expect(marker.entry?.fetchedAt).toBe(999);
  });

  it("count N≥1 records the marker PRESENT with the count (NOT provably empty)", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend({ countActivePayments: async () => 3 })),
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger));

    const marker = ledger.resolve("active_payments:cust-1");
    expect(marker.state).toBe("present");
    expect(marker.entry?.value).toEqual({ count: 3 });
  });

  it('an ERRORED count records the marker as state "error" (Inv 7 — error ≠ absence)', async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({
          countActivePayments: async () => {
            throw new Error("payment count backend down");
          },
        }),
      ),
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger));

    const marker = ledger.resolve("active_payments:cust-1");
    expect(marker.state).toBe("error"); // "could not check" — NOT a provable empty.
    expect(marker.entry).toBeUndefined();
    expect(ledger.errorReason("active_payments:cust-1")).toBe("payment count backend down");
  });

  it("a GUEST turn records NO payment marker (the enumeration short-circuits before it)", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend()),
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger, "guest:abc"));
    expect(ledger.resolve("active_payments:guest:abc").state).toBe("absent");
  });
});

// ── FE-T17b: RESERVATION owner-scoped discovery fallback + provable-empty marker ──
//
// Live-disproof follow-up (dev @ a063661b, turnIds 30c78409-b843-4b5a-8239-
// e36c925233f2 / 91adbe43-5fa2-4c0a-9560-0e376d7aeb84): `get_my_reservations` is a
// no-param LIST call, so `extractTurnResourceIds` structurally never populates
// `reservationIds` for a status question — unlike order/payment questions, the
// model never even ATTEMPTS to extract a reservationId. Without the discovery
// fallback the reservation per-resource read loop iterates an ALWAYS-EMPTY list,
// so `reservation_status:{id}` is NEVER recorded and RESERVATION_STATUS can never
// acquire evidence — the exact mechanism these tests pin, mirroring BKL-073.
describe("ibatexas-investigator — FE-T17b reservation discovery + provable-empty marker", () => {
  it("a SUCCESSFUL empty enumeration records the marker PRESENT with {count:0}", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({ listActiveReservationIds: async () => [] }),
      ),
      now: () => 999,
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger));

    const marker = ledger.resolve("active_reservations:cust-1");
    expect(marker.state).toBe("present"); // count 0 is a PRESENT provable-empty, not absence.
    expect(marker.entry?.value).toEqual({ count: 0 });
    expect(marker.entry?.taint).toBe("TRUSTED");
    expect(marker.entry?.originProvenance).toBe("FIRST_PARTY");
    // The disproven bug, closed: with NO model-extracted id AND zero discovered
    // reservations, NO reservation_status:* key is ever recorded — the honest
    // SAFE_UNKNOWN abstain the live drive flagged stays intact once discovery exists.
    const reservationKeys = [...ledger.keys()].filter((k) =>
      k.startsWith("reservation_status:"),
    );
    expect(reservationKeys).toEqual([]);
  });

  it("N≥1 owned active reservations records the marker PRESENT with the count, and reads each reservation — closing the live-disproof (the model supplied NO id)", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({ listActiveReservationIds: async () => ["r1", "r2"] }),
      ),
    });
    // The model-side plan carries NO reservationId anywhere (exactly the
    // get_my_reservations shape that disproved the render path) — every
    // reservation_status entry below can ONLY come from discovery.
    await investigator.investigate(triadInput({ envelopes: [] }, ledger));

    const marker = ledger.resolve("active_reservations:cust-1");
    expect(marker.state).toBe("present");
    expect(marker.entry?.value).toEqual({ count: 2 });
    // The union carried the owner's real reservations into owner-scoped reads —
    // this is the exact ledger state FIX 2 / ownedResourceIdsByBaseKey needed and
    // never had before this fix.
    expect(ledger.resolve("reservation_status:r1").state).toBe("present");
    expect(ledger.resolve("reservation_status:r2").state).toBe("present");
  });

  it('an ERRORED enumeration records the marker as state "error" (Inv 7), and the union still reads a model-extracted reservation id', async () => {
    const ledger = new EvidenceLedger("t");
    // A read-tool call DID carry a reservationId (e.g. a follow-up read after an
    // earlier turn resolved one) — the owner-enumeration ERRORS, and the union must
    // degrade to the model/tool-extracted id exactly as the order mirror does.
    const plan: Plan = {
      envelopes: [],
      readToolCalls: [{ name: "reservation.lookup", input: { reservationId: "r-known" } }],
    };
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({
          listActiveReservationIds: async () => {
            throw new Error("reservation enumeration backend down");
          },
        }),
      ),
    });
    await investigator.investigate(triadInput(plan, ledger));

    const marker = ledger.resolve("active_reservations:cust-1");
    expect(marker.state).toBe("error"); // "could not check" — NOT a provable empty.
    expect(marker.entry).toBeUndefined();
    expect(ledger.errorReason("active_reservations:cust-1")).toBe(
      "reservation enumeration backend down",
    );
    // Union unchanged: the tool-extracted reservation was still read owner-scoped.
    expect(ledger.resolve("reservation_status:r-known").state).toBe("present");
  });

  it("a GUEST turn records NO reservation marker (the enumeration short-circuits before it)", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend()),
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger, "guest:abc"));
    expect(ledger.resolve("active_reservations:guest:abc").state).toBe("absent");
  });
});

// ── F1: the STORE_OPEN_NOW falsifier FIRES end-to-end (W6 CE#3) ────────────────
//
// The investigator records the day's ScheduleOverride under the registry-declared
// falsifier key `schedule:schedule_override` ONLY when one exists; the kernel's
// `resolveAgainstFalsifiers` (now LINKED via the W6 core) then demotes a present-
// override STORE_OPEN_NOW to UNKNOWN. NON-VACUITY: the SAME setup with NO override
// VALIDATES — so the test proves the arm fires, not that everything is UNKNOWN.
describe("F1 — STORE_OPEN_NOW falsifier fires end-to-end (investigator → kernel)", () => {
  const OVERRIDE_TODAY = {
    id: "ov-1",
    date: "2026-06-29",
    isOpen: false,
    blocks: [],
    note: "feriado emergencial",
  };

  /** Run investigator (schedule + override) → runClaimsKernel over a STORE_OPEN_NOW
   *  candidate whose C6-bound value matches the recorded schedule signal. */
  async function runStoreOpenNow(
    override: typeof OVERRIDE_TODAY | null,
  ): Promise<{ verdict: string; terminal: string }> {
    const ledger = new EvidenceLedger("t-f1");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({
          readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
          readScheduleOverride: async () => override,
        }),
      ),
      now: () => 999,
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger, "guest:abc"));

    const candidate = selectCandidateClaim({
      type: "STORE_OPEN_NOW",
      subject: "store",
      actor: { principal: "system" },
      // C6 value-from-ledger: the rendered mealPeriod must equal the schedule
      // signal's mealPeriod recorded in the ledger ("dinner").
      value: { mealPeriod: "dinner" },
    });
    const deps = createPerTurnClaimsKernelDeps({
      now: 999,
      ownership: { principal: "", ownedResources: new Set<string>() },
      outcomes: [],
    });
    const result = runClaimsKernel(ledger, [candidate!], deps);
    return {
      verdict: result.perClaim[0]?.verdict ?? "MISSING",
      terminal: result.terminal,
    };
  }

  it("a PRESENT ScheduleOverride is recorded under the falsifier key and demotes STORE_OPEN_NOW to UNKNOWN", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({ readScheduleOverride: async () => OVERRIDE_TODAY }),
      ),
      now: () => 999,
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger, "guest:abc"));

    const override = ledger.resolve("schedule:schedule_override");
    expect(override.state).toBe("present");
    expect(override.entry?.originProvenance).toBe("FIRST_PARTY");

    const { verdict } = await runStoreOpenNow(OVERRIDE_TODAY);
    expect(verdict).toBe("UNKNOWN"); // falsifier fired — not a false "open"
  });

  it("NON-VACUITY: with NO override today the falsifier key is ABSENT and STORE_OPEN_NOW VALIDATES", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({ readScheduleOverride: async () => null }),
      ),
      now: () => 999,
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger, "guest:abc"));

    // ABSENCE, not error — the sentinel skip leaves the key never-recorded.
    expect(ledger.resolve("schedule:schedule_override").state).toBe("absent");
    expect(ledger.errorReason("schedule:schedule_override")).toBeUndefined();

    const { verdict, terminal } = await runStoreOpenNow(null);
    expect(verdict).toBe("VALIDATED");
    expect(terminal).toBe("RENDER");
  });
});

// ── BKL-121 — STORE_HOURS evidence + holiday falsifier recording ───────────────
//
// The investigator records TODAY's operating-hours under `schedule:store_hours`
// (first-party, present) and TODAY's holiday under `schedule:holiday` (present ONLY
// on a holiday; ABSENT otherwise). A schedule-load failure (readStoreHours throws) is
// a fail-closed read ERROR (Inv 7), NEVER a fabricated hours string.
describe("BKL-121 — investigator records STORE_HOURS + the holiday falsifier", () => {
  const HOLIDAY_TODAY = {
    id: "hol-1",
    date: "2026-12-25",
    label: "Natal",
    allDay: true,
    startTime: null,
    endTime: null,
  };

  it("records today's hours under schedule:store_hours as a FIRST_PARTY present value", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({ readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }) }),
      ),
      now: () => 999,
    });
    // Public config — recorded even for a guest (before the authenticated gate).
    await investigator.investigate(triadInput({ envelopes: [] }, ledger, "guest:abc"));

    const hours = ledger.resolve("schedule:store_hours");
    expect(hours.state).toBe("present");
    expect(hours.entry?.value).toEqual({ hoursText: "11h–15h / 18h–23h" });
    expect(hours.entry?.taint).toBe("TRUSTED");
    expect(hours.entry?.originProvenance).toBe("FIRST_PARTY");
  });

  it("Inv 7 — a schedule-load failure records schedule:store_hours as an ERROR, never a fabricated value", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({
          readStoreHours: async () => {
            throw new Error("store_hours unavailable: schedule not loaded this turn");
          },
        }),
      ),
      now: () => 999,
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger, "guest:abc"));

    const hours = ledger.resolve("schedule:store_hours");
    expect(hours.state).toBe("error"); // "não consegui conferir" — distinct from absence
    expect(hours.entry).toBeUndefined();
    expect(ledger.errorReason("schedule:store_hours")).toContain("unavailable");
  });

  it("a PRESENT holiday is recorded under schedule:holiday (the falsifier can fire)", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(
        stubBackend({ readHoliday: async () => HOLIDAY_TODAY }),
      ),
      now: () => 999,
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger, "guest:abc"));

    const holiday = ledger.resolve("schedule:holiday");
    expect(holiday.state).toBe("present");
    expect(holiday.entry?.originProvenance).toBe("FIRST_PARTY");
  });

  it("NON-VACUITY: with NO holiday today the schedule:holiday key is ABSENT (falsifier inert)", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend({ readHoliday: async () => null })),
      now: () => 999,
    });
    await investigator.investigate(triadInput({ envelopes: [] }, ledger, "guest:abc"));

    // ABSENCE (sentinel skip), not error — the key was never recorded.
    expect(ledger.resolve("schedule:holiday").state).toBe("absent");
    expect(ledger.errorReason("schedule:holiday")).toBeUndefined();
  });
});

// ── BKL-006 — falsifier-evidence recording (refund / chargeback / cancel) ──────
//
// The registry DECLARED PAYMENT_STATUS's `payment_refund`/`payment_chargeback`,
// ORDER_FULFILLMENT_STAGE's `order_cancelled`, and RESERVATION_STATUS's
// `reservation_cancelled` falsifiers (`falsifierComplete: true`) but NO investigator
// read populated them, so the runtime arm was structurally INERT: a refunded/disputed
// payment could VALIDATE `pago` while the claims flag is ON. These tests pin that the
// investigator now records each falsifier PRESENT only when the falsifying fact
// exists (checked-and-none → ABSENT; read error / cross-owner → state "error"), that
// the arm actually DEMOTES the base to UNKNOWN end-to-end via `resolveAgainstFalsifiers`
// (with NON-VACUITY: the same setup with no falsifier VALIDATES), and the KEY-LOCKSTEP
// pin (the recorded key equals the REAL `selectCandidateClaim` parameterized key — a
// suffix mismatch would leave the arm silently inert).
describe("BKL-006 — falsifier-evidence recording (refund / chargeback / cancel)", () => {
  const ORDER_PLAN: Plan = {
    envelopes: [
      { kind: "order.cancel", payload: { orderId: "order-42" } } as unknown as Plan["envelopes"][number],
    ],
  };
  const RESERVATION_PLAN: Plan = {
    envelopes: [],
    readToolCalls: [{ name: "reservation.lookup", input: { reservationId: "r-7" } }],
  };

  /** Run INVESTIGATE (real triad reads over a stub backend) → runClaimsKernel over a
   *  single owner-scoped candidate whose subject the owner owns — mirrors the F1
   *  STORE_OPEN_NOW helper for the owner-scoped types. */
  async function investigateThenValidate(opts: {
    readonly plan: Plan;
    readonly backend: Partial<TriadReadBackend>;
    readonly type: string;
    readonly subject: string;
    readonly value: unknown;
    readonly owned: readonly string[];
    readonly customerId?: string;
  }): Promise<{ verdict: string; terminal: string }> {
    const customerId = opts.customerId ?? "cust-1";
    const ledger = new EvidenceLedger("t-bkl006");
    const investigator = createIbatexasInvestigator({
      gatherReads: createFirstPartyTurnReads(stubBackend(opts.backend)),
      now: () => 999,
    });
    await investigator.investigate(triadInput(opts.plan, ledger, customerId));

    const candidate = selectCandidateClaim({
      type: opts.type,
      subject: opts.subject,
      actor: { principal: customerId },
      value: opts.value,
    });
    const deps = createPerTurnClaimsKernelDeps({
      now: 999,
      ownership: { principal: customerId, ownedResources: new Set(opts.owned) },
      outcomes: [],
    });
    const result = runClaimsKernel(ledger, [candidate!], deps);
    return {
      verdict: result.perClaim[0]?.verdict ?? "MISSING",
      terminal: result.terminal,
    };
  }

  // ── recording: PRESENT / ABSENT / ERROR / cross-owner (the payment refund) ──────
  describe("payment_refund — ledger recording states", () => {
    it("records payment_refund PRESENT under the falsifier key when a refund fired", async () => {
      const ledger = new EvidenceLedger("t");
      const investigator = createIbatexasInvestigator({
        gatherReads: createFirstPartyTurnReads(
          stubBackend({
            readPaymentRefund: async (orderId) => ({
              orderId,
              refunded: true,
              refundedAmountCentavos: 1500,
              status: "partially_refunded",
            }),
          }),
        ),
        now: () => 999,
      });
      await investigator.investigate(triadInput(ORDER_PLAN, ledger));

      const refund = ledger.resolve("payment_refund:order-42");
      expect(refund.state).toBe("present");
      expect(refund.entry?.taint).toBe("TRUSTED");
      expect(refund.entry?.originProvenance).toBe("FIRST_PARTY");
      expect(refund.entry?.value).toMatchObject({ refunded: true });
    });

    it("checked-and-NO-refund leaves payment_refund ABSENT (never a fabricated present)", async () => {
      const ledger = new EvidenceLedger("t");
      const investigator = createIbatexasInvestigator({
        gatherReads: createFirstPartyTurnReads(stubBackend()), // default: refunded false
        now: () => 999,
      });
      await investigator.investigate(triadInput(ORDER_PLAN, ledger));

      // ABSENCE (sentinel skip), not error — the falsifier stays inert.
      expect(ledger.resolve("payment_refund:order-42").state).toBe("absent");
      expect(ledger.errorReason("payment_refund:order-42")).toBeUndefined();
    });

    it('a FAILED refund read records state "error" (Inv 7), never a value', async () => {
      const ledger = new EvidenceLedger("t");
      const investigator = createIbatexasInvestigator({
        gatherReads: createFirstPartyTurnReads(
          stubBackend({
            readPaymentRefund: async () => {
              throw new Error("refund lookup backend down");
            },
          }),
        ),
        now: () => 999,
      });
      await investigator.investigate(triadInput(ORDER_PLAN, ledger));

      const refund = ledger.resolve("payment_refund:order-42");
      expect(refund.state).toBe("error");
      expect(refund.entry).toBeUndefined();
      expect(ledger.errorReason("payment_refund:order-42")).toContain(
        "refund lookup backend down",
      );
    });

    it("a CROSS-OWNER refund read (backend null) records a fail-closed ERROR, never a fabricated absent", async () => {
      const ledger = new EvidenceLedger("t");
      const plan: Plan = {
        envelopes: [
          { kind: "order.cancel", payload: { orderId: "order-99" } } as unknown as Plan["envelopes"][number],
        ],
      };
      const investigator = createIbatexasInvestigator({
        // The backend refuses the cross-owner read (null) — the IDOR close.
        gatherReads: createFirstPartyTurnReads(
          stubBackend({ readPaymentRefund: async () => null }),
        ),
        now: () => 999,
      });
      await investigator.investigate(triadInput(plan, ledger));

      const refund = ledger.resolve("payment_refund:order-99");
      // ERROR, not absent — an unreadable falsifier cannot be proven not to have fired.
      expect(refund.state).toBe("error");
      expect(refund.entry).toBeUndefined();
      expect(ledger.errorReason("payment_refund:order-99")).toContain(
        "not owned or absent",
      );
    });
  });

  // ── PAYMENT_STATUS end-to-end: the arm fires and demotes `pago` → UNKNOWN ────────
  describe("PAYMENT_STATUS falsifier fires end-to-end (investigator → kernel)", () => {
    it("NON-VACUITY: with NO refund/chargeback, PAYMENT_STATUS=paid VALIDATES", async () => {
      const { verdict, terminal } = await investigateThenValidate({
        plan: ORDER_PLAN,
        backend: {}, // defaults: no refund, no dispute
        type: "PAYMENT_STATUS",
        subject: "order-42",
        value: { status: "paid" },
        owned: ["order-42"],
      });
      expect(verdict).toBe("VALIDATED");
      expect(terminal).toBe("RENDER");
    });

    it("a PRESENT refund demotes PAYMENT_STATUS=paid to UNKNOWN (the latent-risk close)", async () => {
      const { verdict } = await investigateThenValidate({
        plan: ORDER_PLAN,
        backend: {
          readPaymentRefund: async (orderId) => ({
            orderId,
            refunded: true,
            refundedAmountCentavos: 5000,
            status: "refunded",
          }),
        },
        type: "PAYMENT_STATUS",
        subject: "order-42",
        value: { status: "paid" },
        owned: ["order-42"],
      });
      expect(verdict).toBe("UNKNOWN"); // never a confident wrong `pago`
    });

    it("RATIFIED — a PARTIAL refund fires the falsifier (demote-only to UNKNOWN)", async () => {
      const { verdict } = await investigateThenValidate({
        plan: ORDER_PLAN,
        backend: {
          readPaymentRefund: async (orderId) => ({
            orderId,
            refunded: true,
            refundedAmountCentavos: 1200, // a PARTIAL refund (amount > 0)
            status: "partially_refunded",
          }),
        },
        type: "PAYMENT_STATUS",
        subject: "order-42",
        value: { status: "paid" },
        owned: ["order-42"],
      });
      expect(verdict).toBe("UNKNOWN");
    });

    it("a PRESENT chargeback (dispute) demotes PAYMENT_STATUS=paid to UNKNOWN", async () => {
      const { verdict } = await investigateThenValidate({
        plan: ORDER_PLAN,
        backend: {
          readPaymentChargeback: async (orderId) => ({
            orderId,
            disputed: true,
            status: "disputed",
          }),
        },
        type: "PAYMENT_STATUS",
        subject: "order-42",
        value: { status: "paid" },
        owned: ["order-42"],
      });
      expect(verdict).toBe("UNKNOWN");
    });

    it('a FAILED refund read (state "error") poisons the base to UNKNOWN, never renders `paid`', async () => {
      const { verdict } = await investigateThenValidate({
        plan: ORDER_PLAN,
        backend: {
          readPaymentRefund: async () => {
            throw new Error("refund lookup backend down");
          },
        },
        type: "PAYMENT_STATUS",
        subject: "order-42",
        value: { status: "paid" },
        owned: ["order-42"],
      });
      // F6 symmetry: a falsifier that could NOT be read demotes the base (we cannot
      // prove the refund did not fire) — never a confident `paid`.
      expect(verdict).toBe("UNKNOWN");
    });
  });

  // ── Cancellation falsifiers are DELIBERATELY UNREAD (review ruling 2026-07-17) ──
  // The #277 order_cancelled/reservation_cancelled reads were removed as a
  // same-row tautology: they shared the base read's memoized row, so they demoted
  // every TRUTHFUL cancelled render while catching zero staleness. These tests pin
  // the ruling: a truthful cancelled status now VALIDATES (renders honestly).
  describe("cancellation statuses render truthfully (tautological falsifiers removed)", () => {
    it("NON-VACUITY: a NOT-cancelled order VALIDATES its fulfillment stage", async () => {
      const { verdict } = await investigateThenValidate({
        plan: ORDER_PLAN,
        backend: {}, // default: fulfillment "preparing", not cancelled
        type: "ORDER_FULFILLMENT_STAGE",
        subject: "order-42",
        value: { fulfillmentStatus: "preparing" },
        owned: ["order-42"],
      });
      expect(verdict).toBe("VALIDATED");
      // The falsifier key is genuinely absent (not fired).
    });

    it("a TRUTHFUL cancelled order VALIDATES (no tautological self-demotion)", async () => {
      const { verdict } = await investigateThenValidate({
        plan: ORDER_PLAN,
        backend: {
          readOrderFulfillment: async (orderId) => ({ orderId, displayId: 42, fulfillmentStatus: "canceled" }),
        },
        type: "ORDER_FULFILLMENT_STAGE",
        subject: "order-42",
        value: { fulfillmentStatus: "canceled" },
        owned: ["order-42"],
      });
      expect(verdict).toBe("VALIDATED");
    });

    it("NON-VACUITY: a NOT-cancelled reservation VALIDATES its status", async () => {
      const { verdict } = await investigateThenValidate({
        plan: RESERVATION_PLAN,
        backend: {}, // default: reservation "confirmed", not cancelled
        type: "RESERVATION_STATUS",
        subject: "r-7",
        value: { statusLine: "confirmada" },
        owned: ["r-7"],
      });
      expect(verdict).toBe("VALIDATED");
    });

    it("a TRUTHFUL cancelled reservation VALIDATES (no tautological self-demotion)", async () => {
      const { verdict } = await investigateThenValidate({
        plan: RESERVATION_PLAN,
        backend: {
          readReservation: async (reservationId) => ({
            reservationId,
            status: "cancelled",
            partySize: 4,
            statusLine: "cancelada",
          }),
        },
        type: "RESERVATION_STATUS",
        subject: "r-7",
        value: { statusLine: "cancelada" },
        owned: ["r-7"],
      });
      expect(verdict).toBe("VALIDATED");
    });
  });

  // ── KEY-LOCKSTEP PIN (risk #2) ──────────────────────────────────────────────────
  //
  // The investigator's recorded falsifier key MUST equal the registry's parameterized
  // falsifier key (`${base}:${subject}`), or the kernel's `resolveAgainstFalsifiers`
  // looks up a DIFFERENT key, finds it absent, and the arm is SILENTLY INERT. This
  // resolves the expected keys through the REAL production path (`selectCandidateClaim`
  // → `parameterizeKeysBySubject`) and asserts the investigator recorded under EXACTLY
  // those keys — a suffix change on EITHER side (registry base OR investigator builder)
  // fails this test.
  it("KEY-LOCKSTEP: the investigator records under EXACTLY the parameterized registry falsifier keys", async () => {
    const ledger = new EvidenceLedger("t");
    const investigator = createIbatexasInvestigator({
      // Force EVERY falsifier to fire so each key is PRESENT (recorded) in the ledger.
      gatherReads: createFirstPartyTurnReads(
        stubBackend({
          readPaymentRefund: async (orderId) => ({
            orderId,
            refunded: true,
            refundedAmountCentavos: 100,
            status: "partially_refunded",
          }),
          readPaymentChargeback: async (orderId) => ({ orderId, disputed: true, status: "disputed" }),
        }),
      ),
      now: () => 999,
    });
    const plan: Plan = {
      envelopes: [
        { kind: "order.cancel", payload: { orderId: "order-42" } } as unknown as Plan["envelopes"][number],
      ],
      readToolCalls: [{ name: "reservation.lookup", input: { reservationId: "r-7" } }],
    };
    await investigator.investigate(triadInput(plan, ledger));
    const recorded = new Set(ledger.keys());

    const falsifierKeysFor = (type: string, subject: string): string[] => {
      const candidate = selectCandidateClaim({
        type,
        subject,
        actor: { principal: "cust-1" },
        value: undefined,
      });
      return (candidate!.soundness.falsifiers ?? []).map((f) => f.key);
    };

    // PAYMENT_STATUS's falsifiers are keyed by the ORDER subject (payment_status is).
    const paymentFalsifierKeys = falsifierKeysFor("PAYMENT_STATUS", "order-42");
    const orderFalsifierKeys = falsifierKeysFor("ORDER_FULFILLMENT_STAGE", "order-42");
    const reservationFalsifierKeys = falsifierKeysFor("RESERVATION_STATUS", "r-7");

    // Every REAL parameterized PAYMENT falsifier key was recorded (lockstep).
    for (const key of paymentFalsifierKeys) {
      expect(recorded.has(key)).toBe(true);
    }
    // Non-vacuity — the parameterized keys ARE the expected `${base}:${subject}` forms.
    expect(paymentFalsifierKeys).toEqual(
      expect.arrayContaining(["payment_refund:order-42", "payment_chargeback:order-42"]),
    );
    // REVIEW RULING PIN (2026-07-17): the cancellation falsifiers stay DECLARED in
    // the registry (their parameterized keys exist) but are DELIBERATELY UNREAD —
    // the investigator must NOT record them (same-row tautology; see
    // claim-registry.ts + BKL-160). A future INDEPENDENT cancellation signal
    // flips these expectations.
    expect(orderFalsifierKeys).toContain("order_cancelled:order-42");
    expect(reservationFalsifierKeys).toContain("reservation_cancelled:r-7");
    expect(recorded.has("order_cancelled:order-42")).toBe(false);
    expect(recorded.has("reservation_cancelled:r-7")).toBe(false);
  });
});
