// session-claim.ts — the ONE owner of "may this customer claim this web chat
// session?" (F-9 Phase B).
//
// ── WHAT F-9 ACTUALLY WAS ───────────────────────────────────────────────────
// F-9 was filed as "the cart has no cross-session wall": an authenticated turn
// arriving on a foreign conversationId resolves THAT session's cart, with
// customerId unconsulted, and that cart decides what a checkout BUYS.
//
// The obvious fix — check the cart against its owner at the resolver — turned
// out to be unbuildable, because the cart HAS no owner to check. Measured
// 2026-08-04 and recorded in `claustrum/active-cart-resolution.ts`: Medusa's
// `cart.customer_id` stays null on this plane, `rk("cart:owner:<cartId>")` is
// written only by the HTTP cart routes (never by any chat-plane cart creator),
// and `cart.metadata.customerId` is written only at checkout. There is no
// cart→customer binding during a shopping turn.
//
// What IS recorded is who owns a CONVERSATION — and since a conversation IS a
// cart session (that is precisely what `cart:active:session:<conversationId>`
// means), walling the conversation walls the cart. So the wall belongs here, at
// the session-claim seam, and it is the conversation that has to hold the line.
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
// The web claim gate (`routes/chat.ts`) was:
//
//     if (existingOwner && existingOwner !== customerId) → 403
//     await redis.set(ownerKey, customerId, { EX: 86400 })
//
// That is the LENIENT-NULL shape this repo has already condemned elsewhere —
// `routes/cart.ts`'s own R0a note says it outright: *"A lenient `owner && owner
// !== caller` guard short-circuits to ALLOW when `owner` is null."* When the
// owner key is ABSENT the guard allows, and then CLAIMS the session for the
// caller. And the key is absent more often than "never claimed": it carries a
// 24h TTL, while the cart key it protects has no expiry at all when written by
// `order.reorder` and a sliding one otherwise. The cart outlives the wall.
//
// ── THE INVARIANT ───────────────────────────────────────────────────────────
// Once a session has been claimed by customer A, it must never become claimable
// by a DIFFERENT customer B — not even after `session:owner` expires. No TTL'd
// key can deliver that on its own, so the wall is two layers:
//
//   1. FAST PATH — `session:owner` present. Unchanged, byte-identical: same
//      customer allows, different customer refuses.
//   2. DURABLE BACKSTOP — `session:owner` ABSENT and the caller is
//      AUTHENTICATED. Consult the conversation record, which is permanent and
//      (critically) write-once for `customerId`. A DIFFERENT customer is
//      REFUSED through the SAME path the fast-path mismatch already takes; a
//      matching customer, an absent record, or a guest-archived record proceeds
//      exactly as before.
//
// The backstop adds NO new product surface. It reuses the existing refusal, so
// a customer who hits it sees what a foreign-session customer has always seen.
//
// ── WHY THE ARCHIVER'S ASYNC LAG CANNOT CAUSE A FALSE REFUSAL ───────────────
// The conversation row is written asynchronously by a NATS subscriber
// (`subscribers/conversation-archiver.ts`), so it lags the live turn by the
// publish→subscribe→write latency. A reader will reasonably worry that the
// backstop could fire on a stale read. It cannot, and the reason is structural
// rather than a race we are tolerating:
//
//   · The backstop runs ONLY when `session:owner` is ABSENT.
//   · That key is `set` with a FRESH `EX 86400` on EVERY successful
//     authenticated POST (see the caller) — it slides, it is not write-once.
//   · So an absent key means NO authenticated POST succeeded on this session for
//     24 hours. The archiver's lag is sub-second to seconds.
//
// Absent-owner and a lagged row are therefore mutually exclusive by four orders
// of magnitude: inside the lag window the owner key was just written and the
// FAST path handles the request, so the backstop is never consulted at all.
//
// ── FAIL-OPEN ON AN UNREADABLE RECORD, DELIBERATELY ─────────────────────────
// If the durable read THROWS we allow the claim, matching today's behaviour
// exactly. Failing closed here would lock every returning customer out of their
// own idle session during a database hiccup — turning a hardening measure into
// an outage — and the read is a BACKSTOP behind a wall that still stands. An
// unreadable record is "we don't know", and "we don't know" must not be
// upgraded to "you are an impostor". The failure is surfaced to the caller so it
// can be logged rather than swallowed silently.

