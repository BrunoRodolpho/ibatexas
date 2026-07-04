// ops-tool-registry — the governed ops MUTATING tools (NEW-032 slice B).
//
// Verifies capability===intentKind for every tool and the exact side-effect
// mapping of each executor: the availability tool mirrors the admin products
// PATCH egress; the note tool routes the POST-adjudication write with the
// Capsule staffId (never the model payload) and the internal-by-default flag.

import { describe, expect, it, vi } from "vitest";
import type { AuditSink } from "@ibatexas/audit-sink";
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
} {
  const medusaAdjudicated = vi.fn(async () => ({ product: { id: "prod_1" } }));
  const writeAdjudicatedNote = vi.fn(async () => ({
    noteId: "note_1",
    orderId: "order_1",
  }));
  const writeAdjudicatedStatusTransition = vi.fn(async () => ({
    version: 3,
    previousStatus: "preparing",
    newStatus: "ready",
  }));
  const deps: OpsToolRegistryDeps = {
    medusaAdjudicated: medusaAdjudicated as never,
    auditSink: AUDIT_SINK,
    orderCmdSvc: { writeAdjudicatedNote, writeAdjudicatedStatusTransition },
    ...over,
  };
  return {
    deps,
    medusaAdjudicated,
    writeAdjudicatedNote,
    writeAdjudicatedStatusTransition,
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

  it("registers exactly the three governed ops verbs", () => {
    const { deps } = makeDeps();
    const registry = createOpsToolRegistry(deps);
    expect(registry.hasCapability("product.availability.set")).toBe(true);
    expect(registry.hasCapability("order.note.add")).toBe(true);
    expect(registry.hasCapability("order.status.transition")).toBe(true);
    expect(registry.hasCapability("payment.refund.issue")).toBe(false);
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
});
