// R3-S1 anti-drift guard for the RESOLVE-stage safety mirror.
//
// The resolve stage auto-resolves a target the customer left implicit ("cancela
// meu pedido" → the most-recent order; "muda minha reserva" → the one active
// booking) for every kind in ORDER_AUTORESOLVE_KINDS /
// RESERVATION_AUTORESOLVE_KINDS (resolve-and-assemble.ts). The ONLY thing that
// stops a wrong guess from executing is confirmOnAutoResolveGuard, whose
// AUTORESOLVE_CONFIRM_KINDS (compose-policy-packs.ts) is documented to MIRROR
// the union of those two sets. Until this test the mirror was comment-only —
// all three sets were module-private, so nothing could compare them, and the
// mirror HAD already drifted in a hand-copied replica inside
// resolve-and-assemble.test.ts (it omitted order.review.submit and
// reservation.modify, then asserted order.review.submit was not auto-resolved —
// false since FE-D28).
//
// This is the ownership-gating-coverage.test.ts idiom (export the hand-maintained
// kind-sets, pin the relation between them) applied to the second lockstep pair.
//
// Both failing directions, and why they are NOT symmetric:
//
//   MISSING CONFIRM (auto-resolve ∖ confirm) — the safety failure. The resolve
//     stage silently guesses the target, no guard parks the turn, and the kernel
//     EXECUTEs an irreversible money/booking mutation against an order or
//     reservation the customer never named. This is the direction the lockstep
//     comments were written to prevent.
//
//   ORPHAN CONFIRM (confirm ∖ auto-resolve) — not a safety failure but a live
//     lie: `ctx.autoResolvedMoneyRef` is stamped in exactly one place
//     (applyAutoResolve, guarded by the two resolver sets), so a confirm entry
//     for a non-auto-resolving kind can never fire. It reads as protection that
//     does not exist, and it is how a mirror rots into a hand copy.

import { describe, expect, it } from "vitest";
import { buildEnvelope } from "@adjudicate/core";
import { AUTORESOLVE_CONFIRM_KINDS, confirmOnAutoResolveGuard } from "../compose-policy-packs.js";
import {
  ORDER_AUTORESOLVE_KINDS,
  RESERVATION_AUTORESOLVE_KINDS,
} from "../resolve-and-assemble.js";

/** The union AUTORESOLVE_CONFIRM_KINDS is documented to mirror. */
const AUTORESOLVED_KINDS = new Set([
  ...ORDER_AUTORESOLVE_KINDS,
  ...RESERVATION_AUTORESOLVE_KINDS,
]);

const envelopeFor = (kind: string) =>
  buildEnvelope({
    kind,
    payload: {},
    actor: { principal: "llm", sessionId: "s-lockstep" },
    taint: "UNTRUSTED",
    nonce: `n-${kind}`,
  });

describe("R3-S1 autoresolve ⇄ confirm lockstep", () => {
  it("every auto-resolved kind is confirmed (a miss here is a silent auto-EXECUTE against a guessed target)", () => {
    const unconfirmed = [...AUTORESOLVED_KINDS].filter((k) => !AUTORESOLVE_CONFIRM_KINDS.has(k));

    expect(unconfirmed).toEqual([]);
  });

  it("every confirmed kind is auto-resolved (a miss here is an inert guard entry — protection that can never fire)", () => {
    const orphaned = [...AUTORESOLVE_CONFIRM_KINDS].filter((k) => !AUTORESOLVED_KINDS.has(k));

    expect(orphaned).toEqual([]);
  });

  it("the two sides are the SAME set — the 'MUST mirror' the four lockstep comments claim", () => {
    expect([...AUTORESOLVE_CONFIRM_KINDS].sort()).toEqual([...AUTORESOLVED_KINDS].sort());
  });

  // Non-vacuity pin: the membership assertions above only mean something if the
  // exported set is the one the PRODUCTION guard consults. Drive the real guard
  // (the composed adopter business guard, not a replica) with the exact ctx shape
  // the resolve stage stamps — ctx.autoResolvedMoneyRef — for every kind in the
  // union. An exported-but-dead copy would pass the set assertions and fail here.
  it.each([...AUTORESOLVED_KINDS])(
    "the real confirmOnAutoResolveGuard REQUEST_CONFIRMATIONs an auto-resolved %s",
    (kind) => {
      expect(confirmOnAutoResolveGuard(envelopeFor(kind), { ctx: { autoResolvedMoneyRef: true } })?.kind).toBe(
        "REQUEST_CONFIRMATION",
      );
      // No flag (the resume leg carries the EXPLICIT resolved id) → passes.
      expect(confirmOnAutoResolveGuard(envelopeFor(kind), { ctx: {} })).toBeNull();
    },
  );

  // Regression for the drift this slice found: the hand copy in
  // resolve-and-assemble.test.ts omitted exactly these two, so the pair that
  // already broke lockstep in a test is pinned by name on both sides.
  it("pins the two kinds a hand copy had already dropped (FE-D28 review, FE-T14 reservation.modify)", () => {
    for (const kind of ["order.review.submit", "reservation.modify"]) {
      expect(AUTORESOLVED_KINDS.has(kind)).toBe(true);
      expect(AUTORESOLVE_CONFIRM_KINDS.has(kind)).toBe(true);
    }
  });
});
