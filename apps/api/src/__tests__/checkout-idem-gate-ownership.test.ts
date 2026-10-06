// F-21 (class rollout, site 1) — the checkout idempotency gate cannot be
// released by a non-owner. REAL REDIS.
//
// ── The defect being regressed ───────────────────────────────────────────────
//
// `POST /api/cart/checkout` single-flights on a SET-NX gate (P0-PAY-3), the
// last defense between a double-submit and a real payment. Before F-21:
//
//     const checkoutGateKey = rk(`checkout:idem:${idemToken}`);
//     if (!(await redis.set(checkoutGateKey, "1", { NX: true, EX: 120 }))) → 409
//     …
//     releaseGate: async () => { await redis.del(checkoutGateKey); }
//
// A constant value and an unconditional DEL. The live sequence that breaks it:
//
//   1. Request A claims the gate and starts a checkout.
//   2. The checkout runs slow — Medusa, Stripe, PIX — past the 120s EX. The
//      gate expires while A is still in flight.
//   3. The customer, seeing nothing happen, submits again. Request B claims the
//      now-free gate and starts its own checkout.
//   4. A finally hits a FIXABLE failure (insufficient stock, rejected coupon)
//      and its `releaseGate` runs: `del(checkoutGateKey)` — destroying B's gate.
//   5. A third submit finds no gate and races B on the checkout path.
//
// Step 4 is the whole defect: A deletes a key it no longer owns. With a UUID
// token and a compare-and-delete, A's release matches nothing and B stays
// protected. Hard Rule #10.
//
// ── Why a container and not a double ─────────────────────────────────────────
//
// The property is compare-and-delete ATOMICITY: "delete this key only if its
// value is still my token" must be one indivisible step ON THE SERVER, because
// the entire point is that another request is interleaving. A JS Map-stub of
// `eval()` decides that comparison in our own process and returns green on a
// path with no real coverage (W4 RULE 3 — which is why `createInMemoryRedis`
// refuses `eval` outright). The route-level suites
// (`routes/__tests__/cart-uncovered-handlers.test.ts`) prove the ROUTE wiring —
// that the release goes through the ownership path and never through `del`;
// this file proves the SEMANTICS the Lua exists for.
//
// ── What is driven ──────────────────────────────────────────────────────────
//
// `acquireLockAtKeyOn` is the PRODUCTION function `routes/cart.ts` calls, at
// the production key (`rk("checkout:idem:<token>")`) with the production TTL
// (120s). Restoring the constant "1" + unconditional `del` inside the route
// reds the ownership cases here.
//
// Gated by RUN_REAL_REDIS, mirroring every other real-Redis suite; enrolled in
// the M0 loud-skip roll call (`scripts/check-real-redis-suites.mjs`).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { acquireLockAtKeyOn, rk, type LockRedisClient } from "@ibatexas/tools";
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js";

/** The production TTL on the checkout gate (`routes/cart.ts`). */
const GATE_TTL_S = 120;

