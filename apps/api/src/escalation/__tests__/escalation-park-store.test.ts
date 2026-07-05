// AUT-017 — escalation park store: single-use consume, TTL, rk() key shape.
// Fake-redis (set-with-EX + get + Lua GET+DEL eval); no live Redis.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Capture what the store writes to Redis so the key shape + TTL are assertable.
interface Entry {
  value: string;
  ttl: number;
}
const store = new Map<string, Entry>();

const redisStub = {
  async set(key: string, value: string, opts?: { EX?: number }) {
    store.set(key, { value, ttl: opts?.EX ?? -1 });
  },
  async get(key: string) {
    return store.get(key)?.value ?? null;
  },
  // Emulate the CONSUME_PARK_SCRIPT (atomic GET+DEL).
  async eval(_script: string, args: { keys: string[] }) {
    const key = args.keys[0]!;
    const e = store.get(key);
    if (!e) return null;
    store.delete(key);
    return e.value;
  },
};

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => redisStub),
  rk: (key: string) => `test:${key}`,
}));

import {
  createEscalationParkStore,
  getEscalationParkTtlSeconds,
  type ParkedEscalationIntent,
} from "../escalation-park-store.js";

function sampleInput(): Omit<ParkedEscalationIntent, "token"> {
  return {
    sessionId: "admin:owner1",
    intentKind: "payment.refund.issue",
    intentHash: "sha256:abc",
    summaryPtBr: "reembolso de R$ 1.500,00",
    proposerId: "owner1",
    envelopeKind: "payment.refund.issue",
    payload: { paymentId: "pay_1", refundAmountCentavos: 150_000 },
    nonce: "n-1",
    actorSessionId: "admin:owner1",
    actorPrincipal: "user",
    actorRole: "OWNER",
    taint: "UNTRUSTED",
    requestedAt: "2026-07-04T12:00:00.000Z",
  };
}

describe("AUT-017 escalation park store", () => {
  beforeEach(() => {
    store.clear();
    delete process.env.ESCALATION_PARK_TTL_SECONDS;
  });

  it("park() stores under an rk()-namespaced escalation:park:<token> key with a TTL", async () => {
    const parkStore = createEscalationParkStore();
    const { token, ttlSeconds } = await parkStore.park(sampleInput());
    expect(token).toBeTruthy();
    expect(ttlSeconds).toBe(86_400); // default 24h
    const key = `test:escalation:park:${token}`;
    expect(store.has(key)).toBe(true);
    expect(store.get(key)!.ttl).toBe(86_400);
    // The stored record is self-describing (carries its own token).
    const record = JSON.parse(store.get(key)!.value) as ParkedEscalationIntent;
    expect(record.token).toBe(token);
    expect(record.actorRole).toBe("OWNER"); // role round-trips for staffRoleGuard
  });

  it("get() peeks WITHOUT consuming (TTL untouched, second get still returns it)", async () => {
    const parkStore = createEscalationParkStore();
    const { token } = await parkStore.park(sampleInput());
    const first = await parkStore.get(token);
    expect(first?.intentHash).toBe("sha256:abc");
    // Still present — get did not delete.
    const second = await parkStore.get(token);
    expect(second?.intentHash).toBe("sha256:abc");
  });

  it("consume() is single-use: the FIRST returns the record, the SECOND returns null", async () => {
    const parkStore = createEscalationParkStore();
    const { token } = await parkStore.park(sampleInput());
    const first = await parkStore.consume(token);
    expect(first?.proposerId).toBe("owner1");
    const second = await parkStore.consume(token);
    expect(second).toBeNull();
  });

  it("consume()/get() return null for an unknown or implausible token", async () => {
    const parkStore = createEscalationParkStore();
    expect(await parkStore.consume("does-not-exist")).toBeNull();
    expect(await parkStore.get("")).toBeNull();
  });

  it("ESCALATION_PARK_TTL_SECONDS overrides the default TTL", async () => {
    process.env.ESCALATION_PARK_TTL_SECONDS = "3600";
    expect(getEscalationParkTtlSeconds()).toBe(3600);
    const parkStore = createEscalationParkStore();
    const { token, ttlSeconds } = await parkStore.park(sampleInput());
    expect(ttlSeconds).toBe(3600);
    expect(store.get(`test:escalation:park:${token}`)!.ttl).toBe(3600);
  });
});
