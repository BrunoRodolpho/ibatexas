// kernel-bootstrap.test.ts — boot-time fail-closed guarantees.
//
// Coverage:
//   - P0-9: `bootstrapKernel` THROWS when `IBX_KERNEL_SHADOW` or
//     `IBX_KERNEL_ENFORCE` contains an unknown intent kind. The throw is the
//     path that lets `start().catch(...)` (P0-6) trigger `process.exit(1)`.
//     Previously a typo only emitted a warn line — enforcement silently off.
//
// Notes:
//   - We use a minimal fake `FastifyInstance`-shaped object exposing only
//     `server.log` (info/warn/fatal) since bootstrapKernel only reaches into
//     that surface plus the static `installPack`/`validateEnforceConfig`
//     bindings. The fake keeps the test off Fastify boot machinery.
//   - `_resetEnforceConfig` clears the cached env snapshot between cases so
//     a stale singleton from another test doesn't poison this file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { _resetEnforceConfig } from "@adjudicate/core/kernel"
import { bootstrapKernel } from "../kernel-bootstrap.js"

// ── Fake Fastify ─────────────────────────────────────────────────────────────

function makeServer() {
  const info = vi.fn()
  const warn = vi.fn()
  const fatal = vi.fn()
  const error = vi.fn()
  const debug = vi.fn()
  const server = {
    log: { info, warn, fatal, error, debug },
  } as unknown as Parameters<typeof bootstrapKernel>[0]
  return { server, info, warn, fatal }
}

// ── Env-var helpers ──────────────────────────────────────────────────────────

const SAVED_SHADOW = process.env.IBX_KERNEL_SHADOW
const SAVED_ENFORCE = process.env.IBX_KERNEL_ENFORCE

function clearEnvConfig() {
  delete process.env.IBX_KERNEL_SHADOW
  delete process.env.IBX_KERNEL_ENFORCE
  _resetEnforceConfig()
}

beforeEach(() => {
  clearEnvConfig()
})

afterEach(() => {
  if (SAVED_SHADOW === undefined) {
    delete process.env.IBX_KERNEL_SHADOW
  } else {
    process.env.IBX_KERNEL_SHADOW = SAVED_SHADOW
  }
  if (SAVED_ENFORCE === undefined) {
    delete process.env.IBX_KERNEL_ENFORCE
  } else {
    process.env.IBX_KERNEL_ENFORCE = SAVED_ENFORCE
  }
  _resetEnforceConfig()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe("bootstrapKernel — P0-9 enforce-config typo fail-closed", () => {
  it("succeeds when env vars are unset", async () => {
    const { server, fatal } = makeServer()
    await expect(bootstrapKernel(server)).resolves.toBeUndefined()
    expect(fatal).not.toHaveBeenCalled()
  })

  it("succeeds when IBX_KERNEL_SHADOW lists only known intent kinds", async () => {
    process.env.IBX_KERNEL_SHADOW = "order.item.add,reservation.create"
    const { server, fatal } = makeServer()
    await expect(bootstrapKernel(server)).resolves.toBeUndefined()
    expect(fatal).not.toHaveBeenCalled()
  })

  it("succeeds with wildcard", async () => {
    process.env.IBX_KERNEL_ENFORCE = "*"
    const { server, fatal } = makeServer()
    await expect(bootstrapKernel(server)).resolves.toBeUndefined()
    expect(fatal).not.toHaveBeenCalled()
  })

  it("THROWS when IBX_KERNEL_ENFORCE has a typo (unknown intent kind)", async () => {
    // P0-9 example from the audit: a typo like `order.cart.adddd` used to
    // warn and proceed. Now it must halt boot.
    process.env.IBX_KERNEL_ENFORCE = "order.cart.adddd"
    const { server, fatal } = makeServer()

    await expect(bootstrapKernel(server)).rejects.toThrow(
      /enforce-config typo/i,
    )
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "kernel.bootstrap.enforce_config_typo",
        unknownEnforce: expect.arrayContaining(["order.cart.adddd"]),
      }),
      expect.any(String),
    )
  })

  it("THROWS when IBX_KERNEL_SHADOW has a typo", async () => {
    process.env.IBX_KERNEL_SHADOW = "order.item.add,order.bogus.kind"
    const { server, fatal } = makeServer()

    await expect(bootstrapKernel(server)).rejects.toThrow(
      /enforce-config typo/i,
    )
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "kernel.bootstrap.enforce_config_typo",
        unknownShadow: expect.arrayContaining(["order.bogus.kind"]),
      }),
      expect.any(String),
    )
  })

  it("THROWS when both shadow and enforce contain typos", async () => {
    process.env.IBX_KERNEL_SHADOW = "order.zzz"
    process.env.IBX_KERNEL_ENFORCE = "payment.yyy"
    const { server } = makeServer()
    await expect(bootstrapKernel(server)).rejects.toThrow(
      /enforce-config typo/i,
    )
  })
})

