// ops-tool-registry — the governed ops MUTATING tools (NEW-032 slice B).
//
// Verifies capability===intentKind for every tool and the exact side-effect
// mapping of each executor: the availability tool mirrors the admin products
// PATCH egress; the note tool routes the POST-adjudication write with the
// Capsule staffId (never the model payload) and the internal-by-default flag.

import { describe, expect, it, vi } from "vitest";
import type { AuditSink } from "@ibatexas/audit-sink";
import type {
  OrderStatusChangedEvent,
  PaymentStatusChangedEvent,
} from "@ibatexas/types";
import { isKnownOrderStatus } from "@ibatexas/types";
import {
  createOpsToolRegistry,
  listOpsToolDefinitions,
  staffIdFromCapsule,
  type OpsToolRegistryDeps,
} from "../ops-tool-registry.js";

const AUDIT_SINK = {} as unknown as AuditSink;

function makeDeps(over: Partial<OpsToolRegistryDeps> = {}): {
  deps: OpsToolRegistryDeps;
  medusaAdjudicated: ReturnType<typeof vi.fn>;
  writeAdjudicatedNote: ReturnType<typeof vi.fn>;
  writeAdjudicatedStatusTransition: ReturnType<typeof vi.fn>;
  publishOrderStatusChanged: ReturnType<typeof vi.fn>;
  writeAdjudicatedRefund: ReturnType<typeof vi.fn>;
  publishPaymentStatusChanged: ReturnType<typeof vi.fn>;
  appendRefundEventLog: ReturnType<typeof vi.fn>;
  resolveAlertFromEnvelope: ReturnType<typeof vi.fn>;
  closeIncidentFromEnvelope: ReturnType<typeof vi.fn>;
  readProductBrlVariantIds: ReturnType<typeof vi.fn>;
  upsertOverride: ReturnType<typeof vi.fn>;
  invalidateScheduleCache: ReturnType<typeof vi.fn>;
  dailySpecialList: ReturnType<typeof vi.fn>;
  dailySpecialCreate: ReturnType<typeof vi.fn>;
  dailySpecialUpdate: ReturnType<typeof vi.fn>;
} {
  const medusaAdjudicated = vi.fn(async () => ({ product: { id: "prod_1" } }));
  // NEW-004 — default: a single BRL-priced variant (the common uniform product).
  const readProductBrlVariantIds = vi.fn(async () => ["variant_1"]);
  const writeAdjudicatedNote = vi.fn(async () => ({
    noteId: "note_1",
    orderId: "order_1",
  }));
  // Wide result: carries displayId + customerId from the projection row so the
  // emit path never trusts the model payload for those identifiers.
  const writeAdjudicatedStatusTransition = vi.fn(async () => ({
    version: 3,
    previousStatus: "preparing",
    newStatus: "ready",
    displayId: 4242,
    customerId: "cust_proj",
  }));
  const publishOrderStatusChanged = vi.fn(
    async (_event: OrderStatusChangedEvent) => {},
  );
  // BKL-085 — the refund write returns orderId + method from the DB row so the
  // ops emit path never trusts the model payload for them.
  const writeAdjudicatedRefund = vi.fn(async () => ({
    version: 5,
    previousStatus: "paid",
    newStatus: "refunded",
    totalRefundedCentavos: 5_000,
    refundAmountCentavos: 5_000,
    orderId: "order_ref",
    method: "pix",
  }));
  const publishPaymentStatusChanged = vi.fn(
    async (_event: PaymentStatusChangedEvent) => {},
  );
  const appendRefundEventLog = vi.fn(async () => {});
  // BKL-088 — the alert-resolve + incident-close SYSTEM-write layer spies.
  const resolveAlertFromEnvelope = vi.fn(async () => ({
    result: { status: "RESOLVED" },
  }));
  const closeIncidentFromEnvelope = vi.fn(async () => ({
    result: { status: "RESOLVED" },
  }));
  // SCN-127 — the schedule-override write returns the committed row shape.
  const upsertOverride = vi.fn(async (date: string, data: { isOpen: boolean }) => ({
    date,
    isOpen: data.isOpen,
  }));
  const invalidateScheduleCache = vi.fn(async () => ({ ok: true }));
  // SCN-114 — daily-special upsert spies (default: no existing row ⇒ CREATE path).
  const dailySpecialList = vi.fn(
    async (): Promise<ReadonlyArray<{ id: string; medusaProductId: string }>> => [],
  );
  const dailySpecialCreate = vi.fn(async () => ({ id: "special_1" }));
  const dailySpecialUpdate = vi.fn(async () => ({ id: "special_1" }));
  const deps: OpsToolRegistryDeps = {
    medusaAdjudicated: medusaAdjudicated as never,
    auditSink: AUDIT_SINK,
    readProductBrlVariantIds: readProductBrlVariantIds as never,
    orderCmdSvc: { writeAdjudicatedNote, writeAdjudicatedStatusTransition },
    dailySpecialSvc: {
      list: dailySpecialList,
      create: dailySpecialCreate,
      update: dailySpecialUpdate,
    },
    publishOrderStatusChanged,
    paymentCmdSvc: { writeAdjudicatedRefund },
    publishPaymentStatusChanged,
    appendRefundEventLog,
    opsAlertSvc: { resolveAlertFromEnvelope },
    incidentSvc: { closeIncidentFromEnvelope },
    scheduleSvc: { upsertOverride: upsertOverride as never },
    invalidateScheduleCache: invalidateScheduleCache as never,
    ...over,
  };
  return {
    deps,
    medusaAdjudicated,
    writeAdjudicatedNote,
    writeAdjudicatedStatusTransition,
    publishOrderStatusChanged,
    writeAdjudicatedRefund,
    publishPaymentStatusChanged,
    appendRefundEventLog,
    resolveAlertFromEnvelope,
    closeIncidentFromEnvelope,
    readProductBrlVariantIds,
    upsertOverride,
    invalidateScheduleCache,
    dailySpecialList,
    dailySpecialCreate,
    dailySpecialUpdate,
  };
}

