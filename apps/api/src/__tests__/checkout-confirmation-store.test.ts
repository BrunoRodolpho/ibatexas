// Unit tests for the customer checkout confirmation store.
//
// Mirrors the admin-confirmation-store coverage (create / single-use
// consume / expired→null) but Docker-free: a Map-backed mock Redis stands
// in for the real client, and `eval` emulates the atomic GET+DEL Lua so the
// single-use invariant is exercised end-to-end.
//
// ── R5 rollout — the module interception is GONE ──────────────────────────
//
// This file used to `vi.mock("@ibatexas/tools")` to reach the client, which
// also replaced `rk` with `(key) => "ibatexas:" + key`. The store now takes a
// client RESOLVER through `CheckoutConfirmationStoreOptions`, so the double is
// handed in as an argument and the real module is imported.
//
// The faked `rk` was a genuine wrong-prefix fiction: the REAL `rk` under
// apps/api's vitest answers `development:` (no `APP_ENV` is pinned here), so
// the key this file asserted was one production never writes. It is now derived
// by CALLING the real `rk`.
//
// ── Why the double is NOT `createInMemoryRedis` ───────────────────────────
//
// `consume` runs a Lua script. Per W4 RULE 3 the canonical adapter REFUSES
// `eval` outright (`LuaAtomicityNotEmulated`) rather than deciding a
// server-side atomic GET+DEL inside this process.
//
// ── M2: the Lua emulation is GONE (census class (i), item 4) ──────────────
//
// Ruling: docs/architecture/redis-lua-testing-decision.md (Q2). Census:
// `apps/api/src/__tests__/helpers/redis-double-census.md`.
//
// The header above used to end "...against a double that admits it is
// emulating". Admitting it was never a defence: the emulation still DECIDED
// the single-use drain, and a case named for that property was proving a
// property of four lines of test-local JavaScript.
//
// Where the invariant went: `lua-shape-consume-contract.test.ts` reads THIS
// site's `CONSUME_RECEIPT_SCRIPT` text and runs it against a real Redis — 20
// concurrent redemptions, exactly one winner, with a non-atomic control
// (client-side GET-then-DEL, i.e. precisely what the retired double did) that
// shows the same setup handing one receipt to several callers.
//
// What stays here is the store's SHAPE: receipt id, TTL, which script goes to
// which key, the malformed-input gate, and the client seam.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { rk } from "@ibatexas/tools";
import {
  createLuaCallObserver,
  expectLuaCall,
  expectLuaCallCount,
  type LuaSiteRef,
} from "./helpers/lua-call-observer.js";
import {
  createCheckoutConfirmationStore,
  CHECKOUT_CONFIRMATION_TTL_SECONDS,
  type CheckoutConfirmationRedis,
  type PendingCheckout,
} from "../routes/checkout-confirmation-store.js";

/** The production CONSUME site this store runs — the shape suite's anchor. */
const CONSUME_SITE: LuaSiteRef = {
  file: "apps/api/src/routes/checkout-confirmation-store.ts",
  anchor: "const CONSUME_RECEIPT_SCRIPT =",
};

