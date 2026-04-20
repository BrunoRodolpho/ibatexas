// Integration tests for session store ↔ streaming emitter lifecycle
// Tests the flow: createStream → pushChunk → getStream → replay buffer → cleanupStream

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { StreamChunk } from "@ibatexas/types"
import {
  createStream,
  pushChunk,
  getStream,
  isStreamActive,
  cleanupStream,
} from "../streaming/emitter.js"

describe("Streaming emitter lifecycle integration", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const SESSION = "session-lifecycle-test"

  it("full lifecycle: create → push → replay → cleanup", () => {
    // 1. Stream does not exist initially
    expect(isStreamActive(SESSION)).toBe(false)
    expect(getStream(SESSION)).toBeUndefined()

    // 2. Create stream
    createStream(SESSION)
    expect(isStreamActive(SESSION)).toBe(true)
    expect(getStream(SESSION)).toBeDefined()

    // 3. Push chunks → buffer grows
    pushChunk(SESSION, { type: "text_delta", delta: "Olá" })
    pushChunk(SESSION, { type: "text_delta", delta: " mundo!" })
    pushChunk(SESSION, { type: "done" })

    const entry = getStream(SESSION)!
    expect(entry.buffer).toHaveLength(3)
    expect(entry.buffer[0]).toEqual({ type: "text_delta", delta: "Olá" })
    expect(entry.buffer[2]).toEqual({ type: "done" })

    // 4. Late subscriber replays buffer
    const replayed: StreamChunk[] = []
    for (const chunk of entry.buffer) {
      replayed.push(chunk)
    }
    expect(replayed).toHaveLength(3)

    // 5. Cleanup delays deletion by 30s
    cleanupStream(SESSION)
    expect(isStreamActive(SESSION)).toBe(true) // still alive

    vi.advanceTimersByTime(29_999)
    expect(isStreamActive(SESSION)).toBe(true) // still alive at 29.999s

    vi.advanceTimersByTime(1)
    expect(isStreamActive(SESSION)).toBe(false) // gone at 30s
  })

  it("subscribers receive live chunks via EventEmitter", () => {
    const SID = "session-subscriber"
    createStream(SID)

    const received: StreamChunk[] = []
    const entry = getStream(SID)!
    entry.emitter.on("chunk", (chunk: StreamChunk) => {
      received.push(chunk)
    })

    pushChunk(SID, { type: "tool_start", toolName: "search_products", toolUseId: "tu_1" })
    pushChunk(SID, { type: "tool_result", toolName: "search_products", toolUseId: "tu_1", success: true })
    pushChunk(SID, { type: "text_delta", delta: "Encontrei 3 produtos." })
    pushChunk(SID, { type: "done" })

    expect(received).toHaveLength(4)
    expect(received[0]).toEqual({ type: "tool_start", toolName: "search_products", toolUseId: "tu_1" })
    expect(received[3]).toEqual({ type: "done" })

    // Buffer and subscriber receive got the same chunks
    expect(entry.buffer).toEqual(received)

    cleanupStream(SID)
    vi.advanceTimersByTime(30_001)
  })

  it("pushChunk is a no-op for non-existent streams", () => {
    // Should not throw
    pushChunk("no-such-session", { type: "text_delta", delta: "ignored" })
    expect(getStream("no-such-session")).toBeUndefined()
  })
})