/** A Capsule stub carrying only the fields the ops executors read. */
function capsule(staffId: string | null): unknown {
  return { actor: staffId === null ? {} : { staffId } };
}

function toolByKind(deps: OpsToolRegistryDeps, kind: string) {
  const tool = listOpsToolDefinitions(deps).find((t) => t.intentKind === kind);
  if (!tool) throw new Error(`no ops tool for ${kind}`);
  return tool;
}

describe("ops tool registry — shape", () => {
  it("every tool has capability === intentKind", () => {
    const { deps } = makeDeps();
    for (const t of listOpsToolDefinitions(deps)) {
      expect(String(t.capability)).toBe(String(t.intentKind));
    }
  });

  it("registers exactly the nine governed ops verbs", () => {
    const { deps } = makeDeps();
    const registry = createOpsToolRegistry(deps);
    expect(registry.hasCapability("product.availability.set")).toBe(true);
    // NEW-004 — the price-change-by-message verb.
    expect(registry.hasCapability("product.price.set")).toBe(true);
    // SCN-114 — the daily-special-by-message verb.
    expect(registry.hasCapability("menu.special.set")).toBe(true);
    expect(registry.hasCapability("order.note.add")).toBe(true);
    expect(registry.hasCapability("order.status.transition")).toBe(true);
    // BKL-085 — the refunds-by-message verb.
    expect(registry.hasCapability("payment.refund.issue")).toBe(true);
    // BKL-088 — the two OWNED resolution verbs.
    expect(registry.hasCapability("ops.alert.resolve.staff")).toBe(true);
    expect(registry.hasCapability("incident.ticket.close.staff")).toBe(true);
    // SCN-127 — the schedule-override-by-message verb.
    expect(registry.hasCapability("schedule.override.set")).toBe(true);
  });

  it("staffIdFromCapsule reads actor.staffId, never a model field", () => {
    expect(staffIdFromCapsule({ actor: { staffId: "s1" } })).toBe("s1");
    expect(staffIdFromCapsule({ actor: {} })).toBe(null);
    expect(staffIdFromCapsule({ payload: { staffId: "forged" } })).toBe(null);
  });
});

