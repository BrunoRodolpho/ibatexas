// kernel-bootstrap.ts — wires `@adjudicate/core/kernel` into the API boot
// sequence. Two entry points:
//
//   1. `installKernelMetricsSink()` — called from `buildServer()` (server.ts)
//      BEFORE routes are registered. Installs the real MetricsSink (PostHog
//      via NATS + Sentry breadcrumbs + Prometheus counters) and returns the
//      shared prom-client Registry so the `/metrics` route can scrape it.
//
//   2. `bootstrapKernel(server)` — called from `index.ts` AFTER buildServer
//      returns, before `server.listen()`. Validates `IBX_KERNEL_SHADOW` /
//      `IBX_KERNEL_ENFORCE` against the known-intent set (typo-guard), will
//      register first-party Packs via `installPack(...)` once task 08 lands.
//      No metrics installation here — that already happened in step 1.
//
// Investigation 06 (Runtime Config & Governance Plumbing) flagged that the
// kernel is "dormant by accident, not by design" — every framework hook
// exists in `@adjudicate/core/kernel` but no IbateXas startup site calls
// `installPack()`, `validateEnforceConfig()`, or `setMetricsSink()`. This
// file is the boot anchor for all three.
//
// Out of scope for THIS file:
//   • Kill-switch admin endpoint (deferred to a follow-up task).
//   • Real Pack registration with `withBasisAudit` + conformance assertion
//     (deferred to task 08 — see TODO inside `bootstrapKernel`).

import { setMetricsSink, validateEnforceConfig } from "@adjudicate/core/kernel"
import * as Sentry from "@sentry/node"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { Registry } from "prom-client"
import type { FastifyInstance } from "fastify"
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

// ── installKernelMetricsSink ─────────────────────────────────────────────────

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

// ── Known intent kinds (stub) ──────────────────────────────────────────────
//
// TODO(task-08): replace this empty Set with the authoritative
// `KNOWN_INTENT_KINDS` constant exported from `@ibatexas/llm-provider`
// once task 08 lands `@ibatexas/pack-orders`. The full set will be
// derived from `TOOL_CLASSIFICATION.MUTATING` in
// `packages/llm-provider/src/machine/types.ts:386-407` plus the PIX Pack
// intents (`pix.charge.create`, `pix.charge.confirm`, `pix.charge.refund`).
// With the stub empty, `validateEnforceConfig` will treat EVERY token in
// `IBX_KERNEL_SHADOW`/`IBX_KERNEL_ENFORCE` as a typo — which is fine,
// because both env vars default to empty until staged rollout begins.
function getKnownIntentKinds(): ReadonlySet<string> {
  return new Set<string>()
}

// ── bootstrapKernel ─────────────────────────────────────────────────────────

/**
 * Post-`buildServer()` kernel boot anchor. Called from `apps/api/src/index.ts`
 * before `server.listen()`. Responsible for validateEnforceConfig + (future)
 * installPack. Metrics sink is already wired by `installKernelMetricsSink()`
 * which runs earlier inside buildServer.
 */
export async function bootstrapKernel(server: FastifyInstance): Promise<void> {
  // TODO(task-08): installPack(ordersPack, { warn: server.log.warn.bind(server.log) })
  //    — currently using no-op pack. `@ibatexas/pack-orders` does not exist
  //    yet (task 08 creates it). When it lands, replace this comment with:
  //
  //      import { installPack, PackConformanceError } from "@adjudicate/core";
  //      import { ordersPack } from "@ibatexas/pack-orders";
  //      try {
  //        installPack(ordersPack, { warn: server.log.warn.bind(server.log) });
  //      } catch (err) {
  //        if (err instanceof PackConformanceError) {
  //          server.log.fatal({ err }, "[kernel-bootstrap] pack conformance failed");
  //          throw err; // fail-fast: process.exit non-zero before server.listen
  //        }
  //        throw err;
  //      }

  // Validate enforce-config against the known intent set. Surfaces typos in
  // `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` as one-time structured warn
  // lines via the pino logger AND records a sink failure with
  // `errorClass: "enforce_config_typo"` (see
  // `@adjudicate/core/kernel/enforce-config.ts:94-135`).
  const knownIntents = getKnownIntentKinds()
  validateEnforceConfig(knownIntents, process.env, (msg) => {
    server.log.warn({ msg }, "[kernel-bootstrap] enforce-config validation")
  })

  // Structured info lines so operators can verify the bootstrap fired at
  // startup. Names match the docs/adjudicate-migration spec:
  // `kernel.bootstrap.*`.
  server.log.info(
    { event: "kernel.bootstrap.pack_installed", pack: "noop-stub" },
    "[kernel-bootstrap] pack installed (stub — replace in task 08)",
  )
  server.log.info(
    {
      event: "kernel.bootstrap.enforce_config_validated",
      knownIntentCount: knownIntents.size,
    },
    "[kernel-bootstrap] enforce-config validated",
  )
}
