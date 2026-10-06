// active-cart-resolution.ts — the ONE owner of "which cart is this conversation
// working on?" (F-9, Phase A).
//
// ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
// `rk("cart:active:session:<sessionId>")` is not a cache and not a convenience:
// it is the cart's ONLY ownership boundary, and it decides what a checkout BUYS
// (the reorder-orphaned-cart family — see `claimActiveCart` below). Before this
// module the key was spelled out by hand at FIVE production read sites inside
// apps/api and written at one, each restating the lookup, the fail-posture and
// (unevenly) the ordering comments:
//
//   · claustrum-bootstrap.ts   `get_cart` read-tool executor
//   · resolve-and-assemble.ts  `loadCartCtx`
//   · resolve-and-assemble.ts  `readSessionCartId`
//   · resolve-and-assemble.ts  `hasNonEmptyActiveCart`
//   · turn-reads.ts            `readCartContents` (the CART_CONTENTS claim read)
//   · register-workflow-scoped-tools.ts  `claimSessionCart` (the WRITE)
//
// The shared `rk()` helper already prevented the key's SPELLING from drifting.
// What it could not prevent — and what this module exists for — is the key's
// SEMANTICS drifting: what the outcomes are, which of them is an honest absence
// versus an unavailable read, and where a rule about who may resolve this key
// would have to be installed. Five hand-copies means five places to install it
// and five places to get it wrong. This module is that one place.
//
// ── THE OUTCOME TRICHOTOMY (the thing that was actually duplicated) ─────────
// A session-cart lookup has THREE outcomes, and collapsing any two of them is a
// real defect at one site or another:
//
//   · RESOLVED    — the session points at a cart id.
//   · ABSENT      — the session points at nothing. An honest "no cart right
//                   now", NOT an error: a customer who has not started a cart is
//                   the overwhelmingly common case.
//   · UNAVAILABLE — the lookup itself failed (Redis down / connection error). We
//                   do not know whether a cart exists.
//
// ABSENT and UNAVAILABLE are DIFFERENT, and the consumers genuinely differ on
// them — `turn-reads.readCartContents` must report UNAVAILABLE as a fail-closed
// ERROR (Inv 7: an unavailable read may never render as "your cart is empty"),
// while `loadCartCtx` folds both to "no cart" because its guards then REFUSE
// either way. A module that returned `string | null` would have forced that
// distinction back out to the call sites, which is exactly the duplication being
// removed. So the resolution is returned as a discriminated union and each
// consumer maps it to ITS OWN posture, visibly, in one line.
//
// ── ZERO BEHAVIOUR CHANGE (Phase A), AND THE ONE THING THAT IS PRESERVED
//    RATHER THAN FIXED ──────────────────────────────────────────────────────
// Every consumer's observable behaviour is byte-identical to the hand-copied
// read it replaces, including the fail-postures and including one measured
// inconsistency that is DELIBERATELY preserved here rather than quietly
// normalised:
//
//   THE EMPTY-STRING POSTURE. If the key ever held `""`, `readSessionCartId`
//   treated it as ABSENT while the other four sites treated it as a cart id
//   named `""` (and then failed differently downstream: `loadCartCtx` produced
//   `ctx.cartId === ""`, `turn-reads` produced an UNAVAILABLE from the Medusa
//   404, `get_cart` produced its no-active-cart note on the falsy check).
//
//   This module therefore reports `""` as RESOLVED-with-an-empty-id and each
//   consumer keeps its own check, so the refactor moves nothing. The state is
//   UNREACHABLE from every writer — `getOrCreateCart` guards on a falsy cart id,
//   `claimActiveCart` below rejects `""` explicitly, and the journeys seeders
//   guard on `undefined` — so normalising it would be a behaviour change in a
//   state no writer can produce, which is a change that can only be justified
//   on its own evidence and not smuggled through a refactor. Recorded here so
//   the next reader does not have to re-derive it from five sites.
//
// ── WHAT THIS MODULE DOES NOT OWN ──────────────────────────────────────────
// `packages/tools/src/cart/get-or-create-cart.ts` (`cartRedisKey`) reads and
// writes this same key and is NOT routed through here: it lives in a different
// package and apps/api is downstream of `@ibatexas/tools`, so the import would
// invert the dependency. It stays the key's other end, and its `cartRedisKey`
// doc points here. Any rule installed in this module must therefore be stated as
// a rule about the CLAUSTRUM/TURN plane, not about the key globally.
//
// ── WHERE A CROSS-SESSION WALL WOULD GO (F-9), AND WHY IT IS NOT HERE YET ──
// `resolveActiveCart` is the single seam an authenticated turn crosses to reach
// a cart on the claustrum plane, so a rule of the form "an authenticated turn
// may only resolve a cart that belongs to that customer" installs HERE, once,
// and every consumer above inherits it. That rule needs an AUTHORITY — a durable
// cart→customer binding to check against. THERE ISN'T ONE. Measured 2026-08-04,
// recorded here because this is the function a future implementer will open:
//
//   · `rk("cart:owner:<cartId>")` — routes/cart.ts `verifyCartOwnership`. Its
//     ONLY writer is that function, called from 5 HTTP cart handlers, lazily on
//     first authenticated access. NOTHING on the chat/turn plane writes it:
//     not `getOrCreateCart`, not `order.reorder`'s `claimActiveCart`, not the
//     journeys seeders. `EX 86400 NX`, never refreshed, and DELETED at checkout.
//     So for the very carts this module resolves, the key is typically absent.
//
//   · Medusa `cart.customer_id` — null on this plane. `getOrCreateCart` POSTs
//     `/store/carts` with body `{}` and the `medusaStore` transport sends only
//     `x-publishable-api-key` (no customer auth), so nothing associates the
//     customer. Independently recorded from a live read in
//     `packages/journeys/src/live/seed-checkout-cart.ts`: "Medusa's own
//     `customer_id` column stays null — the binding lives ENTIRELY in Redis".
//     `assertCartOwnership` reads this field and therefore falls through for
//     ANY caller on a null-owner cart, which is why it is not a wall either.
//
//   · Medusa `cart.metadata.customerId` — the one durable binding that does get
//     written (`create-checkout.ts` `buildCheckoutMetadata`), but only AT
//     CHECKOUT and only for an authenticated ctx. It exists to make the ORDER
//     attributable and is read order-side. A cart that has not reached checkout
//     — i.e. every cart this module resolves during a shopping turn — has no
//     such binding, so it cannot authorize anything earlier in the lifecycle.
//
// The honest conclusion is that the cart has no owner to check, and inventing a
// check against an absent binding would either fail open (worthless) or fail
// closed on real customers (an outage). The authority for this wall is more
// likely to be conversation-shaped than cart-shaped — "who owns this
// conversationId" — for which `session:owner:<sessionId>` (routes/chat.ts) and
// `ibx_domain.conversations.customerId` are the candidates, each with its own
// coverage gap. Choosing between them is an owner decision on evidence, not a
// refactor, so this module installs NO rule and instead makes exactly one place
// for the chosen rule to go.