describe("product.availability.set executor — mirrors the products PATCH egress", () => {
  it("calls medusaAdjudicated with the exact products-route payload mapping", async () => {
    const { deps, medusaAdjudicated } = makeDeps();
    const tool = toolByKind(deps, "product.availability.set");
    await tool.execute(
      { productId: "prod_1", available: false, reason: "sem estoque" },
      capsule("staff_1"),
    );
    expect(medusaAdjudicated).toHaveBeenCalledTimes(1);
    const args = medusaAdjudicated.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.scope).toBe("admin");
    expect(args.method).toBe("POST");
    expect(args.path).toBe("/admin/products/prod_1");
    expect(args.payload).toEqual({ metadata: { inStock: false } });
    expect(args.intentKind).toBe("medusa.admin.product.update");
    expect(args.sourceSubject).toBe(
      "ops:product.availability.set:admin:staff_1",
    );
    expect(args.auditSink).toBe(AUDIT_SINK);
    expect(typeof args.idempotencyKey).toBe("string");
  });

  it("maps available:true → metadata.inStock:true (does not touch status)", async () => {
    const { deps, medusaAdjudicated } = makeDeps();
    const tool = toolByKind(deps, "product.availability.set");
    await tool.execute({ productId: "p2", available: true }, capsule("s2"));
    const args = medusaAdjudicated.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.payload).toEqual({ metadata: { inStock: true } });
    expect(args.payload).not.toHaveProperty("status");
  });
});

describe("product.price.set executor — re-prices every BRL variant (NEW-004)", () => {
  it("sets each BRL-priced variant to the confirmed price in ONE update (centavos → reais)", async () => {
    const { deps, medusaAdjudicated, readProductBrlVariantIds } = makeDeps();
    // Uniform multi-variant product (P/M/G shirt): two BRL variants.
    readProductBrlVariantIds.mockResolvedValue(["var_p", "var_m"]);
    const tool = toolByKind(deps, "product.price.set");
    const out = (await tool.execute(
      { productId: "prod_1", priceCentavos: 9500, reason: "reajuste" },
      capsule("staff_1"),
    )) as { productId: string; priceCentavos: number; variantsUpdated: number };

    expect(readProductBrlVariantIds).toHaveBeenCalledWith("prod_1");
    expect(medusaAdjudicated).toHaveBeenCalledTimes(1);
    const args = medusaAdjudicated.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.scope).toBe("admin");
    expect(args.method).toBe("POST");
    expect(args.path).toBe("/admin/products/prod_1");
    expect(args.intentKind).toBe("medusa.admin.product.update");
    // The EXACT egress: every BRL variant re-priced to 95 reais (9500 centavos / 100).
    expect(args.payload).toEqual({
      variants: [
        { id: "var_p", prices: [{ currency_code: "brl", amount: 95 }] },
        { id: "var_m", prices: [{ currency_code: "brl", amount: 95 }] },
      ],
    });
    expect(args.sourceSubject).toBe("ops:product.price.set:admin:staff_1");
    expect(args.auditSink).toBe(AUDIT_SINK);
    expect(typeof args.idempotencyKey).toBe("string");
    expect(out).toEqual({
      productId: "prod_1",
      priceCentavos: 9500,
      variantsUpdated: 2,
    });
  });

  it("converts fractional-real centavos exactly (9550 → 95.5 reais)", async () => {
    const { deps, medusaAdjudicated, readProductBrlVariantIds } = makeDeps();
    readProductBrlVariantIds.mockResolvedValue(["v1"]);
    const tool = toolByKind(deps, "product.price.set");
    await tool.execute({ productId: "p", priceCentavos: 9550 }, capsule("s"));
    const args = medusaAdjudicated.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.payload).toEqual({
      variants: [{ id: "v1", prices: [{ currency_code: "brl", amount: 95.5 }] }],
    });
  });

  it("throws (never sends an empty update) when the product has no BRL-priced variant", async () => {
    const { deps, medusaAdjudicated, readProductBrlVariantIds } = makeDeps();
    readProductBrlVariantIds.mockResolvedValue([]);
    const tool = toolByKind(deps, "product.price.set");
    await expect(
      tool.execute({ productId: "prod_x", priceCentavos: 9500 }, capsule("s")),
    ).rejects.toThrow(/no BRL-priced variant/);
    expect(medusaAdjudicated).not.toHaveBeenCalled();
  });
});

