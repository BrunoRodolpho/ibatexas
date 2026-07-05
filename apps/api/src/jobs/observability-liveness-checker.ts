// Observability-plane liveness watchdog — deterministic ops watchdog (BKL-109).
//
// Runs every 5 minutes via BullMQ repeatable job. Probes the observability
// services (VictoriaLogs + VictoriaMetrics) `/health` endpoints and RAISES a
// governed ops-alert (`ops.alert.open`, cause `ops_observability_down`) when a
// service is DOWN while the api itself is UP — surfacing "logs/metrics are being
// silently lost right now" to the admin ops inbox + the ops agent read plane.
//
// WHY this watchdog exists: on 2026-07-04 the victorialogs / victoriametrics /
// grafana containers sat Exited(0) for ~6h while the api kept serving turns.
// Every turn in that window is log-unrecoverable, and nothing surfaced the
// outage — the api can't log its own blindness to a log sink that is down. The
// ops-alert emission path is INDEPENDENT of VictoriaLogs (buildSystemEnvelope →
// OpsAlertService.openAlertFromEnvelope → synchronous kernel adjudication →
// Postgres OpsAlert row), so it still fires when the log plane is dead.
//
// DEBOUNCE (raise slow, resolve fast): a single sweep hiccup (a probe that
// times out during a container restart) must not page. A per-scope Redis counter
// (rk("ops_observability:down:<scope>")) INCRs on each consecutive DOWN sweep and
// only RAISES once it reaches `OPS_OBSERVABILITY_DOWN_SWEEPS` (default 2). The
// counter is DELeted on the first UP sweep, which AUTO-resolves the open alert —
// asymmetric on purpose. The counter carries a TTL (~3× the sweep interval) so a
// dead job self-heals the count rather than leaving a stale raise armed.
//
// GATE: unset VICTORIALOGS_URL ⇒ the obs stack is not configured (logs go
// stdout-only, see .env.example), so probing localhost would be pure noise. The
// watchdog disables itself entirely in that case (logs one INFO line, registers
// nothing). When VICTORIALOGS_URL is set, both VL and VM are probed — they ship
// together in docker-compose.observability.yml.
//
// Governance: every raise/resolve is a SYSTEM-actor `ops.alert.*` IntentEnvelope
// (buildSystemEnvelope) through `reconcileSweepOpsAlert`, adjudicated by the
// SYSTEM-only ops-alert policy bundle (CLAUDE.md rule #9). The LLM never raises
// ops alerts. There is NO WhatsApp broadcaster for ops alerts — the admin inbox
// + ops-agent read plane are the only consumers (owner decision 2026-07-04).