// Map-backed Redis for the non-atomic commands; `eval` is OBSERVED, not
// emulated — it records the call and returns a reply each case declares.
function makeStatefulRedis() {
  const store = new Map<string, string>();
  const lua = createLuaCallObserver(null); // default nil = "no such receipt"
  return {
    store,
    lua,
    set: vi.fn(async (key: string, val: string) => {
      store.set(key, val);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    eval: lua.eval,
  };
}

const PENDING: PendingCheckout = {
  kind: "order.checkout.create",
  payload: { cartId: "cart_01", paymentMethod: "pix" },
  idempotencyKey: "cart_01:checkout",
  cartId: "cart_01",
  customerId: "cus_01",
  userType: "customer",
  checkoutBody: { cartId: "cart_01", paymentMethod: "pix", notes: "sem cebola" },
  pixExtra: { customerName: "Ana", customerEmail: "ana@example.com", customerTaxId: "52998224725" },
  prompt: "Confirmar pedido de R$ 1.500,00?",
  createdAt: "2026-06-08T12:00:00.000Z",
};

/** The key the store computes — through the REAL `rk`. */
const receiptKey = (id: string) => rk(`checkout:confirmation:${id}`);

describe("checkout-confirmation-store", () => {
  let redis: ReturnType<typeof makeStatefulRedis>;
  /** Counts resolutions through the seam. */
  let resolveClient: ReturnType<typeof vi.fn>;
  /** Build the store over the injected double — never the singleton. */
  let makeStore: () => ReturnType<typeof createCheckoutConfirmationStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeStatefulRedis();
    resolveClient = vi.fn(async () => redis as unknown as CheckoutConfirmationRedis);
    makeStore = () =>
      createCheckoutConfirmationStore({
        redis: resolveClient as unknown as () => Promise<CheckoutConfirmationRedis>,
      });
  });

  it("create() stores the pending under a UUID receipt + returns the TTL", async () => {
    const store = makeStore();
    const { confirmationId, ttlSeconds } = await store.create(PENDING);

    expect(confirmationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(ttlSeconds).toBe(CHECKOUT_CONFIRMATION_TTL_SECONDS);
    // Persisted under the rk()-namespaced key with the 10-min EX.
    expect(redis.set).toHaveBeenCalledWith(
      receiptKey(confirmationId),
      JSON.stringify(PENDING),
      { EX: CHECKOUT_CONFIRMATION_TTL_SECONDS },
    );
  });

  // RENAMED from "consume() returns the pending exactly once (single-use)".
  // Single-use belongs to the script, and to `lua-shape-consume-contract.test.ts`.
  it("consume() issues THIS site's CONSUME script against the receipt key, and parses what it returns", async () => {
    const store = makeStore();
    const { confirmationId } = await store.create(PENDING);

    // Declared postcondition: the receipt is present, so CONSUME returns the
    // stored JSON.
    redis.lua.replyOnce(redis.store.get(receiptKey(confirmationId))!);
    const first = await store.consume(confirmationId);
    expect(first).toEqual(PENDING);

    // The bytes matter, not just the round trip. A store that started eval'ing
    // some other script — a CAD, whose contract is the INVERSE — would red
    // here, while the shape suite (still reading this anchor) would not.
    expectLuaCall(redis.lua, 0, {
      site: CONSUME_SITE,
      keys: [receiptKey(confirmationId)],
      arguments: [],
    });

    // Declared postcondition: redeemed, so the next CONSUME returns nil and
    // the store must answer null rather than re-serving the pending.
    const second = await store.consume(confirmationId);
    expect(second).toBeNull();
    expectLuaCallCount(redis.lua, 2);
  });

  it("consume() of an unknown / expired receipt → null", async () => {
    const store = makeStore();
    // Nothing stored — models both the unknown-id and the TTL-expired cases
    // (Redis cannot distinguish them; the route surfaces both as 410).
    const result = await store.consume("11111111-2222-3333-4444-555555555555");
    expect(result).toBeNull();
  });

  it("consume() rejects malformed ids without touching Redis", async () => {
    const store = makeStore();

    expect(await store.consume("")).toBeNull();
    expect(await store.consume("x".repeat(65))).toBeNull();
    // The UUID-shape gate short-circuits before any Redis round trip.
    expectLuaCallCount(redis.lua, 0);
    // …and before the CLIENT RESOLUTION too. This is the "no hoisting" property
    // stated in CheckoutConfirmationStoreOptions, made observable: resolving
    // eagerly at construction (or at the top of `consume`) would make a
    // malformed id open a Redis connection.
    expect(resolveClient).not.toHaveBeenCalled();
  });

  it("consume() tolerates malformed stored JSON → null", async () => {
    const store = makeStore();
    // Declared postcondition: the script found a receipt and handed back bytes
    // that are not JSON. The store must degrade to null, never throw.
    redis.lua.replyOnce("{not json");

    const result = await store.consume("bad");
    expect(result).toBeNull();
  });

  // ── The client seam, born guarded (F-5) ─────────────────────────────────
  //
  // Every case above would still pass if the store ignored `options.redis` and
  // resolved the singleton — they only read `redis.store`, which the test
  // itself owns. This case reads the CONSUMING SURFACE instead: the resolver we
  // handed in was actually called, once per Redis touch and never more. Delete
  // the `options?.redis ? options.redis() : getRedisClient()` threading and it
  // reds at the first assertion (0 calls), before any keyspace comparison.
  it("[seam] resolves the INJECTED client, once per Redis touch", async () => {
    const store = makeStore();

    const { confirmationId } = await store.create(PENDING);
    expect(resolveClient).toHaveBeenCalledTimes(1); // create → one SET

    await store.consume(confirmationId);
    expect(resolveClient).toHaveBeenCalledTimes(2); // consume → one EVAL

    // …and the commands landed on the object that resolver returned.
    expect(redis.set).toHaveBeenCalledTimes(1);
    expectLuaCallCount(redis.lua, 1);
  });

  // The default arm is a real branch and needs its own control, or "the option
  // is honoured" is a claim about the only path ever taken. With no options the
  // store must reach the process singleton — unreachable in this sandbox, which
  // is exactly the observable: it must NOT silently answer from our double.
  it("[seam] with NO options, the default arm never reaches this file's double", async () => {
    const store = createCheckoutConfirmationStore();

    // Whether the process singleton connects depends on the sandbox, and this
    // case deliberately claims NOTHING about that (asserting a rejection would
    // be asserting "no Redis is running here", not a property of the store).
    // What it pins is that the default is a genuinely DIFFERENT path: no part
    // of it may leak back onto the injected double.
    await store.create(PENDING).catch(() => undefined);

    expect(resolveClient).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.store.size).toBe(0);
  });
});
