// SSE bridge between POST /api/chat/messages (producer) and
// GET /api/chat/stream/:sessionId (consumer).
//
// Phase 2: multi-instance via Redis Pub/Sub.
//   The POST and GET for one session may land on *different* API replicas
//   behind a load balancer (or across a rolling deploy). Correctness must NOT
//   depend on them hitting the same process, so chunk fan-out is backed by:
//     - Redis Pub/Sub channel  rk("chat:stream:<sessionId>")  for live chunks
//     - Redis list             rk("chat:stream:replay:<sessionId>")  for replay,
//       so a GET that connects slightly after the POST started still catches up.
//   Each published/stored chunk carries a monotonic `seq` so a consumer that
//   reads the replay list AND receives live messages can de-duplicate the
//   overlap deterministically (subscribe-before-replay + seq dedup).
//
// The in-process EventEmitter is kept ONLY as a same-replica fast path; the
// Redis path is always populated so any replica can serve any consumer.
//
// Race-condition mitigation (unchanged intent):
// - POST creates the entry before starting the agent.
// - GET polls briefly (in chat.ts) if neither the local entry nor any Redis
//   replay/live chunk is ready yet (producer hasn't published its first chunk).
// - Chunks are buffered/replayed so clients that connect after the first chunk
//   still get everything.
// - cleanupStream delays deletion by STREAM_GRACE_SECONDS to allow late SSE
//   connections, and sets the same TTL on the Redis replay list.

import { EventEmitter } from "node:events";
import type { StreamChunk } from "@ibatexas/types";
import { getRedisClient, rk } from "@ibatexas/tools";

/** A chunk as carried over Redis: the payload plus its monotonic sequence. */
interface SeqChunk {
  seq: number;
  chunk: StreamChunk;
}

interface StreamEntry {
  emitter: EventEmitter;
  buffer: StreamChunk[];
  /** Monotonic counter for chunks produced on THIS replica for this session. */
  seq: number;
}

const streams = new Map<string, StreamEntry>();

// Cap concurrent streams to prevent memory exhaustion
const MAX_STREAMS = 1_000;

// Grace window (seconds) for the in-memory entry deletion and the Redis replay
// list TTL — long enough for a late GET to attach after the agent finished.
// (Preserves the previous hardcoded 30s in-memory grace.)
const STREAM_GRACE_SECONDS = 30;

// Cap the Redis replay list so a stuck/very long stream cannot grow unbounded.
const REPLAY_MAX_CHUNKS = 1_000;

/** Pub/Sub channel for live chunks of a session. */
function streamChannel(sessionId: string): string {
  return rk(`chat:stream:${sessionId}`);
}

/** Redis list holding the replayable history for a session. */
function replayKey(sessionId: string): string {
  return rk(`chat:stream:replay:${sessionId}`);
}

/** True if an agent is currently running for this session ON THIS replica. */
export function isStreamActive(sessionId: string): boolean {
  return streams.has(sessionId);
}

/** Called by POST handler before starting the agent. */
export function createStream(sessionId: string): void {
  // Reject new streams when at capacity
  if (streams.size >= MAX_STREAMS) {
    throw new Error("Servidor sobrecarregado. Tente novamente em instantes.");
  }
  const emitter = new EventEmitter();
  emitter.setMaxListeners(5);
  streams.set(sessionId, { emitter, buffer: [], seq: 0 });
}

/**
 * Called for each chunk yielded by the agent loop.
 *
 * Fans the chunk out three ways so any replica's consumer can receive it:
 *   1. in-memory buffer + EventEmitter (same-replica fast path)
 *   2. Redis replay list (so a late GET on any replica can catch up)
 *   3. Redis Pub/Sub publish (so an already-connected GET on any replica gets it live)
 *
 * The Redis work is best-effort and fire-and-forget: a same-replica consumer is
 * already served by the EventEmitter, and the producer's agent loop must not
 * block on Redis. Sequence numbers let cross-replica consumers de-dup replay vs.
 * live delivery.
 */
export function pushChunk(sessionId: string, chunk: StreamChunk): void {
  const entry = streams.get(sessionId);
  if (!entry) return;

  const seq = entry.seq++;
  entry.buffer.push(chunk);
  // Same-replica fast path: deliver the raw chunk (no seq wrapper needed since
  // an in-memory consumer never also reads the Redis replay list).
  entry.emitter.emit("chunk", chunk);

  // Cross-replica path (best-effort).
  void publishChunk(sessionId, { seq, chunk });
}

