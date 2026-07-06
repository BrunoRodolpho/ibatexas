// ws9-ops-scn — the WS9 SCN regression gate for the ops plane (the "AI manager"
// moment). Drives the SCN OPS rows END-TO-END through composeOpsConductor + a full
// handleTurn against the REAL composed router + REAL AUDITED kernel, token-free,
// and asserts the KERNEL facts from the captured AuditRecord (envelope.kind /
// decision.kind / actor.role / decision_basis) — not just the reply text. This is
// the machine-set proof that replaces the two hand-driven live sessions for the
// CI-provable behaviours; the live-model equivalent is scripts/ops-live-smoke.mjs.
//
// ── SCN INDEX (which committed test proves which row) ────────────────────────
//   SCN-112  86 an item (availability OFF)        → this file, describe "SCN-112"
//   SCN-113  restore an item (availability ON)    → this file, describe "SCN-113"
//   ops situational snapshot read                 → this file, describe "snapshot read"
//   product-name resolution (86 by name)          → this file, "…by NAME" +
//                                                    ops-conductor.test.ts (BKL-089)
//   refund confirm loop (park→deny / park→sim→EXECUTE / ATTENDANT / >R$1000)
//                                                  → ops-refunds-confirm-resume.e2e.test.ts
//   price change confirm loop                     → ops-price-confirm-resume.e2e.test.ts
//   order-ref + note/transition verbs             → ops-conductor.test.ts (BKL-089/090)
//
// The genuinely NET-NEW coverage here vs the pre-existing ops e2e files is (1) the
// availability RESTORE (available:true) egress — every prior availability test set
// available:false; (2) the AUDIT-RECORD (kernel-fact) assertions on those rows —
// the prior conductor test used the pure (un-audited) kernel; and (3) the ops
// situational-snapshot READ driven through the FULL conductor (prior proof was
// planner-level only). The overlapping decision/side-effect proofs deliberately
// stay in their existing homes; this file does not re-run them.

import { describe, expect, it, vi } from "vitest";
import { createOpsResolver } from "../ops-resolver.js";
import { OPS_SNAPSHOT_READ_TOOL } from "../ops-read-executor.js";
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

/** An availability toggle intent — `available:false` = 86, `available:true` = restore. */
const AVAIL_CALL = (productRef: string, available: boolean): ScriptedToolCall => ({
  id: "tc-avail",
  name: "express_intent",
  input: {
    capability: "product.availability.set",
    payload: { productId: productRef, available },
  },
});

/**
 * An availability harness. No resume projector: availability EXECUTEs on the first
 * turn (it never parks) — the confirm-resume flows live in the refund/price files.
 * `productsByName` (when set) exercises the name→id resolution rewrite.
 */
function buildAvailabilityHarness(opts: {
  toolCalls: ReadonlyArray<ScriptedToolCall>;
  product: { id: string; status: string } | null;
  productsByName?: Array<{ id: string; title: string; status: string }>;
}) {
  const sink = makeCapturingAuditSink();
  const session = makeStatefulSession();
  const { tools, spies } = buildOpsTools(
    { medusaAdjudicated: vi.fn(async () => ({ product: opts.product ?? {} })) },
    sink,
  );
  const adjudicator = makeAuditedAdjudicator({ sink });
  const deps = composeOpsDeps({
    adjudicator,
    session,
    tools,
    model: scriptedModel(opts.toolCalls),
    buildResolver: (staffId: string) =>
      createOpsResolver({
        staffId,
        tenantId: "ibatexas",
        lookupProduct: async () => opts.product,
        lookupOrder: async () => null,
        ...(opts.productsByName
          ? { listProductsByName: async () => opts.productsByName! }
          : {}),
      }),
  });
  return { deps, spies, sink };
}

const runTurn = (
  deps: ReturnType<typeof buildAvailabilityHarness>["deps"],
  role: StaffRole,
  staffId: string,
  text: string,
) => runOpsTurn(deps, { role, staffId, text });

