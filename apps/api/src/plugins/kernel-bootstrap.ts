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
import { paymentsPack } from "@ibatexas/pack-payments"
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
    // W5-9: pass KNOWN_INTENT_KINDS so the sink can publish
    // `kernel_intent_kind_coverage`. The set is computed at the llm-provider
    // package boundary from the first-party Pack unions; passing it in keeps
    // the sink layered above @ibatexas/llm-provider rather than coupling
    // them at module-graph level.
    knownIntentKinds: overrides?.knownIntentKinds ?? KNOWN_INTENT_KINDS,
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
  const payments = installPack(paymentsPack)
  return { orders, reservations, whatsapp, customerOnboarding, payments }
}

// ── P0-9-TRUE: empty-after-trim validation ───────────────────────────────────
//
// Detects the operator-typo case where `IBX_KERNEL_SHADOW` or
// `IBX_KERNEL_ENFORCE` is SET in the environment but every token strips to
// empty (e.g. `" , , "`, `","`, `"  "`). The upstream `parseList` filters
// these to an empty set silently — visually identical to "env var unset" —
// silently disabling shadow/enforce. We throw here so the misconfig surfaces
// at boot, not at incident.
//
// Allows the env var to be UNSET (legitimate empty-set config). Also accepts
// a non-empty parsed set with trailing comma (`"order.cancel,"`) — the
// parser already keeps `"order.cancel"`; only "all tokens strip to empty"
// is flagged.
//
// To intentionally configure an empty enforce list, UNSET the variable.
// Exported for unit testing.

const KIND_LIST_ENV_VARS = ["IBX_KERNEL_SHADOW", "IBX_KERNEL_ENFORCE"] as const

/** @internal — exported for tests. */
export function assertEnforceConfigNotEmptyAfterTrim(
  env: NodeJS.ProcessEnv,
): void {
  for (const name of KIND_LIST_ENV_VARS) {
    const raw = env[name]
    // Allow env var to be unset (legitimate empty-set config).
    if (raw === undefined) continue
    // Compute the parsed kind list using the same rules as the upstream
    // parser (`@adjudicate/core/kernel/enforce-config.ts:19-29`):
    //   split(",") -> map(trim) -> filter(len > 0)
    const parsed = raw
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    if (parsed.length > 0) continue
    // Parsed empty. If the raw value also has zero length, treat as
    // "set to empty string" — this is the operator's deliberate
    // empty signal (e.g. `IBX_KERNEL_ENFORCE=` in `.env`). Accept.
    if (raw.length === 0) continue
    // Parsed empty BUT raw has characters — must be commas/whitespace.
    // This is the typo case. Throw.
    throw new Error(
      `[kernel-bootstrap] ${name} is set to "${raw}" which strips to an ` +
        `empty kind list — this looks like a typo, not a deliberate ` +
        `empty configuration. Unset the variable to disable, or fix the ` +
        `value. Refusing to boot.`,
    )
  }
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
        packs: [
          "orders",
          "reservations",
          "whatsapp",
          "customer-onboarding",
          "payments",
        ],
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
  // P0-9: a typo such as `IBX_KERNEL_ENFORCE=order.cart.adddd` would warn
  // and proceed — enforcement silently disabled while the ops dashboard
  // showed green. We now treat any non-empty `unknownShadow`/`unknownEnforce`
  // list as fatal: throw a structured error so the bootstrap promise rejects
  // and `start().catch(...)` (P0-6) triggers `process.exit(1)`.
  //
  // P0-9-TRUE (deep-audit hidden bug #6): the upstream parser silently
  // accepts `IBX_KERNEL_ENFORCE=" , , "` (or `","`, `"  "`, `"order.cancel, "`)
  // — every token strips to empty so the parsed set is empty, which the
  // bootstrap currently treats identically to "env var unset". Operator
  // typos that ALL strip to empty silently disable enforcement. We surface
  // this BEFORE the unknown-token check: any time the env var is set in the
  // process environment AND the parsed kind list is empty AND the raw value
  // contains a comma OR whitespace (the syntactic markers of a typo, not a
  // deliberate empty), the bootstrap throws. Operators with a deliberate
  // empty-enforce configuration MUST unset the env var entirely.
  //
  // `KNOWN_INTENT_KINDS` is assembled in `@ibatexas/llm-provider/intent-kinds.ts`
  // from each first-party Pack's intent surface. Future Packs (reservations /
  // whatsapp / customer-onboarding) extend it from inside that module — no
  // change here is needed when those packs land.
  assertEnforceConfigNotEmptyAfterTrim(process.env)
  const enforceConfig = validateEnforceConfig(KNOWN_INTENT_KINDS, process.env, (msg) => {
    server.log.warn({ msg }, "[kernel-bootstrap] enforce-config validation")
  })

  if (
    enforceConfig.unknownShadow.length > 0 ||
    enforceConfig.unknownEnforce.length > 0
  ) {
    server.log.fatal(
      {
        event: "kernel.bootstrap.enforce_config_typo",
        unknownShadow: enforceConfig.unknownShadow,
        unknownEnforce: enforceConfig.unknownEnforce,
      },
      "[kernel-bootstrap] enforce-config contains unrecognized intent kinds — refusing to boot",
    )
    throw new Error(
      `[kernel-bootstrap] enforce-config typo: unknownShadow=${JSON.stringify(
        enforceConfig.unknownShadow,
      )} unknownEnforce=${JSON.stringify(
        enforceConfig.unknownEnforce,
      )}. Fix env vars IBX_KERNEL_SHADOW / IBX_KERNEL_ENFORCE before retry.`,
    )
  }

  server.log.info(
    {
      event: "kernel.bootstrap.enforce_config_validated",
      knownIntentCount: KNOWN_INTENT_KINDS.size,
    },
    "[kernel-bootstrap] enforce-config validated",
  )
}
