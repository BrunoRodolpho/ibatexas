// ops-special-confirm-resume — the SCN-114 crown-jewel proof: daily-special-by-
// message driven END-TO-END through composeOpsConductor + a full handleTurn
// against the REAL composed policy router + REAL audited kernel with a STATEFUL
// session store + the REAL OpsSystemChannel matchToParked driver. No DB/network —
// the model, the product reads, and the DailySpecial upsert service are fakes/spies.
//
// The fake-model + composed-router machinery is the SHARED WS9 harness
// (./ops-e2e-harness.ts); this file supplies the special-specific resume
// projection (buildOpsSpecialResumeState) + resolver reads + the upsert spies, and
// asserts both the WRITE and the KERNEL facts (the captured AuditRecord).
//
// Proves the whole confirm-gated flow:
//   - OWNER "o especial de hoje é feijoada por 45": NAME resolved → product
//     projected → date "hoje" resolved to a concrete YYYY-MM-DD → price "45" →
//     4500 centavos → UNTRUSTED CONFIRM overlay → REQUEST_CONFIRMATION → PARKED
//     (asserted in the session store) → the reply carries the product + R$.
//   - "sim, confirma" → matchToParked confirm → resume (re-project the special
//     state via buildOpsSpecialResumeState, re-adjudicate, CONFIRM→EXECUTE) →
//     dailySpecialSvc CREATEs the row ONCE with the RESOLVED id + integer centavos;
//     the park is cleared.
//   - an EXISTING row for the (product, day) → "sim" UPDATEs (upsert), never a
//     duplicate CREATE (the @@unique([medusaProductId,date]) constraint).
//   - "não" → deny → unparked, no write.
//   - ATTENDANT → REFUSE staff_role_violation; nothing parks; no write.
//   - a past date → REFUSE date_past; nothing parks; no write.

