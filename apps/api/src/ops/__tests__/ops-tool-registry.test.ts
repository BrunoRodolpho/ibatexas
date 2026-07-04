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
} {
  const medusaAdjudicated = vi.fn(async () => ({ product: { id: "prod_1" } }));
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
  const deps: OpsToolRegistryDeps = {
    medusaAdjudicated: medusaAdjudicated as never,
    auditSink: AUDIT_SINK,
    orderCmdSvc: { writeAdjudicatedNote, writeAdjudicatedStatusTransition },
    publishOrderStatusChanged,
    paymentCmdSvc: { writeAdjudicatedRefund },
    publishPaymentStatusChanged,
    appendRefundEventLog,
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

  it("registers exactly the four governed ops verbs", () => {
    const { deps } = makeDeps();
    const registry = createOpsToolRegistry(deps);
    expect(registry.hasCapability("product.availability.set")).toBe(true);
    expect(registry.hasCapability("order.note.add")).toBe(true);
    expect(registry.hasCapability("order.status.transition")).toBe(true);
    // BKL-085 — the refunds-by-message verb is now the fourth governed ops tool.
    expect(registry.hasCapability("payment.refund.issue")).toBe(true);
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
