// FE-T20 — FE-4 MIGRATE 1: intent-identity family generators.
//
// Four family members, four freshness targets:
//   1. KNOWN_INTENT_KINDS        — generateKnownIntentKinds, vs the real
//                                   exported union (+ 2 real external inputs)
//   2. per-pack type-union mirror — generateIntentKindsMirror, vs the real
//                                   exported *_INTENT_KINDS in intent-kinds
//                                   (newly exported this ticket — see that
//                                   file's own comment)
//   3. per-pack runtime intents[] — generatePackIntents, vs each pack's own
//                                   real exported `xxxPack.intents`
//   4. planner allowedIntents     — generatePlannerAllowedIntents, vs a
//                                   RUNTIME-MATERIALIZED union (the real
//                                   CapabilityPlanner.plan() driven under
//                                   synthetic probe states, mirroring
//                                   apps/api's own ROSTER_DRIFT_CONTEXTS
//                                   pattern) — no committed file to diff
//                                   against for this one; see
//                                   generate-planner-allowed-intents.ts's
//                                   own doc for why.

import { describe, expect, it } from "vitest"

import { paymentsPixPack } from "@adjudicate/pack-payments-pix"
import {
  CUSTOMER_ONBOARDING_INTENT_KINDS,
  KNOWN_INTENT_KINDS,
  LOYALTY_INTENT_KINDS,
  OPS_INTENT_KINDS,
  ORDER_INTENT_KINDS,
  PAYMENT_INTENT_KINDS,
  PIX_INTENT_KINDS,
  RESERVATION_INTENT_KINDS,
  WHATSAPP_INTENT_KINDS,
} from "@ibatexas/intent-kinds"
import { customerOnboardingCapabilityPlanner } from "@ibatexas/pack-customer-onboarding"
import { opsCapabilityPlanner } from "@ibatexas/pack-ops"
import { ordersCapabilityPlanner } from "@ibatexas/pack-orders"
import { paymentsCapabilityPlanner } from "@ibatexas/pack-payments"
import { reservationsCapabilityPlanner } from "@ibatexas/pack-reservations"
import { whatsappCapabilityPlanner } from "@ibatexas/pack-whatsapp"

import {
  CAPABILITY_DEFINITIONS,
  generateIntentKindsMirror,
  generateKnownIntentKinds,
  generatePackIntents,
  generatePlannerAllowedIntents,
} from "../capability-definitions/index.js"
import type { CapabilityDefinition, CapabilityPackId } from "../capability-definitions/index.js"

const ALL_PACKS: readonly CapabilityPackId[] = [
  "ibatexas/pack-orders",
  "ibatexas/pack-reservations",
  "ibatexas/pack-customer-onboarding",
  "ibatexas/pack-payments",
  "ibatexas/pack-whatsapp",
  "ibatexas/pack-ops",
]

// ── Family 1: KNOWN_INTENT_KINDS ─────────────────────────────────────────

