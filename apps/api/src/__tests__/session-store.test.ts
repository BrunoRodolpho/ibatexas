// Unit tests for session/store.ts — mocked Redis

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mock Redis client ─────────────────────────────────────────────────────────

const mockMulti = {
  rPush: vi.fn().mockReturnThis(),
  lTrim: vi.fn().mockReturnThis(),
  expire: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue([]),
}

const mockRedis = {
  lRange: vi.fn(),
  multi: vi.fn(() => mockMulti),
}

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => mockRedis),
}))

import { loadSession, appendMessages } from "../session/store.js"

beforeEach(() => {
  vi.clearAllMocks()
})

// ── loadSession ───────────────────────────────────────────────────────────────

describe("loadSession", () => {
  it("returns empty array when no history exists", async () => {
    mockRedis.lRange.mockResolvedValue([])
    const result = await loadSession("sess_01")
    expect(result).toEqual([])
    expect(mockRedis.lRange).toHaveBeenCalledWith("session:sess_01", 0, -1)
  })

  it("returns empty array when lRange returns null", async () => {
    mockRedis.lRange.mockResolvedValue(null)
    const result = await loadSession("sess_02")
    expect(result).toEqual([])
  })

  it("parses stored JSON messages", async () => {
    const msgs = [
      JSON.stringify({ role: "user", content: "Oi" }),
      JSON.stringify({ role: "assistant", content: "Olá!" }),
    ]
    mockRedis.lRange.mockResolvedValue(msgs)

    const result = await loadSession("sess_03")
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: "user", content: "Oi" })
    expect(result[1]).toEqual({ role: "assistant", content: "Olá!" })
  })

  it("returns empty array on malformed JSON", async () => {
    mockRedis.lRange.mockResolvedValue(["not-json"])
    const result = await loadSession("sess_04")
    expect(result).toEqual([])
  })
})

// ── appendMessages ────────────────────────────────────────────────────────────

describe("appendMessages", () => {
  it("pushes messages to pipeline and trims", async () => {
    const messages = [
      { role: "user" as const, content: "Oi" },
      { role: "assistant" as const, content: "Olá!" },
    ]

    await appendMessages("sess_05", messages)

    expect(mockRedis.multi).toHaveBeenCalledTimes(1)
    expect(mockMulti.rPush).toHaveBeenCalledTimes(2)
    expect(mockMulti.rPush).toHaveBeenCalledWith(
      "session:sess_05",
      JSON.stringify(messages[0]),
    )
    expect(mockMulti.rPush).toHaveBeenCalledWith(
      "session:sess_05",
      JSON.stringify(messages[1]),
    )
    expect(mockMulti.lTrim).toHaveBeenCalledWith("session:sess_05", -50, -1)
    expect(mockMulti.expire).toHaveBeenCalledWith("session:sess_05", 48 * 60 * 60)
    expect(mockMulti.exec).toHaveBeenCalledTimes(1)
  })

  it("handles single message", async () => {
    await appendMessages("sess_06", [{ role: "user" as const, content: "Oi" }])
    expect(mockMulti.rPush).toHaveBeenCalledTimes(1)
  })

  it("handles empty array gracefully", async () => {
    await appendMessages("sess_07", [])
    expect(mockMulti.rPush).not.toHaveBeenCalled()
    // Pipeline still executes (LTRIM + EXPIRE)
    expect(mockMulti.exec).toHaveBeenCalledTimes(1)
  })
})
