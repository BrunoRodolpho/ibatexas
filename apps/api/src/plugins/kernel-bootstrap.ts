// Kernel bootstrap — installs the real MetricsSink + the shared prom-client
// Registry used by the `/metrics` route.
//
// SHARED-FILE NOTICE for task 01 (kernel-bootstrap plumbing):
//   Task 01 owns the full bootstrap (intent dispatcher, ledger wiring, audit
//   sink, kill-switch). This stub is the metrics half. When task 01 lands,
//   merge as follows:
//     • Keep `getKernelRegistry()` — required by `routes/metrics.ts`.
//     • Keep `installKernelMetricsSink()` — the call to `setMetricsSink(...)`.
//     • Wrap both in task 01's `installKernel(...)` boot path so the metrics
//       sink is registered BEFORE any guard executes (otherwise the first
//       adjudicate() call no-ops the metrics).
//   If task 01 leaves a stub `setMetricsSink(undefined)` or installs the
//   `createConsoleMetricsSink()` reference, replace it with the call below.
//
// Per CLAUDE.md rule #9 the kernel is the authority — the sink is wired here
// at boot so the eight `audit_*` events (apps/web/src/domains/analytics/
// events.ts:107-114) have a producer.

import { setMetricsSink } from "@adjudicate/core/kernel"
import * as Sentry from "@sentry/node"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { Registry } from "prom-client"
import { logger } from "../lib/logger.js"
import {
  createKernelMetricsSink,
  type KernelMetricsSinkDeps,
  type TrackAnalytics,
} from "./kernel-metrics-sink.js"

// ── Shared registry singleton ────────────────────────────────────────────────
//
// One process-wide Registry. The /metrics route reads from this; the
// MetricsSink writes to it. Held as a module-level lazy singleton so tests
// can `_resetKernelRegistry()` between cases.

let _registry: Registry | null = null

/**
 * Lazy-construct (or return) the shared prom-client Registry. Both
 * `createKernelMetricsSink()` and `metricsRoutes()` MUST use the same
 * instance — otherwise the scrape endpoint will return an empty body.
 */
export function getKernelRegistry(): Registry {
  if (_registry === null) {
    _registry = new Registry()
  }
  return _registry
}

/** @internal — tests only. Drops the registry so the next call rebuilds it. */
export function _resetKernelRegistry(): void {
  _registry = null
}

// ── Default trackAnalytics wire ──────────────────────────────────────────────
//
// Server-side PostHog wire: publish to `analytics.event` on NATS — the same
// pipeline `routes/analytics.ts:82` uses for web-originated events. The
// downstream PostHog ingester subscribes there. Fire-and-forget: any rejected
// promise is swallowed by `createKernelMetricsSink` itself.

const defaultTrackAnalytics: TrackAnalytics = (eventType, properties) => {
  return publishNatsEvent("analytics.event", {
    eventType,
    properties,
    timestamp: new Date().toISOString(),
    source: "kernel",
  } as Record<string, unknown>)
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Build the real MetricsSink and install it via `setMetricsSink`. Returns
 * the registry so callers can pass it to `metricsRoutes({ register })`.
 *
 * Idempotent — calling twice replaces the sink and re-registers metrics on
 * the cached registry.
 */
export function installKernelMetricsSink(
  overrides?: Partial<KernelMetricsSinkDeps>,
): Registry {
  const register = overrides?.register ?? getKernelRegistry()
  const sink = createKernelMetricsSink({
    trackAnalytics: overrides?.trackAnalytics ?? defaultTrackAnalytics,
    sentry: overrides?.sentry ?? Sentry,
    log: overrides?.log ?? logger,
    register,
  })
  setMetricsSink(sink)
  return register
}
