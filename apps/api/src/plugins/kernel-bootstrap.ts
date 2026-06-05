// kernel-bootstrap.ts — wires `@adjudicate/core/kernel` into the API boot
// sequence. The kernel is always-on; there is no env-var gating to validate.
//
// Boot anchor responsibilities:
//
//   1. `installKernelMetricsSink()` — called from `buildServer()` (server.ts)
//      BEFORE routes are registered. Installs the real MetricsSink (PostHog
//      via NATS + Sentry breadcrumbs + Prometheus counters) and returns the
//      shared prom-client Registry so the `/metrics` route can scrape it.
//
//   2. `installFirstPartyPacks()` — called from `bootstrapKernel()`.
//      Registers every first-party `@ibatexas/pack-*` via `installPack(...)`.
//      Throws `PackConformanceError` synchronously if any Pack drifts from
//      `PackV0`.
//
//   3. `assertPackCoverage()` — called from `bootstrapKernel()` after Pack
//      installation. Walks `KNOWN_INTENT_KINDS` and asserts every kind
//      resolves to a Pack policy. Catches the "added a kind but forgot to
//      add a Pack policy" regression case.
//
//   4. `assertAuditPostgresReady()` — called from `bootstrapKernel()`.
//      Probes the `intent_audit` Postgres table; refuses to boot if the
//      table is missing. Operators run `ibx kernel migrate` (via
//      `ibx bootstrap`) to apply the @adjudicate/audit-postgres SQL
//      migrations.
//
//   5. `bootstrapKernel(server)` — called from `index.ts` after
//      `buildServer()` returns, before `server.listen()`. Composes the
//      above into the boot sequence.

import { installPack, PackConformanceError } from "@adjudicate/core"

/** Structural shape we read from an installed Pack. Avoids variance issues
 * when callers pass Packs with narrow literal kind unions. */
type InstalledPackLike = {
  readonly pack: { readonly intents: ReadonlyArray<string> }
}
import { recordSinkFailure, setMetricsSink } from "@adjudicate/core/kernel"
import { customerOnboardingPack } from "@ibatexas/pack-customer-onboarding"
import { ordersPack } from "@ibatexas/pack-orders"
import { paymentsPack } from "@ibatexas/pack-payments"
import { reservationsPack } from "@ibatexas/pack-reservations"
import { whatsappPack } from "@ibatexas/pack-whatsapp"
import { KNOWN_INTENT_KINDS } from "@ibatexas/intent-kinds"
// WS5: the NX-park quota-exceeded hook setter MUST come from the same park-nx
// module instance the live park calls go through — now the apps/api copy
// (re-exported by the park-deferred-intent-nx seam). Importing it from
// `@ibatexas/llm-provider` instead would set the hook on that package's
// transition-shim copy of park-nx, leaving the apps/api copy's hook null and
// silently dropping `kernel_defer_quota_exceeded_total{kind}`.
import { setDeferQuotaExceededHook } from "../adapters/park-deferred-intent-nx.js"
import {
  setAuditDedupHook,
  setAuditLagHook,
  setAuditRedactorFailureHook,
  setAuditSinkBufferSizeHook,
  setAuditSinkFailureHook,
  setAuditSinkSpillSizeHook,
} from "@ibatexas/audit-sink"
import { setAuditConsumerDedupHook } from "../subscribers/audit-consumer.js"
import { prisma } from "@ibatexas/domain"
import * as Sentry from "@sentry/node"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { Registry } from "prom-client"
import type { FastifyInstance } from "fastify"
import { logger } from "../lib/logger.js"
import {
  createKernelMetricsRecorder,
  createKernelMetricsSink,
  type KernelMetricsRecorder,
  type KernelMetricsSinkDeps,
  type TrackAnalytics,
} from "./kernel-metrics-sink.js"

// ── Shared registry singleton ────────────────────────────────────────────────

let _registry: Registry | null = null
let _recorder: KernelMetricsRecorder | null = null

export function getKernelRegistry(): Registry {
  if (_registry === null) {
    _registry = new Registry()
  }
  return _registry
}