/** Push one seq-tagged chunk to the Redis replay list + pub/sub channel. */
async function publishChunk(sessionId: string, payload: SeqChunk): Promise<void> {
  try {
    const redis = await getRedisClient();
    const message = JSON.stringify(payload);
    const key = replayKey(sessionId);
    // Append to replay history, cap its length, and refresh its TTL.
    await redis.rPush(key, message);
    await redis.lTrim(key, -REPLAY_MAX_CHUNKS, -1);
    await redis.expire(key, STREAM_GRACE_SECONDS);
    // Notify already-connected consumers on any replica.
    await redis.publish(streamChannel(sessionId), message);
  } catch (err) {
    // Non-fatal: a same-replica consumer still gets chunks via the EventEmitter,
    // and a cross-replica consumer will surface "Sessão não encontrada." rather
    // than a crash. Mirrors the existing best-effort Redis logging convention.
    console.error(
      "[stream] Redis fan-out failed:",
      (err as Error).message,
    );
  }
}

/** Returns the in-memory stream entry; undefined if not created on this replica. */
export function getStream(sessionId: string): StreamEntry | undefined {
  return streams.get(sessionId);
}

/** Handle returned by subscribeToStream; call close() to release the subscriber. */
export interface StreamSubscription {
  close: () => Promise<void>;
}

/**
 * Cross-replica consumer entrypoint. Streams every chunk for `sessionId` to
 * `onChunk`, regardless of which replica produced it, by:
 *   1. SUBSCRIBE first (on a dedicated duplicated connection — node-redis
 *      forbids regular commands on a subscriber), buffering live messages.
 *   2. LRANGE the replay list to catch up on anything produced before step 1.
 *   3. Drain buffered-then-future live messages, de-duplicating against replay
 *      by `seq` (subscribe-before-replay guarantees no live chunk is missed;
 *      seq dedup removes the replay/live overlap).
 *
 * Returns undefined if no replay history exists AND nothing is published while
 * we attach — i.e. the session is genuinely unknown to the cluster — so the
 * caller can emit the "not found" SSE error exactly as before.
 *
 * The returned subscription MUST be closed (on stream end or client
 * disconnect) to avoid leaking the duplicated Redis connection.
 */
export async function subscribeToStream(
  sessionId: string,
  onChunk: (chunk: StreamChunk) => void,
): Promise<StreamSubscription | undefined> {
  const base = await getRedisClient();
  // Dedicated connection: a subscriber cannot issue normal commands.
  const sub = base.duplicate();
  await sub.connect();

  // Highest seq already delivered (from replay or live), to drop duplicates.
  let lastSeq = -1;
  // Live messages that arrive before/while we read the replay list.
  const pending: SeqChunk[] = [];
  let replayed = false;

  const deliver = (payload: SeqChunk): void => {
    if (payload.seq <= lastSeq) return; // already delivered via replay/live
    lastSeq = payload.seq;
    onChunk(payload.chunk);
  };

  const listener = (raw: string): void => {
    let payload: SeqChunk;
    try {
      payload = JSON.parse(raw) as SeqChunk;
    } catch {
      return;
    }
    // Buffer until the replay catch-up has run, then deliver in order.
    if (!replayed) {
      pending.push(payload);
      return;
    }
    deliver(payload);
  };

  await sub.subscribe(streamChannel(sessionId), listener);

  // Catch up on history produced before we subscribed.
  let history: string[] = [];
  try {
    history = await base.lRange(replayKey(sessionId), 0, -1);
  } catch (err) {
    console.error("[stream] Redis replay read failed:", (err as Error).message);
  }

  // Nothing in history and nothing buffered live → session unknown to cluster.
  if (history.length === 0 && pending.length === 0) {
    await sub.unsubscribe(streamChannel(sessionId));
    await sub.quit();
    return undefined;
  }

  for (const raw of history) {
    let payload: SeqChunk;
    try {
      payload = JSON.parse(raw) as SeqChunk;
    } catch {
      continue;
    }
    deliver(payload);
  }

  // Flush anything that arrived live while we were reading history (seq dedup
  // handles the overlap with what we just replayed), then go fully live.
  replayed = true;
  for (const payload of pending) deliver(payload);
  pending.length = 0;

  const close = async (): Promise<void> => {
    try {
      await sub.unsubscribe(streamChannel(sessionId));
    } catch {
      // already torn down
    }
    try {
      await sub.quit();
    } catch {
      // connection may already be closed
    }
  };

  return { close };
}

/**
 * Called when the agent loop ends (done or error).
 * Delays in-memory deletion by STREAM_GRACE_SECONDS so late SSE clients on this
 * replica can still replay the buffer; the Redis replay list expires on its own
 * TTL (refreshed on every push), so no explicit Redis cleanup is needed here.
 */
export function cleanupStream(sessionId: string): void {
  setTimeout(() => {
    streams.delete(sessionId);
  }, STREAM_GRACE_SECONDS * 1000);
}