describe("order.note.add executor — POST-adjudication note write", () => {
  it("calls writeAdjudicatedNote with author staff + the Capsule staffId + isInternal default true", async () => {
    const { deps, writeAdjudicatedNote } = makeDeps();
    const tool = toolByKind(deps, "order.note.add");
    await tool.execute(
      { orderId: "order_1", body: "conferir troco" },
      capsule("staff_7"),
    );
    expect(writeAdjudicatedNote).toHaveBeenCalledTimes(1);
    const [payload, extras] = writeAdjudicatedNote.mock.calls[0]!;
    expect(payload).toEqual({
      orderId: "order_1",
      body: "conferir troco",
      isInternal: true,
    });
    expect(extras).toEqual({ author: "staff", authorId: "staff_7" });
  });

  it("preserves an explicit isInternal:false (default applies only when omitted)", async () => {
    const { deps, writeAdjudicatedNote } = makeDeps();
    const tool = toolByKind(deps, "order.note.add");
    await tool.execute(
      { orderId: "order_1", body: "aviso público", isInternal: false },
      capsule("staff_7"),
    );
    const [payload] = writeAdjudicatedNote.mock.calls[0]!;
    expect((payload as { isInternal?: boolean }).isInternal).toBe(false);
  });

  it("omits authorId when the Capsule carries no staffId (never fabricates one)", async () => {
    const { deps, writeAdjudicatedNote } = makeDeps();
    const tool = toolByKind(deps, "order.note.add");
    await tool.execute({ orderId: "o1", body: "x" }, capsule(null));
    const [, extras] = writeAdjudicatedNote.mock.calls[0]!;
    expect(extras).toEqual({ author: "staff" });
  });
});

