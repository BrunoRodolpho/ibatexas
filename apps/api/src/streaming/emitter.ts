// In-process SSE bridge between POST /api/chat/messages and GET /api/chat/stream/:sessionId.
//
// Phase 1: single-process — EventEmitter per sessionId is sufficient.
// Phase 2+: replace pushChunk/subscribe with Redis Pub/Sub for multi-instance support.
// See docs/audit/08-deferred-items-plan.md (Item 11) for the full migration plan.
//
// Race condition mitigation:
// - POST creates the entry before starting the agent.
// - GET polls briefly if the entry isn't ready yet (agent hasn't started).
// - Chunks are buffered so clients that connect after the first chunk still get everything.
// - cleanupStream delays deletion by 30s to allow late SSE connections.

import { EventEmitter } from "node:events";
import type { StreamChunk } from "@ibatexas/types";

interface StreamEntry {
  emitter: EventEmitter;
  buffer: StreamChunk[];
}

const streams = new Map<string, StreamEntry>();

// AUDIT-FIX: AI-F04 — Cap concurrent streams to prevent memory exhaustion
const MAX_STREAMS = 1_000;

/** True if an agent is currently running for this session. */
export function isStreamActive(sessionId: string): boolean {
  return streams.has(sessionId);
}

/** Called by POST handler before starting the agent. */
export function createStream(sessionId: string): void {
  // AUDIT-FIX: AI-F04 — Reject new streams when at capacity to prevent memory exhaustion
  if (streams.size >= MAX_STREAMS) {
    throw new Error("Servidor sobrecarregado. Tente novamente em instantes.");
  }
  const emitter = new EventEmitter();
  emitter.setMaxListeners(5);
  streams.set(sessionId, { emitter, buffer: [] });
}

/** Called for each chunk yielded by runAgent. */
export function pushChunk(sessionId: string, chunk: StreamChunk): void {
  const entry = streams.get(sessionId);
  if (!entry) return;
  entry.buffer.push(chunk);
  entry.emitter.emit("chunk", chunk);
}

/** Returns the stream entry; undefined if not yet created. */
export function getStream(sessionId: string): StreamEntry | undefined {
  return streams.get(sessionId);
}

/**
 * Called when the agent loop ends (done or error).
 * Delays deletion by 30s so late SSE clients can still replay the buffer.
 */
export function cleanupStream(sessionId: string): void {
  setTimeout(() => {
    streams.delete(sessionId);
  }, 30_000);
}