describe("codegen-freshness gate — KNOWN_INTENT_KINDS (FE-T20 family 1)", () => {
  it("reproduces KNOWN_INTENT_KINDS byte-for-byte (set contents) from the 58 authored definitions + the two real external inputs", () => {
    const generated = generateKnownIntentKinds(CAPABILITY_DEFINITIONS, {
      // Real runtime materialization — the actual installed PIX pack's own
      // declared intents, never a hand-retyped literal.
      pixIntentKinds: paymentsPixPack.intents,
      loyaltyIntentKinds: [...LOYALTY_INTENT_KINDS],
    })
    expect([...generated].sort()).toEqual([...KNOWN_INTENT_KINDS].sort())
  })

  it("paymentsPixPack.intents (runtime) agrees with the hand-mirrored PIX_INTENT_KINDS (belt-and-braces cross-check)", () => {
    expect([...paymentsPixPack.intents].sort()).toEqual([...PIX_INTENT_KINDS].sort())
  })

  it("the 58 authored definitions alone (no external inputs) cover exactly KNOWN_INTENT_KINDS minus the 3 pix + 1 loyalty kinds", () => {
    // 66 → 61 (BKL-176 retired 5 dead payment.charge.*) → 59 (BKL-177 PR-A
    // retired order.cancel.system + reservation.waitlist.notify) → 57 (BKL-177
    // PR-B retired whatsapp.message.send + template.send) → 58 (NEW-014 added
    // the system-only order.fiscal.emit).
    expect(CAPABILITY_DEFINITIONS).toHaveLength(58)
    const registryOnly = generateKnownIntentKinds(CAPABILITY_DEFINITIONS, {
      pixIntentKinds: [],
      loyaltyIntentKinds: [],
    })
    expect(registryOnly.size).toBe(58)
    const pixSet = new Set<string>(PIX_INTENT_KINDS)
    const expected = new Set(
      [...KNOWN_INTENT_KINDS].filter((k) => !pixSet.has(k) && !LOYALTY_INTENT_KINDS.has(k)),
    )
    expect([...registryOnly].sort()).toEqual([...expected].sort())
  })

  it("is a genuine derivation, not hand-copied: dropping an authored definition changes the projected set", () => {
    const first = CAPABILITY_DEFINITIONS[0]
    if (first === undefined) throw new Error("test fixture assumption violated: CAPABILITY_DEFINITIONS is empty")
    const withoutFirst = CAPABILITY_DEFINITIONS.slice(1)
    const generated = generateKnownIntentKinds(withoutFirst, {
      pixIntentKinds: paymentsPixPack.intents,
      loyaltyIntentKinds: [...LOYALTY_INTENT_KINDS],
    })
    expect(generated.has(first.kind)).toBe(false)
  })
})

// ── Family 2: per-pack type-union mirror (intent-kinds/*_INTENT_KINDS) ──

describe("codegen-freshness gate — per-pack type-union mirror (FE-T20 family 2)", () => {
  const CASES: ReadonlyArray<{ pack: CapabilityPackId; hand: readonly string[] }> = [
    { pack: "ibatexas/pack-orders", hand: ORDER_INTENT_KINDS },
    { pack: "ibatexas/pack-reservations", hand: RESERVATION_INTENT_KINDS },
    { pack: "ibatexas/pack-customer-onboarding", hand: CUSTOMER_ONBOARDING_INTENT_KINDS },
    { pack: "ibatexas/pack-payments", hand: PAYMENT_INTENT_KINDS },
    { pack: "ibatexas/pack-whatsapp", hand: WHATSAPP_INTENT_KINDS },
    { pack: "ibatexas/pack-ops", hand: OPS_INTENT_KINDS },
  ]

  for (const { pack, hand } of CASES) {
    it(`${pack}: reproduces its *_INTENT_KINDS mirror byte-for-byte, in order (${hand.length} kinds)`, () => {
      expect(generateIntentKindsMirror(CAPABILITY_DEFINITIONS, pack)).toEqual([...hand])
    })
  }

  it("union of all 6 mirrors + pix + loyalty reconstructs KNOWN_INTENT_KINDS — cross-checks the per-pack slices against the union definition intent-kinds/index.ts itself uses", () => {
    const union = new Set<string>()
    for (const pack of ALL_PACKS) {
      for (const kind of generateIntentKindsMirror(CAPABILITY_DEFINITIONS, pack)) union.add(kind)
    }
    for (const kind of PIX_INTENT_KINDS) union.add(kind)
    for (const kind of LOYALTY_INTENT_KINDS) union.add(kind)
    expect([...union].sort()).toEqual([...KNOWN_INTENT_KINDS].sort())
  })
})

// ── Family 3: per-pack runtime intents[] (each Pack's own PackV0.intents) ──

