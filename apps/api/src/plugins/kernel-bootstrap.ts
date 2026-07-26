// kernel-bootstrap.ts — wires `@adjudicate/core/kernel` into the API boot
// sequence. The kernel is always-on; there is no env-var gating to validate.
//
// Boot anchor responsibilities:
//
// (Numbering note: the list below is a flat inventory of every exported
// boot-anchor function — items 1 and 8 run outside `bootstrapKernel`'s own
// body (1 from `buildServer()`; 8 IS `bootstrapKernel`), so they have no
// step-comment counterpart inside it. `bootstrapKernel`'s internal step
// comments (further down) number ONLY what it runs, starting fresh at 1 —
// item N here is step N-1 there, EXCEPT the final internal step (defer-
// pending-gauge poll), which has no item-number counterpart here at all —
// it's infrastructure, not a boot-anchor assertion. The two sequences are
// intentionally separate counts, not a typo.)
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
//   5. `assertEnvelopeBoundaryGateWired()` (FE-T04) — called from
//      `bootstrapKernel()`. Drives a synthetic malformed envelope through the
//      real `runCustomerIntent` and asserts the isIntentEnvelope structural
//      gate (customer-intent-gateway.ts) actually rejects it. Refuses to
//      boot if that gate has been silently removed or bypassed.
//
//   6. `assertCommandServiceBoundaryGateWired()` (FE-T04) — called from
//      `bootstrapKernel()`. Same self-check on the OTHER convergence point:
//      drives a synthetic malformed envelope through the real
//      `withAdjudicate` (@ibatexas/domain) — the command-service chokepoint
//      every ops/admin/subscriber/job/LLM-tool mutation flows through.
//
//   7. `assertCapabilityGuardRefsWired()` (FE-T19) — called from
//      `bootstrapKernel()`. Asserts every `CapabilityGuardRef` on the
//      authored `CapabilityDefinition` registry (`@ibatexas/catalog`)
//      resolves to a real, live guard function on the installed Packs'
//      `PolicyBundle`s.
//      Refuses to boot if a guard-ref was left dangling by a rename,
//      removal, or phase move (`GuardRefResolutionError`). This is IN
//      ADDITION to the same assertion already running eagerly at module-
//      import time inside `capability-definitions/index.ts` — cheap, and
//      redundant on purpose: the boot-time call is the one that actually
//      fires in production if a future consumer of the registry forgets to
//      import it before this point runs.
//
//   8. `bootstrapKernel(server)` — called from `index.ts` after
//      `buildServer()` returns, before `server.listen()`. Composes the
//      above into the boot sequence.

import {
  installPack,
  PackConformanceError,
  type IntentEnvelope,
} from "@adjudicate/core"

/** Structural shape we read from an installed Pack. Avoids variance issues
 * when callers pass Packs with narrow literal kind unions. */
type InstalledPackLike = {
  readonly pack: { readonly intents: ReadonlyArray<string> }
}
import {
  recordSinkFailure,
  setMetricsSink,
  type MetricsSink,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import { customerOnboardingPack } from "@ibatexas/pack-customer-onboarding"
import { opsPack } from "@ibatexas/pack-ops"
import { ordersPack } from "@ibatexas/pack-orders"
import { paymentsPack } from "@ibatexas/pack-payments"
import { paymentsPixPack } from "@adjudicate/pack-payments-pix"
import { reservationsPack } from "@ibatexas/pack-reservations"
import { whatsappPack } from "@ibatexas/pack-whatsapp"
import { KNOWN_INTENT_KINDS, LOYALTY_INTENT_KINDS } from "@ibatexas/intent-kinds"
// FE-T19 — the FE-4 EXPAND CapabilityDefinition registry's guard-ref boot
// assertion. See `assertCapabilityGuardRefsWired()` below.
//
// LE2-015: the two halves come from the two packages that own them. The
// authored definitions and their projections live in `@ibatexas/catalog`, the
// single root of business definition. Guard-ref RESOLUTION stays in
// `@ibatexas/packs-composed` — binding a reference to a live guard function in
// an installed Pack is a claim about the runtime, which the catalog never
// holds.
import {
  CAPABILITY_DEFINITIONS,
  generateKnownIntentKinds,
  type CapabilityDefinition,
} from "@ibatexas/catalog"
import {
  assertGuardRefsResolve,
  GuardRefResolutionError,
} from "@ibatexas/packs-composed/capability-definitions"
// WS5: the NX-park quota-exceeded hook setter MUST come from the same park-nx
// module instance the live park calls go through — now the apps/api copy
// (re-exported by the park-deferred-intent-nx seam). Importing it from
// `@ibatexas/llm-provider` instead would set the hook on that package's
// transition-shim copy of park-nx, leaving the apps/api copy's hook null and
// silently dropping `kernel_defer_quota_exceeded_total{kind}`.
import {
  setAuditDedupHook,
  setAuditLagHook,
  setAuditRedactorFailureHook,
  setAuditSinkBufferSizeHook,
  setAuditSinkFailureHook,
  setAuditSinkSpillSizeHook,
} from "@ibatexas/audit-sink"
import { prisma, withAdjudicate } from "@ibatexas/domain"
import * as Sentry from "@sentry/node"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { Registry } from "prom-client"
import type { FastifyInstance } from "fastify"
import { setAuditConsumerDedupHook } from "../subscribers/audit-consumer.js"
import { setDeferQuotaExceededHook } from "../adapters/park-deferred-intent-nx.js"
import { createIbatexasMetricsSink } from "../observability/metrics-sink.js"
import { logger } from "../lib/logger.js"
import {
  runCustomerIntent,
  STRUCTURAL_REJECTION_CODE,
} from "../routes/__shared__/customer-intent-gateway.js"
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
  _registry ??= new Registry()
  return _registry
}

