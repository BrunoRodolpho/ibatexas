// extraction/accuracy-cli.test.ts — FE-T10: the ops-history/session clearer
// (`createOpsHistoryClearer`) pins BOTH keys it must clear per case so a
// money-tier corpus (which ALWAYS parks a REQUEST_CONFIRMATION) never bleeds
// a stale park into a later case — see accuracy-runner.ts's module header
// for the live-caught defect this closes.

import { describe, expect, it, vi } from "vitest"

const delMock = vi.fn(async () => 1)
const rkMock = vi.fn((key: string) => `ibx:${key}`)

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({ del: delMock })),
  rk: rkMock,
}))

describe("createOpsHistoryClearer", () => {
  it("clears BOTH the ops chat-history key AND the claustrum session key (the FE-T10 pending-confirmation fix)", async () => {
    const { createOpsHistoryClearer } = await import("../accuracy-cli.js")
    const clear = createOpsHistoryClearer(() => undefined)
    await clear("staff_1")

    expect(rkMock).toHaveBeenCalledWith("ops:chat:history:staff_1")
    expect(rkMock).toHaveBeenCalledWith("claustrum:session:admin:staff_1")
    expect(delMock).toHaveBeenCalledWith("ibx:ops:chat:history:staff_1")
    expect(delMock).toHaveBeenCalledWith("ibx:claustrum:session:admin:staff_1")
    expect(delMock).toHaveBeenCalledTimes(2)
  })

  it("warns ONCE and re-throws on every call when Redis is unreachable (isolation must never silently degrade)", async () => {
    vi.resetModules()
    vi.doMock("@ibatexas/tools", () => ({
      getRedisClient: vi.fn(async () => {
        throw new Error("connection refused")
      }),
      rk: rkMock,
    }))
    const { createOpsHistoryClearer } = await import("../accuracy-cli.js")
    const warnings: string[] = []
    const clear = createOpsHistoryClearer((line) => warnings.push(line))

    await expect(clear("staff_1")).rejects.toThrow("connection refused")
    await expect(clear("staff_1")).rejects.toThrow("connection refused")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("isolation NOT guaranteed")
  })
})
