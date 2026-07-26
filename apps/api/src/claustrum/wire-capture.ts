/**
 * Wire Truth — capture core (spec: ~/projects/IBX_WIRE_TRUTH_SPEC.md).
 *
 * The frozen `@claustrum/openai` provider sits between the planner/responder
 * call sites (which know the turn) and the Ollama relay (which knows the exact
 * wire bytes), and nothing can be passed through it. Correlation therefore
 * travels OUT OF BAND, in two hops:
 *
 *   1. A turn entry point wraps `handleTurn` in `beginWireTurn` — an
 *      AsyncLocalStorage context holding a PENDING bucket (no turnId needed;
 *      the frozen loop mints it internally). The relay pushes every wire
 *      exchange it makes into whatever context it finds.
 *   2. `emitModelCallTrace` — which DOES know the turnId and runs right after
 *      each model call in the same async chain — calls `sealWireCall(turnId)`,
 *      draining the pending bucket into the module buffer under that turnId
 *      with a per-turn call counter. Seals happen in the same order the flush
 *      assigns `turn_trace.call_index` (emit order), so the stamped callIndex
 *      aligns with the trace row exactly. A regenerate-on-empty retry loop
 *      leaves several exchanges in the bucket before its single trace emit —
 *      they all seal under one callIndex, each keeping its own `seq`. That
 *      per-attempt truth is the point.
 *   3. The turn-trace flush claims the turn's sealed exchanges into the
 *      durable `llm_wire` store (llm-wire-writer.ts).
 *
 * Exchanges captured outside any context (live-check harness, diagnostics) and
 * pending exchanges never sealed (an emit guard was off) are dropped by design.
 * The module buffer is process-local, bounded, and self-pruning: a turn whose
 * flush never claims it expires after WIRE_TURN_TTL_MS. Capture is best-effort
 * by contract — no function in this module throws into a turn.
 */

import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/** Per-body cap. Oversized bodies are replaced by an honest truncation
 *  marker; the flag column is set so the UI can say so. */
export const WIRE_BODY_MAX_BYTES = 65_536;

/** A turn that never flushes is abandoned after this long. */
const WIRE_TURN_TTL_MS = 15 * 60_000;

/** Hard bound on concurrently-buffered turns. */
const MAX_BUFFERED_TURNS = 256;

interface PendingExchange {
  readonly model: string;
  readonly request: unknown;
  readonly response: unknown;
  readonly requestHash: string;
  readonly at: string;
}

interface WireTurnStore {
  pending: PendingExchange[];
}

const wireTurnContext = new AsyncLocalStorage<WireTurnStore>();

export interface WireExchange extends PendingExchange {
  readonly seq: number;
  readonly callIndex: number;
}

interface TurnBuffer {
  lastTouchedMs: number;
  nextCallIndex: number;
  exchanges: WireExchange[];
}

const buffers = new Map<string, TurnBuffer>();

/** Run a conversational turn inside a fresh wire-capture context. Wrap the
 *  `handleTurn` invocation at every ingress. */
export function beginWireTurn<T>(fn: () => Promise<T>): Promise<T> {
  return wireTurnContext.run({ pending: [] }, fn);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      return Object.keys(rec)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = rec[k];
          return acc;
        }, {});
    }
    return v;
  });
}

/** sha256 over canonical (key-sorted) JSON — the replay/join key stored per row. */
export function canonicalWireHash(body: unknown): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

export interface CappedBody {
  readonly value: unknown;
  readonly truncated: boolean;
}

/** Enforce WIRE_BODY_MAX_BYTES on a JSON body. Oversized values are replaced
 *  by `{__truncated, originalBytes, head}` so the row stays valid JSONB and
 *  the loss is self-describing. The head is measured in BYTES and never ends
 *  in a lone surrogate — a code-unit slice through an astral character (an
 *  emoji astride the boundary) produces JSON that PostgreSQL's ::jsonb cast
 *  REJECTS ("low surrogate must follow high surrogate"), which would silently
 *  drop the whole row for exactly the pathological bodies the marker exists
 *  to preserve (review-confirmed against a live pg17). */
export function capJsonBody(body: unknown): CappedBody {
  const text = JSON.stringify(body) ?? "null";
  if (Buffer.byteLength(text, "utf8") <= WIRE_BODY_MAX_BYTES) {
    return { value: body, truncated: false };
  }
  const budget = Math.floor(WIRE_BODY_MAX_BYTES / 2);
  let head = text.slice(0, budget); // ≤ budget bytes only if all-ASCII…
  while (Buffer.byteLength(head, "utf8") > budget) {
    // …so shrink by code units until the BYTE budget holds (coarse then fine).
    head = head.slice(0, -Math.max(1, Math.ceil((Buffer.byteLength(head, "utf8") - budget) / 4)));
  }
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1); // lone high surrogate
  return {
    value: {
      __truncated: true,
      originalBytes: Buffer.byteLength(text, "utf8"),
      head,
    },
    truncated: true,
  };
}

export interface CaptureArgs {
  readonly model: string;
  readonly request: unknown;
  readonly response: unknown;
  readonly at: string;
  /** Test seam only — capture time for TTL bookkeeping. */
  readonly nowMs?: number;
}

/** Relay-side: record one wire exchange into the ambient turn context.
 *  No context → designed no-op. Never throws. */
export function captureWireExchange(args: CaptureArgs): void {
  try {
    const store = wireTurnContext.getStore();
    if (store === undefined) return;
    store.pending.push({
      model: args.model,
      request: args.request,
      response: args.response,
      requestHash: canonicalWireHash(args.request),
      at: args.at,
    });
  } catch {
    // Capture must never break a turn.
  }
}

function prune(nowMs: number): void {
  for (const [turnId, buf] of buffers) {
    if (nowMs - buf.lastTouchedMs > WIRE_TURN_TTL_MS) buffers.delete(turnId);
  }
  if (buffers.size > MAX_BUFFERED_TURNS) {
    const oldestFirst = [...buffers.entries()].sort(
      (a, b) => a[1].lastTouchedMs - b[1].lastTouchedMs,
    );
    for (const [turnId] of oldestFirst.slice(0, buffers.size - MAX_BUFFERED_TURNS)) {
      buffers.delete(turnId);
    }
  }
}

/** Trace-emit-side: drain the ambient pending bucket into the turn's buffer,
 *  stamping the next call index. Call ONCE per emitted trace, right where the
 *  trace is emitted — seal order must equal emit order. Never throws. */
export function sealWireCall(turnId: string, nowMs?: number): void {
  try {
    const store = wireTurnContext.getStore();
    if (store === undefined || store.pending.length === 0) return;
    const now = nowMs ?? Date.now();
    prune(now);
    const buf = buffers.get(turnId) ?? { lastTouchedMs: now, nextCallIndex: 0, exchanges: [] };
    buf.lastTouchedMs = now;
    const callIndex = buf.nextCallIndex;
    buf.nextCallIndex += 1;
    for (const p of store.pending) {
      buf.exchanges.push({ ...p, seq: buf.exchanges.length, callIndex });
    }
    store.pending = [];
    buffers.set(turnId, buf);
  } catch {
    // Capture must never break a turn.
  }
}

/** Flush-side: remove and return a turn's sealed exchanges. Never throws. */
export function claimWireExchanges(turnId: string): WireExchange[] {
  try {
    const buf = buffers.get(turnId);
    buffers.delete(turnId);
    return buf?.exchanges ?? [];
  } catch {
    return [];
  }
}