const IDEM_TOKEN = "idem_f21_checkout";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!RUN_REAL_REDIS)(
  "F-21 checkout idempotency gate ownership (real Redis)",
  () => {
    let harness: RedisTestHarness;
    let gateKey: string;
    let redis: LockRedisClient;

    beforeAll(async () => {
      harness = await setupRedisTestContainer();
      process.env.APP_ENV = "test";
      // rk() reads APP_ENV at call time — build the key after setting it.
      gateKey = rk(`checkout:idem:${IDEM_TOKEN}`);
      // The route hands its THREADED client to the helper (PR #524 /
      // CartRouteDeps.redis); the container client stands in for it here, which
      // is the same shape the production `CartRouteRedisClient` satisfies.
      redis = harness.client as unknown as LockRedisClient;
    }, 90_000);

    afterAll(async () => {
      await harness?.teardown();
    });

    beforeEach(async () => {
      await harness.client.flushAll();
    });

    // ── (i) The headline: the F-21 sequence, both mechanisms ────────────────

    it("A's release does NOT remove B's gate after A's TTL lapsed", async () => {
      // 1. Request A claims the gate.
      const a = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      expect(a).not.toBeNull();

      // 2. A's checkout outruns the TTL. Collapsing 120s to 1ms keeps the test
      //    fast without weakening it — Redis expiry is the same mechanism at
      //    either scale, and the case under test is "the key A claimed is gone
      //    and someone else's is there now".
      await harness.client.pExpire(gateKey, 1);
      await sleep(50);
      expect(await harness.client.get(gateKey)).toBeNull();

      // 3. The customer retries; B claims the free gate.
      const b = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      expect(b).not.toBeNull();
      expect(await harness.client.get(gateKey)).toBe(b?.value);

      // 4. A hits a fixable failure and releases. THE DEFECT WOULD FIRE HERE.
      await a?.release();

      // B's gate survives untouched — B is still single-flighted.
      expect(await harness.client.get(gateKey)).toBe(b?.value);

      // 5. …so a third submit is still refused, which is the 409 the route
      //    returns. Under the pre-F-21 `del` this acquire SUCCEEDS (proven by
      //    the control at the end of this file) and the third submit races B on
      //    the checkout path.
      const c = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      expect(c).toBeNull();
    });

    // ── (ii) The owner's own release still works ────────────────────────────

    it("the owner's release DOES remove its own gate (retry-after-fixable-failure)", async () => {
      const a = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      expect(a).not.toBeNull();

      await a?.release();

      // The gate is gone, so the customer can correct the coupon / stock issue
      // and resubmit immediately instead of waiting out 120s. That is the whole
      // reason `releaseGate` exists and F-21 must not break it.
      expect(await harness.client.get(gateKey)).toBeNull();
      const retry = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      expect(retry).not.toBeNull();
    });

    // ── (iii) Behaviour preservation: the key, the TTL, the 409 ─────────────

    it("keeps the pre-F-21 key shape and the 120s TTL", async () => {
      const a = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      expect(a).not.toBeNull();

      // The KEY is the rolling-deploy constraint (the #514 lesson): an old and
      // a new pod must contend on the same key or single-flight is lost during
      // the deploy window.
      expect(a?.key).toBe(gateKey);
      expect(gateKey).toContain("checkout:idem:");
      expect(gateKey).toContain(IDEM_TOKEN);

      // BOUNDED, not exact-equality: `ttl` decays between the SET and the read,
      // so `toBe(120)` is a flake by construction (#517). The claim that
      // matters is "a 120s window was set", and 0 < ttl <= 120 says it.
      const ttl = await harness.client.ttl(gateKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(GATE_TTL_S);
    });

    it("a second submit inside the window is refused (the 409 path)", async () => {
      const first = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      expect(first).not.toBeNull();

      // `acquireLockAtKeyOn` returning null is EXACTLY the condition
      // `routes/cart.ts` turns into the 409 + CHECKOUT_IN_PROGRESS body. The
      // status code and pt-BR copy are pinned at the route layer
      // (`__tests__/cart-routes.test.ts`); what is pinned here is that the
      // condition behind them is unchanged.
      const second = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      expect(second).toBeNull();
    });

    it("the gate carries a UUID token, never the constant \"1\"", async () => {
      const a = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      const stored = await harness.client.get(gateKey);

      expect(stored).not.toBe("1");
      expect(stored).toBe(a?.value);
      expect(stored).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("mints a DISTINCT token per acquisition", async () => {
      const a = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      await a?.release();
      const b = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);

      expect(a?.value).not.toBe(b?.value);
    });

    // ── (iv) Concurrency: exactly one winner ────────────────────────────────

    it("a 25-way submit storm yields exactly one gate holder, and 24 with nothing to release", async () => {
      const results = await Promise.all(
        Array.from({ length: 25 }, () =>
          acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S),
        ),
      );

      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(await harness.client.get(gateKey)).toBe(winners[0]?.value);

      // The 24 losers hold NULL, not a handle — so a lost race has nothing to
      // release even if a caller tried. That is structural, and it is the
      // second half of the F-21 class: PR #514's cart-creation defect was a
      // `finally` that deleted the lock on the branch where the NX SET had
      // returned null. Here that branch cannot express a release at all.
      const losers = results.filter((r): r is null => r === null);
      expect(losers).toHaveLength(24);
      // `null`, not a handle — the type system itself is the guarantee here:
      // there is no `release` to call on a lost race.
      expect(losers.every((r) => r === null)).toBe(true);
      expect(await harness.client.get(gateKey)).toBe(winners[0]?.value);

      // And once the winner releases, the next storm elects exactly one again.
      await winners[0]?.release();
      const second = await Promise.all(
        Array.from({ length: 25 }, () =>
          acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S),
        ),
      );
      expect(second.filter((r) => r !== null)).toHaveLength(1);
    });

    // ── (v) CONTROL: the pre-F-21 release DOES destroy B's gate ─────────────
    //
    // Without this the ownership cases could be passing for the wrong reason —
    // e.g. if the sequence never actually let B take the gate. This runs the
    // IDENTICAL sequence and swaps ONLY the release mechanism for the one the
    // fix removed. It MUST show the damage.

    it("control — an unconditional DEL in the same sequence DOES destroy B's gate", async () => {
      await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      await harness.client.pExpire(gateKey, 1);
      await sleep(50);
      const b = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      // Possession only — deliberately NOT a token-identity assertion, so this
      // control measures the release mechanism and nothing else.
      expect(b).not.toBeNull();
      expect(await harness.client.get(gateKey)).toBe(b?.value);

      // The pre-F-21 release, verbatim: `await redis.del(checkoutGateKey)`.
      await harness.client.del(gateKey);

      expect(await harness.client.get(gateKey)).toBeNull();
      // B is no longer single-flighted: a third submit walks straight onto the
      // checkout path alongside B. That is the double-charge exposure.
      const c = await acquireLockAtKeyOn(redis, gateKey, GATE_TTL_S);
      expect(c).not.toBeNull();
    });
  },
);