import { createConversationService } from "@ibatexas/domain";

/**
 * The verdict. `refuse` names WHICH layer refused, so the caller can log the
 * new (backstop) case for forensics without changing what the fast path has
 * always done — and so a test can tell the two apart.
 */
export type SessionClaimDecision =
  | { readonly outcome: "allow" }
  | {
      readonly outcome: "refuse";
      readonly basis: "owner-key" | "durable-record";
      /** The customer the session already belongs to. */
      readonly incumbentCustomerId: string;
    };

export interface SessionClaimDeps {
  /**
   * The DURABLE "who owns this conversation" read. `null` when the session was
   * never archived or was archived as a guest. Defaults to the conversation
   * service's narrow `findOwnerBySessionId`.
   */
  readonly readDurableOwner?: (sessionId: string) => Promise<string | null>;
  /** Reported when {@link readDurableOwner} throws — the claim still proceeds. */
  readonly onDurableReadError?: (error: unknown) => void;
}

async function defaultReadDurableOwner(sessionId: string): Promise<string | null> {
  const row = await createConversationService().findOwnerBySessionId(sessionId);
  return row?.customerId ?? null;
}

/**
 * Decide whether `customerId` may claim `sessionId`, given the owner key the
 * caller already read.
 *
 * PURE of IO except the durable read, which is injectable. The caller owns the
 * Redis get/set, the 403 and the logging — this owns the DECISION.
 *
 * @param existingOwner the current `session:owner:<sessionId>` value, or `null`.
 */
export async function decideSessionClaim(
  args: {
    readonly sessionId: string;
    readonly customerId: string;
    readonly existingOwner: string | null;
  },
  deps: SessionClaimDeps = {},
): Promise<SessionClaimDecision> {
  const { sessionId, customerId, existingOwner } = args;

  // ── Layer 1: the fast path. Byte-identical to the pre-F-9 gate. ──────────
  if (existingOwner !== null && existingOwner !== "") {
    return existingOwner === customerId
      ? { outcome: "allow" }
      : { outcome: "refuse", basis: "owner-key", incumbentCustomerId: existingOwner };
  }

  // ── Layer 2: the durable backstop, on the ABSENT-owner path only. ────────
  const readDurableOwner = deps.readDurableOwner ?? defaultReadDurableOwner;
  let durableOwner: string | null;
  try {
    durableOwner = await readDurableOwner(sessionId);
  } catch (error) {
    // "We don't know" is not "you are an impostor" — see the module header.
    deps.onDurableReadError?.(error);
    return { outcome: "allow" };
  }

  // No record, or a record archived as a GUEST (`customerId: null`). Both are
  // ordinary: a brand-new session, and the designed
  // guest-shops-then-logs-in flow, whose row is permanently null because
  // `findOrCreateBySessionId` never updates the column. Claim proceeds.
  if (durableOwner === null || durableOwner === "") return { outcome: "allow" };

  // The session's own returning customer, after >24h idle. This is the case the
  // whole backstop exists to let through — refusing it would lock customers out
  // of their own conversations.
  if (durableOwner === customerId) return { outcome: "allow" };

  // A DIFFERENT authenticated customer, on a session that durably belongs to
  // someone else, after the owner key lapsed. The hijack. Refused through the
  // same path the fast-path mismatch takes.
  return { outcome: "refuse", basis: "durable-record", incumbentCustomerId: durableOwner };
}