describe("WS9 SCN-112 — 86 an item (availability OFF), kernel-fact asserted", () => {
  it("OWNER 'acabou a picanha' → EXECUTE; egress metadata.inStock:false; AuditRecord names kind+OWNER", async () => {
    const { deps, spies, sink } = buildAvailabilityHarness({
      toolCalls: [AVAIL_CALL("prod_1", false)],
      product: { id: "prod_1", status: "published" },
    });
    const out = await runTurn(deps, "OWNER", "owner1", "acabou a picanha");
    expect(out.decision.kind).toBe("EXECUTE");
    // Side effect — the availability egress the products route uses, off.
    expect(spies.medusaAdjudicated).toHaveBeenCalledTimes(1);
    const args = spies.medusaAdjudicated.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.path).toBe("/admin/products/prod_1");
    expect(args.payload).toEqual({ metadata: { inStock: false } });
    expect(args.sourceSubject).toBe("ops:product.availability.set:admin:owner1");
    // KERNEL FACT — the audited EXECUTE record: right kind, OWNER identity stamped
    // by the planner (never the model), audited exactly once.
    const rec = sink.lastDecision("EXECUTE");
    expect(rec).toBeDefined();
    expect(String(rec!.envelope.kind)).toBe("product.availability.set");
    expect(rec!.envelope.actor.role).toBe("OWNER");
    expect(rec!.envelope.actor.sessionId).toBe("admin:owner1");
    expect(sink.byKind("product.availability.set")).toHaveLength(1);
  });

  it("ATTENDANT → REFUSE staff_role_violation; no egress; AuditRecord names ATTENDANT", async () => {
    const { deps, spies, sink } = buildAvailabilityHarness({
      toolCalls: [AVAIL_CALL("prod_1", false)],
      product: { id: "prod_1", status: "published" },
    });
    const out = await runTurn(deps, "ATTENDANT", "att1", "tira o X do cardápio");
    expect(out.decision.kind).toBe("REFUSE");
    if (out.decision.kind === "REFUSE") {
      expect(out.decision.refusal.code).toBe("staff_role_violation");
      // Role-opaque pt-BR: never names the role/matrix to the operator.
      expect(out.response.toLowerCase()).not.toContain("attendant");
    }
    expect(spies.medusaAdjudicated).not.toHaveBeenCalled();
    const rec = sink.lastDecision("REFUSE");
    expect(rec).toBeDefined();
    expect(String(rec!.envelope.kind)).toBe("product.availability.set");
    expect(rec!.envelope.actor.role).toBe("ATTENDANT");
  });

  it("OWNER 'acabou a picanha' by NAME → resolves → EXECUTE with the RESOLVED id", async () => {
    const { deps, spies } = buildAvailabilityHarness({
      toolCalls: [AVAIL_CALL("picanha", false)], // a NAME, per the persona
      product: null, // direct id lookup MISSES → name resolution engages
      productsByName: [{ id: "prod_42", title: "Picanha", status: "published" }],
    });
    const out = await runTurn(deps, "OWNER", "owner1", "acabou a picanha");
    expect(out.decision.kind).toBe("EXECUTE");
    expect(spies.medusaAdjudicated).toHaveBeenCalledTimes(1);
    const args = spies.medusaAdjudicated.mock.calls[0]![0] as Record<string, unknown>;
    // The egress targets the RESOLVED id, not the spoken name.
    expect(args.path).toBe("/admin/products/prod_42");
    expect(args.payload).toEqual({ metadata: { inStock: false } });
  });
});

describe("WS9 SCN-113 — restore an item (availability ON), kernel-fact asserted", () => {
  it("MANAGER 'voltou a picanha' → EXECUTE; egress metadata.inStock:true; AuditRecord names MANAGER", async () => {
    const { deps, spies, sink } = buildAvailabilityHarness({
      toolCalls: [AVAIL_CALL("prod_1", true)],
      product: { id: "prod_1", status: "published" },
    });
    const out = await runTurn(deps, "MANAGER", "mgr1", "voltou a picanha, pode vender");
    expect(out.decision.kind).toBe("EXECUTE");
    expect(spies.medusaAdjudicated).toHaveBeenCalledTimes(1);
    const args = spies.medusaAdjudicated.mock.calls[0]![0] as Record<string, unknown>;
    // The RESTORE egress — inStock TRUE (the net-new assertion; every prior
    // availability test only ever proved the OFF direction).
    expect(args.path).toBe("/admin/products/prod_1");
    expect(args.payload).toEqual({ metadata: { inStock: true } });
    expect(args.sourceSubject).toBe("ops:product.availability.set:admin:mgr1");
    const rec = sink.lastDecision("EXECUTE");
    expect(rec).toBeDefined();
    expect(String(rec!.envelope.kind)).toBe("product.availability.set");
    expect(rec!.envelope.actor.role).toBe("MANAGER");
  });

  it("ATTENDANT restore → REFUSE staff_role_violation; no egress", async () => {
    const { deps, spies } = buildAvailabilityHarness({
      toolCalls: [AVAIL_CALL("prod_1", true)],
      product: { id: "prod_1", status: "published" },
    });
    const out = await runTurn(deps, "ATTENDANT", "att2", "libera a picanha de novo");
    expect(out.decision.kind).toBe("REFUSE");
    expect(spies.medusaAdjudicated).not.toHaveBeenCalled();
  });
});

