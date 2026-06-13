// T2-6a acceptance — bootstrapClaustrum DI seams + full reset hook.
//
// The property under test: TWO SEQUENTIAL `bootstrapClaustrum()` calls in ONE
// vitest process (with `resetClaustrumForTests()` between) do not
// cross-contaminate —
//
//   - distinct Conductor instances (the singleton is really cleared);
//   - no leaked pool handles (the bootstrap-OWNED pg Pool's `end()` is called
//     by the reset; an INJECTED pool is caller-owned and survives the reset);
//   - audit-sink DI is reset (post-reset `getAuditSink()` fail-closes) and
//     RE-WIRED by the second bootstrap (`bootstrapAuditSinkDI` re-runs);
//   - the global kernel MetricsSink is unset via `_resetMetricsSink()` (the
//     upstream @internal test hook — the only unset path `@adjudicate/core`
//     exposes) and freshly reinstalled by the second bootstrap.
//
// Both bootstraps inject a scripted ModelProvider, so the Anthropic SDK
// client is never constructed — zero token cost by construction (the
// substrate T2-6b's content-keyed scripted provider builds on).
//
// Real infra (postgres testcontainer with audit migrations + redis
// testcontainer) because `bootstrapClaustrum()` probes `intent_audit`
// (table/partitions/record_version CHECK) and connects the execution ledger
// at boot — exactly the state a mock cannot certify. Harness:
// helpers/claustrum-bootstrap-harness.ts.
//
// Tests are ORDERED and share suite state on purpose: the sequence
// bootstrap #1 → reset → bootstrap #2 IS the acceptance property.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import {
  CompletionError,
  type Conductor,
  type ModelProvider,
} from "@claustrum/core";
import { hasMetricsSink, type MetricsSink } from "@adjudicate/core/kernel";
import type { AuditSink } from "@adjudicate/core";
import { __auditSinkInitialized, getAuditSink } from "@ibatexas/audit-sink";
import { closeRedisClient } from "@ibatexas/tools";
import {
  bootstrapClaustrum,
  getClaustrumPgPoolForTests,
  getConductor,
  resetClaustrumForTests,
} from "../claustrum-bootstrap.js";
import {
  RUN_BOOTSTRAP_HARNESS,
  setupClaustrumBootstrapHarness,
  type ClaustrumBootstrapTestHarness,
} from "./helpers/claustrum-bootstrap-harness.js";

// ── Scripted doubles ─────────────────────────────────────────────────────────

/**
 * Bootstrap-level scripted ModelProvider: implements the full port
 * (complete + stream + embed) but refuses every call — NO turn runs in this
 * suite, so any invocation is a test bug. T2-6b replaces this with the
 * content-keyed fixture provider.
 */
function scriptedModelProvider(label: string): ModelProvider {
  const refuse = (method: string): never => {
    throw new CompletionError(
      "not_implemented",
      `scripted provider '${label}': ${method}() must not be called in a bootstrap-level test`,
    );
  };
  return {
    async complete() {
      return refuse("complete");
    },
    stream() {
      return refuse("stream");
    },
    async embed() {
      return refuse("embed");
    },
  };
}

function stubMetricsSink(): MetricsSink {
  return {
    recordLedgerOp() {
      /* no-op */
    },
    recordDecision() {
      /* no-op */
    },
    recordRefusal() {
      /* no-op */
    },
    recordSinkFailure() {
      /* no-op */
    },
    recordShadowDivergence() {
      /* no-op (always-on kernel; method present to quiet the install warn) */
    },
  };
}

const stubAuditSink: AuditSink = {
  async emit() {
    /* injected-seam test — nothing is adjudicated in this suite */
  },
};

// ── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_BOOTSTRAP_HARNESS)(
  "bootstrapClaustrum DI + full reset (T2-6a)",
  () => {
    let harness: ClaustrumBootstrapTestHarness;
    let firstConductor: Conductor;
    let firstPool: pg.Pool;

    beforeAll(async () => {
      harness = await setupClaustrumBootstrapHarness();
    }, 300_000);

    afterAll(async () => {
      // Belt-and-braces: end any pool a failed assertion left behind.
      await resetClaustrumForTests().catch(() => undefined);
      // Close the shared @ibatexas/tools Redis singleton BEFORE the container
      // stops so the client does not reconnect-spin against a dead port.
      await closeRedisClient().catch(() => undefined);
      await harness?.teardown();
    }, 60_000);

    it("bootstrap #1: composes a conductor from injected scripted ModelProvider; zero-arg re-call returns the warm singleton", async () => {
      firstConductor = await bootstrapClaustrum({
        modelProvider: scriptedModelProvider("first"),
      });
      expect(getConductor()).toBe(firstConductor);
      // Production double-init parity (index.ts): warm singleton wins.
      await expect(bootstrapClaustrum()).resolves.toBe(firstConductor);

      const pool = getClaustrumPgPoolForTests();
      expect(pool).not.toBeNull();
      firstPool = pool as pg.Pool;
      expect(firstPool.ended).toBe(false);

      // Boot side-effects present: audit-sink leaf DI wired (bootstrapAuditSinkDI
      // ran), kernel MetricsSink installed.
      expect(__auditSinkInitialized()).toBe(true);
      expect(() => getAuditSink()).not.toThrow();
      expect(hasMetricsSink()).toBe(true);
    }, 60_000);

    it("full reset: conductor cleared, owned pool ended, audit-sink DI fail-closed, metrics sink unset", async () => {
      const endSpy = vi.spyOn(firstPool, "end");

      const report = await resetClaustrumForTests();
      expect(report).toEqual({
        conductorCleared: true,
        pgPoolEnded: true,
        auditSinkReset: true,
        metricsSinkReset: true,
      });

      // No leaked pool handles: end() called, pool reports ended.
      expect(endSpy).toHaveBeenCalledTimes(1);
      expect(firstPool.ended).toBe(true);
      expect(getClaustrumPgPoolForTests()).toBeNull();

      // Singleton cleared — fail-closed again.
      expect(() => getConductor()).toThrow(/not initialized/);

      // Audit-sink leaf DI cleared — getAuditSink() fail-closes until rewired.
      expect(__auditSinkInitialized()).toBe(false);
      expect(() => getAuditSink()).toThrow(/__setAuditSinkDependencies/);

      // Kernel MetricsSink unset (the documented _resetMetricsSink leg).
      expect(hasMetricsSink()).toBe(false);
    });

    it("bootstrap #2 in the same process: distinct conductor, fresh live pool, audit sink re-wired, metrics sink reinstalled", async () => {
      const secondConductor = await bootstrapClaustrum({
        modelProvider: scriptedModelProvider("second"),
      });

      // Distinct instances — no cross-contamination from bootstrap #1.
      expect(secondConductor).not.toBe(firstConductor);
      expect(getConductor()).toBe(secondConductor);

      // Fresh OWNED pool, live (not the ended pool from #1).
      const pool2 = getClaustrumPgPoolForTests();
      expect(pool2).not.toBeNull();
      expect(pool2).not.toBe(firstPool);
      expect((pool2 as pg.Pool).ended).toBe(false);
      const probe = await (pool2 as pg.Pool).query("SELECT 1 AS ok");
      expect(probe.rows[0]?.ok).toBe(1);

      // Audit-sink leaf DI re-wired by the second bootstrap.
      expect(__auditSinkInitialized()).toBe(true);
      expect(() => getAuditSink()).not.toThrow();

      // Fresh MetricsSink installed (hasMetricsSink() was false post-reset).
      expect(hasMetricsSink()).toBe(true);

      // Close out the sequence so the next test starts clean.
      const report = await resetClaustrumForTests();
      expect(report.pgPoolEnded).toBe(true);
      expect((pool2 as pg.Pool).ended).toBe(true);
    }, 60_000);

    it("injected seams: caller-owned pgPool survives reset; injected auditSink bypasses the leaf DI; injected metricsSink installs", async () => {
      const callerPool = new pg.Pool({
        connectionString: harness.pgUrl,
        max: 2,
      });
      try {
        await bootstrapClaustrum({
          modelProvider: scriptedModelProvider("third"),
          pgPool: callerPool,
          auditSink: stubAuditSink,
          metricsSink: stubMetricsSink(),
        });

        expect(getClaustrumPgPoolForTests()).toBe(callerPool);
        // Injected audit sink → bootstrapAuditSinkDI skipped; the leaf DI is
        // untouched (still cleared from the previous test's reset).
        expect(__auditSinkInitialized()).toBe(false);
        // Injected metrics sink installed unconditionally.
        expect(hasMetricsSink()).toBe(true);

        const report = await resetClaustrumForTests();
        // Caller-owned pool: reset does NOT end it.
        expect(report.pgPoolEnded).toBe(false);
        expect(callerPool.ended).toBe(false);
        const probe = await callerPool.query("SELECT 1 AS ok");
        expect(probe.rows[0]?.ok).toBe(1);
      } finally {
        await callerPool.end().catch(() => undefined);
      }
    }, 60_000);

    it("test-only gate: reset + pool accessor refuse outside NODE_ENV=test / IBX_TEST_FINGERPRINT", async () => {
      const savedNodeEnv = process.env.NODE_ENV;
      const savedFingerprint = process.env.IBX_TEST_FINGERPRINT;
      try {
        process.env.NODE_ENV = "production";
        delete process.env.IBX_TEST_FINGERPRINT;

        await expect(resetClaustrumForTests()).rejects.toThrow(/test-only/);
        expect(() => getClaustrumPgPoolForTests()).toThrow(/test-only/);

        // The D-010 test-profile fingerprint alone re-enables the surfaces
        // (the live test stack runs prod-shaped NODE_ENV with the fingerprint).
        process.env.IBX_TEST_FINGERPRINT = "t2-6a-gate-probe";
        await expect(resetClaustrumForTests()).resolves.toMatchObject({
          // Nothing was bootstrapped since the last reset — a clean no-op.
          conductorCleared: false,
          pgPoolEnded: false,
        });
      } finally {
        if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = savedNodeEnv;
        if (savedFingerprint === undefined)
          delete process.env.IBX_TEST_FINGERPRINT;
        else process.env.IBX_TEST_FINGERPRINT = savedFingerprint;
      }
    });
  },
);
