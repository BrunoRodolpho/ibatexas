// seed-cancelable-order.test.ts — FE-T12 (team-lead ruling: "fix the cancel
// money-boundary seeding, don't defer"): `targetCentavosForCancelCase`
// (pure) plus `seedCancelableOrder`'s argument-building and error paths
// against a SCRIPTED `node:child_process` double (no live seed-refundable-
// order.ts execution — that governed path is already covered by its own
// module's tests and was hand-verified live; see the PR body).

import { describe, expect, it, vi } from "vitest"

describe("targetCentavosForCancelCase", () => {
  it("maps every named money-boundary case id to its own specific target", async () => {
    const { targetCentavosForCancelCase } = await import("../seed-cancelable-order.js")
    expect(targetCentavosForCancelCase("escalate-exact-threshold-boundary")).toBe(100_000)
    expect(targetCentavosForCancelCase("escalate-well-above-threshold")).toBe(300_000)
    expect(targetCentavosForCancelCase("escalate-paid-large-with-reason")).toBe(150_000)
    expect(targetCentavosForCancelCase("confirm-just-below-escalate-threshold")).toBe(99_999)
    expect(targetCentavosForCancelCase("confirm-paid-below-threshold")).toBe(20_000)
  })

  it("defaults every OTHER case id to the modest R$50,00 total", async () => {
    const { targetCentavosForCancelCase } = await import("../seed-cancelable-order.js")
    expect(targetCentavosForCancelCase("bare-direct")).toBe(5_000)
    expect(targetCentavosForCancelCase("reason-mudei-de-ideia")).toBe(5_000)
    expect(targetCentavosForCancelCase("some-unknown-future-case-id")).toBe(5_000)
  })
})

function mockExecFile(impl: (file: string, args: readonly string[]) => { stdout: string; stderr: string }): void {
  vi.doMock("node:child_process", () => ({
    execFile: (
      file: string,
      args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      try {
        cb(null, impl(file, args))
      } catch (err) {
        cb(err as Error)
      }
    },
  }))
}

describe("seedCancelableOrder — argument building", () => {
  it("invokes seed-refundable-order.ts via `npx tsx` with --amount-centavos / --method cash / --customer-id", async () => {
    vi.resetModules()
    let capturedArgs: readonly string[] = []
    mockExecFile((file, args) => {
      capturedArgs = args
      return {
        stdout: `${JSON.stringify({ orderId: "order_ws9_refund_abc", amountInCentavos: 100_000 })}\n`,
        stderr: "",
      }
    })
    const { seedCancelableOrder } = await import("../seed-cancelable-order.js")

    const result = await seedCancelableOrder({ customerId: "cust_1", targetCentavos: 100_000 })

    expect(result).toEqual({ orderId: "order_ws9_refund_abc", amountInCentavos: 100_000 })
    expect(capturedArgs).toContain("--amount-centavos")
    expect(capturedArgs).toContain("100000")
    expect(capturedArgs).toContain("--method")
    expect(capturedArgs).toContain("cash")
    expect(capturedArgs).toContain("--customer-id")
    expect(capturedArgs).toContain("cust_1")
    expect(capturedArgs.some((a) => a.endsWith("seed-refundable-order.ts"))).toBe(true)
  })
})

describe("seedCancelableOrder — error paths (never silently proceeds with wrong/malformed data)", () => {
  it("throws SeedCancelableOrderError when the child process fails", async () => {
    vi.resetModules()
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        cb(new Error("DATABASE_URL is not set"))
      },
    }))
    const { seedCancelableOrder, SeedCancelableOrderError } = await import("../seed-cancelable-order.js")

    await expect(
      seedCancelableOrder({ customerId: "cust_1", targetCentavos: 5_000 }),
    ).rejects.toThrow(SeedCancelableOrderError)
    await expect(
      seedCancelableOrder({ customerId: "cust_1", targetCentavos: 5_000 }),
    ).rejects.toThrow(/DATABASE_URL is not set/)
  })

  it("throws SeedCancelableOrderError when stdout is not valid JSON", async () => {
    vi.resetModules()
    mockExecFile(() => ({ stdout: "not json at all", stderr: "" }))
    const { seedCancelableOrder, SeedCancelableOrderError } = await import("../seed-cancelable-order.js")

    await expect(
      seedCancelableOrder({ customerId: "cust_1", targetCentavos: 5_000 }),
    ).rejects.toThrow(SeedCancelableOrderError)
  })

  it("throws SeedCancelableOrderError when the seeded order's total does NOT match the target exactly", async () => {
    vi.resetModules()
    mockExecFile(() => ({
      stdout: `${JSON.stringify({ orderId: "order_ws9_refund_abc", amountInCentavos: 4_999 })}\n`,
      stderr: "",
    }))
    const { seedCancelableOrder, SeedCancelableOrderError } = await import("../seed-cancelable-order.js")

    await expect(
      seedCancelableOrder({ customerId: "cust_1", targetCentavos: 5_000 }),
    ).rejects.toThrow(SeedCancelableOrderError)
    await expect(
      seedCancelableOrder({ customerId: "cust_1", targetCentavos: 5_000 }),
    ).rejects.toThrow(/expected EXACTLY 5000/)
  })
})