describe("order.status.transition executor — POST-adjudication kitchen-advance (BKL-090)", () => {
  it("calls writeAdjudicatedStatusTransition with actor=admin + Capsule staffId; never the model actor", async () => {
    const { deps, writeAdjudicatedStatusTransition } = makeDeps();
    const tool = toolByKind(deps, "order.status.transition");
    await tool.execute(
      // The model payload's actor/actorId/expectedVersion MUST be ignored.
      {
        orderId: "order_1",
        newStatus: "ready",
        actor: "customer",
        actorId: "forged",
        expectedVersion: 99,
      },
      capsule("staff_7"),
    );
    expect(writeAdjudicatedStatusTransition).toHaveBeenCalledTimes(1);
    const [payload, extras] = writeAdjudicatedStatusTransition.mock.calls[0]!;
    // Only orderId + newStatus are forwarded (no model expectedVersion).
    expect(payload).toEqual({ orderId: "order_1", newStatus: "ready" });
    // Authoritative provenance: admin + the Capsule staffId, never the payload.
    expect(extras.actor).toBe("admin");
    expect(extras.actorId).toBe("staff_7");
    expect((extras as { reason?: string }).reason).toBe(
      "Status avançado pela operação (ops).",
    );
  });

  it("omits actorId when the Capsule carries no staffId (never fabricates one)", async () => {
    const { deps, writeAdjudicatedStatusTransition } = makeDeps();
    const tool = toolByKind(deps, "order.status.transition");
    await tool.execute(
      { orderId: "o1", newStatus: "ready" },
      capsule(null),
    );
    const [, extras] = writeAdjudicatedStatusTransition.mock.calls[0]!;
    expect(extras).toEqual({
      actor: "admin",
      reason: "Status avançado pela operação (ops).",
    });
  });

  it("emits order.status_changed after the committed write, with displayId/customerId from the projection (never the model)", async () => {
    const { deps, publishOrderStatusChanged } = makeDeps();
    const tool = toolByKind(deps, "order.status.transition");
    await tool.execute(
      // Model payload carries a DIFFERENT customerId/displayId — must be ignored.
      {
        orderId: "order_1",
        newStatus: "ready",
        customerId: "model_forged",
        displayId: 9999,
      },
      capsule("staff_7"),
    );
    expect(publishOrderStatusChanged).toHaveBeenCalledTimes(1);
    const event = publishOrderStatusChanged.mock.calls[0]![0];
    expect(event).toMatchObject({
      orderId: "order_1",
      // From the projection-row read (writeAdjudicatedStatusTransition result),
      // NOT the model payload.
      displayId: 4242,
      customerId: "cust_proj",
      previousStatus: "preparing",
      newStatus: "ready",
      updatedBy: "admin",
      version: 3,
    });
    expect(typeof event.timestamp).toBe("string");
  });

  it("does NOT emit order.status_changed when the write throws (no event for an uncommitted transition)", async () => {
    const publishOrderStatusChanged = vi.fn(async () => {});
    const writeAdjudicatedStatusTransition = vi.fn(async () => {
      throw new Error("InvalidTransitionError");
    });
    const { deps } = makeDeps({
      orderCmdSvc: {
        writeAdjudicatedNote: vi.fn(),
        writeAdjudicatedStatusTransition,
      } as never,
      publishOrderStatusChanged,
    });
    const tool = toolByKind(deps, "order.status.transition");
    await expect(
      tool.execute({ orderId: "order_1", newStatus: "ready" }, capsule("staff_7")),
    ).rejects.toThrow();
    expect(publishOrderStatusChanged).not.toHaveBeenCalled();
  });

  // BKL-144 — the ToolDefinition now declares the REAL model-facing contract so
  // the closed shape is documented (the live probe's empty inputSchema left the
  // planner guessing field names + pt-BR values). This asserts the contract, NOT
  // any runtime normalization — the guard still reads `newStatus` verbatim.
  it("declares the closed contract in inputSchema: orderId + the six English newStatus targets, no pt/alias values", () => {
    const { deps } = makeDeps();
    const tool = toolByKind(deps, "order.status.transition");
    const schema = tool.inputSchema as {
      type: string;
      properties: {
        orderId: { type: string };
        newStatus: { type: string; enum: string[] };
      };
      required: readonly string[];
      additionalProperties: boolean;
    };
    expect(schema.type).toBe("object");
    // Only orderId + newStatus are model-emitted; actor/actorId/reason are
    // Capsule-forced by the executor, so the contract is closed to extras.
    expect(schema.required).toEqual(["orderId", "newStatus"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.orderId.type).toBe("string");
    // Exactly the six English fulfillment targets, verbatim — the enum the live
    // probe's wrong field names + pt-BR values (confirmado/cancel) never reached.
    const enumValues = schema.properties.newStatus.enum;
    expect(enumValues).toEqual([
      "confirmed",
      "preparing",
      "ready",
      "in_delivery",
      "delivered",
      "canceled",
    ]);
    // Every advertised value is a real order status (no drift from the state
    // machine), and none is a pt-BR word or the initial `pending` (never a target).
    for (const v of enumValues) expect(isKnownOrderStatus(v)).toBe(true);
    expect(enumValues).not.toContain("pending");
    expect(enumValues).not.toContain("confirmado");
  });
});

describe("payment.refund.issue executor — POST-adjudication refund write (BKL-085)", () => {
  it("calls writeAdjudicatedRefund with actor=admin + Capsule staffId; never the model actor/actorId", async () => {
    const { deps, writeAdjudicatedRefund } = makeDeps();
    const tool = toolByKind(deps, "payment.refund.issue");
    await tool.execute(
      // The model payload's actor/actorId MUST be overwritten from the Capsule.
      {
        paymentId: "pay_1",
        refundAmountCentavos: 5_000,
        refundableBalanceCentavos: 50_000,
        amountInCentavos: 50_000,
        currentRefundedCentavos: 0,
        actor: "system",
        actorId: "forged",
        reason: "cliente pediu",
      },
      capsule("staff_9"),
    );
    expect(writeAdjudicatedRefund).toHaveBeenCalledTimes(1);
    const [payload] = writeAdjudicatedRefund.mock.calls[0]!;
    // Identity forced from the Capsule, never the model payload.
    expect((payload as { actor: string }).actor).toBe("admin");
    expect((payload as { actorId?: string }).actorId).toBe("staff_9");
    // The balance/amount fields pass through (the resolver already stamped them).
    expect((payload as { refundAmountCentavos: number }).refundAmountCentavos).toBe(5_000);
    expect((payload as { paymentId: string }).paymentId).toBe("pay_1");
  });

  it("omits actorId when the Capsule carries no staffId (never fabricates one)", async () => {
    const { deps, writeAdjudicatedRefund } = makeDeps();
    const tool = toolByKind(deps, "payment.refund.issue");
    await tool.execute(
      {
        paymentId: "pay_1",
        refundAmountCentavos: 5_000,
        refundableBalanceCentavos: 50_000,
        amountInCentavos: 50_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      },
      capsule(null),
    );
    const [payload] = writeAdjudicatedRefund.mock.calls[0]!;
    expect((payload as { actorId?: string }).actorId).toBeUndefined();
    expect((payload as { actor: string }).actor).toBe("admin");
  });

  it("emits payment.status_changed AND appends the ops.refund.executed audit event after the committed write, with orderId/method from the DB row (never the model)", async () => {
    const { deps, publishPaymentStatusChanged, appendRefundEventLog } = makeDeps();
    const tool = toolByKind(deps, "payment.refund.issue");
    await tool.execute(
      {
        paymentId: "pay_1",
        refundAmountCentavos: 5_000,
        refundableBalanceCentavos: 50_000,
        amountInCentavos: 50_000,
        currentRefundedCentavos: 0,
        actor: "admin",
      },
      capsule("staff_9"),
    );
    // payment.status_changed — drives auto-cancel-on-full-refund; orderId/method
    // from the committed DB row (writeAdjudicatedRefund result), not the model.
    expect(publishPaymentStatusChanged).toHaveBeenCalledTimes(1);
    const event = publishPaymentStatusChanged.mock.calls[0]![0];
    expect(event).toMatchObject({
      orderId: "order_ref",
      paymentId: "pay_1",
      previousStatus: "paid",
      newStatus: "refunded",
      method: "pix",
      version: 5,
    });
    expect(typeof event.timestamp).toBe("string");
    // ops.refund.executed audit event appended.
    expect(appendRefundEventLog).toHaveBeenCalledTimes(1);
    const entry = appendRefundEventLog.mock.calls[0]![0];
    expect(entry).toMatchObject({
      orderId: "order_ref",
      eventType: "ops.refund.executed",
    });
  });

  it("a payment.status_changed publish failure NEVER fails the committed refund turn (best-effort emit)", async () => {
    const writeAdjudicatedRefund = vi.fn(async () => ({
      version: 5,
      previousStatus: "paid",
      newStatus: "refunded",
      totalRefundedCentavos: 5_000,
      refundAmountCentavos: 5_000,
      orderId: "order_ref",
      method: "pix",
    }));
    const publishPaymentStatusChanged = vi.fn(async () => {
      throw new Error("NATS down");
    });
    const { deps } = makeDeps({
      paymentCmdSvc: { writeAdjudicatedRefund } as never,
      publishPaymentStatusChanged,
    });
    const tool = toolByKind(deps, "payment.refund.issue");
    // Must resolve (not throw) despite the publish failure.
    await expect(
      tool.execute(
        {
          paymentId: "pay_1",
          refundAmountCentavos: 5_000,
          refundableBalanceCentavos: 50_000,
          amountInCentavos: 50_000,
          currentRefundedCentavos: 0,
          actor: "admin",
        },
        capsule("staff_9"),
      ),
    ).resolves.toMatchObject({ paymentId: "pay_1", newStatus: "refunded" });
    expect(writeAdjudicatedRefund).toHaveBeenCalledTimes(1);
  });
});

describe("ops.alert.resolve.staff executor — D10 SYSTEM-write layer (BKL-088)", () => {
  it("builds a SYSTEM ops.alert.resolve envelope: FORCED resolvedBy=staff:<id> + resolutionType=STAFF, principal=system, taint=SYSTEM", async () => {
    const { deps, resolveAlertFromEnvelope } = makeDeps();
    const tool = toolByKind(deps, "ops.alert.resolve.staff");
    // The `reason` rides the staff-verb envelope (audited) — it is NOT forwarded
    // to the SYSTEM payload (which has no reason slot).
    const out = await tool.execute(
      { alertId: "alert_1", reason: "condição normalizada" },
      capsule("staff_9"),
    );
    expect(resolveAlertFromEnvelope).toHaveBeenCalledTimes(1);
    const [envelope, state] = resolveAlertFromEnvelope.mock.calls[0]!;
    expect(envelope.kind).toBe("ops.alert.resolve");
    expect(envelope.actor.principal).toBe("system");
    // A SYSTEM write is role-free by contract (never admin:+role).
    expect(envelope.actor.role).toBeUndefined();
    expect(envelope.taint).toBe("SYSTEM");
    expect(envelope.payload).toEqual({
      id: "alert_1",
      resolvedBy: "staff:staff_9", // FROM the Capsule, never the model
      resolutionType: "STAFF",
    });
    // No reason leaked into the SYSTEM payload.
    expect(envelope.payload).not.toHaveProperty("reason");
    expect(state).toEqual({});
    expect(out).toMatchObject({ alertId: "alert_1", status: "RESOLVED" });
  });

  it("degrades resolvedBy to a traceable marker when the Capsule carries no staffId (never fabricates a staff id)", async () => {
    const { deps, resolveAlertFromEnvelope } = makeDeps();
    const tool = toolByKind(deps, "ops.alert.resolve.staff");
    await tool.execute({ alertId: "alert_1" }, capsule(null));
    const [envelope] = resolveAlertFromEnvelope.mock.calls[0]!;
    expect((envelope.payload as { resolvedBy: string }).resolvedBy).toBe(
      "ops:unknown",
    );
  });
});

describe("incident.ticket.close.staff executor — D10 SYSTEM-write layer (BKL-088)", () => {
  it("builds a SYSTEM incident.ticket.close envelope: FORCED resolvedBy=staff:<id> + resolutionType=STAFF + closingTurnId null", async () => {
    const { deps, closeIncidentFromEnvelope } = makeDeps();
    const tool = toolByKind(deps, "incident.ticket.close.staff");
    const out = await tool.execute(
      { incidentId: "inc_1" },
      capsule("staff_3"),
    );
    expect(closeIncidentFromEnvelope).toHaveBeenCalledTimes(1);
    const [envelope] = closeIncidentFromEnvelope.mock.calls[0]!;
    expect(envelope.kind).toBe("incident.ticket.close");
    expect(envelope.actor.principal).toBe("system");
    expect(envelope.taint).toBe("SYSTEM");
    expect(envelope.payload).toEqual({
      id: "inc_1",
      resolvedBy: "staff:staff_3",
      resolutionType: "STAFF",
      closingTurnId: null,
    });
    expect(out).toMatchObject({ incidentId: "inc_1", status: "RESOLVED" });
  });
});

describe("schedule.override.set executor — domain-service write + cache invalidation (SCN-127)", () => {
  it("closes a day: upsertOverride(date, {isOpen:false, blocks:[], note}) + invalidates the cache", async () => {
    const { deps, upsertOverride, invalidateScheduleCache } = makeDeps();
    const tool = toolByKind(deps, "schedule.override.set");
    const out = await tool.execute(
      { date: "2026-07-11", isOpen: false, note: "feriado" },
      capsule("staff_1"),
    );
    expect(upsertOverride).toHaveBeenCalledTimes(1);
    const [date, data] = upsertOverride.mock.calls[0]!;
    expect(date).toBe("2026-07-11");
    // A CLOSED day carries NO windows regardless of any blocks in the payload.
    expect(data).toEqual({ isOpen: false, blocks: [], note: "feriado" });
    // Cache invalidated so the customer-facing reads pick the override up now.
    expect(invalidateScheduleCache).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ date: "2026-07-11", isOpen: false });
  });

  it("opens a day with custom hours: forwards the validated blocks; note defaults to null", async () => {
    const { deps, upsertOverride } = makeDeps();
    const tool = toolByKind(deps, "schedule.override.set");
    await tool.execute(
      {
        date: "2026-07-11",
        isOpen: true,
        blocks: [{ label: "Jantar", start: "18:00", end: "23:00" }],
      },
      capsule("staff_1"),
    );
    const [date, data] = upsertOverride.mock.calls[0]!;
    expect(date).toBe("2026-07-11");
    expect(data).toEqual({
      isOpen: true,
      blocks: [{ label: "Jantar", start: "18:00", end: "23:00" }],
      note: null,
    });
  });

  it("drops any blocks on a CLOSED override (executor forces blocks:[] for isOpen:false)", async () => {
    const { deps, upsertOverride } = makeDeps();
    const tool = toolByKind(deps, "schedule.override.set");
    await tool.execute(
      // Defense in depth: even if a block sneaks through, a closed day writes none.
      { date: "2026-07-11", isOpen: false, blocks: [{ label: "x", start: "18:00", end: "19:00" }] },
      capsule("staff_1"),
    );
    const [, data] = upsertOverride.mock.calls[0]!;
    expect((data as { blocks: unknown[] }).blocks).toEqual([]);
  });

  it("a swallowed cache invalidation NEVER fails the committed write (WARN only)", async () => {
    const warn = vi.fn();
    const { deps, upsertOverride } = makeDeps({
      invalidateScheduleCache: vi.fn(async () => ({ ok: false })) as never,
      log: { warn },
    });
    const tool = toolByKind(deps, "schedule.override.set");
    await expect(
      tool.execute({ date: "2026-07-11", isOpen: false }, capsule("staff_1")),
    ).resolves.toEqual({ date: "2026-07-11", isOpen: false });
    expect(upsertOverride).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // The WARN carries the Capsule staffId (audit of who), never a payload field.
    const [ctx] = warn.mock.calls[0]!;
    expect((ctx as { staffId?: string }).staffId).toBe("staff_1");
  });
});