export function getKernelMetricsRecorder(): KernelMetricsRecorder {
  if (_recorder === null) {
    _recorder = createKernelMetricsRecorder(getKernelRegistry(), logger)
  }
  return _recorder
}

/** @internal — tests only. */
export function _resetKernelRegistry(): void {
  _registry = null
  _recorder = null
}

// ── Default trackAnalytics wire ──────────────────────────────────────────────

const defaultTrackAnalytics: TrackAnalytics = (eventType, properties) => {
  return publishNatsEvent("analytics.event", {
    eventType,
    properties,
    timestamp: new Date().toISOString(),
    source: "kernel",
  } as Record<string, unknown>)
}

// ── installKernelMetricsSink ─────────────────────────────────────────────────

export function installKernelMetricsSink(
  overrides?: Partial<KernelMetricsSinkDeps>,
): Registry {
  const register = overrides?.register ?? getKernelRegistry()
  const sink = createKernelMetricsSink({
    trackAnalytics: overrides?.trackAnalytics ?? defaultTrackAnalytics,
    sentry: overrides?.sentry ?? Sentry,
    log: overrides?.log ?? logger,
    register,
    knownIntentKinds: overrides?.knownIntentKinds ?? KNOWN_INTENT_KINDS,
  })
  setMetricsSink(sink)

  const recorder = createKernelMetricsRecorder(
    register,
    overrides?.log ?? logger,
  )
  setAuditLagHook((sinkName, latencySeconds) =>
    recorder.recordAuditLag(sinkName, latencySeconds),
  )
  setAuditRedactorFailureHook((reason) =>
    recorder.recordAuditRedactorFailure(reason),
  )
  setAuditSinkBufferSizeHook((count) =>
    recorder.recordAuditSinkBufferSize(count),
  )
  setAuditSinkSpillSizeHook((count) =>
    recorder.recordAuditSinkSpillSize(count),
  )
  // Q4: forward downstream-sink failures (postgres onError, NATS onFailure,
  // buffered-sink spill-failure events) to the kernel MetricsSink.
  // `recordSinkFailure` is a module-level helper that calls into the
  // installed sink — installed two lines above by `setMetricsSink(sink)`.
  setAuditSinkFailureHook((event) => {
    recordSinkFailure(event)
  })
  // audit-2026-05-24 P0-1 — wire the NX-park quota-exceeded metric.
  // WS5: the wrapper now lives in apps/api (`adapters/park-nx.ts`, re-exported
  // by the `park-deferred-intent-nx` seam this import resolves through); we
  // inject the recorder here so each `quota_exceeded` rejection bumps
  // `kernel_defer_quota_exceeded_total{kind}`.
  setDeferQuotaExceededHook((kind) => {
    recorder.recordDeferQuotaExceeded(kind)
  })
  // audit-2026-05-25 (I11): wire the dedup hooks. PR #62 review found
  // both setAuditDedupHook (in-process sink path) and
  // setAuditConsumerDedupHook (NATS subscriber path) were exported but
  // never installed at boot — so once the upstream
  // `@adjudicate/audit-postgres` UNIQUE(intent_hash, recorded_at)
  // constraint ships, `kernel_audit_dedup_total{path}` would have
  // stayed at zero forever, depriving operators of the documented
  // "schema deployed" signal.
  //
  // Until the constraint lands AND the recorder grows an explicit
  // recordAuditDedup({path}) → Prometheus counter, we forward the
  // events to the structured logger so they surface in log-search +
  // can be aggregated by operators. The Sentry breadcrumb gives
  // incident responders timeline visibility.
  setAuditDedupHook((path) => {
    logger.info({ path }, "[audit-dedup] in-process sink dropped duplicate audit row")
    Sentry.addBreadcrumb({
      category: "audit-dedup",
      level: "info",
      message: `audit dedup fired (path=${path})`,
    })
  })
  setAuditConsumerDedupHook(() => {
    logger.info({ path: "consumer" }, "[audit-dedup] NATS audit-consumer dropped duplicate audit row")
    Sentry.addBreadcrumb({
      category: "audit-dedup",
      level: "info",
      message: "audit dedup fired (path=consumer)",
    })
  })
  _recorder = recorder
  return register
}

