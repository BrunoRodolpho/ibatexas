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
import { EvidenceLedger } from "@adjudicate/core";
import type { CognitiveState, Plan } from "@claustrum/core";
import type { InvestigateInput } from "@claustrum/core";
import {
  createIbatexasInvestigator,
  defaultTurnReads,
  type TurnRead,
} from "../ibatexas-investigator.js";

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
    expect(first?.originProvenance).toBe("TRUSTED");
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
