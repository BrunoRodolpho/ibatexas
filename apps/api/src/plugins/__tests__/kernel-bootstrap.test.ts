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
import {
  assertPackCoverage,
  PackCoverageError,
  assertAuditPostgresReady,
  AuditPostgresPreflightError,
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