export function getKernelMetricsRecorder(): KernelMetricsRecorder {
  _recorder ??= createKernelMetricsRecorder(getKernelRegistry(), logger)
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

/**
 * SIGNAL-4: fan one kernel observability event out to several MetricsSinks.
 * Production needs BOTH the Prometheus/PostHog/Sentry sink AND the structured
 * pino sink (component:kernel event:decision/refusal) so kernel decisions are
 * visible + sliceable in VictoriaLogs — previously only the Prometheus sink was
 * installed (first-wins), so decisions never reached the log stream. Each arm is
 * fenced: an observer must NEVER break the kernel path.
 */
function composeMetricsSinks(a: MetricsSink, b: MetricsSink): MetricsSink {
  const both = (fn: (s: MetricsSink) => void): void => {
    for (const s of [a, b]) {
      try {
        fn(s)
      } catch {
        // observer isolation — swallow (the kernel path must not throw here)
      }
    }
  }
  return {
    recordDecision: (e) => both((s) => s.recordDecision(e)),
    recordRefusal: (e) => both((s) => s.recordRefusal(e)),
    recordLedgerOp: (e) => both((s) => s.recordLedgerOp(e)),
    recordSinkFailure: (e) => both((s) => s.recordSinkFailure(e)),
    // recordResourceLimit + recordShadowDivergence are OPTIONAL on MetricsSink.
    recordResourceLimit: (e) => both((s) => s.recordResourceLimit?.(e)),
    recordShadowDivergence: (e) => both((s) => s.recordShadowDivergence?.(e)),
  }
}

export function installKernelMetricsSink(
  overrides?: Partial<KernelMetricsSinkDeps>,
): Registry {
  const register = overrides?.register ?? getKernelRegistry()
  const promSink = createKernelMetricsSink({
    trackAnalytics: overrides?.trackAnalytics ?? defaultTrackAnalytics,
    sentry: overrides?.sentry ?? Sentry,
    log: overrides?.log ?? logger,
    register,
    knownIntentKinds: overrides?.knownIntentKinds ?? KNOWN_INTENT_KINDS,
  })
  // SIGNAL-4: compose the structured pino decision-logger alongside the
  // Prometheus sink so EXECUTE (info) / REFUSE (warn) / ESCALATE decisions ship
  // to VictoriaLogs, joinable to intent_audit rows by intentHash.
  const sink = composeMetricsSinks(promSink, createIbatexasMetricsSink(logger))
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
  // NOISE-7: dedup firing is the EXPECTED steady state of the always-on
  // execution ledger — logging every drop at info was 535 lines of routine
  // bookkeeping. Demote to debug (tagged component:kernel event:dedup); the
  // Sentry breadcrumb keeps incident-timeline visibility, and the real home
  // for the rate is the kernel_audit_dedup_total Prometheus counter noted above.
  setAuditDedupHook((path) => {
    logger.debug({ component: "kernel", event: "dedup", path }, "[audit-dedup] in-process sink dropped duplicate audit row")
    Sentry.addBreadcrumb({
      category: "audit-dedup",
      level: "info",
      message: `audit dedup fired (path=${path})`,
    })
  })
  setAuditConsumerDedupHook(() => {
    logger.debug({ component: "kernel", event: "dedup", path: "consumer" }, "[audit-dedup] NATS audit-consumer dropped duplicate audit row")
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
  // `@ibatexas/pack-ops` (NEW-032 slice C1) — the staff-plane ops verb pack.
  // It declares `product.availability.set` (now in `KNOWN_INTENT_KINDS`);
  // without installing it that kind resolves to no policy and
  // `assertPackCoverage` refuses to boot. The pack's admin-session fence +
  // the adopter staffRoleGuard (composed router) govern it.
  const ops = installPack(opsPack)
  // `@adjudicate/pack-payments-pix` — the lighthouse PIX-charge-lifecycle Pack
  // (CLAUDE.md rule #9 / ADR #13). It declares the `pix.charge.*` wire-PSP
  // kinds carried in `KNOWN_INTENT_KINDS`; without installing it those kinds
  // resolve to no policy and `assertPackCoverage` refuses to boot. This
  // mirrors the canonical pack roster in `ibx kernel` (cli loadPackIndex).
  const paymentsPix = installPack(paymentsPixPack)

  const recorder = getKernelMetricsRecorder()
  recorder.recordPackInstall("orders")
  recorder.recordPackInstall("reservations")
  recorder.recordPackInstall("whatsapp")
  recorder.recordPackInstall("customer-onboarding")
  recorder.recordPackInstall("payments")
  recorder.recordPackInstall("ops")
  recorder.recordPackInstall("payments-pix")

  return { orders, reservations, whatsapp, customerOnboarding, payments, ops, paymentsPix }
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

// Intent kinds that MUST resolve to an installed Pack at boot.
//
// A subset of `CAPABILITY_DEFINITIONS`'s kinds (+ the pix external input) is
// adjudicated NOT through the global Pack registry but via a domain-internal
// `PolicyBundle` passed straight to `adjudicate()` / `withAdjudicate` (today:
// `loyalty.stamp.add`, owned by `loyalty-policy.ts` in `@ibatexas/domain`;
// the SYSTEM-only stamp award is dispatched by the `order.placed` subscriber
// with the bundle in hand). For those kinds the coverage gate's premise —
// "no Pack policy ⇒ adjudicate() default-REFUSEs legitimate traffic" — is
// false: the caller supplies the bundle, so the kernel never consults the
// registry. We exclude them here, mirroring the `medusa.*` exclusion
// rationale documented in `@ibatexas/intent-kinds`. Every OTHER known kind
// must be declared by an installed Pack or the kernel refuses to boot.
//
// FE-4 CONTRACT (FE-T26): projected DIRECTLY from `CAPABILITY_DEFINITIONS`
// via `generateKnownIntentKinds` — `paymentsPixPack.intents` supplies the
// pix external input as a REAL runtime materialization (mirrors
// `generate-known-intent-kinds.ts`'s own freshness-test precedent), never a
// hand-retyped copy. The hand-authored `KNOWN_INTENT_KINDS`-derived version
// this constant used to be (`[...KNOWN_INTENT_KINDS].filter(...)`) is
// deleted — `KNOWN_INTENT_KINDS` itself still exists (`@ibatexas/
// intent-kinds`, now machine-generated — see that package's own `src/
// index.ts` header), but this boot anchor no longer routes through it: one
// fewer indirection between the single source of truth and the gate that
// consumes it.
const PACK_REGISTERED_INTENT_KINDS: ReadonlySet<string> = new Set(
  [
    ...generateKnownIntentKinds(CAPABILITY_DEFINITIONS, {
      pixIntentKinds: paymentsPixPack.intents,
      loyaltyIntentKinds: [...LOYALTY_INTENT_KINDS],
    }),
  ].filter((kind) => !LOYALTY_INTENT_KINDS.has(kind)),
)

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

// ── FE-T04: envelope structural boundary gate self-check ────────────────────
//
// `runCustomerIntent` (customer-intent-gateway.ts) gates every customer
// envelope through the canonical `isIntentEnvelope` structural check before
// `detectForgery` or `adjudicate()` ever see it. That gate is a single `if`
// inline in the function body — nothing stops a future edit from silently
// deleting it (an accidental merge conflict resolution, a "simplify this"
// refactor, …), and unlike a missing Pack policy it would NOT fail loudly:
// a malformed envelope would just start reaching `detectForgery` / the
// frozen kernel instead of being REFUSEd at the boundary.
//
// This is a live, non-mocked self-check: it drives a synthetic
// structurally-invalid "envelope" through the REAL exported
// `runCustomerIntent` and asserts the boundary contract holds. `runner` is
// dependency-injectable ONLY so a unit test can supply a stand-in that
// skips the gate and prove this assertion actually catches that
// regression — the boot call site always uses the default (the real,
// live-path function).

export class EnvelopeBoundaryGateNotWiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EnvelopeBoundaryGateNotWiredError"
  }
}

/** Minimal always-REFUSE policy — the self-check envelope is malformed and
 * MUST be rejected by the structural gate before any policy is consulted;
 * this exists only to satisfy `RunCustomerIntentOptions.policy`'s type. */
const ENVELOPE_GATE_SELF_CHECK_POLICY: PolicyBundle<string, unknown, unknown> = {
  stateGuards: [],
  authGuards: [],
  business: [],
  taint: { minimumFor: () => "UNTRUSTED" },
  default: "REFUSE",
}

export async function assertEnvelopeBoundaryGateWired(
  runner: typeof runCustomerIntent = runCustomerIntent,
): Promise<void> {
  let executed = false
  const reply = await runner({
    envelope: { notAnEnvelope: true } as unknown as IntentEnvelope,
    state: {},
    policy: ENVELOPE_GATE_SELF_CHECK_POLICY,
    executor: async () => {
      executed = true
      return {}
    },
    ctx: {
      customerId: "kernel-bootstrap-self-check",
      route: "boot.envelope-boundary-gate",
    },
  })
  const code = (reply.body as { code?: unknown } | undefined)?.code
  if (executed || reply.statusCode !== 400 || code !== STRUCTURAL_REJECTION_CODE) {
    throw new EnvelopeBoundaryGateNotWiredError(
      `[kernel-bootstrap] envelope structural boundary gate self-check failed — ` +
        `expected statusCode=400 code="${STRUCTURAL_REJECTION_CODE}" with the executor never run, ` +
        `got statusCode=${reply.statusCode} code=${JSON.stringify(code)} executed=${executed}. ` +
        `The isIntentEnvelope gate in customer-intent-gateway.ts appears to be unwired (FE-T04).`,
    )
  }
}

// `withAdjudicate` (@ibatexas/domain) is the OTHER convergence point the
// structural gate covers — the command-service chokepoint every
// ops/admin/subscriber/job/LLM-tool mutation flows through. Same idiom as
// `assertEnvelopeBoundaryGateWired` above: drive a synthetic malformed
// envelope through the REAL exported `withAdjudicate` and fail boot if the
// executor ran or the decision isn't the expected structural REFUSE.
// `runner` is dependency-injectable ONLY for the "broken wiring" unit test.
export async function assertCommandServiceBoundaryGateWired(
  runner: typeof withAdjudicate = withAdjudicate,
): Promise<void> {
  let executed = false
  const outcome = await runner(
    { notAnEnvelope: true } as unknown as IntentEnvelope,
    {},
    ENVELOPE_GATE_SELF_CHECK_POLICY,
    async () => {
      executed = true
      return {}
    },
  )
  const code =
    outcome.decision.kind === "REFUSE" ? outcome.decision.refusal.code : undefined
  if (executed || outcome.decision.kind !== "REFUSE" || code !== STRUCTURAL_REJECTION_CODE) {
    throw new EnvelopeBoundaryGateNotWiredError(
      `[kernel-bootstrap] command-service structural boundary gate self-check failed — ` +
        `expected decision.kind="REFUSE" refusal.code="${STRUCTURAL_REJECTION_CODE}" with the executor never run, ` +
        `got decision.kind=${outcome.decision.kind} code=${JSON.stringify(code)} executed=${executed}. ` +
        `The isStructurallyMalformed gate in with-adjudicate.ts (@ibatexas/domain) appears to be unwired (FE-T04).`,
    )
  }
}

// ── Capability guard-ref boot assertion (FE-T19) ─────────────────────────────
//
// `@ibatexas/catalog` authors a per-capability
// `CapabilityDefinition` whose `guardRefs` declaratively NAME the Pack guards
// that apply to it. That data is checked against the LIVE `PolicyBundle`
// guard arrays by `assertGuardRefsResolve` — an independent materialization,
// not a re-derivation of the same source (FE-4.3) — but until something
// actually IMPORTS the registry, that check never runs in production: the
// package's own eager module-load self-check only fires for whichever
// process happens to import it. This assertion makes it fire unconditionally
// at API boot, matching the ticket's "break a guard-ref → BOOT fails"
// acceptance criterion rather than "→ some other process's test suite
// fails". `CAPABILITY_DEFINITIONS` is imported directly here (not merely
// side-effect-imported) specifically so this file — not some future,
// easy-to-forget consumer — is the one guaranteeing the check always runs.
//
// `defs` is dependency-injectable ONLY so a unit test can supply a
// deliberately-broken stand-in list and prove this assertion actually
// catches that regression — same rationale as `assertEnvelopeBoundaryGateWired`'s
// injectable `runner` (FE-T04). The boot call site always uses the default
// (the real, committed `CAPABILITY_DEFINITIONS`).

export async function assertCapabilityGuardRefsWired(
  defs: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS,
): Promise<void> {
  assertGuardRefsResolve(defs)
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
          "ops",
          "payments-pix",
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

  // 2. Assert Pack coverage: every pack-registered intent kind must resolve
  //    to a policy in one of the installed Packs. Otherwise the kernel would
  //    default-REFUSE legitimate traffic. Locally-adjudicated kinds (see
  //    PACK_REGISTERED_INTENT_KINDS) are excluded — they carry their bundle
  //    to `adjudicate()` directly and never hit the registry.
  try {
    const allPacks = [
      installedPacks.orders,
      installedPacks.reservations,
      installedPacks.whatsapp,
      installedPacks.customerOnboarding,
      installedPacks.payments,
      installedPacks.ops,
      installedPacks.paymentsPix,
    ]
    assertPackCoverage(allPacks, PACK_REGISTERED_INTENT_KINDS)
    server.log.info(
      {
        event: "kernel.bootstrap.pack_coverage_validated",
        knownIntentCount: KNOWN_INTENT_KINDS.size,
        packRegisteredCount: PACK_REGISTERED_INTENT_KINDS.size,
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

  // 4. FE-T04 — assert the isIntentEnvelope structural boundary gate is
  //    actually wired on the customer-intent-gateway live path. Fail CLOSED:
  //    a silently-removed gate call must never boot green.
  try {
    await assertEnvelopeBoundaryGateWired()
    server.log.info(
      { event: "kernel.bootstrap.envelope_boundary_gate_wired" },
      "[kernel-bootstrap] envelope structural boundary gate verified",
    )
  } catch (err) {
    if (err instanceof EnvelopeBoundaryGateNotWiredError) {
      server.log.fatal(
        { err },
        "[kernel-bootstrap] envelope boundary gate self-check failed — refusing to boot",
      )
    }
    throw err
  }

  // 5. FE-T04 — same self-check, on the OTHER convergence point: the
  //    command-service chokepoint (`withAdjudicate`, @ibatexas/domain) every
  //    ops/admin/subscriber/job/LLM-tool mutation flows through.
  try {
    await assertCommandServiceBoundaryGateWired()
    server.log.info(
      { event: "kernel.bootstrap.command_service_boundary_gate_wired" },
      "[kernel-bootstrap] command-service structural boundary gate verified",
    )
  } catch (err) {
    if (err instanceof EnvelopeBoundaryGateNotWiredError) {
      server.log.fatal(
        { err },
        "[kernel-bootstrap] command-service boundary gate self-check failed — refusing to boot",
      )
    }
    throw err
  }

  // 6. FE-T19 — assert every authored CapabilityDefinition guard-ref
  //    resolves to a real, live guard on the just-installed Packs'
  //    PolicyBundles. Fail CLOSED: a guard renamed, removed, or moved to a
  //    different phase without updating the registry must never boot green.
  try {
    await assertCapabilityGuardRefsWired()
    server.log.info(
      { event: "kernel.bootstrap.capability_guard_refs_resolved" },
      "[kernel-bootstrap] capability-definition guard-refs resolved",
    )
  } catch (err) {
    if (err instanceof GuardRefResolutionError) {
      server.log.fatal(
        { err },
        "[kernel-bootstrap] capability-definition guard-ref resolution failed — refusing to boot",
      )
    }
    throw err
  }

  // 7. Start the defer-pending gauge poll (W3-5). Real kernel behavior;
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
