/**
 * @ibatexas/pack-customer-onboarding — LGPD anonymize lifecycle suite.
 *
 * Reproduces the full destructive-flow lifecycle as policy-level
 * fixtures, sequenced as a single narrative. The OTP gate, parking,
 * and grace resolver live in task 14 (route + subscriber layer); this
 * test verifies only the policy decisions at each lifecycle step.
 *
 * # Lifecycle sequence (per investigation 08 P0 #2)
 *
 *   T0:        customer.anonymize with fresh OTP, no parked deletion
 *              → DEFER {signal: customer.anonymize.confirmed_after_grace,
 *                       timeoutMs: 24h}
 *
 *   T+1h:      customer.anonymize.cancel
 *              → REFUSE {code: cancel_supersedes_parked}
 *              (route layer clears `rk('anonymize:pending:{customerId}')`)
 *
 *   T+1h+1s:   customer.anonymize re-issued (idempotent re-park OK)
 *              → DEFER (same signal)
 *
 *   T+24h+1ms: ledger considers the parked DEFER expired (the sweeper
 *              fires `customer.anonymize.confirmed_after_grace`; that
 *              path lives in task 03/14). The policy itself ALWAYS
 *              returns DEFER for a fresh re-issue — the resolver is
 *              the part that elapses.
 *
 * # Why a dedicated file
 *
 * The lifecycle invariants are easier to read sequentially in one
 * suite than scattered across `conformance.test.ts`. This file is
 * referenced from task 14's route tests (those tests assert the
 * route-layer side effects; the policy decisions are anchored here).
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  CUSTOMER_ANONYMIZE_GRACE_HOURS,
  CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
  customerOnboardingPolicyBundle,
  type CustomerOnboardingIntentKind,
  type CustomerOnboardingPayload,
  type CustomerOnboardingState,
} from "../index.js"

const T0 = "2026-05-22T12:00:00.000Z"
const T_PLUS_1H = "2026-05-22T13:00:00.000Z"
const T_PLUS_1H_1S = "2026-05-22T13:00:01.000Z"
const T_PLUS_24H_1MS = "2026-05-23T12:00:00.001Z"

function env(
  kind: CustomerOnboardingIntentKind,
  payload: Record<string, unknown>,
  createdAt: string,
  nonce: string,
): IntentEnvelope<CustomerOnboardingIntentKind, CustomerOnboardingPayload> {
  return buildEnvelope({
    kind,
    payload: payload as unknown as CustomerOnboardingPayload,
    actor: { principal: "user", sessionId: "s-1" },
    taint: "UNTRUSTED",
    nonce,
    createdAt,
  })
}

function customerState(
  now: string,
  overrides: Partial<CustomerOnboardingState["ctx"]> = {},
): CustomerOnboardingState {
  return {
    ctx: {
      actor: { principal: "user", id: "c-1" },
      customerId: "c-1",
      customerExists: true,
      isAuthenticated: true,
      otpFresh: true,
      hasParkedAnonymize: false,
      now: new Date(now),
      ...overrides,
    },
  }
}

// ── Immediate erasure (HTTP DELETE /api/me/data, D-25 Option B) ─────────

describe("LGPD — immediate erasure (authenticated HTTP path)", () => {
  it("EXECUTEs immediately when immediateErasure is set — skips fresh-OTP + 24h grace", () => {
    const envelope = env(
      "customer.anonymize",
      { customerId: "c-1", scope: "lgpd_art_18" },
      T0,
      "n-imm",
    )
    const decision = adjudicate(
      envelope,
      // Authenticated session, NO fresh OTP, immediate mode → byte-equivalent to the
      // session-only immediate anonymize the HTTP route does today (Option B).
      customerState(T0, { immediateErasure: true, otpFresh: false }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("an UNAUTHENTICATED immediate request is still REFUSED (the LLM path can never erase)", () => {
    const envelope = env(
      "customer.anonymize",
      { customerId: "c-1", scope: "lgpd_art_18" },
      T0,
      "n-imm-unauth",
    )
    const decision = adjudicate(
      envelope,
      // Even with immediateErasure, requireAuthenticated gates on isAuthenticated —
      // the cognitive-loop state is unauthenticated, so it cannot reach erasure.
      customerState(T0, { immediateErasure: true, isAuthenticated: false }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })
})

// ── Step 1: T0 — anonymize DEFERs ───────────────────────────────────────

describe("LGPD lifecycle — T0: customer.anonymize parks via DEFER", () => {
  it("DEFERs with the grace signal and 24h timeoutMs", () => {
    const envelope = env(
      "customer.anonymize",
      { customerId: "c-1", otpToken: "tok-1", scope: "lgpd_art_18" },
      T0,
      "n-1",
    )
    const decision = adjudicate(
      envelope,
      customerState(T0),
      customerOnboardingPolicyBundle,
    )

    expect(decision.kind).toBe("DEFER")
    if (decision.kind !== "DEFER") return
    expect(decision.signal).toBe(CUSTOMER_ANONYMIZE_GRACE_SIGNAL)
    expect(decision.timeoutMs).toBe(
      CUSTOMER_ANONYMIZE_GRACE_HOURS * 60 * 60 * 1000,
    )
    // Basis carries the LGPD anchor and the grace-hours configuration —
    // audit replay can subpoena-friendly correlate the decision to the
    // legal regime.
    expect(decision.basis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "business",
          detail: expect.objectContaining({
            rule: "lgpd_art_18_grace",
            graceHours: CUSTOMER_ANONYMIZE_GRACE_HOURS,
          }),
        }),
      ]),
    )
  })

  it("REFUSEs when OTP is stale (pre-condition not met)", () => {
    const envelope = env(
      "customer.anonymize",
      { customerId: "c-1", otpToken: "tok-1", scope: "lgpd_art_18" },
      T0,
      "n-1-stale",
    )
    const decision = adjudicate(
      envelope,
      customerState(T0, { otpFresh: false }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.otp.stale")
  })
})

// ── Step 2: T+1h — cancel supersedes the parked DEFER ───────────────────

describe("LGPD lifecycle — T+1h: customer.anonymize.cancel supersedes parked anonymize", () => {
  it("REFUSEs with cancel_supersedes_parked basis when a parked DEFER exists", () => {
    const envelope = env(
      "customer.anonymize.cancel",
      { customerId: "c-1" },
      T_PLUS_1H,
      "n-2",
    )
    const decision = adjudicate(
      envelope,
      customerState(T_PLUS_1H, {
        hasParkedAnonymize: true,
        parkedAnonymizeAt: Date.parse(T0),
      }),
      customerOnboardingPolicyBundle,
    )

    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe(
      "customer.anonymize.cancel_supersedes_parked",
    )
    // The basis carries the parked timestamp — task 14's route layer
    // reads this to compute `supersedes: [parked.intentHash]` for the
    // audit record.
    expect(decision.basis).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "business",
          detail: expect.objectContaining({
            rule: "anonymize_cancel_supersedes_parked",
          }),
        }),
      ]),
    )
  })

  it("REFUSEs no_parked_deletion when nothing was parked", () => {
    const envelope = env(
      "customer.anonymize.cancel",
      { customerId: "c-1" },
      T_PLUS_1H,
      "n-2-empty",
    )
    const decision = adjudicate(
      envelope,
      customerState(T_PLUS_1H, { hasParkedAnonymize: false }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.anonymize.no_parked_deletion")
  })
})

// ── Step 3: T+1h+1s — re-issue anonymize (re-park OK) ───────────────────

describe("LGPD lifecycle — T+1h+1s: customer.anonymize re-issued after cancel", () => {
  it("DEFERs again (idempotent re-park) once the cancel has cleared the receipt", () => {
    const envelope = env(
      "customer.anonymize",
      { customerId: "c-1", otpToken: "tok-2", scope: "lgpd_art_18" },
      T_PLUS_1H_1S,
      "n-3",
    )
    // hasParkedAnonymize: false — the cancel at T+1h cleared the receipt
    // via the route layer side-effect. The policy only re-DEFERs if the
    // state reflects the clear; this assertion mirrors how task 14's
    // subscriber will project state for re-issue.
    const decision = adjudicate(
      envelope,
      customerState(T_PLUS_1H_1S, { hasParkedAnonymize: false }),
      customerOnboardingPolicyBundle,
    )

    expect(decision.kind).toBe("DEFER")
    if (decision.kind !== "DEFER") return
    expect(decision.signal).toBe(CUSTOMER_ANONYMIZE_GRACE_SIGNAL)
  })

  it("REFUSEs already_pending if the cancel had not actually cleared the receipt", () => {
    // Negative test: if a buggy adopter forgot to clear the receipt
    // before re-issuing, the policy still refuses on idempotency.
    const envelope = env(
      "customer.anonymize",
      { customerId: "c-1", otpToken: "tok-2", scope: "lgpd_art_18" },
      T_PLUS_1H_1S,
      "n-3-leaked",
    )
    const decision = adjudicate(
      envelope,
      customerState(T_PLUS_1H_1S, {
        hasParkedAnonymize: true,
        parkedAnonymizeAt: Date.parse(T0),
      }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.anonymize.already_pending")
  })
})

// ── Step 4: T+24h+1ms — grace expired, fresh re-issue still DEFERs ──────

describe("LGPD lifecycle — T+24h+1ms: grace expired, policy still DEFERs for fresh re-issue", () => {
  it("DEFERs again — the policy doesn't know about elapsed time, only the resolver does", () => {
    // Per the task spec: "the sweeper lives in task 03/14 — this test
    // only verifies the *policy* still returns DEFER for a fresh
    // re-issue."
    const envelope = env(
      "customer.anonymize",
      { customerId: "c-1", otpToken: "tok-4", scope: "lgpd_art_18" },
      T_PLUS_24H_1MS,
      "n-4",
    )
    const decision = adjudicate(
      envelope,
      // hasParkedAnonymize: false — assume the original park has been
      // resolved (sweeper fired, anonymize completed). A NEW request
      // arrives 24h later; the policy DEFERs the new request.
      customerState(T_PLUS_24H_1MS, { hasParkedAnonymize: false }),
      customerOnboardingPolicyBundle,
    )

    expect(decision.kind).toBe("DEFER")
    if (decision.kind !== "DEFER") return
    expect(decision.signal).toBe(CUSTOMER_ANONYMIZE_GRACE_SIGNAL)
    expect(decision.timeoutMs).toBe(
      CUSTOMER_ANONYMIZE_GRACE_HOURS * 60 * 60 * 1000,
    )
  })
})

// ── Pre-condition matrix (exhaustive guard ordering) ────────────────────

describe("LGPD lifecycle — pre-condition matrix for customer.anonymize", () => {
  it("non-existent customer: REFUSE customer_not_found (state guard wins)", () => {
    const envelope = env(
      "customer.anonymize",
      { customerId: "c-1", otpToken: "tok-x", scope: "lgpd_art_18" },
      T0,
      "n-pc-1",
    )
    const decision = adjudicate(
      envelope,
      customerState(T0, { customerExists: false }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.not_found")
  })

  it("stale OTP + customer exists: REFUSE otp.stale", () => {
    const envelope = env(
      "customer.anonymize",
      { customerId: "c-1", otpToken: "tok-x", scope: "lgpd_art_18" },
      T0,
      "n-pc-2",
    )
    const decision = adjudicate(
      envelope,
      customerState(T0, { otpFresh: false }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.otp.stale")
  })

  it("fresh OTP + already pending: REFUSE already_pending", () => {
    const envelope = env(
      "customer.anonymize",
      { customerId: "c-1", otpToken: "tok-x", scope: "lgpd_art_18" },
      T0,
      "n-pc-3",
    )
    const decision = adjudicate(
      envelope,
      customerState(T0, {
        hasParkedAnonymize: true,
        parkedAnonymizeAt: Date.parse("2026-05-22T11:30:00.000Z"),
      }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.anonymize.already_pending")
  })

  it("unauthenticated session: REFUSE auth.required", () => {
    const envelope = env(
      "customer.anonymize",
      { customerId: "c-1", otpToken: "tok-x", scope: "lgpd_art_18" },
      T0,
      "n-pc-4",
    )
    const decision = adjudicate(
      envelope,
      customerState(T0, { isAuthenticated: false }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    // state-guard ordering: customer.not_found is skipped (customer
    // exists), then otp.stale (fresh), then already-pending (false),
    // then auth gate fires.
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("auth.required")
  })
})
