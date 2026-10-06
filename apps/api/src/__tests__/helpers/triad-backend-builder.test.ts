// triad-backend-builder.test.ts — the RUNTIME half of the builder's contract
// (R5-S3). The COMPILE half — a mis-shaped read must not typecheck — lives in
// `triad-backend-builder.type-coverage.test-d.ts`, which tsc evaluates and Vitest
// never executes. This file pins what tsc cannot see: that an undeclared read
// throws LOUDLY naming itself, that a declared read wins, and that the census
// tracks the real interface method-for-method.

import { describe, expect, it } from "vitest";
import {
  buildTriadReadBackend,
  TRIAD_READ_METHOD_NAMES,
} from "./triad-backend-builder.js";

/**
 * The 18 methods of `TriadReadBackend` (turn-reads.ts), enumerated INDEPENDENTLY of
 * the builder. Written out by hand on purpose: deriving it from the builder's own
 * defaults would make the census test a tautology (it would agree with any object
 * the builder happened to produce). This list is the second witness.
 */
const EXPECTED_METHODS = [
  "readSchedule",
  "readScheduleOverride",
  "readStoreHours",
  "readHoliday",
  "readHoursForDate",
  "readHolidayForDate",
  "readScheduleOverrideForDate",
  "readOrderFulfillment",
  "readPaymentStatus",
  "readReservation",
  "readPaymentRefund",
  "readPaymentChargeback",
  "readCartContents",
  "readOrderHistory",
  "readPaymentHistory",
  "listActiveOrderIds",
  "listActiveReservationIds",
  "countActivePayments",
] as const;

describe("buildTriadReadBackend — the 18-method census", () => {
  it("covers every TriadReadBackend method, and only those", () => {
    expect([...TRIAD_READ_METHOD_NAMES].sort()).toEqual([...EXPECTED_METHODS].sort());
    expect(EXPECTED_METHODS).toHaveLength(18);
  });

  it("returns a callable for every method with no overrides at all", () => {
    const backend = buildTriadReadBackend();
    for (const name of EXPECTED_METHODS) {
      expect(typeof backend[name], `${name} must be present`).toBe("function");
    }
  });
});

describe("buildTriadReadBackend — the notUsed default", () => {
  it("throws a message NAMING the undeclared read, rather than returning a value", async () => {
    // The failure mode the discipline exists to prevent: an unexpected read that
    // resolves to a fabricated value, letting a suite prove a claim off evidence it
    // never legitimately gathered. It must reject, and the rejection must say which
    // read fired so the diagnosis needs no bisect.
    const backend = buildTriadReadBackend();
    await expect(backend.readPaymentChargeback("order-1", "cust-1")).rejects.toThrow(
      "turn-reads.readPaymentChargeback must not run in this suite",
    );
    await expect(backend.readStoreHours()).rejects.toThrow(
      "turn-reads.readStoreHours must not run in this suite",
    );
  });

  it("names each undeclared read distinctly — no shared/generic message", async () => {
    const backend = buildTriadReadBackend();
    const messages = await Promise.all(
      EXPECTED_METHODS.map(async (name) => {
        try {
          // Every method takes 0–2 string args; extra args are ignored by the thrower.
          await (backend[name] as (...a: unknown[]) => Promise<unknown>)("a", "b");
          return `${name}: DID NOT THROW`;
        } catch (e) {
          return (e as Error).message;
        }
      }),
    );
    expect(messages).toEqual(
      EXPECTED_METHODS.map((n) => `turn-reads.${n} must not run in this suite`),
    );
    expect(new Set(messages).size).toBe(EXPECTED_METHODS.length);
  });
});

describe("buildTriadReadBackend — overrides", () => {
  it("uses the declared read and leaves every other read throwing", async () => {
    const backend = buildTriadReadBackend({
      readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
    });
    await expect(backend.readStoreHours()).resolves.toEqual({
      hoursText: "11h–15h / 18h–23h",
    });
    // The un-declared neighbour is NOT quietly defaulted to a benign value.
    await expect(backend.readHoliday()).rejects.toThrow(
      "turn-reads.readHoliday must not run in this suite",
    );
  });

  it("passes the investigator's arguments through to the declared handler", async () => {
    // Owner-scoping is the whole point of these reads (Inv 2/13): a suite asserting
    // "a FOREIGN id never reached the read" needs the ids it was called with, so the
    // builder must not swallow or reorder them.
    const seen: Array<[string, string]> = [];
    const backend = buildTriadReadBackend({
      readOrderFulfillment: async (orderId, customerId) => {
        seen.push([orderId, customerId]);
        return { orderId, displayId: 1042, fulfillmentStatus: "preparing" };
      },
    });
    await backend.readOrderFulfillment("order-9", "cust-7");
    expect(seen).toEqual([["order-9", "cust-7"]]);
  });

  it("threads per-drive mutable state, so a suite's hoisted box still drives reads", async () => {
    // The `vi.hoisted` box pattern the migrated suites depend on: the handler is an
    // ordinary closure, so state flipped between drives is observed on the next read
    // WITHOUT rebuilding the backend.
    const st = { orderIds: [] as string[] };
    const backend = buildTriadReadBackend({
      listActiveOrderIds: async () => [...st.orderIds],
    });
    await expect(backend.listActiveOrderIds("cust-1")).resolves.toEqual([]);
    st.orderIds.push("order-1");
    await expect(backend.listActiveOrderIds("cust-1")).resolves.toEqual(["order-1"]);
  });

  it("returns a FRESH object per call, matching production's per-turn instance", async () => {
    // `createDomainTriadReadBackend` is called once per turn and memoizes reads on the
    // instance; a shared double would leak one turn's memo into the next.
    const overrides = { readStoreHours: async () => ({ hoursText: "10h–22h" }) };
    expect(buildTriadReadBackend(overrides)).not.toBe(buildTriadReadBackend(overrides));
  });
});
