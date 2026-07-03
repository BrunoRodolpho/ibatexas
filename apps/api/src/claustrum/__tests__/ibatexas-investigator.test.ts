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
    readOrderFulfillment: async (orderId) => ({ orderId, fulfillmentStatus: "preparing" }),
    readPaymentStatus: async (orderId) => ({ orderId, status: "paid", method: "pix" }),
    readReservation: async (reservationId) => ({
      reservationId,
      status: "confirmed",
      partySize: 4,
    }),
    // FIX 2 — default: no auto-enumerated active orders (tests that exercise the
    // owner-order enumeration override this).
    listActiveOrderIds: async () => [],
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
    expect(pay.entry?.value).toEqual({ orderId: "order-42", status: "paid", method: "pix" });

    const ful = ledger.resolve("order_fulfillment_stage:order-42");
    expect(ful.state).toBe("present");
    expect(ful.entry?.value).toEqual({ orderId: "order-42", fulfillmentStatus: "preparing" });
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
    expect(res.entry?.value).toEqual({ reservationId: "r-7", status: "confirmed", partySize: 4 });
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
