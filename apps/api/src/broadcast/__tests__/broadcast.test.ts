// Tests for the broadcast orchestrator + opt-out store (D3). Pure + fake-redis.

import { describe, it, expect, vi } from "vitest";
import { runBroadcast } from "../broadcast.js";
import {
  createBroadcastOptOutStore,
  shouldSuppressPromotionalSend,
  type BroadcastConsentDb,
} from "../broadcast-optout.js";

describe("runBroadcast (D3)", () => {
  it("sends to each non-opted-out recipient and returns aggregate counts", async () => {
    const send = vi.fn(async () => {});
    const result = await runBroadcast({
      recipients: ["+5511111111111", "+5522222222222", "+5533333333333"],
      template: "Promoção!",
      send,
      isOptedOut: async (r) => r === "+5522222222222",
    });
    expect(result).toMatchObject({ total: 3, sent: 2, skipped: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalledWith("+5522222222222", "Promoção!");
    expect(result.results.find((r) => r.recipient === "+5522222222222")?.status).toBe(
      "skipped_opted_out",
    );
  });

  it("records a per-recipient failure without aborting the blast", async () => {
    const send = vi.fn(async (recipient: string) => {
      if (recipient === "+5511111111111") throw new Error("twilio 21610");
    });
    const result = await runBroadcast({
      recipients: ["+5511111111111", "+5522222222222"],
      template: "oi",
      send,
      isOptedOut: async () => false,
    });
    expect(result).toMatchObject({ total: 2, sent: 1, failed: 1, skipped: 0 });
    expect(result.results.find((r) => r.status === "failed")?.error).toContain("21610");
  });

  it("dedups recipients and caps the segment size", async () => {
    const send = vi.fn(async () => {});
    const result = await runBroadcast({
      recipients: ["+551", "+551", "+552", "+553"],
      template: "x",
      send,
      isOptedOut: async () => false,
      maxRecipients: 2,
    });
    // dedup → [+551,+552,+553], cap 2 → [+551,+552]
    expect(result.total).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

function fakeConsentDb(): BroadcastConsentDb {
  const opted = new Map<string, boolean>();
  return {
    async getOptedOut(phone) {
      return opted.get(phone) ?? false;
    },
    async setOptedOut(phone, optedOut) {
      opted.set(phone, optedOut);
    },
    async listOptedOut() {
      return [...opted.entries()].filter(([, v]) => v).map(([k]) => k);
    },
  };
}

describe("broadcast opt-out store (D3)", () => {
  it("opt-out then isOptedOut is true; opt-in clears it", async () => {
    const store = createBroadcastOptOutStore(fakeConsentDb());
    expect(await store.isOptedOut("+551")).toBe(false);
    await store.optOut("+551");
    expect(await store.isOptedOut("+551")).toBe(true);
    expect(await store.list()).toEqual(["+551"]);
    await store.optIn("+551");
    expect(await store.isOptedOut("+551")).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("matches opt-out across phone FORMATS (WS3B — closes the silent bypass)", async () => {
    const store = createBroadcastOptOutStore(fakeConsentDb());
    // Opt out using a spaced/dashed form…
    await store.optOut("+55 11 99999-0000");
    // …a blast listing the bare E.164 form must STILL be skipped (both canonicalize).
    expect(await store.isOptedOut("+5511999990000")).toBe(true);
    // The 'whatsapp:' channel prefix is normalized away too.
    expect(await store.isOptedOut("whatsapp:+5511999990000")).toBe(true);
    // Stored canonically, so opt-in with a formatted variant clears it.
    await store.optIn("+55 (11) 99999-0000");
    expect(await store.isOptedOut("+5511999990000")).toBe(false);
  });
});

// Mirrors PROMOTIONAL_NOTIFICATION_TYPES in cart-intelligence.ts — the call-site
// allowlist that decides whether shouldSuppressPromotionalSend is even consulted.
const PROMOTIONAL_TYPES = new Set(["cart_abandoned", "loyalty_reward", "follow_up"]);

describe("shouldSuppressPromotionalSend (WS3 send-time consent gate — LGPD)", () => {
  it("suppresses a promotional send to an opted-out recipient", async () => {
    const store = createBroadcastOptOutStore(fakeConsentDb());
    await store.optOut("+5511999990000");
    expect(await shouldSuppressPromotionalSend("+5511999990000", undefined, store)).toBe(true);
  });

  it("does not suppress when the recipient has NOT opted out", async () => {
    const store = createBroadcastOptOutStore(fakeConsentDb());
    expect(await shouldSuppressPromotionalSend("+5511999990000", undefined, store)).toBe(false);
  });

  it("never suppresses a TRANSACTIONAL type, even for an opted-out recipient", async () => {
    const store = createBroadcastOptOutStore(fakeConsentDb());
    await store.optOut("+5511999990000");
    // The call site only invokes the gate for promotional types. A transactional
    // type (payment_expired) short-circuits the allowlist → always sends.
    const gate = async (type: string, phone: string) =>
      PROMOTIONAL_TYPES.has(type) &&
      (await shouldSuppressPromotionalSend(phone, undefined, store));
    expect(await gate("payment_expired", "+5511999990000")).toBe(false);
    expect(await gate("order_confirmed", "+5511999990000")).toBe(false);
    // …while a promotional type to the same opted-out recipient IS suppressed.
    expect(await gate("cart_abandoned", "+5511999990000")).toBe(true);
  });

  it("FAILS OPEN (sends) and logs a warning when the consent read throws", async () => {
    const throwingStore = createBroadcastOptOutStore({
      getOptedOut: async () => {
        throw new Error("pg 57P01 — DB blip");
      },
      setOptedOut: async () => {},
      listOptedOut: async () => [],
    });
    const log = { warn: vi.fn() };
    expect(await shouldSuppressPromotionalSend("+5511999990000", log, throwingStore)).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
