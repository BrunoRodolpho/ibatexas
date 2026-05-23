// kernel-bootstrap.ts — wires `@adjudicate/core/kernel` into the API boot
// sequence. After this plugin runs, the kernel becomes addressable from
// Fastify: a `MetricsSink` slot is populated (stub for now; real PostHog +
// Sentry sink lands in task 05), `validateEnforceConfig(...)` audits
// `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` for typos, and (once task 08
// lands) the orders Pack is registered via `installPack(...)`.
//
// Investigation 06 (Runtime Config & Governance Plumbing) flagged that
// the kernel is "dormant by accident, not by design" — every framework
// hook exists in `@adjudicate/core/kernel` but no IbateXas startup site
// calls `installPack()`, `validateEnforceConfig()`, or
// `setMetricsSink()`. This plugin is the smallest cut that gives the
// rest of the migration a boot anchor to attach to.
//
// Scope of THIS file (task 01 of the adjudicate migration):
//   • Call `setMetricsSink(noopMetricsSink)` — install a stub so the
//     kernel's record* helpers have a target. Real PostHog/Sentry sink
//     in task 05 (see docs/adjudicate-migration/tasks/05-*).
//   • Call `validateEnforceConfig(knownIntents, env, warn)` — even with
//     an empty `knownIntents` set, this surfaces shadow/enforce config
//     typos as a structured warn line. Task 08+ supply the real intent
//     union via `KNOWN_INTENT_KINDS` from `@ibatexas/llm-provider`.
//   • Stub `installPack(...)` until `@ibatexas/pack-orders` exists
//     (task 08). The TODO below is the integration point.
//
// Out of scope for THIS file:
//   • LearningSink wiring (deferred to task 05/06).
//   • Kill-switch admin endpoint (deferred to task 07).
//   • Real Pack registration with `withBasisAudit` + conformance
//     assertion (deferred to task 08).

import {
  setMetricsSink,
  validateEnforceConfig,
  type MetricsSink,
} from "@adjudicate/core/kernel";
import type { FastifyInstance } from "fastify";

// ── Stub MetricsSink ────────────────────────────────────────────────────────
//
// TODO(task-05): replace with the real `MetricsSink` adapter that
// fans out to PostHog (`audit_kernel_shadow_diverged_*`,
// `audit_decision_*`, `audit_ledger_hit`) + Sentry breadcrumbs.
// `@adjudicate/core` exports `createConsoleMetricsSink()` for dev
// visibility, but we install a no-op here so test/CI runs don't
// pollute stdout. Verify the real sink against the event union in
// `apps/web/src/domains/analytics/events.ts:107-114`.
function createNoopMetricsSink(server: FastifyInstance): MetricsSink {
  // The pino logger is captured here so task 05 can swap the stub for
  // a logging sink without changing the call site if desired.
  const log = server.log;
  return {
    recordLedgerOp(event) {
      log.debug({ event }, "[kernel-bootstrap] recordLedgerOp (stub)");
    },
    recordDecision(event) {
      log.debug({ event }, "[kernel-bootstrap] recordDecision (stub)");
    },
    recordRefusal(event) {
      log.debug({ event }, "[kernel-bootstrap] recordRefusal (stub)");
    },
    recordSinkFailure(event) {
      log.debug({ event }, "[kernel-bootstrap] recordSinkFailure (stub)");
    },
    recordShadowDivergence(event) {
      log.debug({ event }, "[kernel-bootstrap] recordShadowDivergence (stub)");
    },
    recordResourceLimit(event) {
      log.debug({ event }, "[kernel-bootstrap] recordResourceLimit (stub)");
    },
  };
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
  return new Set<string>();
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function bootstrapKernel(server: FastifyInstance): Promise<void> {
  // 1. Install the MetricsSink slot. Per `@adjudicate/core/kernel/metrics.ts`,
  //    `setMetricsSink` also wires `setShadowTelemetrySink` so the four
  //    DivergenceClass routes share the same pipeline.
  const sink = createNoopMetricsSink(server);
  setMetricsSink(sink);

  // 2. TODO(task-08): installPack(ordersPack, { warn: server.log.warn.bind(server.log) })
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

  // 3. Validate enforce-config against the known intent set. Surfaces
  //    typos in `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE` as one-time
  //    structured warn lines via the pino logger AND records a sink
  //    failure with `errorClass: "enforce_config_typo"` (see
  //    `@adjudicate/core/kernel/enforce-config.ts:94-135`).
  const knownIntents = getKnownIntentKinds();
  validateEnforceConfig(knownIntents, process.env, (msg) => {
    server.log.warn({ msg }, "[kernel-bootstrap] enforce-config validation");
  });

  // 4. Two structured info lines so operators can verify the bootstrap
  //    fired at startup. Names match the docs/adjudicate-migration spec:
  //    `kernel.bootstrap.*`.
  server.log.info(
    { event: "kernel.bootstrap.pack_installed", pack: "noop-stub" },
    "[kernel-bootstrap] pack installed (stub — replace in task 08)",
  );
  server.log.info(
    {
      event: "kernel.bootstrap.enforce_config_validated",
      knownIntentCount: knownIntents.size,
    },
    "[kernel-bootstrap] enforce-config validated",
  );
}
