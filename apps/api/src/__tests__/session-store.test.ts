// Unit tests for session/store.ts
//
// ── R5 rollout — the module interception is GONE ──────────────────────────
//
// This file used to `vi.mock("@ibatexas/tools")` wholesale to reach the Redis
// client: `getRedisClient` answered a hand double and `rk` was replaced with
// `(key) => "ibatexas:" + key`. `session/store.ts` now takes its client through
// an options bag (`SessionStoreOptions`), so the double is handed in as an
// ARGUMENT and the module is imported for real.
//
// Two things that were fiction are now facts:
//
//   • `rk`. The fake answered `ibatexas:session:<id>`. The REAL `rk` under
//     apps/api's vitest answers `development:session:<id>` (no `APP_ENV` is
//     pinned in `apps/api/vitest.config.ts` or `src/__tests__/setup.ts`), so
//     every key assertion below was asserting a prefix production never writes.
//     The constant is now derived by CALLING the real `rk`, so it cannot drift
//     from what the SUT computes and cannot be a hand-copied guess either.
//   • The client. It arrives through the production seam, so "the store used
//     our client" is observable — see the two `[seam]` cases at the bottom.
//
// ── Why the double is still hand-rolled and not `createInMemoryRedis` ──────
//
// `appendMessages`'s only Redis touch is a MULTI pipeline. The canonical
// adapter REFUSES `multi` (W4 — pipeline/atomicity emulation is the owner-gated
// class), so a migration onto it is not available to this file. `loadSession`
// alone could not migrate either: the adapter implements no `lRange`.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { rk } from "@ibatexas/tools"
import {
  loadSession,
  appendMessages,
  type SessionHistoryReadClient,
  type SessionHistoryAppendClient,
} from "../session/store.js"

// ── The injected doubles ─────────────────────────────────────────────────────

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

/** The read client, at the exact type `loadSession` declares. */
const readClient = mockRedis as unknown as SessionHistoryReadClient
/** The append client, at the exact type `appendMessages` declares. */
const appendClient = mockRedis as unknown as SessionHistoryAppendClient

/** The key the SUT computes — through the REAL `rk`, not a hand-written guess. */
const key = (sessionId: string) => rk(`session:${sessionId}`)

beforeEach(() => {
  vi.clearAllMocks()
})

// ── loadSession ───────────────────────────────────────────────────────────────

describe("loadSession", () => {
  it("returns empty array when no history exists", async () => {
    mockRedis.lRange.mockResolvedValue([])
    const result = await loadSession("sess_01", { client: readClient })
    expect(result).toEqual([])
    expect(mockRedis.lRange).toHaveBeenCalledWith(key("sess_01"), 0, -1)
  })

  it("returns empty array when lRange returns null", async () => {
    mockRedis.lRange.mockResolvedValue(null)
    const result = await loadSession("sess_02", { client: readClient })
    expect(result).toEqual([])
  })

  it("parses stored JSON messages", async () => {
    const msgs = [
      JSON.stringify({ role: "user", content: "Oi" }),
      JSON.stringify({ role: "assistant", content: "Olá!" }),
    ]
    mockRedis.lRange.mockResolvedValue(msgs)

    const result = await loadSession("sess_03", { client: readClient })
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: "user", content: "Oi" })
    expect(result[1]).toEqual({ role: "assistant", content: "Olá!" })
  })

  it("returns empty array on malformed JSON", async () => {
    mockRedis.lRange.mockResolvedValue(["not-json"])
    const result = await loadSession("sess_04", { client: readClient })
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

    await appendMessages("sess_05", messages, false, undefined, { client: appendClient })

    expect(mockRedis.multi).toHaveBeenCalledTimes(1)
    expect(mockMulti.rPush).toHaveBeenCalledTimes(2)
    expect(mockMulti.rPush).toHaveBeenCalledWith(
      key("sess_05"),
      JSON.stringify(messages[0]),
    )
    expect(mockMulti.rPush).toHaveBeenCalledWith(
      key("sess_05"),
      JSON.stringify(messages[1]),
    )
    expect(mockMulti.lTrim).toHaveBeenCalledWith(key("sess_05"), -50, -1)
    expect(mockMulti.expire).toHaveBeenCalledWith(key("sess_05"), 48 * 60 * 60)
    expect(mockMulti.exec).toHaveBeenCalledTimes(1)
  })

  it("handles single message", async () => {
    await appendMessages("sess_06", [{ role: "user" as const, content: "Oi" }], false, undefined, {
      client: appendClient,
    })
    expect(mockMulti.rPush).toHaveBeenCalledTimes(1)
  })

  it("handles empty array gracefully", async () => {
    await appendMessages("sess_07", [], false, undefined, { client: appendClient })
    expect(mockMulti.rPush).not.toHaveBeenCalled()
    // Pipeline still executes (LTRIM + EXPIRE)
    expect(mockMulti.exec).toHaveBeenCalledTimes(1)
  })

  it("upgrades the TTL to the customer window when authenticated", async () => {
    await appendMessages(
      "sess_08",
      [{ role: "user" as const, content: "Oi" }],
      true,
      undefined,
      { client: appendClient },
    )
    expect(mockMulti.expire).toHaveBeenCalledWith(key("sess_08"), 24 * 60 * 60)
  })
})

// ── The client seam, born guarded (F-5) ──────────────────────────────────────
//
// Injecting a client and asserting on it does NOT prove the module used it: if
// the `options?.client ??` threading were deleted, `getRedisClient()` would run
// instead and these tests' own double would go untouched. Both cases below
// assert exactly that untouchedness is impossible — the work landed on OUR
// object, and the singleton (unreachable in this sandbox: no Redis is running,
// and `getRedisClient` is no longer mocked) was never needed. Remove the `??`
// from either entry point and the case for that entry point reds, because the
// module then awaits a connection that never opens.

describe("[seam] session/store.ts drives the INJECTED client", () => {
  it("loadSession reads through the injected client, at the REAL rk key", async () => {
    mockRedis.lRange.mockResolvedValue([])
    await loadSession("sess_seam_r", { client: readClient })

    expect(mockRedis.lRange).toHaveBeenCalledTimes(1)
    // The prefix is production's, not a fake's — the old `ibatexas:` was fiction.
    expect(mockRedis.lRange.mock.calls[0]![0]).toBe("development:session:sess_seam_r")
    // `loadSession` reaches lRange and nothing else.
    expect(mockRedis.multi).not.toHaveBeenCalled()
  })

  it("appendMessages pipelines through the injected client, at the REAL rk key", async () => {
    await appendMessages(
      "sess_seam_a",
      [{ role: "user" as const, content: "Oi" }],
      false,
      undefined,
      { client: appendClient },
    )

    expect(mockRedis.multi).toHaveBeenCalledTimes(1)
    expect(mockMulti.exec).toHaveBeenCalledTimes(1)
    expect(mockMulti.rPush.mock.calls[0]![0]).toBe("development:session:sess_seam_a")
    // `appendMessages` reaches multi and nothing else on the client.
    expect(mockRedis.lRange).not.toHaveBeenCalled()
  })
})