describe("codegen-freshness gate — per-pack runtime intents[] (FE-T20 family 3)", () => {
  it("ibatexas/pack-orders: reproduces ordersPack.intents byte-for-byte", async () => {
    const { ordersPack } = await import("@ibatexas/pack-orders")
    expect(generatePackIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-orders")).toEqual([...ordersPack.intents])
  })

  it("ibatexas/pack-reservations: reproduces reservationsPack.intents byte-for-byte", async () => {
    const { reservationsPack } = await import("@ibatexas/pack-reservations")
    expect(generatePackIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-reservations")).toEqual([
      ...reservationsPack.intents,
    ])
  })

  it("ibatexas/pack-customer-onboarding: reproduces customerOnboardingPack.intents byte-for-byte", async () => {
    const { customerOnboardingPack } = await import("@ibatexas/pack-customer-onboarding")
    expect(generatePackIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-customer-onboarding")).toEqual([
      ...customerOnboardingPack.intents,
    ])
  })

  it("ibatexas/pack-payments: reproduces paymentsPack.intents byte-for-byte", async () => {
    const { paymentsPack } = await import("@ibatexas/pack-payments")
    expect(generatePackIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-payments")).toEqual([...paymentsPack.intents])
  })

  it("ibatexas/pack-whatsapp: reproduces whatsappPack.intents byte-for-byte", async () => {
    const { whatsappPack } = await import("@ibatexas/pack-whatsapp")
    expect(generatePackIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-whatsapp")).toEqual([...whatsappPack.intents])
  })

  it("ibatexas/pack-ops: reproduces opsPack.intents byte-for-byte", async () => {
    const { opsPack } = await import("@ibatexas/pack-ops")
    expect(generatePackIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-ops")).toEqual([...opsPack.intents])
  })

  it("hand-corrupt one definition's kind → the freshness diff fails (the ticket's required negative direction)", async () => {
    const { ordersPack } = await import("@ibatexas/pack-orders")
    const corrupted: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def, i) =>
      i === 0 ? { ...def, kind: "order.THIS_KIND_DOES_NOT_EXIST" } : def,
    )
    expect(generatePackIntents(corrupted, "ibatexas/pack-orders")).not.toEqual([...ordersPack.intents])
  })
})

// ── Family 4: planner allowedIntents (runtime materialization) ──────────
//
// No committed hand file to diff against — `allowedIntents` is runtime
// planner OUTPUT. Drives the REAL CapabilityPlanner.plan() for each pack
// under synthetic probe states (mirroring apps/api's own
// ROSTER_DRIFT_CONTEXTS: an authenticated-customer probe and a staff
// probe), unions what each pack's planner ACTUALLY returned across every
// probe it cares about, and asserts the generator's static projection
// equals that real union — the FE-4.3-preferred "diff against an
// independent runtime materialization", not a second hand list.

/** Mirrors the union ctx shape every pack's planner reads `state.ctx.X`
 *  off — the same minimal probe shape apps/api's own `driftProbeState`
 *  uses for the identical purpose (`register-ibatexas-tool-packs.ts`). */
function probeState(over: {
  readonly customerId?: string | null
  readonly staffId?: string | null
  readonly isAuthenticated?: boolean
}): unknown {
  return {
    ctx: {
      tenantId: "ibatexas",
      channel: "web",
      cartId: null,
      orderId: null,
      customerId: null,
      staffId: null,
      isAuthenticated: false,
      ...over,
    },
  }
}

const AUTHED_CUSTOMER_PROBE = probeState({ customerId: "probe-customer", isAuthenticated: true })
const STAFF_PROBE = probeState({ staffId: "probe-staff" })
const ANONYMOUS_PROBE = probeState({})

