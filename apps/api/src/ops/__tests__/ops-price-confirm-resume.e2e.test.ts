// ops-price-confirm-resume — the NEW-004 crown-jewel proof: price-change-by-
// message driven END-TO-END through composeOpsConductor + a full handleTurn
// against the REAL composed policy router + REAL audited kernel
// (adjudicateAndAudit) with a STATEFUL session store + the REAL OpsSystemChannel
// matchToParked driver. No DB/network — the model, the pricing reads, and the
// Medusa price egress are fakes/spies.
//
// The fake-model + composed-router machinery is the SHARED WS9 harness
// (./ops-e2e-harness.ts); this file supplies the price-specific resume projection
// (buildOpsPriceResumeState) + resolver reads + tool spies, and asserts both the
// egress AND the KERNEL facts (the captured AuditRecord) via the harness sink.
//
// Proves the whole confirm-gated flow:
//   - OWNER "muda o preço da picanha pra 95": NAME resolved → pricing projected
//     → UNTRUSTED taint CONFIRM overlay → REQUEST_CONFIRMATION → PARKED (asserted
//     in the session store) → the reply carries the product name + old→new BRL.
//   - "sim, confirma" → matchToParked confirm → resume (re-project the pricing
//     state via buildOpsPriceResumeState, re-adjudicate the parked envelope, the
//     receipt flips CONFIRM→EXECUTE) → medusaAdjudicated called ONCE with the
//     EXACT price egress (every BRL variant → 95 reais); the park is cleared.
//   - "não" → deny → unparked, the egress NEVER runs.
//   - ATTENDANT → REFUSE staff_role_violation; nothing parks.
//   - an absurd price → REFUSE (out_of_range); nothing parks.

import { describe, expect, it, vi } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";
import {
  createOpsResolver,
  buildOpsPriceResumeState,
  type OpsResolverPriceProduct,
} from "../ops-resolver.js";
import {
  buildOpsTools,
  composeOpsDeps,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulSession,
  runOpsTurn,
  scriptedModel,
  type ScriptedToolCall,
  type StaffRole,
} from "./ops-e2e-harness.js";

/** A single-variant, uniform-price product (the pricing snapshot the resolver +
 *  resume project, and whose variant the executor re-prices). Current R$89,00. */
const PICANHA: OpsResolverPriceProduct = {
  id: "prod_picanha",
  status: "published",
  name: "Picanha",
  currentPriceCentavos: 8900,
  divergentVariantPrices: false,
};

/** pricing-by-id used by BOTH the plan-stage lookup and the resume re-projection. */
const pricingById = (id: string): OpsResolverPriceProduct | null =>
  id === "prod_picanha" ? PICANHA : null;

function buildHarness(opts: { toolCalls: ReadonlyArray<ScriptedToolCall> }) {
  const sink = makeCapturingAuditSink();
  const session = makeStatefulSession();
  const { tools, spies } = buildOpsTools(
    {
      medusaAdjudicated: vi.fn(async () => ({ product: { id: "prod_picanha" } })),
      readProductBrlVariantIds: vi.fn(async (id: string) =>
        id === "prod_picanha" ? ["var_picanha"] : null,
      ),
    },
    sink,
  );
  // The production resume path (buildAdjudicator.resume → enrichResumeState) for an
  // admin price change re-projects via buildOpsPriceResumeState: FRESH pricing read
  // by the parked (rewritten) productId + receipt.
  const adjudicator = makeAuditedAdjudicator({
    sink,
    projectResumeState: (env: IntentEnvelope) => {
      const payload = (env.payload ?? {}) as Record<string, unknown>;
      const productId =
        typeof payload.productId === "string" ? payload.productId : "";
      const staffId = env.actor.sessionId.slice("admin:".length);
      return buildOpsPriceResumeState(
        productId === "" ? null : pricingById(productId),
        { staffId, tenantId: "ibatexas" },
      );
    },
  });
  const deps = composeOpsDeps({
    adjudicator,
    session,
    tools,
    model: scriptedModel(opts.toolCalls),
    buildResolver: (staffId: string) =>
      createOpsResolver({
        staffId,
        tenantId: "ibatexas",
        lookupProduct: async () => null,
        lookupOrder: async () => null,
        // Direct id pricing lookup by the resolved id hits; the raw name misses.
        lookupProductPricing: async (id) => pricingById(id),
        // The persona fills productId with the NAME; resolve it to prod_picanha.
        listProductsByName: async () => [
          { id: "prod_picanha", title: "Picanha", status: "published" },
        ],
      }),
  });
  return { deps, session, spies, sink };
}

/** Positional adapter so the scenario bodies stay behaviour-identical. */
const runTurn = (
  deps: ReturnType<typeof buildHarness>["deps"],
  role: StaffRole,
  staffId: string,
  text: string,
) => runOpsTurn(deps, { role, staffId, text });

