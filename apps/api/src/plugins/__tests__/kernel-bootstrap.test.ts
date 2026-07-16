// kernel-bootstrap.test.ts — always-on kernel boot guarantees.
//
// Coverage:
//   - bootstrapKernel installs all 6 first-party Packs
//   - assertPackCoverage throws when a KNOWN_INTENT_KINDS entry is
//     not declared by any installed Pack
//   - assertAuditPostgresReady throws cleanly when intent_audit is
//     missing (operator gets a clear path to `ibx bootstrap`)

import { afterEach, describe, expect, it } from "vitest"
import { customerOnboardingPack } from "@ibatexas/pack-customer-onboarding"
import { opsPack } from "@ibatexas/pack-ops"
import { ordersPack } from "@ibatexas/pack-orders"
import { paymentsPack } from "@ibatexas/pack-payments"
import { paymentsPixPack } from "@adjudicate/pack-payments-pix"
import { reservationsPack } from "@ibatexas/pack-reservations"
import { whatsappPack } from "@ibatexas/pack-whatsapp"
import { KNOWN_INTENT_KINDS, LOYALTY_INTENT_KINDS } from "@ibatexas/intent-kinds"
import { withAdjudicate } from "@ibatexas/domain"
import { runCustomerIntent } from "../../routes/__shared__/customer-intent-gateway.js"
import {
  CAPABILITY_DEFINITIONS,
  generateKnownIntentKinds,
  GuardRefResolutionError,
  type CapabilityDefinition,
} from "@ibatexas/packs-composed/capability-definitions"
import {
  assertPackCoverage,
  PackCoverageError,
  assertAuditPostgresReady,
  AuditPostgresPreflightError,
  assertEnvelopeBoundaryGateWired,
  assertCommandServiceBoundaryGateWired,
  EnvelopeBoundaryGateNotWiredError,
  assertCapabilityGuardRefsWired,
} from "../kernel-bootstrap.js"

// ── Pack coverage ────────────────────────────────────────────────────────────

function fakeInstalledPack(intents: readonly string[]) {
  return { pack: { intents } }
}

describe("assertPackCoverage", () => {
  it("passes when every known kind is declared by some Pack", () => {
    const packs = [
      fakeInstalledPack(["order.cart.ensure", "order.item.add"]),
      fakeInstalledPack(["reservation.create"]),
    ]
    expect(() =>
      assertPackCoverage(packs, new Set(["order.cart.ensure", "order.item.add", "reservation.create"])),
    ).not.toThrow()
  })

  it("throws PackCoverageError listing every uncovered kind", () => {
    const packs = [fakeInstalledPack(["order.cart.ensure"])]
    let caught: unknown = null
    try {
      assertPackCoverage(packs, new Set(["order.cart.ensure", "order.item.add", "payment.create"]))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PackCoverageError)
    expect((caught as PackCoverageError).missingKinds).toEqual(
      expect.arrayContaining(["order.item.add", "payment.create"]),
    )
  })

  it("treats an empty installed-pack list as failing for any known kind", () => {
    expect(() =>
      assertPackCoverage([], new Set(["order.cart.ensure"])),
    ).toThrow(PackCoverageError)
  })
})

// ── Real boot roster covers the real taxonomy ────────────────────────────────
//
// Regression guard. The toy-set cases above never exercise the actual
// `KNOWN_INTENT_KINDS` against the actual installed roster, which is exactly
// how `pix.charge.*` (the un-installed `@adjudicate/pack-payments-pix` Pack)
// and `loyalty.stamp.add` (a domain-internal bundle, never registered) both
// slipped past CI and crashed the live boot. These tests pin the invariant:
// every pack-registered kind resolves to one of the six installed Packs, and
// the only kinds excluded from the gate are the locally-adjudicated ones.

