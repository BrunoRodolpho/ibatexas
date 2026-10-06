// Shared pino multistream wiring for the api log path (observability Layer 3).
//
// When VICTORIALOGS_URL is set (the obs stack is up — see
// docker-compose.observability.yml), every api log line is fanned out to TWO
// sinks via pino.multistream:
//   1. raw pino JSON  → VictoriaLogs (failure-isolated; never blocks a turn —
//      see victorialogs-stream.ts)
//   2. human-readable → stdout (pino-pretty in dev, raw JSON in prod)
//
// When VICTORIALOGS_URL is unset the helpers return null and callers keep their
// existing single-stream (transport) config — so a dev without the obs stack is
// unaffected. This is the single place that decides "ship logs or not"; both the
// standalone logger (lib/logger.ts) and the Fastify server logger (server.ts)
// build on it so their behaviour stays in lockstep.

import pino from "pino";
import pretty from "pino-pretty";
import { createVictoriaLogsStream } from "./victorialogs-stream.js";

/** The configured VictoriaLogs base URL, or undefined when the obs stack is off. */
export function victoriaLogsUrl(): string | undefined {
  const u = process.env.VICTORIALOGS_URL?.trim();
  return u || undefined;
}

// ── BKL-266: boot-time funnel-sink warning ──────────────────────────────────
//
// The log shipper above is deliberately failure-isolated: a VictoriaLogs outage
// degrades to "stdout only" in total silence. For most log lines that is right —
// they are also on stdout. For ZERO-CALL FUNNEL TURNS it is not: L0 / L1 /
// L2-fallback / ALIAS turns make no model call, so they write NO turn_trace row
// by design and the pino line IS the record. Losing the sink loses them
// permanently — never-written, not late — which is exactly how ~15h of funnel
// evidence disappeared on 2026-07-26 (and ~6h on 2026-07-04) with nothing said.
//
// So: ONE warn line at boot, then never again. Deliberately NOT a boot refusal
// (making the evidence channel REQUIRED is an owner-level governance-posture
// change) and NOT a retry loop — the 5-minute watchdog in
// jobs/observability-liveness-checker.ts owns steady-state detection, but it
// gates ITSELF OFF when VICTORIALOGS_URL is unset, which is precisely the case
// this warning covers.

/** Boot probe budget. Short on purpose: the call site is fire-and-forget, so
 *  this bounds the background work, never the boot path. */
const BOOT_PROBE_TIMEOUT_MS = 2000;

/** Latch — the warning is emitted at most once per process, so a repeated
 *  `buildServer()` (tests, or a re-listen) can never turn it into noise. */
let funnelSinkWarned = false;

/** Test-only: clear the once-per-process latch. */
export function resetFunnelSinkWarningForTests(): void {
  funnelSinkWarned = false;
}

export interface FunnelSinkWarningDeps {
  /** Where the warning goes. Any pino/Fastify logger. */
  readonly log: { warn: (obj: object, msg: string) => void };
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to `victoriaLogsUrl()`. */
  readonly url?: string | undefined;
}

/**
 * Emit ONE loud warn line when the funnel telemetry sink is absent — either
 * VICTORIALOGS_URL is unset, or it is set but the endpoint does not answer a
 * bounded `/health` probe at boot.
 *
 * Never throws, never refuses boot, never retries. Resolves after at most one
 * probe of BOOT_PROBE_TIMEOUT_MS; call it fire-and-forget so it adds no boot
 * latency at all. A healthy sink emits nothing.
 */