import { describe, expect, it, vi } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";
import {
  createOpsResolver,
  buildOpsSpecialResumeState,
  type OpsResolverSpecialProduct,
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

/** The product the resolver + resume project, and whose special the executor upserts. */
const FEIJOADA: OpsResolverSpecialProduct = {
  id: "prod_feijoada",
  status: "published",
  name: "Feijoada",
};

/** product-by-id used by BOTH the plan-stage lookup and the resume re-projection. */
const productById = (id: string): OpsResolverSpecialProduct | null =>
  id === "prod_feijoada" ? FEIJOADA : null;

function buildHarness(opts: {
  toolCalls: ReadonlyArray<ScriptedToolCall>;
  /** An existing DailySpecial row for the (product, day); absent ⇒ list empty (CREATE path). */
  existingRow?: { id: string; medusaProductId: string } | null;
}) {
  const sink = makeCapturingAuditSink();
  const session = makeStatefulSession();
  const { tools, spies } = buildOpsTools(
    {
      dailySpecialList: vi.fn(async () =>
        opts.existingRow ? [opts.existingRow] : [],
      ),
      dailySpecialCreate: vi.fn(async () => ({ id: "special_new" })),
      dailySpecialUpdate: vi.fn(async () => ({
        id: opts.existingRow?.id ?? "special_x",
      })),
    },
    sink,
  );
  // The production resume path (buildAdjudicator.resume → enrichResumeState) for an
  // admin daily-special re-projects via buildOpsSpecialResumeState: FRESH product
  // read by the parked (rewritten) productId + a FRESH today reading.
  const adjudicator = makeAuditedAdjudicator({
    sink,
    projectResumeState: (env: IntentEnvelope) => {
      const payload = (env.payload ?? {}) as Record<string, unknown>;
      const productId =
        typeof payload.productId === "string" ? payload.productId : "";
      const staffId = env.actor.sessionId.slice("admin:".length);
      return buildOpsSpecialResumeState(
        productId === "" ? null : productById(productId),
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
        // Direct id lookup by the resolved id hits; the raw name misses.
        lookupSpecialProduct: async (id) => productById(id),
        // The persona fills productId with the NAME; resolve it to prod_feijoada.
        listProductsByName: async () => [
          { id: "prod_feijoada", title: "Feijoada", status: "published" },
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

/** An express_intent call proposing menu.special.set (date defaults to "hoje"). */
const SPECIAL_CALL = (
  productRef: string,
  extra: Record<string, unknown>,
): ScriptedToolCall => ({
  id: "tc-special",
  name: "express_intent",
  input: {
    capability: "menu.special.set",
    payload: { productId: productRef, date: "hoje", ...extra },
  },
});

describe("SCN-114 daily-special-by-message — end-to-end park → confirm-resume → upsert", () => {
  it("OWNER: name resolved → CONFIRM (product + R$), then 'sim' CREATEs the special ONCE", async () => {
    const { deps, session, spies, sink } = buildHarness({
      toolCalls: [SPECIAL_CALL("feijoada", { promoPriceCentavos: 4500 })],
      existingRow: null,
    });
    const sessionId = "system:staff:owner1";

    // Turn 1 — the daily special parks for confirmation.
    const t1 = await runTurn(deps, "OWNER", "owner1", "o especial de hoje é feijoada por 45 reais");
    expect(t1.decision.kind).toBe("REQUEST_CONFIRMATION");
    const parks = session.parksFor(sessionId);
    expect(parks).toHaveLength(1);
    // The reply states the product + the promo price (the staff confirms specifics).
    expect(t1.response).toContain("Feijoada");
    expect(t1.response).toContain("R$ 45,00");
    // The parked envelope carries the RESOLVED productId (name → id rewrite).
    expect(
      (parks[0]!.envelope.payload as { productId: string }).productId,
    ).toBe("prod_feijoada");
    // No write yet.
    expect(spies.dailySpecialCreate).not.toHaveBeenCalled();
    // KERNEL FACT — the audited CONFIRM record names the kind + OWNER identity.
    const confirmRec = sink.lastDecision("REQUEST_CONFIRMATION");
    expect(confirmRec).toBeDefined();
    expect(String(confirmRec!.envelope.kind)).toBe("menu.special.set");
    expect(confirmRec!.envelope.actor.role).toBe("OWNER");

    // Turn 2 — "sim, confirma" resumes → EXECUTE → the upsert CREATEs ONCE.
    const t2 = await runTurn(deps, "OWNER", "owner1", "sim, confirma");
    expect(t2.decision.kind).toBe("EXECUTE");
    expect(spies.dailySpecialCreate).toHaveBeenCalledTimes(1);
    const createArgs = spies.dailySpecialCreate.mock.calls[0]![0] as {
      medusaProductId: string;
      date: string;
      promoPriceCentavos?: number;
    };
    // The write targets the RESOLVED id + integer centavos + a concrete date.
    expect(createArgs.medusaProductId).toBe("prod_feijoada");
    expect(createArgs.promoPriceCentavos).toBe(4500);
    expect(createArgs.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // No UPDATE (no existing row).
    expect(spies.dailySpecialUpdate).not.toHaveBeenCalled();
    // The park was cleared.
    expect(session.parksFor(sessionId)).toHaveLength(0);
    // KERNEL FACT — the resumed EXECUTE is audited.
    expect(sink.lastDecision("EXECUTE")).toBeDefined();
  });

  it("an EXISTING row for the day → 'sim' UPDATEs (upsert), never a duplicate CREATE", async () => {
    const { deps, spies } = buildHarness({
      toolCalls: [SPECIAL_CALL("feijoada", { promoPriceCentavos: 5000 })],
      existingRow: { id: "special_existing", medusaProductId: "prod_feijoada" },
    });
    await runTurn(deps, "OWNER", "owner5", "o especial de hoje é feijoada por 50");
    const t2 = await runTurn(deps, "OWNER", "owner5", "sim");
    expect(t2.decision.kind).toBe("EXECUTE");
    expect(spies.dailySpecialUpdate).toHaveBeenCalledTimes(1);
    const call = spies.dailySpecialUpdate.mock.calls[0]!;
    expect(call[0]).toBe("special_existing");
    const patch = call[1] as { promoPriceCentavos?: number; active?: boolean };
    expect(patch.promoPriceCentavos).toBe(5000);
    // Re-affirming a special (re)activates it.
    expect(patch.active).toBe(true);
    expect(spies.dailySpecialCreate).not.toHaveBeenCalled();
  });

  it("'não' after a park → deny → unparked, no write", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [SPECIAL_CALL("feijoada", { promoPriceCentavos: 4500 })],
    });
    const sessionId = "system:staff:owner2";
    await runTurn(deps, "OWNER", "owner2", "o especial de hoje é feijoada por 45");
    expect(session.parksFor(sessionId)).toHaveLength(1);
    const t2 = await runTurn(deps, "OWNER", "owner2", "não, deixa como está");
    expect(t2.decision.kind).not.toBe("EXECUTE");
    expect(spies.dailySpecialCreate).not.toHaveBeenCalled();
    expect(session.parksFor(sessionId)).toHaveLength(0);
  });

  it("ATTENDANT → REFUSE staff_role_violation; nothing parks; no write", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [SPECIAL_CALL("feijoada", { promoPriceCentavos: 4500 })],
    });
    const t = await runTurn(deps, "ATTENDANT", "att1", "o especial de hoje é feijoada por 45");
    expect(t.decision.kind).toBe("REFUSE");
    if (t.decision.kind === "REFUSE") {
      expect(t.decision.refusal.code).toBe("staff_role_violation");
    }
    expect(session.parksFor("system:staff:att1")).toHaveLength(0);
    expect(spies.dailySpecialCreate).not.toHaveBeenCalled();
  });

  it("a PAST date → REFUSE date_past; nothing parks; no write", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [
        SPECIAL_CALL("feijoada", { date: "2020-01-01", promoPriceCentavos: 4500 }),
      ],
    });
    const t = await runTurn(deps, "OWNER", "owner3", "põe feijoada como especial de 2020");
    expect(t.decision.kind).toBe("REFUSE");
    if (t.decision.kind === "REFUSE") {
      expect(t.decision.refusal.code).toBe("menu.special.date_past");
    }
    expect(session.parksFor("system:staff:owner3")).toHaveLength(0);
    expect(spies.dailySpecialCreate).not.toHaveBeenCalled();
  });
});