import { getRedisClient, rk } from "@ibatexas/tools";

/**
 * The session→active-cart key. The ONE spelling on the claustrum/turn plane.
 *
 * `sessionId` is the CONVERSATION id on every claustrum path (the conductor's
 * `conversationId`, the WhatsApp `sessionKey`, the chat route's `sessionId`) —
 * a conversation IS a cart session, which is precisely what makes this key an
 * ownership boundary rather than a lookup.
 */
export function activeCartSessionKey(sessionId: string): string {
  return rk(`cart:active:session:${sessionId}`);
}

/**
 * The outcome of a session→active-cart lookup. See the module header for why
 * ABSENT and UNAVAILABLE may not be collapsed.
 */
export type ActiveCartResolution =
  | {
      readonly outcome: "resolved";
      /** The raw stored value. May be `""` — see the module header. */
      readonly cartId: string;
    }
  | { readonly outcome: "absent" }
  | {
      readonly outcome: "unavailable";
      /** The failure, for a consumer that must rethrow rather than degrade. */
      readonly error: unknown;
    };

/**
 * The IO this module needs, injectable so a consumer's test can drive the real
 * decision without a Redis. Defaults to the `@ibatexas/tools` singleton, which
 * is what every call site resolved for itself before.
 */
export interface ActiveCartResolutionDeps {
  readonly redisGet?: (key: string) => Promise<string | null>;
  readonly redisSet?: (key: string, value: string) => Promise<unknown>;
}

async function defaultRedisGet(key: string): Promise<string | null> {
  const redis = await getRedisClient();
  return redis.get(key);
}

async function defaultRedisSet(key: string, value: string): Promise<unknown> {
  const redis = await getRedisClient();
  return redis.set(key, value);
}

/**
 * Resolve the cart this session is working on.
 *
 * NEVER throws — a lookup failure is reported as `unavailable` carrying the
 * error, so a consumer that must fail closed can degrade and a consumer that
 * must propagate (`get_cart`, which had no catch) can rethrow. Which of those a
 * consumer does is the consumer's call and is stated at the consumer.
 */
export async function resolveActiveCart(
  args: { readonly sessionId: string },
  deps: ActiveCartResolutionDeps = {},
): Promise<ActiveCartResolution> {
  const redisGet = deps.redisGet ?? defaultRedisGet;
  let cartId: string | null;
  try {
    cartId = await redisGet(activeCartSessionKey(args.sessionId));
  } catch (error) {
    return { outcome: "unavailable", error };
  }
  if (cartId === null) return { outcome: "absent" };
  return { outcome: "resolved", cartId };
}

/**
 * Point the session at `cartId` — the WRITE half, and the reason the read half
 * is an ownership boundary at all.
 *
 * `order.reorder` POSTs a brand-new cart, and before LE2-023 nothing pointed the
 * session at it: the customer was told a new cart was built while their session
 * still resolved the OLD one, so the follow-up "quero finalizar" checked out the
 * previous basket. The rebuilt cart was orphaned the moment it was built. That
 * is what this write prevents, and it is why "which cart is this conversation
 * on" is a money question.
 *
 * Returns `false` when there is nothing to claim (no session, or a cart id that
 * is not a non-empty string) or when the write FAILED — the caller decides
 * whether that is fatal. It is not fatal for a reorder (the cart exists either
 * way) but it IS loud, because it leaves the customer pointed at the old basket.
 */
export async function claimActiveCart(
  args: { readonly sessionId: string | undefined; readonly cartId: unknown },
  deps: ActiveCartResolutionDeps = {},
): Promise<{ readonly claimed: boolean; readonly error?: unknown }> {
  const { sessionId, cartId } = args;
  if (sessionId === undefined) return { claimed: false };
  if (typeof cartId !== "string" || cartId === "") return { claimed: false };
  const redisSet = deps.redisSet ?? defaultRedisSet;
  try {
    await redisSet(activeCartSessionKey(sessionId), cartId);
    return { claimed: true };
  } catch (error) {
    return { claimed: false, error };
  }
}
