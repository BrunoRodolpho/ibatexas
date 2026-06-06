/**
 * @ibatexas/pack-customer-onboarding — per-guard unit tests.
 *
 * Each guard tested in isolation: input → expected decision.
 *
 * Companion to `conformance.test.ts` (kernel invariants + 28+ corpus
 * fixtures) and `lgpd-anonymize.test.ts` (dedicated LGPD lifecycle
 * suite). This file targets readability of each guard's behaviour
 * for future Pack maintainers; the conformance file targets the
 * cross-outcome / kind matrix; the LGPD file targets the
 * destructive-flow lighthouse end-to-end.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  CUSTOMER_ANONYMIZE_GRACE_HOURS,
  CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
  CUSTOMER_PROFILE_RATE_LIMIT_HOURS,
  customerOnboardingPack,
  customerOnboardingPolicyBundle,
  type CustomerOnboardingIntentKind,
  type CustomerOnboardingPayload,
  type CustomerOnboardingState,
} from "../index.js"

const DET_TIME = "2026-05-22T12:00:00.000Z"

function env(
  kind: CustomerOnboardingIntentKind,
  payload: Record<string, unknown>,
  taint: "SYSTEM" | "TRUSTED" | "UNTRUSTED" = "UNTRUSTED",
): IntentEnvelope<CustomerOnboardingIntentKind, CustomerOnboardingPayload> {
  return buildEnvelope({
    kind,
    payload: payload as unknown as CustomerOnboardingPayload,
    actor: { principal: "llm", sessionId: "s-1" },
    taint,
    nonce: "n-test",
    createdAt: DET_TIME,
  })
}

function baseState(
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
      now: new Date("2026-05-22T12:00:00.000Z"),
      ...overrides,
    },
  }
}

// ── Allergen explicit-array safety guard ────────────────────────────────

describe("customerOnboardingPolicyBundle — allergen explicit-array guard", () => {
  it("REFUSE customer.preferences.update when allergenExclusions is missing", () => {
    const decision = adjudicate(
      env("customer.preferences.update", {}),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.allergens.must_be_explicit")
  })

  it("REFUSE customer.preferences.update when allergenExclusions is a string (LLM inferred)", () => {
    const decision = adjudicate(
      env("customer.preferences.update", {
        allergenExclusions: "amendoim, glúten",
      }),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.allergens.must_be_explicit")
  })

  it("EXECUTE customer.preferences.update with empty array (no exclusions)", () => {
    const decision = adjudicate(
      env("customer.preferences.update", {
        allergenExclusions: [],
      }),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE customer.preferences.update with populated allergen array", () => {
    const decision = adjudicate(
      env("customer.preferences.update", {
        allergenExclusions: ["amendoim", "lactose"],
        dietaryFlags: ["vegetariano"],
      }),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE customer.preferences.update with allergens + favoriteCategories", () => {
    const decision = adjudicate(
      env("customer.preferences.update", {
        allergenExclusions: ["amendoim"],
        favoriteCategories: ["churrasco", "grelhados"],
      }),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Profile rate-limit guard ────────────────────────────────────────────

describe("customerOnboardingPolicyBundle — profile rate-limit guard", () => {
  it("EXECUTE customer.profile.update on first update (no lastProfileUpdateAt)", () => {
    const decision = adjudicate(
      env("customer.profile.update", { name: "Maria" }),
      baseState({ lastProfileUpdateAt: null }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REFUSE customer.profile.update within rate-limit window", () => {
    const now = new Date("2026-05-22T12:00:00.000Z")
    const halfHourAgo = now.getTime() - 30 * 60 * 1000
    const decision = adjudicate(
      env("customer.profile.update", { name: "Maria Silva" }),
      baseState({ now, lastProfileUpdateAt: halfHourAgo }),
      customerOnboardingPolicyBundle,
    )
    // CUSTOMER_PROFILE_RATE_LIMIT_HOURS default 1; 0.5h ago → REFUSE.
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.profile.rate_limit")
    expect(decision.refusal.userFacing).toMatch(/0\.5h/)
  })

  it("EXECUTE customer.profile.update after rate-limit window", () => {
    const now = new Date("2026-05-22T12:00:00.000Z")
    const twoHoursAgo =
      now.getTime() - (CUSTOMER_PROFILE_RATE_LIMIT_HOURS + 1) * 60 * 60 * 1000
    const decision = adjudicate(
      env("customer.profile.update", { name: "Maria Silva" }),
      baseState({ now, lastProfileUpdateAt: twoHoursAgo }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── CPF-shape guard ─────────────────────────────────────────────────────

describe("customerOnboardingPolicyBundle — CPF-shape guard", () => {
  it("REFUSE customer.pix.details.save with invalid CPF (wrong length)", () => {
    const decision = adjudicate(
      env("customer.pix.details.save", {
        name: "Maria",
        email: "m@example.com",
        cpf: "123",
      }),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.cpf.invalid_format")
  })

  it("REFUSE customer.pix.details.save with invalid CPF (all-same digits)", () => {
    const decision = adjudicate(
      env("customer.pix.details.save", {
        name: "Maria",
        email: "m@example.com",
        cpf: "11111111111",
      }),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.cpf.invalid_format")
  })

  it("REFUSE customer.pix.details.save with invalid CPF (bad checksum)", () => {
    const decision = adjudicate(
      env("customer.pix.details.save", {
        name: "Maria",
        email: "m@example.com",
        cpf: "12345678900",
      }),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.cpf.invalid_format")
  })

  it("EXECUTE customer.pix.details.save with valid CPF (with mask chars)", () => {
    const decision = adjudicate(
      env("customer.pix.details.save", {
        name: "Maria",
        email: "m@example.com",
        // 935.411.347-80 — valid CPF (used in CPF test vectors).
        cpf: "935.411.347-80",
      }),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE customer.pix.details.save with valid plain-digit CPF", () => {
    const decision = adjudicate(
      env("customer.pix.details.save", {
        name: "Maria",
        email: "m@example.com",
        cpf: "39053344705",
      }),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── customer.anonymize DEFER + pre-conditions ───────────────────────────

describe("customerOnboardingPolicyBundle — customer.anonymize DEFER + pre-conditions", () => {
  it("DEFER customer.anonymize with fresh OTP and no parked deletion", () => {
    const decision = adjudicate(
      env("customer.anonymize", {
        customerId: "c-1",
        otpToken: "tok-1",
        scope: "lgpd_art_18",
      }),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("DEFER")
    if (decision.kind !== "DEFER") return
    expect(decision.signal).toBe(CUSTOMER_ANONYMIZE_GRACE_SIGNAL)
    expect(decision.timeoutMs).toBe(
      CUSTOMER_ANONYMIZE_GRACE_HOURS * 60 * 60 * 1000,
    )
  })

  it("REFUSE customer.anonymize with stale OTP", () => {
    const decision = adjudicate(
      env("customer.anonymize", {
        customerId: "c-1",
        otpToken: "tok-1",
        scope: "lgpd_art_18",
      }),
      baseState({ otpFresh: false }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.otp.stale")
  })

  it("REFUSE customer.anonymize when already pending (idempotency)", () => {
    const decision = adjudicate(
      env("customer.anonymize", {
        customerId: "c-1",
        otpToken: "tok-1",
        scope: "lgpd_art_18",
      }),
      baseState({
        hasParkedAnonymize: true,
        parkedAnonymizeAt: Date.now() - 60 * 60 * 1000,
      }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.anonymize.already_pending")
  })
})

// ── customer.anonymize.cancel ───────────────────────────────────────────

describe("customerOnboardingPolicyBundle — customer.anonymize.cancel branches", () => {
  it("REFUSE-supersedes-parked when a parked anonymize exists", () => {
    const decision = adjudicate(
      env("customer.anonymize.cancel", { customerId: "c-1" }),
      baseState({
        hasParkedAnonymize: true,
        parkedAnonymizeAt: Date.now() - 60 * 60 * 1000,
      }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe(
      "customer.anonymize.cancel_supersedes_parked",
    )
  })

  it("REFUSE no_parked_deletion when nothing is parked", () => {
    const decision = adjudicate(
      env("customer.anonymize.cancel", { customerId: "c-1" }),
      baseState({ hasParkedAnonymize: false }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.anonymize.no_parked_deletion")
  })

  it("REFUSE customer.anonymize.cancel with stale OTP", () => {
    const decision = adjudicate(
      env("customer.anonymize.cancel", { customerId: "c-1" }),
      baseState({ otpFresh: false, hasParkedAnonymize: true }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.otp.stale")
  })
})

// ── Taint policy: customer.create is SYSTEM-only ────────────────────────

describe("customerOnboardingPolicyBundle — taint policy", () => {
  it("customer.create requires SYSTEM taint", () => {
    expect(
      customerOnboardingPolicyBundle.taint.minimumFor("customer.create"),
    ).toBe("SYSTEM")
  })

  it("every other kind tolerates UNTRUSTED", () => {
    expect(
      customerOnboardingPolicyBundle.taint.minimumFor(
        "customer.profile.update",
      ),
    ).toBe("UNTRUSTED")
    expect(
      customerOnboardingPolicyBundle.taint.minimumFor("customer.anonymize"),
    ).toBe("UNTRUSTED")
  })

  it("EXECUTE customer.create with SYSTEM taint", () => {
    const decision = adjudicate(
      env(
        "customer.create",
        { phoneHash: "h-1", source: "otp" },
        "SYSTEM",
      ),
      baseState({
        actor: { principal: "system" },
        customerExists: false,
        isAuthenticated: false,
        otpFresh: false,
      }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REFUSE UNTRUSTED customer.create (taint gate blocks)", () => {
    const decision = adjudicate(
      env(
        "customer.create",
        { phoneHash: "h-1", source: "otp" },
        "UNTRUSTED",
      ),
      baseState({
        actor: { principal: "user" },
        customerExists: false,
      }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })

  it("REFUSE TRUSTED customer.create (taint gate requires SYSTEM)", () => {
    const decision = adjudicate(
      env(
        "customer.create",
        { phoneHash: "h-1", source: "otp" },
        "TRUSTED",
      ),
      baseState({
        actor: { principal: "system" },
        customerExists: false,
        isAuthenticated: false,
        otpFresh: false,
      }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
  })
})

// ── Auth + state requirements ───────────────────────────────────────────

describe("customerOnboardingPolicyBundle — auth + state guards", () => {
  it("REFUSE customer.profile.update without authenticated session", () => {
    const decision = adjudicate(
      env("customer.profile.update", { name: "Maria" }),
      baseState({ isAuthenticated: false }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("auth.required")
  })

  it("REFUSE customer.preferences.update when customer does not exist", () => {
    const decision = adjudicate(
      env("customer.preferences.update", { allergenExclusions: [] }),
      baseState({ customerExists: false }),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("customer.not_found")
  })

  it("EXECUTE customer.address.add for authenticated existing customer", () => {
    const decision = adjudicate(
      env("customer.address.add", {
        address: {
          street: "Rua Exemplo",
          city: "Ibaté",
          state: "SP",
          zip: "13990-000",
        },
      }),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE customer.address.remove for authenticated existing customer", () => {
    const decision = adjudicate(
      env("customer.address.remove", { addressId: "addr-1" }),
      baseState(),
      customerOnboardingPolicyBundle,
    )
    expect(decision.kind).toBe("EXECUTE")
  })
})

// ── Default-deny invariant ──────────────────────────────────────────────

describe("customerOnboardingPolicyBundle — default-deny invariant", () => {
  it("policy.default is REFUSE (fail-safe — master plan #4)", () => {
    expect(customerOnboardingPolicyBundle.default).toBe("REFUSE")
  })

  it("customerOnboardingPack.policy.default mirrors the bundle default", () => {
    expect(customerOnboardingPack.policy.default).toBe("REFUSE")
  })
})

// ── PackV0 shape ────────────────────────────────────────────────────────

describe("customerOnboardingPack — PackV0 shape", () => {
  it("declares v0 contract", () => {
    expect(customerOnboardingPack.contract).toBe("v0")
  })

  it("id matches the org convention", () => {
    expect(customerOnboardingPack.id).toBe("ibatexas/pack-customer-onboarding")
  })

  it("version is 1.0.0", () => {
    expect(customerOnboardingPack.version).toBe("1.0.0")
  })

  it("declares all 8 unique intents", () => {
    expect(customerOnboardingPack.intents.length).toBe(8)
    const unique = new Set(customerOnboardingPack.intents)
    expect(unique.size).toBe(customerOnboardingPack.intents.length)
  })

  it("declares the LGPD anonymize grace signal", () => {
    expect(customerOnboardingPack.signals).toContain(
      CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
    )
  })

  it("planner returns empty visible tools for unauthenticated session", () => {
    const plan = customerOnboardingPack.planner.plan(
      baseState({ isAuthenticated: false }),
      { actor: { principal: "user" } },
    )
    expect(plan.visibleReadTools.length).toBe(0)
    expect(plan.allowedIntents.length).toBe(0)
  })

  it("planner exposes read tools + LLM-callable mutation intents when authenticated", () => {
    const plan = customerOnboardingPack.planner.plan(baseState(), {
      actor: { principal: "user", id: "c-1" },
    })
    expect(plan.visibleReadTools).toEqual(
      expect.arrayContaining(["get_my_profile", "get_my_preferences"]),
    )
    expect(plan.allowedIntents).toEqual(
      expect.arrayContaining([
        "customer.preferences.update",
        "customer.pix.details.save",
      ]),
    )
    // Anonymize is NEVER LLM-proposable — HTTP-only via task 14.
    expect(plan.allowedIntents).not.toContain("customer.anonymize")
    expect(plan.allowedIntents).not.toContain("customer.anonymize.cancel")
    // SYSTEM-only kinds are also absent.
    expect(plan.allowedIntents).not.toContain("customer.create")
  })

  it("declares the full basisCodes vocabulary", () => {
    expect(customerOnboardingPack.basisCodes).toEqual(
      expect.arrayContaining([
        "auth.required",
        "customer.otp.stale",
        "customer.not_found",
        "customer.anonymize.already_pending",
        "customer.anonymize.no_parked_deletion",
        "customer.anonymize.cancel_supersedes_parked",
        "customer.allergens.must_be_explicit",
        "customer.profile.rate_limit",
        "customer.cpf.invalid_format",
        "customer.default.deny",
      ]),
    )
  })
})

// ── Rehydrator ──────────────────────────────────────────────────────────

describe("rehydrateCustomerOnboardingState", () => {
  it("returns a default state for malformed input", () => {
    const out = customerOnboardingPack.rehydrateState?.(null)
    expect(out).toBeDefined()
    expect(out!.ctx.customerExists).toBe(false)
    expect(out!.ctx.isAuthenticated).toBe(false)
  })

  it("promotes ISO-string Date fields back to Date", () => {
    const raw = {
      ctx: {
        actor: { principal: "user", id: "c-1" },
        customerId: "c-1",
        customerExists: true,
        isAuthenticated: true,
        otpFresh: true,
        hasParkedAnonymize: false,
        now: "2026-05-22T12:00:00.000Z",
      },
    }
    const out = customerOnboardingPack.rehydrateState?.(raw)
    expect(out?.ctx.now).toBeInstanceOf(Date)
  })

  it("returns default state when ctx is malformed", () => {
    const out = customerOnboardingPack.rehydrateState?.({ ctx: "garbage" })
    expect(out?.ctx.customerExists).toBe(false)
  })
})