describe("codegen-freshness gate — planner allowedIntents (FE-T20 family 4, runtime materialization)", () => {
  it("ibatexas/pack-orders: the static union matches the real planner's output under the authenticated-customer probe", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only probe cast, see module doc
    const live = ordersCapabilityPlanner.plan(AUTHED_CUSTOMER_PROBE as any, {} as any).allowedIntents
    expect([...generatePlannerAllowedIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-orders")].sort()).toEqual(
      [...live].sort(),
    )
  })

  it("ibatexas/pack-reservations: the static union matches the real planner's output UNIONED across the customer probe AND the staff probe", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only probe cast, see module doc
    const customerLive = reservationsCapabilityPlanner.plan(AUTHED_CUSTOMER_PROBE as any, {} as any).allowedIntents
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only probe cast, see module doc
    const staffLive = reservationsCapabilityPlanner.plan(STAFF_PROBE as any, {} as any).allowedIntents
    const liveUnion = new Set([...customerLive, ...staffLive])
    expect([...generatePlannerAllowedIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-reservations")].sort()).toEqual(
      [...liveUnion].sort(),
    )
  })

  it("ibatexas/pack-customer-onboarding: the static union matches the real planner's output under the authenticated-customer probe", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only probe cast, see module doc
    const live = customerOnboardingCapabilityPlanner.plan(AUTHED_CUSTOMER_PROBE as any, {} as any).allowedIntents
    expect(
      [...generatePlannerAllowedIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-customer-onboarding")].sort(),
    ).toEqual([...live].sort())
  })

  it("ibatexas/pack-payments: the static union matches the real planner's output (state-independent — always payment.pix.regenerate)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only probe cast, see module doc
    const live = paymentsCapabilityPlanner.plan(ANONYMOUS_PROBE as any, {} as any).allowedIntents
    expect([...generatePlannerAllowedIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-payments")].sort()).toEqual(
      [...live].sort(),
    )
  })

  it("ibatexas/pack-whatsapp: the static union matches the real planner's output — whatsapp.handoff.request, unconditionally, under every probe (FE-T14/BKL-030-activation)", () => {
    for (const probe of [ANONYMOUS_PROBE, AUTHED_CUSTOMER_PROBE, STAFF_PROBE]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only probe cast, see module doc
      expect(whatsappCapabilityPlanner.plan(probe as any, {} as any).allowedIntents).toEqual([
        "whatsapp.handoff.request",
      ])
    }
    expect(generatePlannerAllowedIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-whatsapp")).toEqual([
      "whatsapp.handoff.request",
    ])
  })

  it("ibatexas/pack-ops: the static union matches the real planner's output under the staff probe (empty for non-staff, verified separately)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only probe cast, see module doc
    const anonymousLive = opsCapabilityPlanner.plan(ANONYMOUS_PROBE as any, {} as any).allowedIntents
    expect(anonymousLive).toEqual([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only probe cast, see module doc
    const staffLive = opsCapabilityPlanner.plan(STAFF_PROBE as any, {} as any).allowedIntents
    expect([...generatePlannerAllowedIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-ops")].sort()).toEqual(
      [...staffLive].sort(),
    )
  })

  it("cross-pack foreign advertisement: order.note.add / order.status.transition / payment.refund.issue are all advertised by pack-ops' own staff probe, despite being owned by pack-orders / pack-payments", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only probe cast, see module doc
    const opsStaffLive = opsCapabilityPlanner.plan(STAFF_PROBE as any, {} as any).allowedIntents as readonly string[]
    expect(opsStaffLive).toEqual(
      expect.arrayContaining(["order.note.add", "order.status.transition", "payment.refund.issue"]),
    )
    const generated = generatePlannerAllowedIntents(CAPABILITY_DEFINITIONS, "ibatexas/pack-ops")
    expect(generated).toEqual(
      expect.arrayContaining(["order.note.add", "order.status.transition", "payment.refund.issue"]),
    )
  })

  it("FE-D28 — order.review.submit is now advertised by pack-orders' OWN planner projection (review-by-chat activated), and by no other pack", () => {
    // Was the last "registered-but-unadvertised" chat-tier kind until FE-D28
    // wired the orderId/productId resolver (resolve-and-assemble.ts) and flipped
    // plannerAdvertisedBy to ["ibatexas/pack-orders"]. Mirrors how
    // whatsapp.handoff.request's test inverted after FE-T14/BKL-030-activation.
    const ordersGenerated = generatePlannerAllowedIntents(
      CAPABILITY_DEFINITIONS,
      "ibatexas/pack-orders",
    )
    expect(ordersGenerated).toContain("order.review.submit")
    for (const pack of ALL_PACKS) {
      if (pack === "ibatexas/pack-orders") continue
      const generated = generatePlannerAllowedIntents(CAPABILITY_DEFINITIONS, pack)
      expect(generated).not.toContain("order.review.submit")
    }
  })
})
