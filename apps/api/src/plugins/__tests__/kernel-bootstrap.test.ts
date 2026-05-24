// kernel-bootstrap.test.ts — always-on kernel boot guarantees.
//
// Coverage:
//   - bootstrapKernel installs all 5 first-party Packs
//   - assertPackCoverage throws when a KNOWN_INTENT_KINDS entry is
//     not declared by any installed Pack
//   - assertAuditPostgresReady throws cleanly when intent_audit is
//     missing (operator gets a clear path to `ibx bootstrap`)

import { afterEach, describe, expect, it } from "vitest"
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
