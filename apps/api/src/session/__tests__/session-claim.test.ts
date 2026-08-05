// session-claim.test.ts — the claimed-once invariant at its own seam (F-9 Phase B).
//
// THE PROPERTY UNDER TEST, stated so a reader can check the tests against it:
// once a session has been claimed by customer A, it must never become claimable
// by a DIFFERENT customer B — not even after `session:owner` expires.
//
// WHY THE NEGATIVE IS NOT VACUOUS. An access-class negative passes with the
// enforcement deleted whenever the forbidden thing was never actually attempted,
// so every refusal case below is paired with a CONTROL THAT MUST VALIDATE on the
// same axis: the hijack (B on A's expired session) sits next to B on a genuinely
// guest session and next to A re-claiming A's own idle session. Delete the
// backstop and exactly one of each pair flips — which is the RTR this file is
// built to support. A test that only asserted "B is refused" would also pass if
// the module refused everyone, and that module would be an outage.
//
// The durable read is injected rather than mocked at the module boundary, so the
// REAL decision runs in every case; nothing here stubs `decideSessionClaim`.

import { describe, expect, it, vi } from "vitest";

vi.mock("@ibatexas/domain", () => ({
  createConversationService: () => ({
    findOwnerBySessionId: async () => {
      throw new Error("no test may reach the real service — inject readDurableOwner");
    },
  }),
}));

const { decideSessionClaim } = await import("../session-claim.js");

const A = "cust_A";
const B = "cust_B";
const SID = "sess-1";

/** A durable record naming `owner`; `null` = archived as guest / never archived. */
const durable = (owner: string | null) => ({ readDurableOwner: async () => owner });

describe("layer 1 — the fast path (owner key PRESENT): byte-identical to the pre-F-9 gate", () => {
  it("the incumbent owner is allowed", async () => {
    // The durable read must not even be consulted on this path — a present key
    // is already an answer, and a DB round trip on every authenticated turn
    // would be a real cost. `readDurableOwner` throws to prove it never runs.
    const decision = await decideSessionClaim(
      { sessionId: SID, customerId: A, existingOwner: A },
      {
        readDurableOwner: async () => {
          throw new Error("the fast path must not consult the durable record");
        },
      },
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  it("a DIFFERENT customer is refused on the owner-key basis", async () => {
    const decision = await decideSessionClaim(
      { sessionId: SID, customerId: B, existingOwner: A },
      durable(null),
    );

    // `basis` is asserted, not just the refusal: the caller logs ONLY the
    // durable-record branch, so mislabelling this one would start emitting a
    // forensic line for behaviour that predates F-9 entirely.
    expect(decision).toEqual({
      outcome: "refuse",
      basis: "owner-key",
      incumbentCustomerId: A,
    });
  });
});

describe("layer 2 — the durable backstop (owner key ABSENT): the claimed-once invariant", () => {
  // ── THE HIJACK, and the two controls that make it discriminating ──────────

  it("THE HIJACK: B cannot claim A's session once the owner key has expired", async () => {
    // A claimed; the key lapsed (24h idle); B is authenticated and the
    // conversation record durably names A. Pre-F-9 this ALLOWED and then handed
    // B the session — and with it A's active cart, which is what a checkout buys.
    const decision = await decideSessionClaim(
      { sessionId: SID, customerId: B, existingOwner: null },
      durable(A),
    );

    expect(decision).toEqual({
      outcome: "refuse",
      basis: "durable-record",
      incumbentCustomerId: A,
    });
  });

  it("CONTROL — A re-claims A's OWN idle session and is allowed", async () => {
    // The case that must NOT break. A returning customer whose owner key lapsed
    // is the overwhelmingly common way to reach the backstop at all; refusing
    // here would lock customers out of their own conversations, which is a worse
    // failure than the one being fixed.
    const decision = await decideSessionClaim(
      { sessionId: SID, customerId: A, existingOwner: null },
      durable(A),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  it("CONTROL — B claims a genuinely GUEST session (row archived with no customer)", async () => {
    // First-login-after-guest-shopping, a DESIGNED flow. The row is permanently
    // `customerId: null` because `findOrCreateBySessionId` never updates the
    // column, so this session stays claimable forever — by design.
    const decision = await decideSessionClaim(
      { sessionId: SID, customerId: B, existingOwner: null },
      durable(null),
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  it("CONTROL — B claims a session that was never archived at all", async () => {
    // `null` ROW rather than a null column: a brand-new session id. Distinct
    // input, same required outcome — and reaching it through a different branch
    // than the guest case, so neither subsumes the other.
    const decision = await decideSessionClaim(
      { sessionId: SID, customerId: B, existingOwner: null },
      { readDurableOwner: async () => null },
    );

    expect(decision).toEqual({ outcome: "allow" });
  });

  it("the backstop reads THE SESSION UNDER CLAIM, not some other session", async () => {
    // Cheap, and it catches the one wiring mistake that would make every case
    // above pass while the wall protected the wrong conversation.
    const asked: string[] = [];
    await decideSessionClaim(
      { sessionId: "sess-under-claim", customerId: B, existingOwner: null },
      {
        readDurableOwner: async (sid) => {
          asked.push(sid);
          return A;
        },
      },
    );

    expect(asked).toEqual(["sess-under-claim"]);
  });
});

describe("the fail-open contract on an unreadable durable record", () => {
  it("a THROWING durable read ALLOWS the claim and surfaces the error", async () => {
    // Deliberate. The backstop sits behind a wall that still stands, and failing
    // closed on a DB hiccup would lock every returning customer out of their own
    // idle session — turning a hardening measure into an outage. "We don't know"
    // is not "you are an impostor".
    const boom = new Error("db down");
    const seen: unknown[] = [];

    const decision = await decideSessionClaim(
      { sessionId: SID, customerId: B, existingOwner: null },
      {
        readDurableOwner: async () => {
          throw boom;
        },
        onDurableReadError: (err) => seen.push(err),
      },
    );

    expect(decision).toEqual({ outcome: "allow" });
    // Reported, never swallowed — the caller logs it, so a silent degrade of the
    // wall is visible in the logs rather than invisible.
    expect(seen).toEqual([boom]);
  });

  it("an empty-string owner key is treated as ABSENT, so the backstop still engages", async () => {
    // `""` is not an owner. Reading it as one would send the fast path down the
    // "present" branch and silently disable the backstop for that session.
    const decision = await decideSessionClaim(
      { sessionId: SID, customerId: B, existingOwner: "" },
      durable(A),
    );

    expect(decision).toEqual({
      outcome: "refuse",
      basis: "durable-record",
      incumbentCustomerId: A,
    });
  });
});