// ── P0-9-TRUE: empty-after-trim ─────────────────────────────────────────────

describe("assertEnforceConfigNotEmptyAfterTrim — P0-9-TRUE", () => {
  // Import the helper directly so we can drive it with synthetic env objects.
  it("accepts env unset (deliberate empty)", async () => {
    const { assertEnforceConfigNotEmptyAfterTrim } = await import(
      "../kernel-bootstrap.js"
    )
    expect(() => assertEnforceConfigNotEmptyAfterTrim({})).not.toThrow()
  })

  it("accepts an explicitly empty-string env (legitimate empty config)", async () => {
    const { assertEnforceConfigNotEmptyAfterTrim } = await import(
      "../kernel-bootstrap.js"
    )
    expect(() =>
      assertEnforceConfigNotEmptyAfterTrim({ IBX_KERNEL_ENFORCE: "" }),
    ).not.toThrow()
    expect(() =>
      assertEnforceConfigNotEmptyAfterTrim({ IBX_KERNEL_SHADOW: "" }),
    ).not.toThrow()
  })

  it("accepts a non-empty enforce list with trailing comma", async () => {
    const { assertEnforceConfigNotEmptyAfterTrim } = await import(
      "../kernel-bootstrap.js"
    )
    // "order.cancel, " strips to ["order.cancel"] — at least one valid kind
    // survives. This is suspicious but not the all-empty typo pattern; the
    // existing typo-guard will catch unknown kinds.
    expect(() =>
      assertEnforceConfigNotEmptyAfterTrim({
        IBX_KERNEL_ENFORCE: "order.cancel, ",
      }),
    ).not.toThrow()
  })

  it("THROWS when IBX_KERNEL_ENFORCE is all commas+whitespace", async () => {
    const { assertEnforceConfigNotEmptyAfterTrim } = await import(
      "../kernel-bootstrap.js"
    )
    expect(() =>
      assertEnforceConfigNotEmptyAfterTrim({ IBX_KERNEL_ENFORCE: " , , " }),
    ).toThrow(/strips to an empty kind list/i)
  })

  it("THROWS when IBX_KERNEL_ENFORCE is a single comma", async () => {
    const { assertEnforceConfigNotEmptyAfterTrim } = await import(
      "../kernel-bootstrap.js"
    )
    expect(() =>
      assertEnforceConfigNotEmptyAfterTrim({ IBX_KERNEL_ENFORCE: "," }),
    ).toThrow(/strips to an empty kind list/i)
  })

  it("THROWS when IBX_KERNEL_ENFORCE is whitespace only", async () => {
    const { assertEnforceConfigNotEmptyAfterTrim } = await import(
      "../kernel-bootstrap.js"
    )
    expect(() =>
      assertEnforceConfigNotEmptyAfterTrim({ IBX_KERNEL_ENFORCE: "  " }),
    ).toThrow(/strips to an empty kind list/i)
  })

  it("THROWS when IBX_KERNEL_SHADOW is all commas+whitespace", async () => {
    const { assertEnforceConfigNotEmptyAfterTrim } = await import(
      "../kernel-bootstrap.js"
    )
    expect(() =>
      assertEnforceConfigNotEmptyAfterTrim({ IBX_KERNEL_SHADOW: " , , " }),
    ).toThrow(/strips to an empty kind list/i)
  })

  it("rejects empty-after-trim BEFORE unknown-token validation in bootstrap", async () => {
    process.env.IBX_KERNEL_ENFORCE = " , , "
    const { server } = makeServer()
    // The throw mentions empty-after-trim, NOT the unknown-token message.
    await expect(bootstrapKernel(server)).rejects.toThrow(
      /strips to an empty kind list/i,
    )
  })
})