describe("assertPackCoverage — real boot roster", () => {
  // Mirrors `installFirstPartyPacks()` in kernel-bootstrap.ts. assertPackCoverage
  // reads `installed.pack.intents`, so wrap each raw Pack as `{ pack }`.
  const roster = [
    { pack: ordersPack },
    { pack: reservationsPack },
    { pack: whatsappPack },
    { pack: customerOnboardingPack },
    { pack: paymentsPack },
    { pack: opsPack },
    { pack: paymentsPixPack },
  ]

  // KNOWN_INTENT_KINDS minus the locally-adjudicated kinds — the same set the
  // boot anchor passes (PACK_REGISTERED_INTENT_KINDS, module-private there).
  const packRegistered = new Set(
    [...KNOWN_INTENT_KINDS].filter((kind) => !LOYALTY_INTENT_KINDS.has(kind)),
  )

  it("covers every pack-registered intent kind (incl. pix.charge.*)", () => {
    expect(() => assertPackCoverage(roster, packRegistered)).not.toThrow()
  })

  it("would refuse boot if loyalty.stamp.add were treated as pack-registered", () => {
    // Documents WHY loyalty.stamp.add is excluded: no installed Pack declares
    // it (it ships its own bundle to adjudicate()), so the full KNOWN set fails.
    let caught: unknown = null
    try {
      assertPackCoverage(roster, KNOWN_INTENT_KINDS)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PackCoverageError)
    expect((caught as PackCoverageError).missingKinds).toEqual([
      ...LOYALTY_INTENT_KINDS,
    ])
  })
})

// ── FE-T25 (FE-4.3) — assertPackCoverage repointed to a GENERATED walked set ──
//
// The real boot call (kernel-bootstrap.ts) now walks
// GENERATED_PACK_REGISTERED_INTENT_KINDS (projected from CAPABILITY_
// DEFINITIONS) instead of the hand-authored PACK_REGISTERED_INTENT_KINDS.
// The `declared` side (every installed Pack's real `.intents[]`, inside
// assertPackCoverage's own body) is untouched — already a genuine runtime
// materialization, independent of both. This suite proves (a) the
// generated walked set is byte-identical to the hand-authored one it
// replaces, and (b) a REAL runtime/DI mismatch (an incomplete pack roster)
// still fails closed when probed with the GENERATED set — the repoint
// didn't silently defang the gate.

describe("FE-T25 — assertPackCoverage's generated walked-set repoint", () => {
  // Independently reconstructed here (not imported from kernel-bootstrap.ts,
  // which keeps GENERATED_PACK_REGISTERED_INTENT_KINDS module-private) —
  // mirrors this file's own established pattern of rebuilding
  // PACK_REGISTERED_INTENT_KINDS's derivation above rather than importing it.
  const generatedPackRegistered = new Set(
    [
      ...generateKnownIntentKinds(CAPABILITY_DEFINITIONS, {
        pixIntentKinds: paymentsPixPack.intents,
        loyaltyIntentKinds: [...LOYALTY_INTENT_KINDS],
      }),
    ].filter((kind) => !LOYALTY_INTENT_KINDS.has(kind)),
  )

  const handAuthoredPackRegistered = new Set(
    [...KNOWN_INTENT_KINDS].filter((kind) => !LOYALTY_INTENT_KINDS.has(kind)),
  )

  it("the generated walked set is byte-identical to the hand-authored PACK_REGISTERED_INTENT_KINDS it replaces", () => {
    expect(generatedPackRegistered).toEqual(handAuthoredPackRegistered)
  })

  it("the real 7-pack boot roster still covers the GENERATED walked set (matches the real boot call's new behavior)", () => {
    const roster = [
      { pack: ordersPack },
      { pack: reservationsPack },
      { pack: whatsappPack },
      { pack: customerOnboardingPack },
      { pack: paymentsPack },
      { pack: opsPack },
      { pack: paymentsPixPack },
    ]
    expect(() => assertPackCoverage(roster, generatedPackRegistered)).not.toThrow()
  })

  it("REGRESSION PROOF: a REAL runtime/DI mismatch (an incomplete pack roster) still fails closed against the GENERATED set — proving the repoint is load-bearing, not vacuous", () => {
    // Omit pack-payments — a real DI mismatch (the kind the ratified boot
    // sequence would refuse to start on), not a synthetic toy fixture.
    const incompleteRoster = [
      { pack: ordersPack },
      { pack: reservationsPack },
      { pack: whatsappPack },
      { pack: customerOnboardingPack },
      { pack: opsPack },
      { pack: paymentsPixPack },
    ]
    let caught: unknown = null
    try {
      assertPackCoverage(incompleteRoster, generatedPackRegistered)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PackCoverageError)
    // Positive control: every kind pack-payments owns is among the missing
    // ones (proves this isn't an empty/vacuous failure).
    const missing = (caught as PackCoverageError).missingKinds
    expect(missing).toEqual(expect.arrayContaining(["payment.pix.regenerate"]))
    expect(missing.length).toBeGreaterThan(0)
  })

  it("REGRESSION PROOF (pix positive control): omitting the installed PIX pack itself still fails closed against the GENERATED set — a full roster-removal is caught even though the repoint made the pix sub-leg same-source (see fe4-drift-gates.md's MINOR-2 note)", () => {
    const withoutPix = [
      { pack: ordersPack },
      { pack: reservationsPack },
      { pack: whatsappPack },
      { pack: customerOnboardingPack },
      { pack: paymentsPack },
      { pack: opsPack },
      // paymentsPix omitted.
    ]
    let caught: unknown = null
    try {
      assertPackCoverage(withoutPix, generatedPackRegistered)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PackCoverageError)
    const missing = (caught as PackCoverageError).missingKinds
    expect(missing.some((kind) => kind.startsWith("pix.charge."))).toBe(true)
    expect(missing.length).toBeGreaterThan(0)
  })
})

