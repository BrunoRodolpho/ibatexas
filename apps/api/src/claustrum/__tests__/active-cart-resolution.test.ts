// active-cart-resolution.test.ts — the session→active-cart module's own unit
// coverage (F-9 Phase A).
//
// WHAT IS WORTH TESTING HERE, AND WHAT IS NOT. The key's SPELLING is pinned once
// (a byte pin, because five call sites used to spell it by hand and the whole
// point of the module is that they no longer can). The interesting property is
// the OUTCOME TRICHOTOMY: `absent` and `unavailable` are different outcomes and
// the consumers genuinely diverge on them — `turn-reads.readCartContents` must
// fail closed on `unavailable` while reporting `absent` as an empty cart, so a
// module that collapsed the two would render "seu carrinho está vazio" at a
// customer whose cart merely could not be read. Each of the three outcomes is
// therefore asserted DISTINCTLY, and the two failure-shaped ones are asserted to
// be distinguishable from each other rather than merely both falsy.

import { describe, expect, it, vi } from "vitest";

vi.mock("@ibatexas/tools", () => ({
  rk: (s: string) => `ibx:${s}`,
  getRedisClient: async () => {
    throw new Error("no test may reach the real client — pass deps explicitly");
  },
}));

const { activeCartSessionKey, claimActiveCart, resolveActiveCart } = await import(
  "../active-cart-resolution.js"
);

describe("activeCartSessionKey", () => {
  it("is the rk()-namespaced session-scoped active-cart key", () => {
    // A byte pin. This exact string is what `getOrCreateCart` (a DIFFERENT
    // package, which cannot import this module — see the module header) writes,
    // so the two ends agree only by matching literals and a drift here silently
    // orphans every cart the chat plane built.
    expect(activeCartSessionKey("conv-1")).toBe("ibx:cart:active:session:conv-1");
  });
});

describe("resolveActiveCart — the outcome trichotomy", () => {
  it("RESOLVED: a stored cart id comes back under the session's own key", async () => {
    const seen: string[] = [];
    const resolution = await resolveActiveCart(
      { sessionId: "conv-1" },
      {
        redisGet: async (key) => {
          seen.push(key);
          return "cart_abc";
        },
      },
    );

    expect(resolution).toEqual({ outcome: "resolved", cartId: "cart_abc" });
    // The lookup went to THIS session's key, not a bare or differently-scoped one.
    expect(seen).toEqual(["ibx:cart:active:session:conv-1"]);
  });

  it("ABSENT: no stored cart is an honest absence, NOT an error", async () => {
    const resolution = await resolveActiveCart(
      { sessionId: "conv-1" },
      { redisGet: async () => null },
    );

    expect(resolution).toEqual({ outcome: "absent" });
  });

  it("UNAVAILABLE: a failed lookup reports the failure and NEVER throws", async () => {
    const boom = new Error("redis down");
    const resolution = await resolveActiveCart(
      { sessionId: "conv-1" },
      {
        redisGet: async () => {
          throw boom;
        },
      },
    );

    // The error is CARRIED, not swallowed: `get_cart` rethrows it (it had no
    // catch before this module existed) while the claim reads degrade.
    expect(resolution).toEqual({ outcome: "unavailable", error: boom });
  });

  it("UNAVAILABLE and ABSENT are DISTINGUISHABLE — the property the consumers split on", async () => {
    // The discriminating assertion, stated as its own case: both of the above are
    // "no cart id", and a `string | null` return would have made them the same
    // value. Consumers that must tell them apart can only do so if the module
    // does. Collapse the two outcomes in the module and THIS case fails while the
    // two above still pass.
    const absent = await resolveActiveCart(
      { sessionId: "conv-1" },
      { redisGet: async () => null },
    );
    const unavailable = await resolveActiveCart(
      { sessionId: "conv-1" },
      {
        redisGet: async () => {
          throw new Error("redis down");
        },
      },
    );

    expect(absent.outcome).not.toBe(unavailable.outcome);
    expect(absent.outcome).toBe("absent");
    expect(unavailable.outcome).toBe("unavailable");
  });

  it("an empty stored value is reported as RESOLVED — the preserved posture", async () => {
    // Deliberately NOT normalised to `absent`. Consumers disagreed on `""` before
    // this module and the refactor moved nothing; the state is unreachable from
    // every writer (`claimActiveCart` below rejects it). Pinned so that
    // normalising it later is a visible decision rather than a silent one.
    const resolution = await resolveActiveCart(
      { sessionId: "conv-1" },
      { redisGet: async () => "" },
    );

    expect(resolution).toEqual({ outcome: "resolved", cartId: "" });
  });
});

describe("claimActiveCart — the write half", () => {
  it("points the session at the cart and reports the claim stuck", async () => {
    const writes: Array<[string, string]> = [];
    const claim = await claimActiveCart(
      { sessionId: "conv-1", cartId: "cart_new" },
      { redisSet: async (k, v) => void writes.push([k, v]) },
    );

    expect(claim).toEqual({ claimed: true });
    // The SAME key the reads resolve — this is the whole reason the write lives
    // in this module (an orphaned reorder cart is what happens when it drifts).
    expect(writes).toEqual([["ibx:cart:active:session:conv-1", "cart_new"]]);
  });

  it.each([
    ["no session", { sessionId: undefined, cartId: "cart_new" }],
    ["an empty cart id", { sessionId: "conv-1", cartId: "" }],
    ["a non-string cart id", { sessionId: "conv-1", cartId: 42 }],
  ])("writes NOTHING and claims nothing given %s", async (_label, args) => {
    let wrote = false;
    const claim = await claimActiveCart(args, {
      redisSet: async () => {
        wrote = true;
      },
    });

    expect(claim).toEqual({ claimed: false });
    // Not merely "returned false" — the guard must prevent the WRITE, else a
    // session could be pointed at a cart named "".
    expect(wrote).toBe(false);
  });

  it("a FAILED write is reported with its error, distinct from a skipped one", async () => {
    const boom = new Error("redis down");
    const claim = await claimActiveCart(
      { sessionId: "conv-1", cartId: "cart_new" },
      {
        redisSet: async () => {
          throw boom;
        },
      },
    );

    // The caller logs at ERROR on this and stays silent on a skip, so the two
    // must be distinguishable: a reorder whose claim failed left the customer
    // pointed at their PREVIOUS basket and that has to be loud.
    expect(claim).toEqual({ claimed: false, error: boom });
  });
});
