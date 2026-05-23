// kernel-bootstrap.ts — wires `@adjudicate/core/kernel` into the API boot
// sequence. Three entry points:
//
//   1. `installKernelMetricsSink()` — called from `buildServer()` (server.ts)
//      BEFORE routes are registered. Installs the real MetricsSink (PostHog
//      via NATS + Sentry breadcrumbs + Prometheus counters) and returns the
//      shared prom-client Registry so the `/metrics` route can scrape it.
//
//   2. `installFirstPartyPacks()` — called from `bootstrapKernel()`. Registers
//      every first-party `@ibatexas/pack-*` via `installPack(...)`. Throws
//      `PackConformanceError` synchronously if any Pack drifts from `PackV0`.
//      Adds future Packs (reservations / whatsapp / customer-onboarding) here
//      as tasks 09 / 10 / 21 land.
//
//   3. `bootstrapKernel(server)` — called from `index.ts` AFTER buildServer
//      returns, before `server.listen()`. Installs Packs and validates
//      `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` against the known-intent set
//      (typo-guard). No metrics installation here — that already happened in
//      step 1.
//
// Investigation 06 (Runtime Config & Governance Plumbing) flagged that the
// kernel is "dormant by accident, not by design" — every framework hook
// exists in `@adjudicate/core/kernel` but no IbateXas startup site calls
// `installPack()`, `validateEnforceConfig()`, or `setMetricsSink()`. This
// file is the boot anchor for all three.

import { installPack, PackConformanceError } from "@adjudicate/core"
import { setMetricsSink, validateEnforceConfig } from "@adjudicate/core/kernel"
import { customerOnboardingPack } from "@ibatexas/pack-customer-onboarding"
import { ordersPack } from "@ibatexas/pack-orders"
import { reservationsPack } from "@ibatexas/pack-reservations"
import { whatsappPack } from "@ibatexas/pack-whatsapp"
import { KNOWN_INTENT_KINDS } from "@ibatexas/llm-provider"
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

// ── installFirstPartyPacks ───────────────────────────────────────────────────
//
// Per CLAUDE.md rule #9 (LLM authority / IBX-IGE v2.0) and the
// adjudicate-migration master plan §"WS4 — Pack architecture", every
// first-party Pack MUST be installed via `installPack(...)` from
// `@adjudicate/core` so its conformance is asserted at boot. The Pack's
// policy default (REFUSE — master plan #4) is verified by the assertion
// and the boot fails-loud if drift is introduced.

/**
 * Install IbateXas's first-party Packs against the kernel. Throws
 * `PackConformanceError` synchronously if any Pack drifts from `PackV0`.
 */
export function installFirstPartyPacks() {
  const orders = installPack(ordersPack)
  const reservations = installPack(reservationsPack)
  const whatsapp = installPack(whatsappPack)
  const customerOnboarding = installPack(customerOnboardingPack)
  return { orders, reservations, whatsapp, customerOnboarding }
}

// ── bootstrapKernel ─────────────────────────────────────────────────────────

/**
 * Post-`buildServer()` kernel boot anchor. Called from `apps/api/src/index.ts`
 * before `server.listen()`. Responsible for Pack installation + enforce-config
 * validation. Metrics sink is already wired by `installKernelMetricsSink()`
 * which runs earlier inside buildServer.
 */
export async function bootstrapKernel(server: FastifyInstance): Promise<void> {
  // Install first-party Packs. `installPack` throws `PackConformanceError`
  // synchronously if any Pack drifts from `PackV0` — we let it propagate
  // so `index.ts` exits non-zero before `server.listen()`.
  try {
    installFirstPartyPacks()
    server.log.info(
      {
        event: "kernel.bootstrap.pack_installed",
        packs: ["orders", "reservations", "whatsapp", "customer-onboarding"],
      },
      "[kernel-bootstrap] first-party packs installed",
    )
  } catch (err) {
    if (err instanceof PackConformanceError) {
      server.log.fatal({ err }, "[kernel-bootstrap] pack conformance failed")
    }
    throw err
  }

  // Validate enforce-config against the known intent set. Surfaces typos in
  // `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` as one-time structured warn
  // lines via the pino logger AND records a sink failure with
  // `errorClass: "enforce_config_typo"` (see
  // `@adjudicate/core/kernel/enforce-config.ts:94-135`).
  //
  // `KNOWN_INTENT_KINDS` is assembled in `@ibatexas/llm-provider/intent-kinds.ts`
  // from each first-party Pack's intent surface. Future Packs (reservations /
  // whatsapp / customer-onboarding) extend it from inside that module — no
  // change here is needed when those packs land.
  validateEnforceConfig(KNOWN_INTENT_KINDS, process.env, (msg) => {
    server.log.warn({ msg }, "[kernel-bootstrap] enforce-config validation")
  })

  server.log.info(
    {
      event: "kernel.bootstrap.enforce_config_validated",
      knownIntentCount: KNOWN_INTENT_KINDS.size,
    },
    "[kernel-bootstrap] enforce-config validated",
  )
}
