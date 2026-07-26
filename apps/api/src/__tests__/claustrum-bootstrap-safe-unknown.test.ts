// BKL-078 D5 (customer half) — boot-level regression guard that the CUSTOMER
// conductor's responder is composed WITH the safeUnknown gate when
// ENABLE_CLAIMS_PIPELINE is ON, and WITHOUT it when OFF. Mirrors the BKL-101
// claims-seam boot guard (claustrum-bootstrap-claims-seams.test.ts): it boots the
// REAL bootstrapClaustrum on the shared testcontainers harness, but spies
// createIbatexasResponder (keeping every other responder export real) to read the
// deps the genuine boot handed the customer responder.
//
// The ops-plane half of D5 ("ops NEVER wires it") is DISSOLVED by LE2 Implementation
// Decision 6 — the ops conductor now composes the SAME gate. Its replacement pin is
// ops/__tests__/ops-claims-convergence.test.ts (composition, no infra) plus the
// turn-seam proof in ops/__tests__/ops-store-open-claims.e2e.test.ts. This file keeps
// the CUSTOMER half unchanged: the gate is still flag-gated and still absent when OFF.
//
// Zero Anthropic tokens: a refuse-all scripted ModelProvider means the SDK client
// is never built and no turn runs — the dep is asserted at COMPOSITION.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CompletionError, type ModelProvider } from "@claustrum/core";
import { closeRedisClient } from "@ibatexas/tools";
import {
  bootstrapClaustrum,
  resetClaustrumForTests,
} from "../claustrum-bootstrap.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";
import {
  RUN_BOOTSTRAP_HARNESS,
  setupClaustrumBootstrapHarness,
  type ClaustrumBootstrapTestHarness,
  TEST_EXTERNAL_REFERENCE_PROBES,
} from "./helpers/claustrum-bootstrap-harness.js";

// Spy createIbatexasResponder; keep every other export of the module REAL. The
// customer conductor is the FIRST (and, with IBX_AGENTS_ENABLED unset, only)
// responder built at boot — composed before the agent-plane block — so calls[0] is
// the customer responder's deps. A stub responder is sufficient: no turn runs.
const { createIbatexasResponderSpy } = vi.hoisted(() => ({
  createIbatexasResponderSpy: vi.fn((_deps: unknown) => ({
    respond: async () => ({ text: "" }),
  })),
}));
vi.mock("../claustrum/ibatexas-responder.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../claustrum/ibatexas-responder.js")>();
  return { ...actual, createIbatexasResponder: createIbatexasResponderSpy };
});

function scriptedModelProvider(label: string): ModelProvider {
  const refuse = (method: string): never => {
    throw new CompletionError(
      "not_implemented",
      `scripted provider '${label}': ${method}() must not be called in the safeUnknown boot test`,
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

/** Boot the REAL bootstrapClaustrum with the flag set to `value` (or unset when
 *  undefined), return the deps the customer responder was composed with, then reset
 *  the singleton and restore the flag. */
async function customerResponderDeps(
  value: string | undefined,
  label: string,
): Promise<Record<string, unknown>> {
  const saved = process.env[CLAIMS_PIPELINE_ENABLED_ENV];
  if (value === undefined) delete process.env[CLAIMS_PIPELINE_ENABLED_ENV];
  else process.env[CLAIMS_PIPELINE_ENABLED_ENV] = value;
  createIbatexasResponderSpy.mockClear();
  try {
    await bootstrapClaustrum({
      modelProvider: scriptedModelProvider(label),
      externalReferenceProbes: TEST_EXTERNAL_REFERENCE_PROBES,
    });
    expect(createIbatexasResponderSpy).toHaveBeenCalled();
    return createIbatexasResponderSpy.mock.calls[0]![0] as Record<string, unknown>;
  } finally {
    await resetClaustrumForTests().catch(() => undefined);
    if (saved === undefined) delete process.env[CLAIMS_PIPELINE_ENABLED_ENV];
    else process.env[CLAIMS_PIPELINE_ENABLED_ENV] = saved;
  }
}

describe.skipIf(!RUN_BOOTSTRAP_HARNESS)(
  "bootstrapClaustrum — customer responder safeUnknown wiring (BKL-078 D5)",
  () => {
    let harness: ClaustrumBootstrapTestHarness;

    beforeAll(async () => {
      harness = await setupClaustrumBootstrapHarness();
    }, 300_000);

    afterAll(async () => {
      await resetClaustrumForTests().catch(() => undefined);
      await closeRedisClient().catch(() => undefined);
      await harness?.teardown();
    }, 60_000);

    it("flag ON: the customer responder is composed WITH the safeUnknown gate", async () => {
      const deps = await customerResponderDeps("true", "flag-on");
      expect(deps).toHaveProperty("safeUnknown");
      const safeUnknown = deps.safeUnknown as {
        gate?: unknown;
        render?: unknown;
      };
      expect(typeof safeUnknown.gate).toBe("function");
      expect(typeof safeUnknown.render).toBe("function");
      // The gate is the real question-shape discriminator.
      expect((safeUnknown.gate as (t: string) => boolean)("vocês têm sushi?")).toBe(
        true,
      );
      expect((safeUnknown.gate as (t: string) => boolean)("oi, tudo bem?")).toBe(
        false,
      );
      // The real wired render: open → the proposition-free SAFE_UNKNOWN text;
      // closed → the disclosure is appended ONLY when the degraded question is about
      // ordering/hours (⑥ — relevance-gated so it is not unsolicited on an unrelated
      // question).
      const render = safeUnknown.render as (s: unknown, t: string) => string;
      expect(render(undefined, "posso fazer um pedido?")).toContain(
        "Não localizei essa informação",
      );
      const closedOrder = render(
        { isClosed: true, nextOpenDay: "amanhã" },
        "posso fazer um pedido?",
      );
      expect(closedOrder).toContain("Não localizei essa informação");
      expect(closedOrder).toContain("fechados");
      // Topically-unrelated question while closed → NO unsolicited pickup offer.
      const closedUnrelated = render(
        { isClosed: true, nextOpenDay: "amanhã" },
        "vocês têm estacionamento?",
      );
      expect(closedUnrelated).not.toContain("fechados");
    }, 60_000);

    it("flag OFF (unset): the customer responder has NO safeUnknown dep (byte-identical)", async () => {
      const deps = await customerResponderDeps(undefined, "flag-off");
      expect("safeUnknown" in deps).toBe(false);
    }, 60_000);

    it("flag literal non-'true' ('1'): treated as OFF — no safeUnknown dep", async () => {
      const deps = await customerResponderDeps("1", "flag-not-true");
      expect("safeUnknown" in deps).toBe(false);
    }, 60_000);
  },
);