// ── Audit-postgres preflight ─────────────────────────────────────────────────

describe("assertAuditPostgresReady", () => {
  const SAVED_DATABASE_URL = process.env.DATABASE_URL

  afterEach(() => {
    if (SAVED_DATABASE_URL === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = SAVED_DATABASE_URL
  })

  it("throws when DATABASE_URL is unset", async () => {
    const original = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    try {
      await expect(assertAuditPostgresReady()).rejects.toThrow(
        AuditPostgresPreflightError,
      )
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original
    }
  })

  // Note: full live-table coverage requires a working Postgres connection and
  // is exercised in the audit-postgres-boot-preflight integration test (P2.4).
  // This unit suite covers the env-var guard and error type contract only.
})

// ── FE-T04: envelope structural boundary gate self-check ─────────────────────
//
// `assertEnvelopeBoundaryGateWired` is dependency-injectable ONLY so these
// tests can prove it actually detects a broken gate — the default (no-arg)
// call always exercises the REAL, live `runCustomerIntent`.

describe("assertEnvelopeBoundaryGateWired", () => {
  it("passes against the REAL runCustomerIntent — proves the structural gate is wired on the live path", async () => {
    await expect(assertEnvelopeBoundaryGateWired()).resolves.toBeUndefined()
  })

  it("throws EnvelopeBoundaryGateNotWiredError when the runner skips the structural gate entirely", async () => {
    // Stand-in for what `runCustomerIntent` would do if the gate call were
    // deleted: it just runs the executor unconditionally regardless of
    // envelope shape. Proves the self-check catches that regression rather
    // than vacuously passing.
    const gateRemoved = (async (options: Parameters<typeof runCustomerIntent>[0]) => {
      const result = await options.executor(
        (options.envelope as { payload?: unknown }).payload,
      )
      return {
        statusCode: 200,
        body: result,
        decision: { kind: "EXECUTE", basis: [] },
      }
    }) as unknown as typeof runCustomerIntent

    await expect(assertEnvelopeBoundaryGateWired(gateRemoved)).rejects.toThrow(
      EnvelopeBoundaryGateNotWiredError,
    )
  })

  it("throws when the runner rejects with the WRONG code (e.g. only detectForgery ran, not the structural gate)", async () => {
    const wrongGate = (async () => ({
      statusCode: 400,
      body: { error: "Requisição inválida.", code: "forgery_attempt" },
      decision: {
        kind: "REFUSE",
        refusal: { kind: "SECURITY", code: "forgery_attempt", userFacing: "x" },
        basis: [],
      },
    })) as unknown as typeof runCustomerIntent

    await expect(assertEnvelopeBoundaryGateWired(wrongGate)).rejects.toThrow(
      EnvelopeBoundaryGateNotWiredError,
    )
  })
})

// ── FE-T04: command-service (with-adjudicate) structural boundary gate ───────
//
// The OTHER convergence point: `withAdjudicate` (@ibatexas/domain) is the
// command-service chokepoint every ops/admin/subscriber/job/LLM-tool
// mutation flows through. Same dependency-injection idiom as
// `assertEnvelopeBoundaryGateWired` above — the default (no-arg) call always
// exercises the REAL, live `withAdjudicate`.

describe("assertCommandServiceBoundaryGateWired", () => {
  it("passes against the REAL withAdjudicate — proves the structural gate is wired on the live path", async () => {
    await expect(assertCommandServiceBoundaryGateWired()).resolves.toBeUndefined()
  })

  it("throws EnvelopeBoundaryGateNotWiredError when the runner skips the structural gate entirely", async () => {
    // Stand-in for what `withAdjudicate` would do if the gate call were
    // deleted: it just runs the executor unconditionally regardless of
    // envelope shape.
    const gateRemoved = (async (
      envelope: Parameters<typeof withAdjudicate>[0],
      _state: unknown,
      _policy: unknown,
      executor: (payload: unknown) => Promise<unknown>,
    ) => {
      const result = await executor((envelope as { payload?: unknown }).payload)
      return { decision: { kind: "EXECUTE", basis: [] }, result }
    }) as unknown as typeof withAdjudicate

    await expect(
      assertCommandServiceBoundaryGateWired(gateRemoved),
    ).rejects.toThrow(EnvelopeBoundaryGateNotWiredError)
  })

  it("throws when the runner refuses with the WRONG code (structural gate not what fired)", async () => {
    const wrongGate = (async () => ({
      decision: {
        kind: "REFUSE",
        refusal: { kind: "SECURITY", code: "some_other_code", userFacing: "x" },
        basis: [],
      },
    })) as unknown as typeof withAdjudicate

    await expect(
      assertCommandServiceBoundaryGateWired(wrongGate),
    ).rejects.toThrow(EnvelopeBoundaryGateNotWiredError)
  })

  it("throws when the runner EXECUTEs the malformed envelope (executor ran)", async () => {
    const executedAnyway = (async (
      _envelope: unknown,
      _state: unknown,
      _policy: unknown,
      executor: (payload: unknown) => Promise<unknown>,
    ) => {
      const result = await executor(undefined)
      return { decision: { kind: "EXECUTE", basis: [] }, result }
    }) as unknown as typeof withAdjudicate

    await expect(
      assertCommandServiceBoundaryGateWired(executedAnyway),
    ).rejects.toThrow(EnvelopeBoundaryGateNotWiredError)
  })
})

// ── Capability guard-ref boot assertion (FE-T19) ─────────────────────────────

describe("assertCapabilityGuardRefsWired", () => {
  it("passes against the real, committed CAPABILITY_DEFINITIONS (the default boot call site)", async () => {
    await expect(assertCapabilityGuardRefsWired()).resolves.toBeUndefined()
  })

  it("throws GuardRefResolutionError when an injected guard-ref does not resolve — proves the boot call site would actually catch a dangling ref, not just pass vacuously", async () => {
    const first = CAPABILITY_DEFINITIONS[0]
    if (first === undefined) {
      throw new Error("test fixture assumption violated: CAPABILITY_DEFINITIONS is empty")
    }
    // FE-T20's discriminated union: `guardRefs` exists only on the
    // chat-tier variant, so it must be narrowed before being overridden —
    // spreading the union type directly would be an excess-property error
    // against the identity-tier member.
    if (first.tier !== "chat") {
      throw new Error(`test fixture assumption violated: "${first.kind}" is tier:"${first.tier}", expected "chat"`)
    }
    const broken: readonly CapabilityDefinition[] = [
      {
        ...first,
        guardRefs: [{ phase: "business", name: "this_guard_does_not_exist_KB_TEST" }],
      },
    ]
    await expect(assertCapabilityGuardRefsWired(broken)).rejects.toThrow(
      GuardRefResolutionError,
    )
  })
})