export async function warnIfFunnelSinkAbsent(deps: FunnelSinkWarningDeps): Promise<void> {
  const CONSEQUENCE =
    "zero-call funnel records will not be written anywhere " +
    "(L0/L1/L2-fallback/ALIAS turns write no turn_trace row — this log line is their only record)";

  try {
    if (funnelSinkWarned) return;
    const url = (deps.url !== undefined ? deps.url : victoriaLogsUrl())?.trim();

    if (!url) {
      funnelSinkWarned = true;
      deps.log.warn(
        { component: "observability.funnel-sink", event: "absent", reason: "unset" },
        `[funnel-sink] VICTORIALOGS_URL is UNSET — ${CONSEQUENCE}. ` +
          "Start the obs stack with `ibx dev` (it is a default service) or set VICTORIALOGS_URL.",
      );
      return;
    }

    // Single bounded probe. Any non-ok status or throw = absent for this boot.
    const fetchImpl = deps.fetchImpl ?? fetch;
    let reason: string | undefined;
    try {
      const res = await fetchImpl(`${stripTrailingSlashes(url)}/health`, {
        signal: AbortSignal.timeout(BOOT_PROBE_TIMEOUT_MS),
      });
      if (!res.ok) reason = `HTTP ${res.status}`;
    } catch (err) {
      reason = String(err);
    }
    if (reason === undefined) return; // sink is up — say nothing

    funnelSinkWarned = true;
    deps.log.warn(
      { component: "observability.funnel-sink", event: "absent", reason: "unreachable", url, probeError: reason },
      `[funnel-sink] VictoriaLogs at ${url} did NOT answer /health at boot — ${CONSEQUENCE}. ` +
        "Bring the obs stack up: `docker compose -f docker-compose.observability.yml up -d`.",
    );
  } catch {
    // This is a warning about lost observability; it must never become the
    // reason a boot fails. Swallow everything.
  }
}

/** Strip trailing "/" in linear time — mirrors victorialogs-stream.ts, so a
 *  configured `http://host:9428/` cannot probe `//health` (which both VL and VM
 *  answer 400, i.e. a false "absent" on a healthy stack — the BKL-109 trap). */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

/**
 * Shared root pino options for the multistream (→ VictoriaLogs) path. The single
 * place both the standalone logger (lib/logger.ts) and the Fastify server logger
 * configure signal quality, so they stay in lockstep:
 *  - `base: { component: "api" }` — the VL insert pins `_stream_fields=component,event`,
 *    so a line with no `component` lands in the shared empty `{}` stream and VMUI
 *    can't slice it. A base binding gives EVERY line a default stream; per-log
 *    `{ component: "..." }` objects (conductor/kernel/whatsapp/job.*) still override
 *    it via pino's last-key-wins. This also drops pino's default `{pid,hostname}`.
 *  - `formatters.level` — ship the level NAME ("info"/"warn"/"error") not the raw
 *    number, so `level:error` LogsQL filters work. Safe here because these are
 *    main-thread streams, NOT a worker `transport` (pino forbids `formatters`
 *    alongside `transport` — never add this to the transport-fallback branch).
 *  - `redact` — defense-in-depth for secret-named fields. Free-text PII (message
 *    bodies, completions) is scrubbed at the call site via the turn_trace redactor,
 *    NOT here (path-based redact can't reach free prose). `token` is deliberately
 *    NOT redacted — it is a non-secret approval idempotency handle in this codebase.
 */
export const MULTISTREAM_PINO_OPTIONS = {
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { component: "api" },
  formatters: { level: (label: string) => ({ level: label }) },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
      "headers.cookie",
      "password",
      "*.password",
      "otp",
      "*.otp",
      "secret",
      "*.secret",
      "phone",
      "*.phone",
    ],
    censor: "[REDACTED]",
  },
} satisfies pino.LoggerOptions;

/** Build a pino multistream fanning raw JSON → VictoriaLogs and human-readable
 *  → stdout. Returns null when VICTORIALOGS_URL is unset (callers fall back to
 *  their existing single-stream config). The VictoriaLogs stream is
 *  failure-isolated, so a logs outage degrades to "stdout only", never a stall. */
export function buildLogStreams(): pino.MultiStreamRes | null {
  const url = victoriaLogsUrl();
  if (!url) return null;
  const isProd = process.env.NODE_ENV === "production";
  // pino-pretty's factory defaults its destination to stdout (fd 1).
  const human = isProd ? process.stdout : pretty({ colorize: true });
  return pino.multistream([
    { stream: createVictoriaLogsStream(url) }, // raw pino JSON → VictoriaLogs
    { stream: human }, // human-readable → stdout
  ]);
}

/** A fully-built pino instance over the multistream (ISO timestamps so the
 *  VictoriaLogs `_time_field=time` stream parses correctly), or null when the
 *  obs stack is off. Used as Fastify's `loggerInstance`. */
export function buildMultistreamLogger(): pino.Logger | null {
  const streams = buildLogStreams();
  if (!streams) return null;
  return pino(MULTISTREAM_PINO_OPTIONS, streams);
}