// ── The ops situational-snapshot READ, driven through the FULL conductor ─────
// A read is UNGOVERNED: the planner calls the ops_snapshot read tool, the executor
// composes the snapshot, and the responder renders from it. The net-new proof over
// ops-read-enrichment.test.ts (planner-level) is that the executor is wired into
// the conductor's read loop AND that the read AUTHORIZES NO MUTATION — the only
// thing the kernel ever sees is the empty follow-up plan (the same empty-plan
// convention the pre-existing conductor test's adjudicator uses), never a governed
// ops verb. So no EXECUTE and no real-capability record appears in the trail.

function buildSnapshotHarness() {
  const sink = makeCapturingAuditSink();
  const session = makeStatefulSession();
  const { tools } = buildOpsTools({}, sink);
  const adjudicator = makeAuditedAdjudicator({ sink });
  // BKL-100 — a SHAPE-COMPLETE OpsSnapshot so the responder renders the full
  // panorama deterministically from the read (the fix is to complete the fixture,
  // never to weaken the assert). A partial shape would now exercise the honest
  // "couldn't check" degrade line instead.
  const snapshotExecutor = vi.fn(async () => ({
    now: "2026-07-04T21:00:00.000Z",
    opsAlerts: { open: 2, bySeverity: { low: 0, medium: 1, high: 1 } },
    incidents: { open: 1 },
    kitchen: {
      activeTickets: 3,
      oldestTicketAgeMs: 90_000,
      queueDepth: [{ status: "preparing", count: 3 }],
    },
    caixa: {
      date: "2026-07-04",
      ordersCount: 12,
      grossCentavos: 120_000,
      settledCentavos: 110_000,
      refundedCentavos: 0,
      netCentavos: 110_000,
    },
    reservations: {
      date: "2026-07-04",
      total: 4,
      byStatus: [{ status: "confirmed", count: 4 }],
    },
    degraded: [],
  }));
  const deps = composeOpsDeps({
    adjudicator,
    session,
    tools,
    model: scriptedModel(
      [{ id: "r-1", name: OPS_SNAPSHOT_READ_TOOL, input: {} }],
      { responderText: "Hoje: 12 pedidos, caixa positivo, 2 alertas abertos." },
    ),
    buildResolver: (staffId: string) =>
      createOpsResolver({
        staffId,
        tenantId: "ibatexas",
        lookupProduct: async () => null,
        lookupOrder: async () => null,
      }),
    opsReadToolExecutors: { [OPS_SNAPSHOT_READ_TOOL]: snapshotExecutor },
  });
  return { deps, sink, snapshotExecutor };
}

describe("WS9 ops snapshot read — reachable end-to-end, authorizes no mutation", () => {
  it("OWNER 'como estão as vendas hoje?' → the ops_snapshot executor runs; NO governed verb is authorized", async () => {
    const { deps, sink, snapshotExecutor } = buildSnapshotHarness();
    const out = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner1",
      text: "como estão as vendas hoje?",
    });
    // The read executor ran (the snapshot was composed for the responder).
    expect(snapshotExecutor).toHaveBeenCalledTimes(1);
    // The read authorized NO mutation: no EXECUTE in the trail, and no record for
    // any real ops capability — the only thing the kernel saw was the empty plan.
    expect(sink.lastDecision("EXECUTE")).toBeUndefined();
    expect(sink.records.every((r) => String(r.envelope.kind) === "noop")).toBe(true);
    // The turn did not EXECUTE any mutation.
    expect(out.decision.kind).not.toBe("EXECUTE");
    // BKL-100 — the reply is the DETERMINISTIC panorama rendered from the read
    // (not the scripted model prose): its header + the true caixa figure appear.
    expect(out.response.length).toBeGreaterThan(0);
    expect(out.response).toContain("Panorama operacional");
    expect(out.response).toContain("12 pedidos");
  });
});
