// AUT-017 — escalation park store: consume/peek shape, TTL, rk() key shape.
//
// ── M2: the Lua emulation is GONE (census class (i), item 3) ────────────────
//
// Ruling: docs/architecture/redis-lua-testing-decision.md (Q2). Census:
// `apps/api/src/__tests__/helpers/redis-double-census.md`.
//
// This stub's `eval` used to re-implement CONSUME_PARK_SCRIPT as an
// unconditional Map GET+DEL — script-blind (it never looked at the script it
// was handed) and unable to fail the race it existed to win, because there is
// no race inside one JS process. It is replaced by a `createLuaCallObserver`,
// which records the call and returns a reply this file DECLARES.
//
// Where the invariant went: "the receipt is redeemed AT MOST ONCE" is
// `apps/api/src/__tests__/lua-shape-consume-contract.test.ts`, which EVALs THIS
// site's own script text against a real Redis — 20 concurrent redemptions,
// exactly one winner — with a non-atomic control that demonstrates the defect
// the Lua prevents. What stays here is the store's SHAPE: which script it
// issues, against which key, and how it parses what comes back.
//
// (The second fiction the census recorded — `set` returning `undefined` where
// node-redis returns `"OK"` — is fixed below.)

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createLuaCallObserver,
  expectLuaCall,
  expectLuaCallCount,
  type LuaSiteRef,
} from "../../__tests__/helpers/lua-call-observer.js";

/** The production CONSUME site this store runs — the shape suite's anchor. */
const CONSUME_SITE: LuaSiteRef = {
  file: "apps/api/src/escalation/escalation-park-store.ts",
  anchor: "const CONSUME_PARK_SCRIPT =",
};

// Capture what the store writes to Redis so the key shape + TTL are assertable.
interface Entry {
  value: string;
  ttl: number;
}
const store = new Map<string, Entry>();

/** Declared-reply observer; default nil = "no receipt under that key". */
const lua = createLuaCallObserver(null);

const redisStub = {
  async set(key: string, value: string, opts?: { EX?: number }) {
    store.set(key, { value, ttl: opts?.EX ?? -1 });
    return "OK"; // node-redis answers "OK", not undefined
  },
  async get(key: string) {
    return store.get(key)?.value ?? null;
  },
  eval: lua.eval,
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
    lua.reset();
    lua.reply(null);
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

  // ── The consume seam (M2) ────────────────────────────────────────────────
  //
  // RENAMED from "consume() is single-use: the FIRST returns the record, the
  // SECOND returns null". That name claimed a property this file no longer
  // proves and never really did: single-use is the CONSUME script's, and it is
  // proven in `lua-shape-consume-contract.test.ts` — 20 concurrent redemptions
  // of this site's own script text against a real Redis, exactly one winner,
  // beside a non-atomic control that shows the same setup handing the receipt
  // to several callers. The two cases below are what remains true here.

  it("consume() issues THIS site's CONSUME script against the rk()-namespaced park key", async () => {
    const parkStore = createEscalationParkStore();
    const { token } = await parkStore.park(sampleInput());

    await parkStore.consume(token);

    // The bytes matter, not just the round trip: this is the site's own
    // CONSUME_PARK_SCRIPT — the same anchor the shape suite reads. Were this
    // store to start eval'ing something else (a CAD, say, whose contract is
    // the INVERSE — delete only on an ownership match, return 1/0), it would
    // red here, while the shape suite, still reading the anchor, would not.
    expectLuaCallCount(lua, 1);
    expectLuaCall(lua, 0, {
      site: CONSUME_SITE,
      keys: [`test:escalation:park:${token}`],
      arguments: [], // the script takes no ARGV
    });
  });

  it("consume() parses the record the script returned, and answers null once it returns nil", async () => {
    const parkStore = createEscalationParkStore();
    const { token } = await parkStore.park(sampleInput());

    // Declared postcondition #1: the receipt was there, so CONSUME hands back
    // the stored JSON. (What the store WROTE is asserted by the park() case.)
    lua.replyOnce(store.get(`test:escalation:park:${token}`)!.value);
    const first = await parkStore.consume(token);
    expect(first?.proposerId).toBe("owner1");

    // Declared postcondition #2: it was redeemed, so the next CONSUME returns
    // nil — the shape suite's property, stated here as an input rather than
    // computed by a Map that cannot lose a race.
    const second = await parkStore.consume(token);
    expect(second).toBeNull();
  });

  it("consume()/get() return null for an unknown or implausible token", async () => {
    const parkStore = createEscalationParkStore();
    expect(await parkStore.consume("does-not-exist")).toBeNull();
    expect(await parkStore.get("")).toBeNull();
    // The plausibility gate short-circuits `get("")` before any round trip,
    // and the unknown-token consume is the ONE Lua call this case makes.
    expectLuaCallCount(lua, 1);
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