const PRICE_CALL = (productRef: string, priceCentavos: number): ScriptedToolCall => ({
  id: "tc-price",
  name: "express_intent",
  input: {
    capability: "product.price.set",
    payload: { productId: productRef, priceCentavos, reason: "reajuste" },
  },
});

describe("NEW-004 price-change-by-message — end-to-end park → confirm-resume → EXECUTE", () => {
  it("OWNER: name resolved → CONFIRM (name + old→new), then 'sim' EXECUTEs the egress ONCE", async () => {
    const { deps, session, spies, sink } = buildHarness({
      toolCalls: [PRICE_CALL("picanha", 9500)],
    });
    const sessionId = "system:staff:owner1";

    // Turn 1 — the price change parks for confirmation.
    const t1 = await runTurn(deps, "OWNER", "owner1", "muda o preço da picanha pra 95");
    expect(t1.decision.kind).toBe("REQUEST_CONFIRMATION");
    const parks = session.parksFor(sessionId);
    expect(parks).toHaveLength(1);
    // The reply states the product name + old→new BRL (the staff confirms numbers).
    expect(t1.response).toContain("Picanha");
    expect(t1.response).toContain("R$ 89,00");
    expect(t1.response).toContain("R$ 95,00");
    // The parked envelope carries the RESOLVED productId (name → id rewrite).
    expect(
      (parks[0]!.envelope.payload as { productId: string }).productId,
    ).toBe("prod_picanha");
    // No egress yet.
    expect(spies.medusaAdjudicated).not.toHaveBeenCalled();
    // KERNEL FACT — the audited CONFIRM record names the kind + OWNER identity.
    const confirmRec = sink.lastDecision("REQUEST_CONFIRMATION");
    expect(confirmRec).toBeDefined();
    expect(String(confirmRec!.envelope.kind)).toBe("product.price.set");
    expect(confirmRec!.envelope.actor.role).toBe("OWNER");

    // Turn 2 — "sim, confirma" resumes → EXECUTE → the egress runs ONCE.
    const t2 = await runTurn(deps, "OWNER", "owner1", "sim, confirma");
    expect(t2.decision.kind).toBe("EXECUTE");
    expect(spies.medusaAdjudicated).toHaveBeenCalledTimes(1);
    const [egressArgs] = spies.medusaAdjudicated.mock.calls[0]!;
    // The EXACT price egress: the resolved product, every BRL variant → 95 reais.
    expect(egressArgs.scope).toBe("admin");
    expect(egressArgs.method).toBe("POST");
    expect(egressArgs.path).toBe("/admin/products/prod_picanha");
    expect(egressArgs.intentKind).toBe("medusa.admin.product.update");
    expect(egressArgs.payload).toEqual({
      variants: [
        { id: "var_picanha", prices: [{ currency_code: "brl", amount: 95 }] },
      ],
    });
    // The park was cleared.
    expect(session.parksFor(sessionId)).toHaveLength(0);
    // KERNEL FACT — the resumed EXECUTE carries the confirmation:received basis.
    expect(sink.lastDecision("EXECUTE")).toBeDefined();
    expect(sink.hasBasis("product.price.set", "received")).toBe(true);
  });

  it("'não' after a park → deny → unparked, the egress NEVER runs", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [PRICE_CALL("picanha", 9500)],
    });
    const sessionId = "system:staff:owner2";
    await runTurn(deps, "OWNER", "owner2", "muda o preço da picanha pra 95");
    expect(session.parksFor(sessionId)).toHaveLength(1);
    const t2 = await runTurn(deps, "OWNER", "owner2", "não, deixa como está");
    expect(t2.decision.kind).not.toBe("EXECUTE");
    expect(spies.medusaAdjudicated).not.toHaveBeenCalled();
    expect(session.parksFor(sessionId)).toHaveLength(0);
  });

  it("ATTENDANT → REFUSE staff_role_violation; nothing parks; no egress", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [PRICE_CALL("picanha", 9500)],
    });
    const t = await runTurn(deps, "ATTENDANT", "att1", "muda o preço da picanha pra 95");
    expect(t.decision.kind).toBe("REFUSE");
    if (t.decision.kind === "REFUSE") {
      expect(t.decision.refusal.code).toBe("staff_role_violation");
    }
    expect(session.parksFor("system:staff:att1")).toHaveLength(0);
    expect(spies.medusaAdjudicated).not.toHaveBeenCalled();
  });

  it("absurd price (> R$100.000,00) → REFUSE out_of_range; nothing parks; no egress", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [PRICE_CALL("picanha", 10_000_001)],
    });
    const t = await runTurn(deps, "OWNER", "owner3", "muda o preço da picanha pra 100 mil e um centavos");
    expect(t.decision.kind).toBe("REFUSE");
    if (t.decision.kind === "REFUSE") {
      expect(t.decision.refusal.code).toBe("ops.price.out_of_range");
    }
    expect(session.parksFor("system:staff:owner3")).toHaveLength(0);
    expect(spies.medusaAdjudicated).not.toHaveBeenCalled();
  });
});