// ── installFirstPartyPacks ───────────────────────────────────────────────────

export function installFirstPartyPacks() {
  const orders = installPack(ordersPack)
  const reservations = installPack(reservationsPack)
  const whatsapp = installPack(whatsappPack)
  const customerOnboarding = installPack(customerOnboardingPack)
  const payments = installPack(paymentsPack)

  const recorder = getKernelMetricsRecorder()
  recorder.recordPackInstall("orders")
  recorder.recordPackInstall("reservations")
  recorder.recordPackInstall("whatsapp")
  recorder.recordPackInstall("customer-onboarding")
  recorder.recordPackInstall("payments")

  return { orders, reservations, whatsapp, customerOnboarding, payments }
}

// ── Pack coverage assertion ──────────────────────────────────────────────────
//
// The kernel is always authoritative. If a `KNOWN_INTENT_KINDS` entry has
// no Pack policy, `adjudicate()` will default-REFUSE that intent — every
// invocation fails with `code: "no_policy_for_kind"`. We assert at boot
// instead of waiting for the first refusal in production traffic.

export class PackCoverageError extends Error {
  constructor(public readonly missingKinds: readonly string[]) {
    super(
      `[kernel-bootstrap] ${missingKinds.length} known intent kind(s) have no Pack policy: ${missingKinds.join(", ")}`,
    )
    this.name = "PackCoverageError"
  }
}

/**
 * Assert that every `KNOWN_INTENT_KINDS` entry is declared by at least one
 * installed Pack's `intents` list. Throws `PackCoverageError` if any kind
 * is uncovered.
 *
 * Implementation: collects `installedPack.pack.intents` from every Pack
 * and treats a kind as covered if any Pack declares it. The Pack's
 * conformance assertion (run at install time) already verifies the
 * policy bundle handles every declared intent — this check closes the
 * loop on the ibatexas side.
 */
export function assertPackCoverage(
  packs: ReadonlyArray<InstalledPackLike>,
  knownKinds: ReadonlySet<string> = KNOWN_INTENT_KINDS,
): void {
  const declared = new Set<string>()
  for (const installed of packs) {
    for (const kind of installed.pack.intents) {
      declared.add(kind)
    }
  }
  const missing: string[] = []
  for (const kind of knownKinds) {
    if (!declared.has(kind)) missing.push(kind)
  }
  if (missing.length > 0) {
    throw new PackCoverageError(missing)
  }
}

// ── Audit-postgres preflight ─────────────────────────────────────────────────
//
// The audit sink fan-out includes Postgres unconditionally. If the
// `intent_audit` table is missing, every adjudicate() call would emit
// errors. Fail fast at boot with a clear path-forward error message.

export class AuditPostgresPreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuditPostgresPreflightError"
  }
}

export async function assertAuditPostgresReady(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new AuditPostgresPreflightError(
      "[kernel-bootstrap] DATABASE_URL is required — the kernel needs durable audit (intent_audit table).",
    )
  }
  try {
    await prisma.$queryRawUnsafe("SELECT 1 FROM intent_audit LIMIT 1")
  } catch (err) {
    const message = (err as Error).message ?? ""
    if (message.includes("intent_audit") || message.includes("does not exist") || message.includes("relation")) {
      throw new AuditPostgresPreflightError(
        '[kernel-bootstrap] intent_audit table is missing — run `ibx bootstrap` (or `ibx kernel migrate`) to apply the @adjudicate/audit-postgres migrations.',
      )
    }
    throw new AuditPostgresPreflightError(
      `[kernel-bootstrap] audit-postgres preflight failed: ${message}`,
    )
  }
}

// ── bootstrapKernel ─────────────────────────────────────────────────────────

/**
 * Post-`buildServer()` kernel boot anchor. Called from `apps/api/src/index.ts`
 * before `server.listen()`. Composes Pack installation, coverage assertion,
 * and audit-postgres preflight. Metrics sink is already wired by
 * `installKernelMetricsSink()` which runs earlier inside buildServer.
 */
