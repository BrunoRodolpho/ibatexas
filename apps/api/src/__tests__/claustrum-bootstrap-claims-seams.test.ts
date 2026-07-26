// BKL-101 — boot-level regression guard for the customer conductor's claims-seam
// spread.
//
// The gap this closes: `buildClaimsSeams(flag ON)` returns the claims-runtime
// seams and `claims-pipeline.test.ts` proves that SHAPE; `live-agent-conductor.
// test.ts` proves the AGENT plane spreads them (BKL-003 / PR #187). But NOTHING
// proved the CUSTOMER (main) `bootstrapClaustrum` actually SPREADS those seams
// into its `createConductor({ ... , ...claimsSeams })` call
// (claustrum-bootstrap.ts). A future refactor of that monolithic composition
// root could silently drop the `...claimsSeams` spread and every test would still
// pass — the flag-ON customer claims path would go dark with no failing test.
// This suite makes that regression impossible to land quietly, in BOTH
// directions: seams present when the flag is ON, and NONE present when it is OFF.
//
// Technique (the proven PR #187 idiom): spy `createConductor` via `vi.mock`,
// keeping EVERY other `@claustrum/core` export real, and read the composed
// `ConductorOptions` the REAL `bootstrapClaustrum` produced. Booting the true
// composition root needs real infra BEFORE `createConductor` is reached
// (`assertAuditPostgresReady`, the Redis execution-ledger connect), so this rides
// the established `claustrum-bootstrap-harness` testcontainers (audit-migrated
// Postgres + Redis) exactly like `claustrum-bootstrap-reset.test.ts` — which CI
// runs (`RUN_BOOTSTRAP_HARNESS` default-on; the `docker info` gate in ci.yml).
// No composition-root refactor, no new infra mocks: this observes the genuine
// `...claimsSeams` spread in the real boot path.
//
// Zero Anthropic tokens by construction: an injected (scripted, refuse-all)
// ModelProvider means the SDK client is never built, and no turn runs here — the
// seams are asserted at COMPOSITION, not by driving a conversation.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CompletionError, type ModelProvider } from "@claustrum/core";
import { closeRedisClient } from "@ibatexas/tools";
import {
  bootstrapClaustrum,
  resetClaustrumForTests,
} from "../claustrum-bootstrap.js";
import {
  buildClaimsSeams,
  CLAIMS_PIPELINE_ENABLED_ENV,
} from "../claustrum/claims-pipeline.js";
import type { ClaimAwarePlannerPort } from "../claustrum/ibatexas-planner.js";
import {
  RUN_BOOTSTRAP_HARNESS,
  setupClaustrumBootstrapHarness,
  type ClaustrumBootstrapTestHarness,
  TEST_EXTERNAL_REFERENCE_PROBES,
} from "./helpers/claustrum-bootstrap-harness.js";

// createConductor-spy (PR #187 / BKL-003 idiom): keep every other
// `@claustrum/core` export REAL — replace ONLY `createConductor` with a spy that
// returns an inert conductor stub, so a test can inspect the composed
// `ConductorOptions` the REAL `bootstrapClaustrum` produced. `bootstrapClaustrum`
// never dereferences the returned conductor (`grep _conductor\.` → none), so the
// stub is sufficient for a boot to complete.
const { createConductorSpy } = vi.hoisted(() => ({
  createConductorSpy: vi.fn((_opts: unknown) => ({
    openCapsule: async () => ({}),
    closeCapsule: async () => {},
  })),
}));
vi.mock("@claustrum/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claustrum/core")>();
  return { ...actual, createConductor: createConductorSpy };
});

// The exact seam key set `buildClaimsSeams(ON)` produces — i.e. the keys the
// `...claimsSeams` spread MUST carry into the customer composition. Deriving it
// from `buildClaimsSeams` itself (not a hand-copied list) makes this guard
// AUTOMATICALLY cover a newly-added seam: add a 7th seam to `buildClaimsSeams`
// and the flag-ON assertion below requires the boot to spread it too, while the
// flag-OFF assertion requires its absence. A stub planner suffices — the seam
// factories only WRAP the planner at construction (no calls).
const SEAM_KEYS: readonly string[] = Object.keys(
  buildClaimsSeams({
    planner: {} as unknown as ClaimAwarePlannerPort,
    env: { [CLAIMS_PIPELINE_ENABLED_ENV]: "true" } as NodeJS.ProcessEnv,
    warn: () => {},
  }),
);

/**
 * Bootstrap-level scripted ModelProvider — implements the full port but refuses
 * every call: NO turn runs in this suite, so any invocation is a test bug.
 * Mirrors `claustrum-bootstrap-reset.test.ts`. (`resolveGroundingPort` probes
 * `embed()` at boot and fail-safes on the throw — a designed empty-retrieval
 * no-op, D-009 — so a refuse-all provider boots cleanly.)
 */
