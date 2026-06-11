/**
 * @ibatexas/pack-customer-onboarding — conformance test.
 *
 * Two-part:
 *
 *   1. Corpus of 28+ envelope+state fixtures covering EXECUTE,
 *      REFUSE, and DEFER outcomes across the Pack's 8 intent kinds.
 *      Each fixture asserts the expected Decision shape against
 *      `customerOnboardingPack.policy`.
 *
 *   2. Kernel-invariant suite — `runConformance(customerOnboardingPack)`
 *      from `@adjudicate/conformance` verifies taint protection,
 *      replay determinism, intent-hash determinism, basis-vocabulary
 *      purity, guard ordering, and default polarity hold for the Pack.
 *
 * Note: REQUEST_CONFIRMATION, ESCALATE, and REWRITE are intentionally
 * not exercised — the customer-onboarding domain currently has no
 * confirm/escalate threshold (the destructive flow uses DEFER + grace,
 * not a confirm-prompt) and no clamping primitive. Three of six
 * decision outcomes appear in this corpus (EXECUTE, REFUSE, DEFER);
 * the others are appropriately absent here.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import { runConformance } from "@adjudicate/conformance"
import { analyzePolicy, type PlannerProbe } from "@adjudicate/analyze"
import {
  CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
  customerOnboardingPack,
  type CustomerOnboardingContext,
  type CustomerOnboardingIntentKind,
  type CustomerOnboardingPayload,
  type CustomerOnboardingState,
} from "../index.js"

const DET_TIME = "2026-05-22T12:00:00.000Z"
// 935.411.347-80 is a structurally valid Brazilian CPF (passes the
// Modulo-11 checksum) used commonly in CPF-validation test vectors.
const VALID_CPF = "935.411.347-80"

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

// ── Corpus ──────────────────────────────────────────────────────────────

type Fixture = {
  readonly name: string
  readonly envelope: IntentEnvelope<
    CustomerOnboardingIntentKind,
    CustomerOnboardingPayload
  >
  readonly state: CustomerOnboardingState
  readonly expect: {
    readonly kind:
      | "EXECUTE"
      | "REFUSE"
      | "DEFER"
      | "REWRITE"
      | "REQUEST_CONFIRMATION"
      | "ESCALATE"
    readonly refusalCode?: string
    readonly signal?: string
    readonly escalateTo?: "human" | "supervisor"
  }
}

const corpus: ReadonlyArray<Fixture> = [
  // ── EXECUTE (10 cases) ───────────────────────────────────────────────
  {
    name: "EXECUTE: customer.create with SYSTEM taint (OTP-seed path)",
    envelope: env(
      "customer.create",
      { phoneHash: "h-1", source: "otp" },
      "SYSTEM",
    ),
    state: baseState({
      actor: { principal: "system" },
      customerExists: false,
      isAuthenticated: false,
      otpFresh: false,
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: customer.create with SYSTEM taint (wa-auto seed)",
    envelope: env(
      "customer.create",
      { phoneHash: "h-2", source: "wa-auto" },
      "SYSTEM",
    ),
    state: baseState({
      actor: { principal: "system" },
      customerExists: false,
      isAuthenticated: false,
      otpFresh: false,
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: customer.profile.update on first update (no prior timestamp)",
    envelope: env("customer.profile.update", {
      name: "Maria Silva",
      email: "maria@example.com",
    }),
    state: baseState({ lastProfileUpdateAt: null }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: customer.profile.update after rate-limit window",
    envelope: env("customer.profile.update", { name: "Maria" }),
    state: baseState({
      lastProfileUpdateAt: Date.parse("2026-05-22T10:00:00.000Z"),
    }),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: customer.preferences.update with empty allergen array",
    envelope: env("customer.preferences.update", {
      allergenExclusions: [],
    }),
    state: baseState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: customer.preferences.update with explicit allergens + dietary flags",
    envelope: env("customer.preferences.update", {
      allergenExclusions: ["amendoim", "lactose"],
      dietaryFlags: ["vegetariano"],
    }),
    state: baseState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: customer.pix.details.save with valid CPF",
    envelope: env("customer.pix.details.save", {
      name: "Maria Silva",
      email: "maria@example.com",
      cpf: VALID_CPF,
    }),
    state: baseState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: customer.pix.details.save with plain-digit CPF",
    envelope: env("customer.pix.details.save", {
      name: "Maria Silva",
      email: "maria@example.com",
      // 39053344705 — another valid CPF test vector
      cpf: "39053344705",
    }),
    state: baseState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: customer.address.add for authenticated customer",
    envelope: env("customer.address.add", {
      address: {
        label: "Casa",
        street: "Rua das Flores",
        number: "123",
        city: "Ibaté",
        state: "SP",
        zip: "13990-000",
      },
    }),
    state: baseState(),
    expect: { kind: "EXECUTE" },
  },
  {
    name: "EXECUTE: customer.address.remove for authenticated customer",
    envelope: env("customer.address.remove", { addressId: "addr-1" }),
    state: baseState(),
    expect: { kind: "EXECUTE" },
  },

  // ── REFUSE (13 cases) ────────────────────────────────────────────────
  {
    name: "REFUSE: customer.create with UNTRUSTED taint (LLM cannot forge)",
    envelope: env(
      "customer.create",
      { phoneHash: "h-1", source: "otp" },
      "UNTRUSTED",
    ),
    state: baseState({
      actor: { principal: "user" },
      customerExists: false,
    }),
    expect: { kind: "REFUSE" },
  },
  {
    name: "REFUSE: customer.create with TRUSTED taint (still below SYSTEM)",
    envelope: env(
      "customer.create",
      { phoneHash: "h-1", source: "otp" },
      "TRUSTED",
    ),
    state: baseState({
      actor: { principal: "staff" },
      customerExists: false,
    }),
    expect: { kind: "REFUSE" },
  },
  {
    name: "REFUSE: customer.profile.update without authenticated session",
    envelope: env("customer.profile.update", { name: "Maria" }),
    state: baseState({ isAuthenticated: false }),
    expect: { kind: "REFUSE", refusalCode: "auth.required" },
  },
  {
    name: "REFUSE: customer.profile.update for non-existent customer",
    envelope: env("customer.profile.update", { name: "Maria" }),
    state: baseState({ customerExists: false }),
    expect: { kind: "REFUSE", refusalCode: "customer.not_found" },
  },
  {
    name: "REFUSE: customer.profile.update within rate-limit window",
    envelope: env("customer.profile.update", { name: "Maria" }),
    state: baseState({
      lastProfileUpdateAt: Date.parse("2026-05-22T11:30:00.000Z"),
    }),
    expect: { kind: "REFUSE", refusalCode: "customer.profile.rate_limit" },
  },
  {
    name: "REFUSE: customer.preferences.update with non-array allergenExclusions",
    envelope: env("customer.preferences.update", {
      allergenExclusions: "amendoim",
    }),
    state: baseState(),
    expect: {
      kind: "REFUSE",
      refusalCode: "customer.allergens.must_be_explicit",
    },
  },
  {
    name: "REFUSE: customer.preferences.update with missing allergenExclusions",
    envelope: env("customer.preferences.update", {
      dietaryFlags: ["vegetariano"],
    }),
    state: baseState(),
    expect: {
      kind: "REFUSE",
      refusalCode: "customer.allergens.must_be_explicit",
    },
  },
  {
    name: "REFUSE: customer.pix.details.save with invalid CPF",
    envelope: env("customer.pix.details.save", {
      name: "Maria",
      email: "m@example.com",
      cpf: "12345678900",
    }),
    state: baseState(),
    expect: { kind: "REFUSE", refusalCode: "customer.cpf.invalid_format" },
  },
  {
    name: "REFUSE: customer.pix.details.save with too-short CPF",
    envelope: env("customer.pix.details.save", {
      name: "Maria",
      email: "m@example.com",
      cpf: "123",
    }),
    state: baseState(),
    expect: { kind: "REFUSE", refusalCode: "customer.cpf.invalid_format" },
  },
  {
    name: "REFUSE: customer.anonymize with stale OTP",
    envelope: env("customer.anonymize", {
      customerId: "c-1",
      otpToken: "tok-1",
      scope: "lgpd_art_18",
    }),
    state: baseState({ otpFresh: false }),
    expect: { kind: "REFUSE", refusalCode: "customer.otp.stale" },
  },
  {
    name: "REFUSE: customer.anonymize already pending (idempotency)",
    envelope: env("customer.anonymize", {
      customerId: "c-1",
      otpToken: "tok-1",
      scope: "lgpd_art_18",
    }),
    state: baseState({
      hasParkedAnonymize: true,
      parkedAnonymizeAt: Date.parse("2026-05-22T11:00:00.000Z"),
    }),
    expect: {
      kind: "REFUSE",
      refusalCode: "customer.anonymize.already_pending",
    },
  },
  {
    name: "REFUSE: customer.anonymize.cancel with no parked deletion",
    envelope: env("customer.anonymize.cancel", { customerId: "c-1" }),
    state: baseState({ hasParkedAnonymize: false }),
    expect: {
      kind: "REFUSE",
      refusalCode: "customer.anonymize.no_parked_deletion",
    },
  },
  {
    name: "REFUSE: customer.anonymize.cancel with stale OTP",
    envelope: env("customer.anonymize.cancel", { customerId: "c-1" }),
    state: baseState({
      otpFresh: false,
      hasParkedAnonymize: true,
      parkedAnonymizeAt: Date.parse("2026-05-22T11:00:00.000Z"),
    }),
    expect: { kind: "REFUSE", refusalCode: "customer.otp.stale" },
  },

  // ── REFUSE-supersedes-parked (the success-via-refuse case, 2 cases) ──
  {
    name: "REFUSE-supersedes-parked: customer.anonymize.cancel clears parked anonymize",
    envelope: env("customer.anonymize.cancel", { customerId: "c-1" }),
    state: baseState({
      hasParkedAnonymize: true,
      parkedAnonymizeAt: Date.parse("2026-05-22T11:00:00.000Z"),
    }),
    expect: {
      kind: "REFUSE",
      refusalCode: "customer.anonymize.cancel_supersedes_parked",
    },
  },
  {
    name: "REFUSE-supersedes-parked: cancel within minutes of original park",
    envelope: env("customer.anonymize.cancel", { customerId: "c-1" }),
    state: baseState({
      hasParkedAnonymize: true,
      parkedAnonymizeAt: Date.parse("2026-05-22T11:55:00.000Z"),
    }),
    expect: {
      kind: "REFUSE",
      refusalCode: "customer.anonymize.cancel_supersedes_parked",
    },
  },

  // ── DEFER (3 cases) ──────────────────────────────────────────────────
  {
    name: "DEFER: customer.anonymize with fresh OTP and no parked anonymize",
    envelope: env("customer.anonymize", {
      customerId: "c-1",
      otpToken: "tok-1",
      scope: "lgpd_art_18",
    }),
    state: baseState(),
    expect: { kind: "DEFER", signal: CUSTOMER_ANONYMIZE_GRACE_SIGNAL },
  },
  {
    name: "DEFER: customer.anonymize from staff-assisted session",
    envelope: env(
      "customer.anonymize",
      {
        customerId: "c-1",
        otpToken: "tok-2",
        scope: "lgpd_art_18",
      },
      "UNTRUSTED",
    ),
    state: baseState({
      actor: { principal: "user", id: "c-1" },
    }),
    expect: { kind: "DEFER", signal: CUSTOMER_ANONYMIZE_GRACE_SIGNAL },
  },
  {
    name: "DEFER: customer.anonymize after a prior cancel (re-park ok)",
    envelope: env("customer.anonymize", {
      customerId: "c-1",
      otpToken: "tok-3",
      scope: "lgpd_art_18",
    }),
    state: baseState({
      // Cancel cleared the parked receipt; re-issue with fresh OTP DEFERs anew.
      hasParkedAnonymize: false,
    }),
    expect: { kind: "DEFER", signal: CUSTOMER_ANONYMIZE_GRACE_SIGNAL },
  },
]

describe("customerOnboardingPack — corpus (28+ cases across 3 decision kinds)", () => {
  it("corpus is at least 28 cases (acceptance criterion)", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(28)
  })

  for (const fixture of corpus) {
    it(fixture.name, () => {
      const decision = adjudicate(
        fixture.envelope,
        fixture.state,
        customerOnboardingPack.policy,
      )
      expect(decision.kind).toBe(fixture.expect.kind)
      if (fixture.expect.refusalCode && decision.kind === "REFUSE") {
        expect(decision.refusal.code).toBe(fixture.expect.refusalCode)
      }
      if (fixture.expect.signal && decision.kind === "DEFER") {
        expect(decision.signal).toBe(fixture.expect.signal)
      }
      if (fixture.expect.escalateTo && decision.kind === "ESCALATE") {
        expect(decision.to).toBe(fixture.expect.escalateTo)
      }
    })
  }
})

// ── Kernel-invariant suite ──────────────────────────────────────────────

describe("customerOnboardingPack — kernel invariants via runConformance()", () => {
  it("runConformance returns zero failures", () => {
    const report = runConformance(customerOnboardingPack)
    if (!report.passed) {
      for (const r of report.results) {
        if (!r.passed) console.error(`[${r.id}] ${r.name}: ${r.details}`)
      }
    }
    expect(report.passed).toBe(true)
    expect(report.summary.failed).toBe(0)
  })

  it("policy default is REFUSE (default-polarity / bypass-detection)", () => {
    // Mirrors AC-006 (default-polarity) from @adjudicate/conformance —
    // also asserted here so the bypass-detection invariant is
    // surfaced explicitly in the Pack's own test surface (task spec
    // acceptance criterion).
    expect(customerOnboardingPack.policy.default).toBe("REFUSE")
  })
})

// ── Tier-3 policy coherence (AJD-301) via analyzePolicy() ───────────────────
//
// F11 gate: the planner must never offer an intent the Pack doesn't declare
// (`phantom_intent`, the only error-severity rule → flips `report.passed`).
// System-only kinds (taint minimum above UNTRUSTED) are intentionally not
// planner-proposable; the analyzer auto-excludes them from `unreachable_intent`
// via `pack.policy.taint.minimumFor`. We pin that carve-out so a future drop of
// `customer.create` from the taint policy fails loudly here.
//
// NOTE: we deliberately do NOT assert `summary.warning === 0` — the planner
// omits several declared, non-system intents (profile.update, address.add,
// address.remove, anonymize, anonymize.cancel) that are reached by routed/HTTP
// flows (task 14), each a benign `unreachable_intent` warning. `report.passed`
// stays true (error === 0).

describe("customerOnboardingPack — policy coherence via analyzePolicy() (AJD-301)", () => {
  // Probes MUST exercise both planner branches — the planner keys on
  // `state.ctx.isAuthenticated` (guest vs authenticated). `context` is unused by
  // this planner (it does `void context`) but required by the probe shape.
  const probes: ReadonlyArray<
    PlannerProbe<CustomerOnboardingState, CustomerOnboardingContext>
  > = [
    {
      label: "unauthenticated",
      state: baseState({ isAuthenticated: false }),
      context: {
        actor: { principal: "user" },
      } as unknown as CustomerOnboardingContext,
    },
    {
      label: "authenticated",
      state: baseState(),
      context: {
        actor: { principal: "user", id: "c-1" },
      } as unknown as CustomerOnboardingContext,
    },
  ]

  // Derive the system-only set the SAME way the analyzer does (taint minimum),
  // never a hand-list — so this test cannot drift from
  // `customerOnboardingTaintPolicy`.
  const systemOnlyKinds = customerOnboardingPack.intents.filter((k) => {
    const min = customerOnboardingPack.policy.taint.minimumFor(k)
    return min !== undefined && min !== "UNTRUSTED"
  })

  it("planner proposes no phantom intents (report.passed, zero errors)", () => {
    const report = analyzePolicy({
      pack: customerOnboardingPack,
      plannerProbes: probes,
    })
    for (const d of report.diagnostics) {
      if (d.severity === "error") console.error(`[${d.code}] ${d.message}`)
    }
    expect(report.passed).toBe(true)
    expect(report.summary.error).toBe(0)
  })

  it("system-only kinds (customer.create, …) are carved out", () => {
    const report = analyzePolicy({
      pack: customerOnboardingPack,
      plannerProbes: probes,
    })
    // Guard against a vacuous pass: the carve-out subject must really be system-only.
    expect(systemOnlyKinds).toContain("customer.create")
    for (const kind of systemOnlyKinds) {
      const unreachable = report.diagnostics.find(
        (d) =>
          d.detail?.rule === "unreachable_intent" && d.detail?.intent === kind,
      )
      expect(
        unreachable,
        `${kind} is system-only — must NOT be flagged unreachable`,
      ).toBeUndefined()
      const contradiction = report.diagnostics.find(
        (d) =>
          d.detail?.rule === "system_taint_contradiction" &&
          d.detail?.intent === kind,
      )
      expect(
        contradiction,
        `${kind} is system-only — planner must NOT offer it`,
      ).toBeUndefined()
    }
  })
})

// ── PII data-classification guard (F1) ──────────────────────────────────────
// On customer.pix.details.save, AFTER validateCpfShape (I10). Card PAN → REFUSE;
// cpf/email/phone mistyped into the NAME leaf → REWRITE-to-sentinel. The legit
// `email` and the structured `cpf` field are never masked.

describe("customerOnboardingPack — PII data-classification guard (F1)", () => {
  const pix = (payload: Record<string, unknown>) =>
    env("customer.pix.details.save", payload)

  it("EXECUTE: legit name + email + valid CPF — nothing masked (I10)", () => {
    const decision = adjudicate(
      pix({ name: "Maria Silva", email: "maria@example.com", cpf: VALID_CPF }),
      baseState(),
      customerOnboardingPack.policy,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("EXECUTE: absent CPF + clean name/email — guest PIX path unchanged (I10)", () => {
    const decision = adjudicate(
      pix({ name: "Maria Silva", email: "maria@example.com" }),
      baseState(),
      customerOnboardingPack.policy,
    )
    expect(decision.kind).toBe("EXECUTE")
  })

  it("REWRITE: email mistyped into name → name masked, email + cpf untouched, no key dropped", () => {
    const decision = adjudicate(
      pix({ name: "Maria foo@bar.com", email: "maria@example.com", cpf: VALID_CPF }),
      baseState(),
      customerOnboardingPack.policy,
    )
    expect(decision.kind).toBe("REWRITE")
    if (decision.kind !== "REWRITE") return
    const p = decision.rewritten.payload as {
      name: string
      email: string
      cpf: string
    }
    expect(p.name).toBe("Maria [REDACTED:EMAIL]")
    expect(p.email).toBe("maria@example.com") // legit email NEVER masked
    expect(p.cpf).toBe(VALID_CPF) // cpf byte-identical (I10)
    expect(Object.keys(p).sort()).toEqual(["cpf", "email", "name"])
  })

  it("REFUSE: card PAN in the name leaf → pii_blocked", () => {
    const decision = adjudicate(
      pix({ name: "4111 1111 1111 1111", email: "maria@x.com", cpf: VALID_CPF }),
      baseState(),
      customerOnboardingPack.policy,
    )
    expect(decision.kind).toBe("REFUSE")
    if (decision.kind !== "REFUSE") return
    expect(decision.refusal.code).toBe("pii_blocked")
  })

  it("REFUSE: card PAN in the email leaf → pii_blocked", () => {
    const decision = adjudicate(
      pix({ name: "Maria", email: "4111111111111111", cpf: VALID_CPF }),
      baseState(),
      customerOnboardingPack.policy,
    )
    expect(decision.kind).toBe("REFUSE")
  })

  it("ordering: PAN + email both in name → REFUSE wins over REWRITE", () => {
    const decision = adjudicate(
      pix({
        name: "foo@bar.com 4111111111111111",
        email: "maria@x.com",
        cpf: VALID_CPF,
      }),
      baseState(),
      customerOnboardingPack.policy,
    )
    expect(decision.kind).toBe("REFUSE")
  })
})
