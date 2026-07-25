// BKL-078 D5 (customer half) — boot-level regression guard that the CUSTOMER
// conductor's responder is composed WITH the safeUnknown gate when
// ENABLE_CLAIMS_PIPELINE is ON, and WITHOUT it when OFF. Mirrors the BKL-101
// claims-seam boot guard (claustrum-bootstrap-claims-seams.test.ts): it boots the
// REAL bootstrapClaustrum on the shared testcontainers harness, but spies
// createIbatexasResponder (keeping every other responder export real) to read the
// deps the genuine boot handed the customer responder.
//
// BKL-230 rides the SAME captured deps for the third layer of the checkout-render
// proof: the production boot's `readAnswer.renderAction` is not merely asserted to
// EXIST, it is INVOKED with a real committed-checkout dispatch and must return the
// deterministic PIX line. That closes the wiring link behaviourally (the LE2-002
// dead-feature class is an unproven wiring link, and a source-text regex proves
// only that a line of code is present, not that it renders).
//
// The ops-plane half of D5 (ops NEVER wires it) is pinned cheaply, without infra,
// in ops/__tests__/ops-conductor-safe-unknown.test.ts.
//
// Zero Anthropic tokens: a refuse-all scripted ModelProvider means the SDK client
// is never built and no turn runs — the dep is asserted at COMPOSITION.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    await bootstrapClaustrum({ modelProvider: scriptedModelProvider(label) });
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

    // ── BKL-230 layer 3 — the checkout render's WIRING link, proved behaviourally ──
    //
    // Layers 1 and 2 (the unit matrix, and the respond() short-circuit test in
    // claustrum/__tests__/checkout-action-render.turn-seam.test.ts) both supply
    // their own `readAnswer`. Only this test reads the one the REAL boot composed,
    // so it is the only place a silent unwiring of `renderAction` would surface.
    // It INVOKES that captured function rather than asserting its presence: a
    // present-but-broken wiring is exactly the LE2-002 dead-feature class.
    it("BKL-230: the boot-composed readAnswer.renderAction renders the PIX line from a committed checkout", async () => {
      const deps = await customerResponderDeps(undefined, "bkl230-render-action");
      const readAnswer = deps.readAnswer as {
        renderAction?: (acted: unknown, turnId: string) => string | undefined;
      };
      expect(typeof readAnswer?.renderAction).toBe("function");
      const renderAction = readAnswer.renderAction!;

      // A committed checkout whose tool PROVED success (the shape @claustrum's
      // dispatcher builds: `executed` + the executor's own return as `result`).
      const pixLine = renderAction(
        {
          kind: "executed",
          envelope: {
            kind: "order.checkout.create",
            payload: { cartId: "cart_1", paymentMethod: "pix" },
          },
          result: { success: true, paymentMethod: "pix", orderId: "pi_3QxyzABC123" },
        },
        "turn-boot-1",
      );
      expect(pixLine).toBe(
        "Seu código PIX foi gerado! O pedido será confirmado assim que o pagamento for aprovado.",
      );
      // The Stripe PaymentIntent id is never voiced as an order number.
      expect(pixLine).not.toContain("pi_");

      // …and the truthfulness gate is live through the SAME boot-composed wiring:
      // a checkout that FAILED in the tool (a `success:false` RETURN, which the
      // dispatcher still classifies `executed`) renders nothing.
      expect(
        renderAction(
          {
            kind: "executed",
            envelope: { kind: "order.checkout.create", payload: { cartId: "cart_1" } },
            result: {
              success: false,
              paymentMethod: "pix",
              message: "Nome e email são obrigatórios para pagamento PIX.",
            },
          },
          "turn-boot-2",
        ),
      ).toBeUndefined();
    }, 60_000);
  },
);

// ── Bootstrap wiring, static (runs even when containers are skipped) ───────────
//
// The behavioural proof above is the primary gate, but it lives behind
// RUN_BOOTSTRAP_HARNESS (default ON, opt-out via IBX_SKIP_REAL_POSTGRES/REDIS). This
// source-level assertion — the session-lock-injection.test.ts idiom — keeps the
// BKL-230 wiring link pinned on a container-skipped run too, so an unwiring can
// never pass silently in BOTH modes at once.
describe("claustrum-bootstrap wires the customer action render (BKL-215/BKL-230)", () => {
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../claustrum-bootstrap.ts"),
    "utf8",
  );

  it("passes renderCustomerActionAnswer as readAnswer.renderAction to the customer responder", () => {
    expect(source).toMatch(
      /renderAction:\s*\(acted[^)]*\)\s*=>\s*\n?\s*renderCustomerActionAnswer\(acted\)/,
    );
  });

  it("imports renderCustomerActionAnswer from the render module", () => {
    expect(source).toMatch(
      /renderCustomerActionAnswer[\s\S]{0,120}from "\.\/claustrum\/customer-action-render\.js"/,
    );
  });
});
