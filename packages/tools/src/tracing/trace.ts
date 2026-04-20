// Distributed tracing for the 4-phase pipeline.
//
// Lightweight: creates trace/span IDs, measures durations, persists summary to Redis.
// No external dependencies — pure Node.js crypto + Redis.

import { randomUUID } from "node:crypto"
import { getRedisClient } from "../redis/client.js"
import { rk } from "../redis/key.js"

const TRACE_TTL = Number.parseInt(process.env.TRACE_TTL_SECONDS || "3600", 10) // 1h

export interface Span {
  name: string
  startMs: number
  endMs?: number
  durationMs?: number
  metadata?: Record<string, unknown>
}

export interface TraceContext {
  traceId: string
  sessionId: string
  spans: Span[]
  startMs: number
}

/**
 * Create a new trace context for a pipeline execution.
 */
export function createTrace(sessionId: string): TraceContext {
  return {
    traceId: randomUUID().slice(0, 12),
    sessionId,
    spans: [],
    startMs: Date.now(),
  }
}

/**
 * Start a named span within a trace. Returns the span for later completion.
 */
export function startSpan(trace: TraceContext, name: string, metadata?: Record<string, unknown>): Span {
  const span: Span = { name, startMs: Date.now(), metadata }
  trace.spans.push(span)
  return span
}

/**
 * End a span and compute its duration.
 */
export function endSpan(span: Span): void {
  span.endMs = Date.now()
  span.durationMs = span.endMs - span.startMs
}

/**
 * Get total trace duration so far.
 */
export function getTraceDuration(trace: TraceContext): number {
  return Date.now() - trace.startMs
}

/**
 * Persist trace summary to Redis for debugging.
 * Non-blocking, fire-and-forget.
 */
export async function persistTrace(trace: TraceContext): Promise<void> {
  try {
    const redis = await getRedisClient()
    const summary = {
      traceId: trace.traceId,
      sessionId: trace.sessionId,
      totalMs: Date.now() - trace.startMs,
      spans: trace.spans.map((s) => ({
        name: s.name,
        durationMs: s.durationMs ?? (Date.now() - s.startMs),
        ...(s.metadata && { metadata: s.metadata }),
      })),
    }
    await redis.set(
      rk(`trace:${trace.traceId}`),
      JSON.stringify(summary),
      { EX: TRACE_TTL },
    )
  } catch {
    // Tracing is non-critical
  }
}

/**
 * Load a trace from Redis by ID (for replay/debugging).
 */
export async function loadTrace(traceId: string): Promise<unknown | null> {
  try {
    const redis = await getRedisClient()
    const data = await redis.get(rk(`trace:${traceId}`))
    return data ? JSON.parse(data) : null
  } catch {
    return null
  }
}

/**
 * Log a span completion at debug level.
 */
export function logSpan(trace: TraceContext, span: Span): void {
  console.warn(
    "[trace:%s] [span:%s] %dms",
    trace.traceId,
    span.name,
    span.durationMs ?? (Date.now() - span.startMs),
  )
}