function scriptedModelProvider(label: string): ModelProvider {
  const refuse = (method: string): never => {
    throw new CompletionError(
      "not_implemented",
      `scripted provider '${label}': ${method}() must not be called in the claims-seams boot test`,
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

/**
 * The `ConductorOptions` the boot composed the CUSTOMER conductor with. The
 * customer conductor is the FIRST (and, with `IBX_AGENTS_ENABLED` unset, only)
 * `createConductor` call at boot — composed at claustrum-bootstrap.ts before the
 * agent-plane block — so `calls[0]` is always the customer composition.
 */
function customerConductorOptions(): Record<string, unknown> {
  expect(createConductorSpy).toHaveBeenCalled();
  return createConductorSpy.mock.calls[0]![0] as Record<string, unknown>;
}

/**
 * Boot the REAL `bootstrapClaustrum` with `ENABLE_CLAIMS_PIPELINE` set to
 * `value` (or unset when `undefined`), return the composed customer
 * `ConductorOptions`, then reset the singleton and restore the flag. Each boot is
 * independent — the singleton is cleared so the next boot recomposes (the
 * boot→reset→boot property `claustrum-bootstrap-reset.test.ts` certifies).
 */
async function bootWithClaimsFlag(
  value: string | undefined,
  label: string,
): Promise<Record<string, unknown>> {
  const saved = process.env[CLAIMS_PIPELINE_ENABLED_ENV];
  if (value === undefined) delete process.env[CLAIMS_PIPELINE_ENABLED_ENV];
  else process.env[CLAIMS_PIPELINE_ENABLED_ENV] = value;
  createConductorSpy.mockClear();
  try {
    await bootstrapClaustrum({
      modelProvider: scriptedModelProvider(label),
      externalReferenceProbes: TEST_EXTERNAL_REFERENCE_PROBES,
    });
    return customerConductorOptions();
  } finally {
    await resetClaustrumForTests().catch(() => undefined);
    if (saved === undefined) delete process.env[CLAIMS_PIPELINE_ENABLED_ENV];
    else process.env[CLAIMS_PIPELINE_ENABLED_ENV] = saved;
  }
}

describe.skipIf(!RUN_BOOTSTRAP_HARNESS)(
  "bootstrapClaustrum — customer conductor claims-seam spread (BKL-101)",
  () => {
    let harness: ClaustrumBootstrapTestHarness;

    beforeAll(async () => {
      harness = await setupClaustrumBootstrapHarness();
    }, 300_000);

    afterAll(async () => {
      // Belt-and-braces: clear any singleton a failed boot left, then close the
      // shared Redis client BEFORE the container stops (harness contract).
      await resetClaustrumForTests().catch(() => undefined);
      await closeRedisClient().catch(() => undefined);
      await harness?.teardown();
    }, 60_000);

    it("sanity: buildClaimsSeams(ON) yields exactly the eight documented claims seams", () => {
      // Anchors the derived SEAM_KEYS to the named contract — if a seam is
      // renamed/dropped in buildClaimsSeams, this fails loudly here first.
      expect([...SEAM_KEYS].sort()).toEqual(
        [
          "activeResourcesForTurn",
          "claimPlanner",
          "claimsKernel",
          "claimsKernelDepsForTurn",
          "claimsRenderer",
          // BKL-155/153 — the render-vs-draft precedence seam, PAIRED with claimsRenderer.
          "claimsRenderPrecedence",
          "investigator",
          // BKL-152-edge — the @claustrum/core 0.8.0 render-carrier seam (resolvedQueryDate).
          "renderCarriersForTurn",
        ].sort(),
      );
    });

    it("flag ON: the customer conductor is composed WITH every claims seam (guards the ...claimsSeams spread)", async () => {
      const opts = await bootWithClaimsFlag("true", "flag-on");
      // Every seam buildClaimsSeams(ON) produces reached the composition AND is a
      // live value (not merely a present-but-undefined key).
      for (const key of SEAM_KEYS) {
        expect(
          opts,
          `claims seam '${key}' is missing from the customer ConductorOptions`,
        ).toHaveProperty(key);
        expect(
          opts[key],
          `claims seam '${key}' is present but was not constructed`,
        ).toBeDefined();
      }
      // The four thesis-critical seams by name (readability / intent anchor).
      expect(opts.investigator).toBeDefined();
      expect(opts.claimPlanner).toBeDefined();
      expect(opts.claimsKernel).toBeDefined();
      expect(opts.claimsRenderer).toBeDefined();
    }, 60_000);

    it("flag OFF (unset): the customer conductor carries NONE of the claims seams (no-op spread, byte-identical)", async () => {
      const opts = await bootWithClaimsFlag(undefined, "flag-off");
      for (const key of SEAM_KEYS) {
        expect(
          key in opts,
          `claims seam '${key}' leaked into a flag-OFF composition`,
        ).toBe(false);
      }
    }, 60_000);

    it("flag literal non-'true' (e.g. '1'): treated as OFF — the exact-match flag contract holds through boot", async () => {
      const opts = await bootWithClaimsFlag("1", "flag-not-true");
      for (const key of SEAM_KEYS) {
        expect(
          key in opts,
          `claims seam '${key}' leaked when ENABLE_CLAIMS_PIPELINE='1'`,
        ).toBe(false);
      }
    }, 60_000);
  },
);