import { getRedisClient, rk } from "@ibatexas/tools";
import {
  createOpsAlertService,
  OPS_ALERT_CAUSE_LABELS_PT,
  type OpsAlertOpenPayload,
  type OpsAlertService,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import * as Sentry from "@sentry/node";
import type { Queue, Worker } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import { createQueue, createWorker, type Job } from "./queue.js";
import { reconcileSweepOpsAlert } from "./ops-alert-reconcile.js";

const REPEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Per-probe abort timeout. A health endpoint that has not answered in 3s is
 * treated as DOWN for this sweep (the debounce counter absorbs a single slow
 * response during a restart). An implementation const, like dlq's SCAN_COUNT.
 */
const PROBE_TIMEOUT_MS = 3000;

/**
 * TTL on the per-scope DOWN counter — ~3× the sweep interval. Refreshed on each
 * increment so a live outage keeps the count armed; if the job itself dies the
 * counter lapses and a recovered-then-relapsed service starts counting fresh
 * rather than firing on a stale count.
 */
const COUNTER_TTL_SECONDS = 3 * (REPEAT_INTERVAL_MS / 1000); // 900s

let queue: Queue | null = null;
let worker: Worker | null = null;
let logger: FastifyBaseLogger | null = null;

// ── Pure helpers (exported for exhaustive unit testing) ─────────────────────

export type ObservabilityScope = "victorialogs" | "victoriametrics";

/** A single probe target — the scope tag and its resolved `/health` URL. */
export interface ScopeProbe {
  readonly scope: ObservabilityScope;
  readonly url: string;
}

/**
 * Severity band per scope. VictoriaLogs DOWN is the INCIDENT class — every turn
 * in the window becomes log-unrecoverable (the 2026-07-04 incident), so `high`.
 * VictoriaMetrics DOWN loses dashboards/alerting-metrics but no turn history, so
 * `medium`.
 */
export function livenessSeverity(scope: ObservabilityScope): "high" | "medium" {
  return scope === "victorialogs" ? "high" : "medium";
}

/** The raise gate: N consecutive DOWN sweeps have accrued for this scope. */
export function shouldRaise(consecutiveDown: number, requiredSweeps: number): boolean {
  return consecutiveDown >= requiredSweeps;
}

/**
 * Debounce threshold from env (`OPS_OBSERVABILITY_DOWN_SWEEPS`, default 2). A
 * non-numeric / sub-1 value falls back to the default (never raise on the first
 * sweep by misconfiguration).
 */
export function requiredDownSweeps(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OPS_OBSERVABILITY_DOWN_SWEEPS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

/**
 * Resolve the probe targets from env. Returns `[]` (watchdog disabled) when
 * VICTORIALOGS_URL is unset — the obs stack is not configured, so there is
 * nothing to probe. When set, VL and VM are probed together (they ship in the
 * same docker-compose.observability.yml). VICTORIAMETRICS_URL defaults to the
 * conventional local port; note `packages/tools endpoints.observabilityEndpoints()`
 * deliberately hardcodes VM elsewhere and is intentionally left alone.
 */
export function resolveProbeTargets(env: NodeJS.ProcessEnv = process.env): ScopeProbe[] {
  const vlBase = env.VICTORIALOGS_URL;
  if (!vlBase) return [];
  const vmBase = env.VICTORIAMETRICS_URL ?? "http://localhost:8428";
  return [
    { scope: "victorialogs", url: `${vlBase}/health` },
    { scope: "victoriametrics", url: `${vmBase}/health` },
  ];
}

/** Redis debounce-counter key for a scope (rk() — Hard Rule #7). */
export function counterKey(scope: ObservabilityScope): string {
  return rk(`ops_observability:down:${scope}`);
}

/**
 * PURE builder for the `ops.alert.open` payload of a DOWN scope. pt-BR title/detail
 * from OPS_ALERT_CAUSE_LABELS_PT (Hard Rule #4). One OPEN alert per scope
 * (dedupeKey `ops_observability_down:<scope>`), so VL and VM raise/resolve
 * independently even though they share the cause. `context` is JSON-safe + PII-free.
 */
export function buildObservabilityOpenPayload(args: {
  readonly scope: ObservabilityScope;
  readonly url: string;
  readonly consecutiveDown: number;
  readonly requiredSweeps: number;
  readonly probeError?: string;
}): OpsAlertOpenPayload {
  const { scope, url, consecutiveDown, requiredSweeps, probeError } = args;
  return {
    cause: "ops_observability_down",
    severity: livenessSeverity(scope),
    source: "observability-liveness-checker",
    scope,
    title: `${OPS_ALERT_CAUSE_LABELS_PT.ops_observability_down}: ${scope} (${consecutiveDown} varreduras)`,
    detail: `O serviço de observabilidade "${scope}" não respondeu ao health check em ${consecutiveDown} varredura(s) consecutiva(s) (limite ${requiredSweeps}).`,
    context: {
      url,
      scope,
      consecutiveDown,
      requiredSweeps,
      ...(probeError ? { probeError } : {}),
    },
    dedupeKey: `ops_observability_down:${scope}`,
  };
}

// ── IO wiring ───────────────────────────────────────────────────────────────

export interface CheckObservabilityLivenessDeps {
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to the shared Redis client. */
  readonly redis?: {
    incr: (key: string) => Promise<number>;
    expire: (key: string, seconds: number) => Promise<unknown>;
    del: (key: string) => Promise<unknown>;
  };
  /** Injected for tests. Defaults to a fresh audited OpsAlertService. */
  readonly svc?: OpsAlertService;
  /** Injected for tests. Defaults to `resolveProbeTargets()` (env-driven gate). */
  readonly targets?: readonly ScopeProbe[];
  /** Injected for tests. Defaults to `requiredDownSweeps()`. */
  readonly requiredSweeps?: number;
}

/** Core job logic — exported for direct testing. */
export async function checkObservabilityLiveness(
  log?: FastifyBaseLogger | null,
  deps: CheckObservabilityLivenessDeps = {},
): Promise<void> {
  const effectiveLogger = log ?? logger;
  const targets = deps.targets ?? resolveProbeTargets();
  if (targets.length === 0) return; // gated off (VICTORIALOGS_URL unset)

  const fetchImpl = deps.fetchImpl ?? fetch;
  const requiredSweeps = deps.requiredSweeps ?? requiredDownSweeps();
  const svc =
    deps.svc ?? createOpsAlertService({ auditSink: getAuditSink(), log: effectiveLogger ?? undefined });
  const redis = deps.redis ?? (await getRedisClient());

  for (const target of targets) {
    try {
      // Inline probe (CLAUDE.md — config from env; no shared probe helper). A
      // non-ok status OR a throw (timeout / connection refused) both mean DOWN.
      let up = false;
      let probeError: string | undefined;
      try {
        const res = await fetchImpl(target.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        up = res.ok;
        if (!res.ok) probeError = `HTTP ${res.status}`;
      } catch (err) {
        up = false;
        probeError = String(err);
      }

      // Debounce counter: DEL on UP (resolve fast), INCR + refresh TTL on DOWN.
      const key = counterKey(target.scope);
      let consecutiveDown = 0;
      if (up) {
        await redis.del(key);
      } else {
        consecutiveDown = await redis.incr(key);
        await redis.expire(key, COUNTER_TTL_SECONDS);
      }

      const over = shouldRaise(consecutiveDown, requiredSweeps);

      // Wrapped per the reconcile contract: an ops-alert failure NEVER breaks the
      // sweep (the alert is observability; the probe already did its job).
      try {
        await reconcileSweepOpsAlert({
          svc,
          over,
          open: buildObservabilityOpenPayload({
            scope: target.scope,
            url: target.url,
            consecutiveDown,
            requiredSweeps,
            probeError,
          }),
          sourceSubject: "observability-liveness-checker",
          now: Date.now(),
          log: effectiveLogger ?? undefined,
        });
      } catch (err) {
        effectiveLogger?.warn(
          { scope: target.scope, error: String(err) },
          "[obs-liveness] ops-alert reconcile failed (non-fatal)",
        );
      }

      if (!up && over) {
        effectiveLogger?.warn(
          {
            component: "job.obs-liveness",
            event: "down",
            scope: target.scope,
            consecutiveDown,
            requiredSweeps,
          },
          "[obs-liveness] observability service DOWN — governed ops-alert raised",
        );
      }
    } catch (err) {
      // Per-scope isolation: one scope's IO error (Redis / service) must not skip
      // the other scope's probe. Sentry + continue.
      effectiveLogger?.error(
        { scope: target.scope, error: String(err) },
        "[obs-liveness] Error during observability liveness sweep",
      );
      Sentry.withScope((scope) => {
        scope.setTag("job", "observability-liveness-checker");
        scope.setTag("source", "background-job");
        Sentry.captureException(err);
      });
    }
  }
}

/** BullMQ processor — wraps the core logic. */
async function processor(_job: Job): Promise<void> {
  await checkObservabilityLiveness();
}

export function startObservabilityLivenessChecker(log?: FastifyBaseLogger): void {
  if (worker) return;
  logger = log ?? null;

  // GATE: unset VICTORIALOGS_URL ⇒ obs stack not configured (logs go stdout-only),
  // so probing localhost would be pure noise. Disable the watchdog entirely.
  if (!process.env.VICTORIALOGS_URL) {
    (log ?? undefined)?.info(
      { component: "job.obs-liveness", event: "disabled" },
      "observability watchdog disabled: VICTORIALOGS_URL unset — obs stack not configured",
    );
    return;
  }

  queue = createQueue("observability-liveness-checker");
  worker = createWorker("observability-liveness-checker", processor);

  worker.on("failed", (_job, err) => {
    logger?.error(err, "[observability-liveness-checker] Unexpected error");
    Sentry.withScope((scope) => {
      scope.setTag("job", "observability-liveness-checker");
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  void queue.upsertJobScheduler("observability-liveness-repeat", { every: REPEAT_INTERVAL_MS });
}

export async function stopObservabilityLivenessChecker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
