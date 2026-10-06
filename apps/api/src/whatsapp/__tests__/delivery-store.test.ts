// LE2-030 — the whatsapp_delivery writer.
//
// Everything external is mocked: the store is driven through its
// `__setDeliveryStorePoolForTests` seam, so no DB and no network is touched
// (CLAUDE.md module-system rule: "No DB or network — mock everything external").

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __setDeliveryStorePoolForTests,
  FAILED_WHATSAPP_STATUSES,
  isFailedWhatsAppStatus,
  isTerminalWhatsAppStatus,
  normalizeWhatsAppStatus,
  recordDeliveryStatus,
  recordOutboundSid,
  WHATSAPP_STATUS_RANK,
  whatsAppStatusRank,
} from "../delivery-store.js";

interface Call {
  sql: string;
  params: ReadonlyArray<unknown>;
}

/** An in-memory stand-in for the single row `whatsapp_delivery` holds per SID —
 *  enough to reproduce the rank-guarded UPDATE the real SQL performs. */
interface Row {
  status: string | null;
  callbackCount: number;
}

const calls: Call[] = [];
let rows: Map<string, Row>;

/** Fake pool: records every statement, and simulates the two statements the
 *  store issues (INSERT … ON CONFLICT DO NOTHING, and the rank-guarded UPDATE). */
