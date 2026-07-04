// ops-resolver — the per-kind ops SystemState projection (NEW-032 slice B).

import { describe, expect, it, vi } from "vitest";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import type { ResolverInput } from "@claustrum/core";
import {
  createOpsResolver,
  type OpsResolverDeps,
} from "../ops-resolver.js";

function opsEnvelope(
  kind: string,
  payload: Record<string, unknown>,
): IntentEnvelope {
  return buildEnvelope({
    kind,
    payload,
    actor: { principal: "user", sessionId: "admin:staff_1", role: "OWNER" },
    taint: "UNTRUSTED",
    nonce: "n-1",
    createdAt: "2026-07-04T12:00:00.000Z",
  }) as IntentEnvelope;
}

function input(env: IntentEnvelope): ResolverInput {
  return {
    plan: { envelopes: [env] },
    cognition: {},
    customerId: "staff:staff_1",
    channel: "system",
  } as unknown as ResolverInput;
}

function makeDeps(over: Partial<OpsResolverDeps> = {}): OpsResolverDeps {
  return {
    staffId: "staff_1",
    tenantId: "ibatexas",
    lookupProduct: vi.fn(async () => ({ id: "prod_1", status: "published" })),
    lookupOrder: vi.fn(async () => ({
      customerId: "cust_1",
      paymentMethod: "pix",
      paymentStatus: "confirmed",
      totalInCentavos: 5000,
      fulfillmentStatus: "confirmed",
    })),
    ...over,
  };
}

describe("ops resolver — product.availability.set state", () => {
  it("projects { ctx, product } from the product lookup", async () => {
    const deps = makeDeps();
    const [resolved] = await createOpsResolver(deps).resolve(
      input(opsEnvelope("product.availability.set", { productId: "prod_1", available: false })),
    );
    expect(resolved!.state).toEqual({
      ctx: {
        channel: "staff",
        customerId: null,
        staffId: "staff_1",
        tenantId: "ibatexas",
      },
      product: { id: "prod_1", status: "published" },
    });
  });

  it("product missing ⇒ product:null (REFUSE product_not_found)", async () => {
    const deps = makeDeps({ lookupProduct: vi.fn(async () => null) });
    const [resolved] = await createOpsResolver(deps).resolve(
      input(opsEnvelope("product.availability.set", { productId: "ghost", available: true })),
    );
    expect((resolved!.state as { product: unknown }).product).toBeNull();
  });

  it("lookup THROW is fail-closed to product:null (never crashes the turn)", async () => {
    const deps = makeDeps({
      lookupProduct: vi.fn(async () => {
        throw new Error("medusa down");
      }),
    });
    const [resolved] = await createOpsResolver(deps).resolve(
      input(opsEnvelope("product.availability.set", { productId: "prod_1", available: true })),
    );
    expect((resolved!.state as { product: unknown }).product).toBeNull();
  });

  it("empty productId ⇒ product:null WITHOUT calling the lookup", async () => {
    const lookupProduct = vi.fn(async () => ({ id: "x", status: "y" }));
    const deps = makeDeps({ lookupProduct });
    const [resolved] = await createOpsResolver(deps).resolve(
      input(opsEnvelope("product.availability.set", { available: true })),
    );
    expect((resolved!.state as { product: unknown }).product).toBeNull();
    expect(lookupProduct).not.toHaveBeenCalled();
  });

  it("preserves the envelope actor/taint/nonce on rebuild", async () => {
    const deps = makeDeps();
    const env = opsEnvelope("product.availability.set", { productId: "prod_1", available: false });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect(resolved!.envelope.actor).toEqual(env.actor);
    expect(resolved!.envelope.taint).toBe("UNTRUSTED");
    expect(resolved!.envelope.nonce).toBe("n-1");
    // Same canonical inputs ⇒ same intentHash.
    expect(resolved!.envelope.intentHash).toBe(env.intentHash);
  });
});

