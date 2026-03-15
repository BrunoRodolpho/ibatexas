// Unit tests for streaming/emitter.ts — pure in-memory SSE bridge

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  createStream,
  pushChunk,
  getStream,
  isStreamActive,
  cleanupStream,
} from "../streaming/emitter.js"
import type { StreamChunk } from "@ibatexas/types"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("createStream", () => {
  it("registers a new stream", () => {
    createStream("test_01")
    expect(isStreamActive("test_01")).toBe(true)
  })
})

describe("isStreamActive", () => {
  it("returns false for unknown session", () => {
    expect(isStreamActive("nonexistent")).toBe(false)
  })
})

describe("pushChunk", () => {
  it("buffers chunks and emits events", () => {
    createStream("test_02")
    const chunks: StreamChunk[] = []
    const entry = getStream("test_02")!
    entry.emitter.on("chunk", (c: StreamChunk) => chunks.push(c))

    const chunk: StreamChunk = { type: "text_delta", delta: "Olá" }
    pushChunk("test_02", chunk)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual(chunk)
    expect(entry.buffer).toHaveLength(1)
  })

  it("silently ignores pushes to nonexistent sessions", () => {
    expect(() => pushChunk("ghost", { type: "text_delta", delta: "x" })).not.toThrow()
  })
})

describe("getStream", () => {
  it("returns the entry with emitter and buffer", () => {
    createStream("test_03")
    const entry = getStream("test_03")
    expect(entry).toBeDefined()
    expect(entry!.buffer).toEqual([])
    expect(entry!.emitter).toBeDefined()
  })

  it("returns undefined for unknown session", () => {
    expect(getStream("unknown")).toBeUndefined()
  })
})

describe("cleanupStream", () => {
  it("deletes stream after 30s delay", () => {
    createStream("test_04")
    cleanupStream("test_04")

    // Still active immediately
    expect(isStreamActive("test_04")).toBe(true)

    // After 30s, removed
    vi.advanceTimersByTime(30_000)
    expect(isStreamActive("test_04")).toBe(false)
  })
})