function fakePool() {
  return {
    async query(sql: string, params: ReadonlyArray<unknown> = []) {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO whatsapp_delivery")) {
        const sid = params[0] as string;
        if (!rows.has(sid)) rows.set(sid, { status: null, callbackCount: 0 });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE whatsapp_delivery")) {
        const sid = params[0] as string;
        const incomingRank = params[1] as number;
        const incomingStatus = params[2] as string;
        const row = rows.get(sid);
        if (row === undefined) return { rowCount: 0, rows: [] };
        row.callbackCount += 1;
        // The rank guard, exactly as the CASE expressions encode it.
        if (incomingRank > whatsAppStatusRank(row.status)) row.status = incomingStatus;
        return { rowCount: 1, rows: [{ status: row.status }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  rows = new Map();
  __setDeliveryStorePoolForTests(fakePool());
});

afterEach(() => {
  __setDeliveryStorePoolForTests(null);
  vi.unstubAllEnvs();
});

// ── status vocabulary ────────────────────────────────────────────────────────

describe("delivery-store — Twilio status vocabulary", () => {
  it("normalizes case + whitespace and rejects anything off the map", () => {
    expect(normalizeWhatsAppStatus("Delivered")).toBe("delivered");
    expect(normalizeWhatsAppStatus("  SENT ")).toBe("sent");
    expect(normalizeWhatsAppStatus("teleported")).toBeNull();
    expect(normalizeWhatsAppStatus(undefined)).toBeNull();
    expect(normalizeWhatsAppStatus(42)).toBeNull();
  });

  it("never inherits a prototype key as a valid status (hasOwnProperty guard)", () => {
    expect(normalizeWhatsAppStatus("constructor")).toBeNull();
    expect(normalizeWhatsAppStatus("toString")).toBeNull();
  });

  it("ranks failures above every success status", () => {
    for (const failed of FAILED_WHATSAPP_STATUSES) {
      expect(whatsAppStatusRank(failed)).toBeGreaterThan(whatsAppStatusRank("delivered"));
      expect(whatsAppStatusRank(failed)).toBeGreaterThan(whatsAppStatusRank("read"));
    }
    expect(whatsAppStatusRank("delivered")).toBeGreaterThan(whatsAppStatusRank("sent"));
    expect(whatsAppStatusRank(null)).toBe(0);
  });

  it("classifies terminal + failed statuses", () => {
    expect(isTerminalWhatsAppStatus("delivered")).toBe(true);
    expect(isTerminalWhatsAppStatus("failed")).toBe(true);
    expect(isTerminalWhatsAppStatus("sent")).toBe(false);
    expect(isTerminalWhatsAppStatus(null)).toBe(false);
    expect(isFailedWhatsAppStatus("undelivered")).toBe(true);
    expect(isFailedWhatsAppStatus("delivered")).toBe(false);
  });

  it("keeps every rank key to a safe [a-z] shape — the CASE builder interpolates them", () => {
    for (const key of Object.keys(WHATSAPP_STATUS_RANK)) {
      expect(key).toMatch(/^[a-z]+$/);
    }
  });
});

// ── AC1: SID persisted on send ───────────────────────────────────────────────

describe("delivery-store — recordOutboundSid (AC1)", () => {
  it("persists the SID with its turn + part correlation", async () => {
    await recordOutboundSid({
      messageSid: "SM_part0",
      turnId: "turn-abc",
      conversationId: "conv-1",
      partIndex: 0,
      phoneHash: "hash-1",
      source: "send",
      sentAt: "2026-07-24T10:00:00.000Z",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("INSERT INTO whatsapp_delivery");
    expect(calls[0]!.sql).toContain("ON CONFLICT (message_sid) DO NOTHING");
    expect(calls[0]!.params).toEqual([
      "SM_part0",
      "turn-abc",
      "conv-1",
      0,
      "hash-1",
      "send",
      "2026-07-24T10:00:00.000Z",
    ]);
  });

  it("records a send with no conductor turn (job/alert) as a NULL turn_id", async () => {
    await recordOutboundSid({
      messageSid: "SM_job",
      partIndex: 0,
      sentAt: "2026-07-24T10:00:00.000Z",
    });
    expect(calls[0]!.params.slice(1, 3)).toEqual([null, null]);
  });

  it("is fail-open: a store outage never throws into the send path", async () => {
    __setDeliveryStorePoolForTests({
      async query() {
        throw new Error("connection refused");
      },
    });
    await expect(
      recordOutboundSid({ messageSid: "SM_x", partIndex: 0, sentAt: "2026-07-24T10:00:00.000Z" }),
    ).resolves.toBeUndefined();
  });

  it("no-ops entirely when DATABASE_URL is unset (never dials localhost)", async () => {
    __setDeliveryStorePoolForTests(null);
    vi.stubEnv("DATABASE_URL", "");
    await expect(
      recordOutboundSid({ messageSid: "SM_y", partIndex: 0, sentAt: "2026-07-24T10:00:00.000Z" }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

// ── AC2: callbacks correlate by SID and record transitions ───────────────────

describe("delivery-store — recordDeliveryStatus (AC2)", () => {
  const send = (sid: string) =>
    recordOutboundSid({ messageSid: sid, partIndex: 0, sentAt: "2026-07-24T10:00:00.000Z" });

  it("records a status transition against the SID's row", async () => {
    await send("SM_1");
    const outcome = await recordDeliveryStatus({
      messageSid: "SM_1",
      status: "delivered",
      at: "2026-07-24T10:00:05.000Z",
    });
    expect(outcome).toBe("applied");
    expect(rows.get("SM_1")).toEqual({ status: "delivered", callbackCount: 1 });
  });

  it("advances through the normal lifecycle sent → delivered", async () => {
    await send("SM_2");
    expect(await recordDeliveryStatus({ messageSid: "SM_2", status: "sent", at: "t1" })).toBe("applied");
    expect(rows.get("SM_2")!.status).toBe("sent");
    expect(await recordDeliveryStatus({ messageSid: "SM_2", status: "delivered", at: "t2" })).toBe("applied");
    expect(rows.get("SM_2")!.status).toBe("delivered");
  });

  it("keeps the terminal status when an out-of-order `sent` lands after `delivered`", async () => {
    await send("SM_3");
    await recordDeliveryStatus({ messageSid: "SM_3", status: "delivered", at: "t2" });
    const outcome = await recordDeliveryStatus({ messageSid: "SM_3", status: "sent", at: "t1" });

    expect(outcome).toBe("stale");
    // The terminal status stands; only the callback counter moved.
    expect(rows.get("SM_3")).toEqual({ status: "delivered", callbackCount: 2 });
  });

  it("lets a failure overrule an earlier success (failures outrank)", async () => {
    await send("SM_4");
    await recordDeliveryStatus({ messageSid: "SM_4", status: "delivered", at: "t1" });
    const outcome = await recordDeliveryStatus({
      messageSid: "SM_4",
      status: "failed",
      at: "t2",
      errorCode: "63016",
      errorMessage: "Failed to send freeform message",
    });
    expect(outcome).toBe("applied");
    expect(rows.get("SM_4")!.status).toBe("failed");
  });

  it("persists the failure reason alongside the status", async () => {
    await send("SM_5");
    await recordDeliveryStatus({
      messageSid: "SM_5",
      status: "undelivered",
      at: "t1",
      errorCode: "63024",
      errorMessage: "Invalid recipient",
    });
    const update = calls.find((c) => c.sql.includes("UPDATE whatsapp_delivery"))!;
    expect(update.params).toEqual(["SM_5", 6, "undelivered", "t1", "63024", "Invalid recipient"]);
  });

  it("is a no-op for an unknown SID (never sent by us)", async () => {
    const outcome = await recordDeliveryStatus({
      messageSid: "SM_never_sent",
      status: "delivered",
      at: "t1",
    });
    expect(outcome).toBe("unknown");
    expect(rows.size).toBe(0);
  });

  it("reports `error` — never throws — when the store is unreachable", async () => {
    __setDeliveryStorePoolForTests({
      async query() {
        throw new Error("connection refused");
      },
    });
    await expect(
      recordDeliveryStatus({ messageSid: "SM_6", status: "delivered", at: "t1" }),
    ).resolves.toBe("error");
  });

  it("folds the rank comparison into ONE statement (no read-modify-write)", async () => {
    await send("SM_7");
    calls.length = 0;
    await recordDeliveryStatus({ messageSid: "SM_7", status: "delivered", at: "t1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("UPDATE whatsapp_delivery");
    expect(calls[0]!.sql).toContain("callback_count = callback_count + 1");
    // The stored-rank CASE is generated from WHATSAPP_STATUS_RANK.
    expect(calls[0]!.sql).toContain("WHEN 'delivered' THEN 4");
  });
});