describe("ops resolver — order.note.add state", () => {
  it("projects the pack-orders OrderState from the order projection", async () => {
    const deps = makeDeps();
    const [resolved] = await createOpsResolver(deps).resolve(
      input(opsEnvelope("order.note.add", { orderId: "order_1", body: "nota" })),
    );
    expect(resolved!.state).toEqual({
      ctx: {
        channel: "web",
        customerId: "cust_1",
        cartId: null,
        orderId: "order_1",
        paymentMethod: "pix",
        paymentStatus: "confirmed",
        totalInCentavos: 5000,
      },
    });
  });

  it("order missing ⇒ ctx.orderId null (REFUSE no_order, never a thrown turn)", async () => {
    const deps = makeDeps({ lookupOrder: vi.fn(async () => null) });
    const [resolved] = await createOpsResolver(deps).resolve(
      input(opsEnvelope("order.note.add", { orderId: "ghost", body: "nota" })),
    );
    expect((resolved!.state as { ctx: { orderId: unknown } }).ctx.orderId).toBeNull();
  });

  it("order lookup THROW is fail-closed to orderId null", async () => {
    const deps = makeDeps({
      lookupOrder: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const [resolved] = await createOpsResolver(deps).resolve(
      input(opsEnvelope("order.note.add", { orderId: "order_1", body: "nota" })),
    );
    expect((resolved!.state as { ctx: { orderId: unknown } }).ctx.orderId).toBeNull();
  });
});

describe("ops resolver — order.status.transition state (BKL-090)", () => {
  it("projects the pack-orders OrderState with the CURRENT fulfillmentStatus", async () => {
    const deps = makeDeps({
      lookupOrder: vi.fn(async () => ({
        customerId: "cust_1",
        paymentMethod: "pix",
        paymentStatus: "confirmed",
        totalInCentavos: 5000,
        fulfillmentStatus: "preparing",
      })),
    });
    const [resolved] = await createOpsResolver(deps).resolve(
      input(
        opsEnvelope("order.status.transition", {
          orderId: "order_1",
          newStatus: "ready",
        }),
      ),
    );
    expect(resolved!.state).toEqual({
      ctx: {
        channel: "web",
        customerId: "cust_1",
        cartId: null,
        orderId: "order_1",
        fulfillmentStatus: "preparing",
      },
    });
  });

  it("order missing ⇒ ctx.orderId null AND fulfillmentStatus null (fail-closed)", async () => {
    const deps = makeDeps({ lookupOrder: vi.fn(async () => null) });
    const [resolved] = await createOpsResolver(deps).resolve(
      input(
        opsEnvelope("order.status.transition", {
          orderId: "ghost",
          newStatus: "ready",
        }),
      ),
    );
    const ctx = (resolved!.state as { ctx: { orderId: unknown; fulfillmentStatus: unknown } }).ctx;
    expect(ctx.orderId).toBeNull();
    expect(ctx.fulfillmentStatus).toBeNull();
  });

  it("order lookup THROW is fail-closed to orderId + fulfillmentStatus null", async () => {
    const deps = makeDeps({
      lookupOrder: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const [resolved] = await createOpsResolver(deps).resolve(
      input(
        opsEnvelope("order.status.transition", {
          orderId: "order_1",
          newStatus: "ready",
        }),
      ),
    );
    const ctx = (resolved!.state as { ctx: { orderId: unknown; fulfillmentStatus: unknown } }).ctx;
    expect(ctx.orderId).toBeNull();
    expect(ctx.fulfillmentStatus).toBeNull();
  });
});

describe("ops resolver — unknown kind", () => {
  it("returns no per-envelope state (falls back to resolution.state)", async () => {
    const deps = makeDeps();
    const [resolved] = await createOpsResolver(deps).resolve(
      input(opsEnvelope("some.other.kind", {})),
    );
    expect(resolved!.state).toBeUndefined();
  });
});
