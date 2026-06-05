// Failure-isolated log shipper to VictoriaLogs (observability Layer 3).
//
// A main-thread Writable that pino's multistream feeds. FENCE: this sits in the
// api log path, so it MUST NOT block or crash the app or a turn. Design:
//   - write() only appends the line to a bounded in-memory buffer and returns
//     immediately (O(1) — it NEVER awaits the network).
//   - a background interval batches the buffer and POSTs it to VictoriaLogs'
//     /insert/jsonline. ALL errors are swallowed and the batch dropped (the same
//     lines are already on stdout, so nothing is truly lost). The interval is
//     unref'd so it can never keep the process alive.
//   - the buffer is bounded (MAX_BUFFERED lines); on overflow the OLDEST lines
//     are dropped — a prolonged VictoriaLogs outage can never OOM the api.
//
// So a VictoriaLogs outage degrades to "no shipping", never to a stalled or
// crashed turn. This is a plain main-thread stream (not a pino worker transport)
// on purpose: dev runs under tsx, and a worker transport pointing at a .ts module
// would fail to load there.

import { Writable } from "node:stream";

const FLUSH_INTERVAL_MS = Number(process.env.VICTORIALOGS_FLUSH_MS ?? 1000);
const MAX_BUFFERED = Number(process.env.VICTORIALOGS_MAX_BUFFER ?? 10_000);
const MAX_BATCH = 1_000;
const POST_TIMEOUT_MS = Number(process.env.VICTORIALOGS_POST_TIMEOUT_MS ?? 5_000);

/**
 * Build a Writable that ships pino JSON lines to VictoriaLogs. pino lines already
 * carry `msg` + ISO `time`; we tag the log stream by `component`+`event` so
 * LogsQL `component:kernel event:decision` filters work out of the box.
 */
export function createVictoriaLogsStream(baseUrl: string): Writable {
  const url =
    baseUrl.replace(/\/+$/, "") +
    "/insert/jsonline?_msg_field=msg&_time_field=time&_stream_fields=component,event";

  let buffer: string[] = [];
  let flushing = false;

  async function flush(): Promise<void> {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer.slice(0, MAX_BATCH);
    buffer = buffer.slice(batch.length);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/stream+json" },
        body: batch.join(""), // each pino line already ends with "\n" → valid ndjson
        signal: controller.signal,
      });
    } catch {
      // Best-effort: VictoriaLogs is an observability sidecar, never a hard dep.
      // Drop the batch (it is also on stdout) rather than re-buffer unbounded.
    } finally {
      clearTimeout(timeout);
      flushing = false;
    }
  }

  const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  timer.unref();

  return new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      buffer.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      if (buffer.length > MAX_BUFFERED) buffer.splice(0, buffer.length - MAX_BUFFERED);
      cb(); // O(1) — never block the logger
    },
    final(cb): void {
      clearInterval(timer);
      void flush().finally(() => cb());
    },
    destroy(err, cb): void {
      clearInterval(timer);
      cb(err);
    },
  });
}