export async function bootstrapKernel(server: FastifyInstance): Promise<void> {
  // 1. Install first-party Packs. `installPack` throws `PackConformanceError`
  //    synchronously if any Pack drifts from `PackV0`.
  let installedPacks: ReturnType<typeof installFirstPartyPacks>
  try {
    installedPacks = installFirstPartyPacks()
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

  // 2. Assert Pack coverage: every known intent kind must resolve to a
  //    policy in one of the installed Packs. Otherwise the kernel would
  //    default-REFUSE legitimate traffic.
  try {
    const allPacks = [
      installedPacks.orders,
      installedPacks.reservations,
      installedPacks.whatsapp,
      installedPacks.customerOnboarding,
      installedPacks.payments,
    ]
    assertPackCoverage(allPacks)
    server.log.info(
      {
        event: "kernel.bootstrap.pack_coverage_validated",
        knownIntentCount: KNOWN_INTENT_KINDS.size,
      },
      "[kernel-bootstrap] pack coverage validated",
    )
  } catch (err) {
    if (err instanceof PackCoverageError) {
      server.log.fatal(
        { err, missingKinds: err.missingKinds },
        "[kernel-bootstrap] pack coverage failed — refusing to boot",
      )
    }
    throw err
  }

  // 3. Audit-postgres preflight. Refuse to boot if the `intent_audit`
  //    table is missing — every adjudicate() call would otherwise emit
  //    a spill error.
  try {
    await assertAuditPostgresReady()
    server.log.info(
      { event: "kernel.bootstrap.audit_postgres_ready" },
      "[kernel-bootstrap] audit-postgres preflight passed",
    )
  } catch (err) {
    if (err instanceof AuditPostgresPreflightError) {
      server.log.fatal({ err }, "[kernel-bootstrap] audit-postgres preflight failed — refusing to boot")
    }
    throw err
  }

  // 4. Start the defer-pending gauge poll (W3-5). Real kernel behavior;
  //    surfaces the count of `defer:pending:*` Redis keys.
  const recorder = getKernelMetricsRecorder()
  startDeferPendingGaugePoll(recorder, server.log)
}

// ── W3-5: defer-pending-gauge poll ──────────────────────────────────────────

let _deferPendingPoll: ReturnType<typeof setInterval> | null = null
const DEFER_PENDING_POLL_INTERVAL_MS =
  Number.parseInt(
    process.env.IBX_DEFER_PENDING_POLL_SECONDS ?? "60",
    10,
  ) * 1000
const MAX_DEFER_SCAN_KEYS = 10_000

function startDeferPendingGaugePoll(
  recorder: KernelMetricsRecorder,
  log: { warn: (obj: Record<string, unknown>, msg?: string) => void },
): void {
  if (process.env.NODE_ENV === "test") return
  if (_deferPendingPoll !== null) return
  const tick = async () => {
    try {
      const { getRedisClient, rk } = await import("@ibatexas/tools")
      const redis = await getRedisClient()
      let count = 0
      const pattern = rk("defer:pending:*")
      for await (const key of redis.scanIterator({
        MATCH: pattern,
        COUNT: 100,
      })) {
        if (Array.isArray(key)) count += key.length
        else count += 1
        if (count >= MAX_DEFER_SCAN_KEYS) break
      }
      recorder.recordDeferPending(count)
    } catch (err) {
      log.warn(
        { err: String(err) },
        "[kernel-bootstrap] defer-pending poll threw",
      )
    }
  }
  void tick()
  _deferPendingPoll = setInterval(() => {
    void tick()
  }, DEFER_PENDING_POLL_INTERVAL_MS)
  if (typeof _deferPendingPoll.unref === "function") _deferPendingPoll.unref()
}

/** @internal — tests only. */
export function _stopDeferPendingGaugePoll(): void {
  if (_deferPendingPoll !== null) {
    clearInterval(_deferPendingPoll)
    _deferPendingPoll = null
  }
}
