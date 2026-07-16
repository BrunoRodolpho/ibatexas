// ops-resolver — the per-kind ops SystemState projection (NEW-032 slice B).

import { describe, expect, it, vi } from "vitest";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import type { ResolverInput } from "@claustrum/core";
import {
  createOpsResolver,
  buildOpsRefundResumeState,
  buildOpsSpecialResumeState,
  type OpsResolverDeps,
} from "../ops-resolver.js";
import type { ProductCandidate } from "../ops-product-resolution.js";
import type {
  OrderCandidate,
  OrderReferenceReads,
} from "../ops-order-resolution.js";

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

// ── BKL-089 — product NAME→id resolution + payload rewrite ───────────────────
//
// When the direct id lookup MISSES and `listProductsByName` is wired, the
// resolver treats payload.productId as a NAME, resolves it deterministically,
// and REWRITES productId to the resolved id — the rebuilt envelope's intentHash
// then covers the RESOLVED payload (the chat-plane BKL-028/061 posture). A
// none/ambiguous outcome leaves the payload untouched (product stays null).

function candidate(id: string, title: string, status = "published"): ProductCandidate {
  return { id, title, status };
}

/** The canonical hash a direct buildEnvelope over the FINAL payload produces —
 *  same actor/taint/nonce/createdAt as `opsEnvelope`. */
function hashOver(kind: string, payload: Record<string, unknown>): string {
  return (
    buildEnvelope({
      kind,
      payload,
      actor: { principal: "user", sessionId: "admin:staff_1", role: "OWNER" },
      taint: "UNTRUSTED",
      nonce: "n-1",
      createdAt: "2026-07-04T12:00:00.000Z",
    }) as IntentEnvelope
  ).intentHash;
}

describe("ops resolver — product name→id resolution (BKL-089)", () => {
  it("id lookup MISS → name resolves → payload productId rewritten + product PRESENT", async () => {
    const listProductsByName = vi.fn(async () => [candidate("prod_42", "Picanha")]);
    const deps = makeDeps({
      lookupProduct: vi.fn(async () => null), // direct id lookup misses
      listProductsByName,
    });
    const env = opsEnvelope("product.availability.set", {
      productId: "picanha",
      available: false,
      reason: "acabou",
    });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));

    // product PRESENT (from the name resolution) ⇒ requireProductExists passes.
    expect((resolved!.state as { product: unknown }).product).toEqual({
      id: "prod_42",
      status: "published",
    });
    // productId REWRITTEN to the resolved id; every other field preserved.
    expect(resolved!.envelope.payload).toEqual({
      productId: "prod_42",
      available: false,
      reason: "acabou",
    });
    expect(listProductsByName).toHaveBeenCalledTimes(1);
  });

  it("the rebuilt intentHash covers the REWRITTEN payload (not the original name)", async () => {
    const deps = makeDeps({
      lookupProduct: vi.fn(async () => null),
      listProductsByName: vi.fn(async () => [candidate("prod_42", "Picanha")]),
    });
    const env = opsEnvelope("product.availability.set", {
      productId: "picanha",
      available: false,
      reason: "acabou",
    });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));

    // Equals a direct buildEnvelope over the FINAL (resolved) payload …
    expect(resolved!.envelope.intentHash).toBe(
      hashOver("product.availability.set", {
        productId: "prod_42",
        available: false,
        reason: "acabou",
      }),
    );
    // … and DIFFERS from the original name-payload hash (the payload changed).
    expect(resolved!.envelope.intentHash).not.toBe(env.intentHash);
  });

  it("resolution NEVER touches the envelope actor/taint/nonce (adversarial pin)", async () => {
    const deps = makeDeps({
      lookupProduct: vi.fn(async () => null),
      listProductsByName: vi.fn(async () => [candidate("prod_42", "Picanha")]),
    });
    const env = opsEnvelope("product.availability.set", {
      productId: "picanha",
      available: true,
    });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect(resolved!.envelope.actor).toEqual(env.actor);
    expect(resolved!.envelope.taint).toBe("UNTRUSTED");
    expect(resolved!.envelope.nonce).toBe("n-1");
  });

  it("AMBIGUOUS name → payload UNTOUCHED + product:null (honest REFUSE)", async () => {
    const deps = makeDeps({
      lookupProduct: vi.fn(async () => null),
      listProductsByName: vi.fn(async () => [
        candidate("prod_1", "Coca-Cola Lata"),
        candidate("prod_2", "Coca-Cola Zero"),
      ]),
    });
    const env = opsEnvelope("product.availability.set", {
      productId: "coca-cola",
      available: false,
    });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect((resolved!.state as { product: unknown }).product).toBeNull();
    // Payload unchanged ⇒ same canonical hash as the original.
    expect(resolved!.envelope.payload).toEqual({ productId: "coca-cola", available: false });
    expect(resolved!.envelope.intentHash).toBe(env.intentHash);
  });

  it("NONE (no match) → payload UNTOUCHED + product:null", async () => {
    const deps = makeDeps({
      lookupProduct: vi.fn(async () => null),
      listProductsByName: vi.fn(async () => [candidate("prod_1", "Picanha")]),
    });
    const env = opsEnvelope("product.availability.set", {
      productId: "brisket",
      available: false,
    });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect((resolved!.state as { product: unknown }).product).toBeNull();
    expect(resolved!.envelope.payload).toEqual({ productId: "brisket", available: false });
  });

  it("direct id lookup HIT → name resolver NOT consulted (id-literal path intact)", async () => {
    const listProductsByName = vi.fn(async () => [candidate("prod_x", "Other")]);
    const deps = makeDeps({
      lookupProduct: vi.fn(async () => ({ id: "prod_1", status: "published" })),
      listProductsByName,
    });
    const env = opsEnvelope("product.availability.set", { productId: "prod_1", available: false });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect((resolved!.state as { product: { id: string } }).product.id).toBe("prod_1");
    expect(resolved!.envelope.payload).toEqual({ productId: "prod_1", available: false });
    expect(listProductsByName).not.toHaveBeenCalled();
  });

  it("no name-resolver wired (v1) → MISS stays product:null, payload untouched", async () => {
    // makeDeps omits listProductsByName ⇒ byte-identical to the id-literal v1.
    const deps = makeDeps({ lookupProduct: vi.fn(async () => null) });
    const env = opsEnvelope("product.availability.set", { productId: "picanha", available: false });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect((resolved!.state as { product: unknown }).product).toBeNull();
    expect(resolved!.envelope.payload).toEqual({ productId: "picanha", available: false });
    expect(resolved!.envelope.intentHash).toBe(env.intentHash);
  });
});

// ── NEW-004 — product.price.set state projection + name resolution ────────────

const PRICING = {
  id: "prod_1",
  status: "published",
  name: "Picanha",
  currentPriceCentavos: 8900,
  divergentVariantPrices: false,
};

describe("ops resolver — product.price.set state (NEW-004)", () => {
  it("projects { ctx, priceProduct } from the pricing lookup", async () => {
    const deps = makeDeps({ lookupProductPricing: vi.fn(async () => PRICING) });
    const [resolved] = await createOpsResolver(deps).resolve(
      input(opsEnvelope("product.price.set", { productId: "prod_1", priceCentavos: 9500 })),
    );
    expect(resolved!.state).toEqual({
      ctx: {
        channel: "staff",
        customerId: null,
        staffId: "staff_1",
        tenantId: "ibatexas",
      },
      priceProduct: PRICING,
    });
  });

  it("carries the divergent-variant flag through (⇒ requireUniformVariantPricing REFUSEs)", async () => {
    const deps = makeDeps({
      lookupProductPricing: vi.fn(async () => ({ ...PRICING, divergentVariantPrices: true })),
    });
    const [resolved] = await createOpsResolver(deps).resolve(
      input(opsEnvelope("product.price.set", { productId: "prod_1", priceCentavos: 9500 })),
    );
    expect(
      (resolved!.state as { priceProduct: { divergentVariantPrices: boolean } }).priceProduct
        .divergentVariantPrices,
    ).toBe(true);
  });

  it("pricing missing ⇒ priceProduct:null (REFUSE product_not_found)", async () => {
    const deps = makeDeps({ lookupProductPricing: vi.fn(async () => null) });
    const [resolved] = await createOpsResolver(deps).resolve(
      input(opsEnvelope("product.price.set", { productId: "ghost", priceCentavos: 9500 })),
    );
    expect((resolved!.state as { priceProduct: unknown }).priceProduct).toBeNull();
  });

  it("pricing lookup THROW is fail-closed to priceProduct:null (never crashes the turn)", async () => {
    const deps = makeDeps({
      lookupProductPricing: vi.fn(async () => {
        throw new Error("medusa down");
      }),
    });
    const [resolved] = await createOpsResolver(deps).resolve(
      input(opsEnvelope("product.price.set", { productId: "prod_1", priceCentavos: 9500 })),
    );
    expect((resolved!.state as { priceProduct: unknown }).priceProduct).toBeNull();
  });

  it("no pricing lookup wired (inert) → priceProduct:null, payload untouched", async () => {
    const deps = makeDeps(); // omits lookupProductPricing
    const env = opsEnvelope("product.price.set", { productId: "prod_1", priceCentavos: 9500 });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect((resolved!.state as { priceProduct: unknown }).priceProduct).toBeNull();
    expect(resolved!.envelope.intentHash).toBe(env.intentHash);
  });

  it("id lookup MISS → name resolves → pricing by resolved id → priceProduct present + payload rewritten", async () => {
    const listProductsByName = vi.fn(async () => [candidate("prod_42", "Picanha")]);
    // Direct id lookup (by the name string) misses; the by-resolved-id lookup hits.
    const lookupProductPricing = vi.fn(async (id: string) =>
      id === "prod_42" ? { ...PRICING, id: "prod_42" } : null,
    );
    const deps = makeDeps({ listProductsByName, lookupProductPricing });
    const env = opsEnvelope("product.price.set", {
      productId: "picanha",
      priceCentavos: 9500,
      reason: "reajuste",
    });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));

    expect((resolved!.state as { priceProduct: { id: string } }).priceProduct.id).toBe("prod_42");
    // productId REWRITTEN to the resolved id; every other field preserved.
    expect(resolved!.envelope.payload).toEqual({
      productId: "prod_42",
      priceCentavos: 9500,
      reason: "reajuste",
    });
    // The rebuilt intentHash covers the RESOLVED payload.
    expect(resolved!.envelope.intentHash).toBe(
      hashOver("product.price.set", {
        productId: "prod_42",
        priceCentavos: 9500,
        reason: "reajuste",
      }),
    );
  });

  it("name resolves but the product is BRL-priceless (pricing null) → payload UNTOUCHED + priceProduct null", async () => {
    const deps = makeDeps({
      listProductsByName: vi.fn(async () => [candidate("prod_42", "Picanha")]),
      lookupProductPricing: vi.fn(async () => null), // both the id AND the resolved-id lookup miss
    });
    const env = opsEnvelope("product.price.set", { productId: "picanha", priceCentavos: 9500 });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect((resolved!.state as { priceProduct: unknown }).priceProduct).toBeNull();
    expect(resolved!.envelope.payload).toEqual({ productId: "picanha", priceCentavos: 9500 });
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
        // FE-T05 — a direct id hit (an explicit reference) is authoritative,
        // never grounded: `requireConfirmationOnGroundedStatusTransition`
        // does not fire.
        orderResolutionTrust: "authoritative",
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

// ── BKL-089 — order REFERENCE→id resolution + payload rewrite ────────────────
//
// When the direct id lookup MISSES and `orderReferenceReads` is wired, the
// resolver treats payload.orderId as a staff REFERENCE (display number "4242" or
// a customer name), resolves it deterministically, and REWRITES orderId to the
// resolved order id for BOTH order kinds — the rebuilt envelope's intentHash then
// covers the RESOLVED payload. A none/ambiguous outcome leaves the payload
// untouched (ctx.orderId stays null → honest REFUSE no_order). The resolution
// NEVER touches the envelope actor.

function orderCandidate(over: Partial<OrderCandidate> = {}): OrderCandidate {
  return {
    id: "order_99",
    displayId: 4242,
    customerName: "Maria Silva",
    fulfillmentStatus: "preparing",
    customerId: "cust_9",
    paymentMethod: "pix",
    paymentStatus: "confirmed",
    totalInCentavos: 7000,
    ...over,
  };
}

function orderReads(opts: {
  byDisplayId?: OrderCandidate[];
  recentActive?: OrderCandidate[];
}): OrderReferenceReads {
  return {
    findByDisplayId: vi.fn(async () => opts.byDisplayId ?? []),
    listRecentActive: vi.fn(async () => opts.recentActive ?? []),
  };
}

describe("ops resolver — order reference→id resolution (BKL-089, orders scope)", () => {
  it("note.add: id MISS → displayId '4242' resolves → orderId rewritten + state PRESENT", async () => {
    const deps = makeDeps({
      lookupOrder: vi.fn(async () => null), // direct id lookup misses
      orderReferenceReads: orderReads({
        byDisplayId: [orderCandidate({ id: "order_99", displayId: 4242 })],
      }),
    });
    const env = opsEnvelope("order.note.add", { orderId: "4242", body: "nota" });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));

    // ctx.orderId is the RESOLVED id (not the spoken number) → guard passes.
    expect(resolved!.state).toEqual({
      ctx: {
        channel: "web",
        customerId: "cust_9",
        cartId: null,
        orderId: "order_99",
        paymentMethod: "pix",
        paymentStatus: "confirmed",
        totalInCentavos: 7000,
      },
    });
    // payload.orderId REWRITTEN; body preserved.
    expect(resolved!.envelope.payload).toEqual({ orderId: "order_99", body: "nota" });
  });

  it("note.add: the rebuilt intentHash covers the REWRITTEN payload (not the reference)", async () => {
    const deps = makeDeps({
      lookupOrder: vi.fn(async () => null),
      orderReferenceReads: orderReads({
        byDisplayId: [orderCandidate({ id: "order_99", displayId: 4242 })],
      }),
    });
    const env = opsEnvelope("order.note.add", { orderId: "4242", body: "nota" });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));

    expect(resolved!.envelope.intentHash).toBe(
      hashOver("order.note.add", { orderId: "order_99", body: "nota" }),
    );
    expect(resolved!.envelope.intentHash).not.toBe(env.intentHash);
  });

  it("resolution NEVER touches the envelope actor/taint/nonce (adversarial pin)", async () => {
    const deps = makeDeps({
      lookupOrder: vi.fn(async () => null),
      orderReferenceReads: orderReads({
        byDisplayId: [orderCandidate({ id: "order_99", displayId: 4242 })],
      }),
    });
    const env = opsEnvelope("order.note.add", { orderId: "4242", body: "nota" });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect(resolved!.envelope.actor).toEqual(env.actor);
    expect(resolved!.envelope.taint).toBe("UNTRUSTED");
    expect(resolved!.envelope.nonce).toBe("n-1");
  });

  it("status.transition: id MISS → customer name resolves → orderId rewritten + CURRENT status present", async () => {
    const deps = makeDeps({
      lookupOrder: vi.fn(async () => null),
      orderReferenceReads: orderReads({
        recentActive: [
          orderCandidate({ id: "order_m", customerName: "Maria", fulfillmentStatus: "preparing" }),
        ],
      }),
    });
    const env = opsEnvelope("order.status.transition", { orderId: "Maria", newStatus: "ready" });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));

    expect(resolved!.state).toEqual({
      ctx: {
        channel: "web",
        customerId: "cust_9",
        cartId: null,
        orderId: "order_m",
        fulfillmentStatus: "preparing",
        // FE-T05 — an explicit customer-name reference is authoritative.
        orderResolutionTrust: "authoritative",
      },
    });
    expect(resolved!.envelope.payload).toEqual({ orderId: "order_m", newStatus: "ready" });
    expect(resolved!.envelope.intentHash).toBe(
      hashOver("order.status.transition", { orderId: "order_m", newStatus: "ready" }),
    );
  });

  it("AMBIGUOUS reference → payload UNTOUCHED + ctx.orderId null (honest REFUSE no_order)", async () => {
    const deps = makeDeps({
      lookupOrder: vi.fn(async () => null),
      orderReferenceReads: orderReads({
        byDisplayId: [
          orderCandidate({ id: "order_a", displayId: 4242 }),
          orderCandidate({ id: "order_b", displayId: 4242 }),
        ],
      }),
    });
    const env = opsEnvelope("order.note.add", { orderId: "4242", body: "nota" });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect((resolved!.state as { ctx: { orderId: unknown } }).ctx.orderId).toBeNull();
    expect(resolved!.envelope.payload).toEqual({ orderId: "4242", body: "nota" });
    expect(resolved!.envelope.intentHash).toBe(env.intentHash);
  });

  it("NONE (no match) → payload UNTOUCHED + ctx.orderId null", async () => {
    const deps = makeDeps({
      lookupOrder: vi.fn(async () => null),
      orderReferenceReads: orderReads({ byDisplayId: [], recentActive: [] }),
    });
    const env = opsEnvelope("order.note.add", { orderId: "9999", body: "nota" });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect((resolved!.state as { ctx: { orderId: unknown } }).ctx.orderId).toBeNull();
    expect(resolved!.envelope.payload).toEqual({ orderId: "9999", body: "nota" });
  });

  it("direct id lookup HIT → reference reads NOT consulted (id-literal path intact)", async () => {
    const reads = orderReads({ byDisplayId: [orderCandidate({ id: "order_other" })] });
    const deps = makeDeps({
      lookupOrder: vi.fn(async () => ({
        customerId: "cust_1",
        paymentMethod: "pix",
        paymentStatus: "confirmed",
        totalInCentavos: 5000,
        fulfillmentStatus: "confirmed",
      })),
      orderReferenceReads: reads,
    });
    const env = opsEnvelope("order.note.add", { orderId: "order_1", body: "nota" });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect((resolved!.state as { ctx: { orderId: unknown } }).ctx.orderId).toBe("order_1");
    expect(resolved!.envelope.payload).toEqual({ orderId: "order_1", body: "nota" });
    expect(reads.findByDisplayId).not.toHaveBeenCalled();
    expect(reads.listRecentActive).not.toHaveBeenCalled();
  });

  it("no reference reads wired (v1) → MISS stays ctx.orderId null, payload untouched (parity)", async () => {
    // makeDeps omits orderReferenceReads ⇒ byte-identical to the id-literal v1.
    const deps = makeDeps({ lookupOrder: vi.fn(async () => null) });
    const env = opsEnvelope("order.note.add", { orderId: "4242", body: "nota" });
    const [resolved] = await createOpsResolver(deps).resolve(input(env));
    expect((resolved!.state as { ctx: { orderId: unknown } }).ctx.orderId).toBeNull();
    expect(resolved!.envelope.payload).toEqual({ orderId: "4242", body: "nota" });
    expect(resolved!.envelope.intentHash).toBe(env.intentHash);
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

// ── BKL-085 — payment.refund.issue resolution + STOP-GATE B balance stamping ──

/** An active refundable payment fake (the shape lookupActivePayment returns). */
const ACTIVE_PAID = {
  paymentId: "pay_db_1",
  status: "paid",
  amountInCentavos: 10_000,
  refundedAmountCentavos: 0,
  method: "pix",
  version: 3,
};

function refundDeps(over: Partial<OpsResolverDeps> = {}): OpsResolverDeps {
  return makeDeps({
    lookupActivePayment: vi.fn(async () => ACTIVE_PAID),
    ...over,
  });
}

async function resolveRefund(
  deps: OpsResolverDeps,
  payload: Record<string, unknown>,
) {
  const [resolved] = await createOpsResolver(deps).resolve(
    input(opsEnvelope("payment.refund.issue", payload)),
  );
  return resolved!;
}

describe("ops resolver — payment.refund.issue (BKL-085)", () => {
  it("stamps paymentId + balance fields from the DB row; model controls only amount + reason", async () => {
    const resolved = await resolveRefund(refundDeps(), {
      orderId: "order_direct",
      refundAmountCentavos: 3_000,
      reason: "cliente reclamou",
    });
    const p = resolved.envelope.payload as Record<string, unknown>;
    // Model-controlled:
    expect(p.refundAmountCentavos).toBe(3_000);
    expect(p.reason).toBe("cliente reclamou");
    // STAMPED from the DB row (never the model):
    expect(p.paymentId).toBe("pay_db_1");
    expect(p.refundableBalanceCentavos).toBe(10_000); // amount - refunded
    expect(p.amountInCentavos).toBe(10_000);
    expect(p.currentRefundedCentavos).toBe(0);
    // Identity stamped from the authenticated staffId:
    expect(p.actor).toBe("admin");
    expect(p.actorId).toBe("staff_1");
    // The pack PaymentState carries the DB status/balance the guards read.
    const state = resolved.state as { ctx: Record<string, unknown> };
    expect(state.ctx.exists).toBe(true);
    expect(state.ctx.currentStatus).toBe("paid");
    expect(state.ctx.amountInCentavos).toBe(10_000);
    expect(state.ctx.isTerminal).toBe(false);
  });

  it("STOP-GATE B: a model-forged high balance is OVERWRITTEN from the DB row", async () => {
    const resolved = await resolveRefund(refundDeps(), {
      orderId: "order_direct",
      refundAmountCentavos: 9_000,
      // Model tries to forge a huge refundable balance to defeat the over-balance guard.
      refundableBalanceCentavos: 999_999_999,
      amountInCentavos: 999_999_999,
      currentRefundedCentavos: 0,
      actor: "system",
      actorId: "forged_staff",
    });
    const p = resolved.envelope.payload as Record<string, unknown>;
    // Every forgeable field reflects DB truth, not the model's inflated values.
    expect(p.refundableBalanceCentavos).toBe(10_000);
    expect(p.amountInCentavos).toBe(10_000);
    expect(p.actor).toBe("admin");
    expect(p.actorId).toBe("staff_1");
  });

  it("defaults refundAmountCentavos to the FULL refundable balance when the model omits it", async () => {
    const resolved = await resolveRefund(refundDeps({
      lookupActivePayment: vi.fn(async () => ({
        ...ACTIVE_PAID,
        status: "partially_refunded",
        refundedAmountCentavos: 4_000,
      })),
    }), { orderId: "order_direct" });
    const p = resolved.envelope.payload as Record<string, unknown>;
    // Full remaining balance = 10_000 - 4_000.
    expect(p.refundAmountCentavos).toBe(6_000);
    expect(p.refundableBalanceCentavos).toBe(6_000);
    expect(p.currentRefundedCentavos).toBe(4_000);
  });

  it("no active payment ⇒ exists:false (REFUSE payment_not_found, never an executor throw)", async () => {
    const resolved = await resolveRefund(
      refundDeps({ lookupActivePayment: vi.fn(async () => null) }),
      { orderId: "order_direct", refundAmountCentavos: 1_000 },
    );
    expect((resolved.state as { ctx: { exists: boolean } }).ctx.exists).toBe(false);
  });

  it("a non-refundable active status (awaiting_payment) fails closed to exists:false", async () => {
    const resolved = await resolveRefund(
      refundDeps({
        lookupActivePayment: vi.fn(async () => ({
          ...ACTIVE_PAID,
          status: "awaiting_payment",
        })),
      }),
      { orderId: "order_direct", refundAmountCentavos: 1_000 },
    );
    expect((resolved.state as { ctx: { exists: boolean } }).ctx.exists).toBe(false);
  });

  it("order reference that does not resolve ⇒ exists:false", async () => {
    const resolved = await resolveRefund(
      refundDeps({ lookupOrder: vi.fn(async () => null) }),
      { orderId: "não-existe", refundAmountCentavos: 1_000 },
    );
    expect((resolved.state as { ctx: { exists: boolean } }).ctx.exists).toBe(false);
  });

  it("lookupActivePayment ABSENT ⇒ refund inert (exists:false)", async () => {
    // makeDeps() has no lookupActivePayment wired.
    const resolved = await resolveRefund(makeDeps(), {
      orderId: "order_direct",
      refundAmountCentavos: 1_000,
    });
    expect((resolved.state as { ctx: { exists: boolean } }).ctx.exists).toBe(false);
  });

  it("resolves the order via displayId reference before locating the payment", async () => {
    const candidate: OrderCandidate = {
      id: "order_resolved",
      displayId: 4242,
      customerName: "Maria",
      fulfillmentStatus: "confirmed",
      customerId: "cust_1",
      paymentMethod: "pix",
      paymentStatus: "paid",
      totalInCentavos: 10_000,
    };
    const lookupActivePayment = vi.fn(async (orderId: string) =>
      orderId === "order_resolved" ? ACTIVE_PAID : null,
    );
    const refs: OrderReferenceReads = {
      findByDisplayId: async (d) => (d === 4242 ? [candidate] : []),
      listRecentActive: async () => [],
    };
    const resolved = await resolveRefund(
      refundDeps({
        lookupOrder: vi.fn(async () => null), // direct id miss ⇒ reference resolution
        orderReferenceReads: refs,
        lookupActivePayment,
      }),
      { orderId: "4242", refundAmountCentavos: 5_000 },
    );
    // The payment was located against the RESOLVED order id.
    expect(lookupActivePayment).toHaveBeenCalledWith("order_resolved");
    const p = resolved.envelope.payload as Record<string, unknown>;
    expect(p.paymentId).toBe("pay_db_1");
    expect((resolved.state as { ctx: { exists: boolean } }).ctx.exists).toBe(true);
  });
});

// ── BKL-094 — refund amount threading (reais aliases → exact centavos) ─────────
// Live proof: both the 4B and Sonnet emit the spoken figure under
// `amount`/`value`/`valor` in REAIS ("reembolsa 10 reais" → {amount:10}); the
// resolver threads that to `refundAmountCentavos` in EXACT centavos. Priority:
// centavos field → reais aliases → the confirm-gated full-balance default.
// ACTIVE_PAID balance = R$100 (10_000 centavos).

/** Read the requested amount the resolver stamped onto the rebuilt payload. */
async function requestedRefundCentavos(
  payload: Record<string, unknown>,
): Promise<number> {
  const resolved = await resolveRefund(refundDeps(), {
    orderId: "order_direct",
    ...payload,
  });
  const p = resolved.envelope.payload as Record<string, unknown>;
  return p.refundAmountCentavos as number;
}

describe("ops resolver — BKL-094 refund amount threading", () => {
  it("prefers refundAmountCentavos (centavos) over a reais alias", async () => {
    // Schema-correct centavos wins even when a reais alias is also present.
    expect(await requestedRefundCentavos({ refundAmountCentavos: 2_500, amount: 10 })).toBe(2_500);
  });

  it("amount/value/valor are interpreted as REAIS → ×100 centavos", async () => {
    expect(await requestedRefundCentavos({ amount: 10 })).toBe(1_000);
    expect(await requestedRefundCentavos({ value: 10 })).toBe(1_000);
    expect(await requestedRefundCentavos({ valor: 10 })).toBe(1_000);
  });

  it("alias priority is amount → value → valor", async () => {
    expect(await requestedRefundCentavos({ amount: 10, value: 20, valor: 30 })).toBe(1_000);
    expect(await requestedRefundCentavos({ value: 20, valor: 30 })).toBe(2_000);
  });

  it("converts decimals EXACTLY (no float multiply-and-round hazard)", async () => {
    expect(await requestedRefundCentavos({ amount: 10.5 })).toBe(1_050);
    expect(await requestedRefundCentavos({ amount: 10.55 })).toBe(1_055); // 10.55*100 === 1054.999… in float
    expect(await requestedRefundCentavos({ amount: 0.5 })).toBe(50);
  });

  it("accepts pt-BR string forms defensively ('10,50', 'R$ 10,50', '10.50')", async () => {
    expect(await requestedRefundCentavos({ amount: "10,50" })).toBe(1_050);
    expect(await requestedRefundCentavos({ amount: "R$ 10,50" })).toBe(1_050);
    expect(await requestedRefundCentavos({ amount: "10.50" })).toBe(1_050);
    expect(await requestedRefundCentavos({ amount: "10" })).toBe(1_000);
  });

  it(">2 decimal places is rejected → confirm-gated FULL balance", async () => {
    // 10.555 is not a representable centavos amount → keep the honest full-balance default.
    expect(await requestedRefundCentavos({ amount: 10.555 })).toBe(10_000);
    expect(await requestedRefundCentavos({ amount: "10,555" })).toBe(10_000);
  });

  it("≤0 / non-numeric / null fall back to the FULL balance (never a silent wrong number)", async () => {
    // NB: a real NaN/Infinity can never arrive — a model tool call is JSON, which
    // has no such literals (buildEnvelope's canonical hash even rejects them). The
    // parser guards them defensively; here we exercise the JSON-representable forms.
    expect(await requestedRefundCentavos({ amount: 0 })).toBe(10_000);
    expect(await requestedRefundCentavos({ amount: -5 })).toBe(10_000);
    expect(await requestedRefundCentavos({ amount: "abc" })).toBe(10_000);
    expect(await requestedRefundCentavos({ amount: "NaN" })).toBe(10_000);
    expect(await requestedRefundCentavos({ amount: null })).toBe(10_000);
    expect(await requestedRefundCentavos({ amount: "1.000,50" })).toBe(10_000); // ambiguous thousands grouping → reject
    expect(await requestedRefundCentavos({})).toBe(10_000); // nothing supplied
  });

  it("an over-balance amount passes through UN-CLAMPED (pack REFUSEs honestly)", async () => {
    // R$150 > the R$100 DB balance — the request is threaded verbatim (15_000),
    // NOT reduced to the balance; the stamped balance stays the true DB value so
    // the pack's over-balance guard REFUSEs on truth.
    const resolved = await resolveRefund(refundDeps(), { orderId: "order_direct", amount: 150 });
    const p = resolved.envelope.payload as Record<string, unknown>;
    expect(p.refundAmountCentavos).toBe(15_000);
    expect(p.refundableBalanceCentavos).toBe(10_000);
  });

  it("a non-integer refundAmountCentavos (centavos schema violated) falls through to reais aliases", async () => {
    // 10.5 is not integer centavos → NOT trusted as centavos; the reais alias wins.
    expect(await requestedRefundCentavos({ refundAmountCentavos: 10.5, amount: 25 })).toBe(2_500);
  });
});

// ── BKL-085 — buildOpsRefundResumeState (the resume-path re-projection) ────────

describe("buildOpsRefundResumeState — money-safe resume re-projection", () => {
  it("null payment ⇒ exists:false (clean payment_not_found REFUSE on resume)", () => {
    const state = buildOpsRefundResumeState(null, "ibatexas") as {
      ctx: { exists: boolean };
    };
    expect(state.ctx.exists).toBe(false);
  });

  it("a paid payment ⇒ exists:true, non-terminal, live balance", () => {
    const state = buildOpsRefundResumeState(
      {
        status: "paid",
        amountInCentavos: 10_000,
        refundedAmountCentavos: 2_000,
        method: "pix",
        version: 7,
        orderId: "order_1",
      },
      "ibatexas",
    ) as { ctx: Record<string, unknown> };
    expect(state.ctx.exists).toBe(true);
    expect(state.ctx.isTerminal).toBe(false);
    expect(state.ctx.currentStatus).toBe("paid");
    // The LIVE refunded amount the magnitude guard's divergence check reads.
    expect(state.ctx.refundedAmountCentavos).toBe(2_000);
    expect(state.ctx.amountInCentavos).toBe(10_000);
    expect(state.ctx.tenantId).toBe("ibatexas");
  });

  it("a since-parked REFUNDED (terminal, non-refundable) payment ⇒ exists:false (FIX 2 — refundability re-applied on resume)", () => {
    // AUT-017 FIX 2: buildOpsRefundResumeState re-applies OPS_REFUNDABLE_STATUSES,
    // so a payment that left a refundable state since parking projects exists:false
    // (⇒ kernel REFUSE) rather than exists:true + isTerminal — a stronger,
    // status-explicit gate than relying on the terminal check alone.
    const state = buildOpsRefundResumeState(
      {
        status: "refunded",
        amountInCentavos: 10_000,
        refundedAmountCentavos: 10_000,
        method: "pix",
        version: 8,
      },
      "ibatexas",
    ) as { ctx: { exists: boolean } };
    expect(state.ctx.exists).toBe(false);
  });

  it("a since-parked DISPUTED (non-terminal, NON-refundable) payment ⇒ exists:false (FIX 2 — no refund-on-chargeback)", () => {
    // DISPUTED is non-terminal AND canTransition("disputed","refunded")===true, so
    // the terminal guard alone would MISS it; re-applying refundability is what
    // stops a refund-on-chargeback double-payment.
    const state = buildOpsRefundResumeState(
      {
        status: "disputed",
        amountInCentavos: 10_000,
        refundedAmountCentavos: 0,
        method: "pix",
        version: 9,
      },
      "ibatexas",
    ) as { ctx: { exists: boolean } };
    expect(state.ctx.exists).toBe(false);
  });
});

// ── schedule.override.set state + NL-date normalization (SCN-127) ─────────────
//
// The resolver normalizes the owner's relative date word to a CONCRETE ISO date
// in RESTAURANT_TIMEZONE and STAMPS it into the payload BEFORE adjudication (the
// intentHash then covers the resolved date), and projects the today-or-future
// reference into `state.schedule.today`. The clock is injected (`now`) so the
// normalization is deterministic — frozen to the 2026-07-04 business day here.

const FIXED_NOW = () => new Date("2026-07-04T12:00:00.000Z");

function scheduleDeps(over: Partial<OpsResolverDeps> = {}): OpsResolverDeps {
  return makeDeps({ now: FIXED_NOW, ...over });
}

describe("ops resolver — schedule.override.set state (SCN-127)", () => {
  it('normalizes "amanhã" → the concrete next business day + projects today', async () => {
    const [resolved] = await createOpsResolver(scheduleDeps()).resolve(
      input(opsEnvelope("schedule.override.set", { date: "amanhã", isOpen: false })),
    );
    // 2026-07-04 (SP business day) + 1 = 2026-07-05, stamped into the payload.
    expect((resolved!.envelope.payload as { date: string }).date).toBe("2026-07-05");
    expect(resolved!.state).toEqual({
      ctx: {
        channel: "staff",
        customerId: null,
        staffId: "staff_1",
        tenantId: "ibatexas",
      },
      schedule: { today: "2026-07-04" },
    });
  });

  it('normalizes "hoje" → today (today-or-future is inclusive)', async () => {
    const [resolved] = await createOpsResolver(scheduleDeps()).resolve(
      input(opsEnvelope("schedule.override.set", { date: "hoje", isOpen: false })),
    );
    expect((resolved!.envelope.payload as { date: string }).date).toBe("2026-07-04");
  });

  it("passes an explicit ISO date through unchanged (no rewrite)", async () => {
    const [resolved] = await createOpsResolver(scheduleDeps()).resolve(
      input(opsEnvelope("schedule.override.set", { date: "2026-07-20", isOpen: false })),
    );
    expect((resolved!.envelope.payload as { date: string }).date).toBe("2026-07-20");
  });

  it("normalizes a weekday name to the nearest upcoming such day", async () => {
    // 2026-07-04 is a Saturday; the next Wednesday ("quarta") is 2026-07-08.
    const [resolved] = await createOpsResolver(scheduleDeps()).resolve(
      input(opsEnvelope("schedule.override.set", { date: "quarta", isOpen: false })),
    );
    expect((resolved!.envelope.payload as { date: string }).date).toBe("2026-07-08");
  });

  it("leaves an UNRESOLVABLE word VERBATIM (⇒ pack validator REFUSEs, fail-closed)", async () => {
    const [resolved] = await createOpsResolver(scheduleDeps()).resolve(
      input(opsEnvelope("schedule.override.set", { date: "qualquer dia", isOpen: false })),
    );
    // Untouched — the pack `validateScheduleOverridePayload` REFUSEs (not ISO).
    expect((resolved!.envelope.payload as { date: string }).date).toBe("qualquer dia");
    expect((resolved!.state as { schedule: { today: string } }).schedule.today).toBe(
      "2026-07-04",
    );
  });

  it("preserves the envelope actor/taint/nonce on the date rewrite (adversarial pin)", async () => {
    const env = opsEnvelope("schedule.override.set", { date: "amanhã", isOpen: false });
    const [resolved] = await createOpsResolver(scheduleDeps()).resolve(input(env));
    expect(resolved!.envelope.actor).toEqual(env.actor);
    expect(resolved!.envelope.taint).toBe(env.taint);
    expect(resolved!.envelope.nonce).toBe(env.nonce);
  });
});

// ── menu.special.set state + date/price normalization (SCN-114) ──────────────

describe("ops resolver — menu.special.set state (SCN-114)", () => {
  const specialProduct = { id: "prod_1", status: "published", name: "Feijoada" };
  const specialDeps = (over: Partial<OpsResolverDeps> = {}) =>
    makeDeps({
      lookupSpecialProduct: vi.fn(async (id: string) =>
        id === "prod_1" ? specialProduct : null,
      ),
      ...over,
    });
  const resolveSpecial = (deps: OpsResolverDeps, payload: Record<string, unknown>) =>
    createOpsResolver(deps).resolve(input(opsEnvelope("menu.special.set", payload)));

  const withFrozenClock = async (run: () => Promise<void>) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T12:00:00.000Z")); // 09:00 in America/Sao_Paulo
    const prev = process.env.RESTAURANT_TIMEZONE;
    process.env.RESTAURANT_TIMEZONE = "America/Sao_Paulo";
    try {
      await run();
    } finally {
      if (prev === undefined) delete process.env.RESTAURANT_TIMEZONE;
      else process.env.RESTAURANT_TIMEZONE = prev;
      vi.useRealTimers();
    }
  };

  it("projects { ctx, special:{product,todayYmd} } and stamps a concrete date + centavos", async () => {
    await withFrozenClock(async () => {
      const [resolved] = await resolveSpecial(specialDeps(), {
        productId: "prod_1",
        date: "hoje",
        promoPriceCentavos: 4500,
      });
      expect(resolved!.state).toEqual({
        ctx: {
          channel: "staff",
          customerId: null,
          staffId: "staff_1",
          tenantId: "ibatexas",
        },
        special: { product: specialProduct, todayYmd: "2026-07-04" },
      });
      // Canonical payload: concrete date + integer centavos, nothing else.
      expect(resolved!.envelope.payload).toEqual({
        productId: "prod_1",
        date: "2026-07-04",
        promoPriceCentavos: 4500,
      });
    });
  });

  it.each([
    ["hoje", "2026-07-04"],
    ["amanhã", "2026-07-05"],
    ["amanha", "2026-07-05"],
    ["depois de amanhã", "2026-07-06"],
    ["2026-08-01", "2026-08-01"],
  ])("resolves date %s → %s (RESTAURANT_TIMEZONE, frozen clock)", async (raw, expected) => {
    await withFrozenClock(async () => {
      const [resolved] = await resolveSpecial(specialDeps(), {
        productId: "prod_1",
        date: raw,
        promoPriceCentavos: 4500,
      });
      expect((resolved!.envelope.payload as { date: string }).date).toBe(expected);
    });
  });

  it.each([
    [{ promoPriceCentavos: 4500 }, 4500],
    [{ promoPrice: 45 }, 4500],
    [{ promoPrice: "45,50" }, 4550],
    [{ preco: "R$ 45,50" }, 4550],
    [{ valor: 45.5 }, 4550],
  ])("normalizes a spoken promo price %o → %i centavos", async (priceField, expected) => {
    const [resolved] = await resolveSpecial(specialDeps(), {
      productId: "prod_1",
      date: "2026-07-10",
      ...priceField,
    });
    const p = resolved!.envelope.payload as Record<string, unknown>;
    expect(p.promoPriceCentavos).toBe(expected);
    // The reais alias keys are STRIPPED from the canonical payload (closed contract).
    expect(p.promoPrice).toBeUndefined();
    expect(p.valor).toBeUndefined();
    expect(p.preco).toBeUndefined();
  });

  it("omits promoPriceCentavos when no usable price is present (featured without discount)", async () => {
    const [resolved] = await resolveSpecial(specialDeps(), {
      productId: "prod_1",
      date: "2026-07-10",
    });
    expect(
      (resolved!.envelope.payload as Record<string, unknown>).promoPriceCentavos,
    ).toBeUndefined();
  });

  it("name → id: 'feijoada' resolves via listProductsByName; payload productId rewritten", async () => {
    const deps = specialDeps({
      lookupSpecialProduct: vi.fn(async (id: string) =>
        id === "prod_42"
          ? { id: "prod_42", status: "published", name: "Feijoada Completa" }
          : null,
      ),
      listProductsByName: vi.fn(async () => [
        candidate("prod_42", "Feijoada Completa"),
      ]),
    });
    const [resolved] = await resolveSpecial(deps, {
      productId: "feijoada",
      date: "2026-07-10",
      promoPriceCentavos: 4500,
    });
    expect((resolved!.envelope.payload as { productId: string }).productId).toBe(
      "prod_42",
    );
    expect(
      (resolved!.state as { special: { product: { id: string } } }).special.product
        .id,
    ).toBe("prod_42");
  });

  it("product missing ⇒ special.product null (REFUSE product_not_found)", async () => {
    const deps = specialDeps({ lookupSpecialProduct: vi.fn(async () => null) });
    const [resolved] = await resolveSpecial(deps, {
      productId: "ghost",
      date: "2026-07-10",
    });
    expect(
      (resolved!.state as { special: { product: unknown } }).special.product,
    ).toBeNull();
  });

  it("lookupSpecialProduct dep ABSENT ⇒ special.product null (verb inert until wired)", async () => {
    const [resolved] = await resolveSpecial(makeDeps(), {
      productId: "prod_1",
      date: "2026-07-10",
    });
    expect(
      (resolved!.state as { special: { product: unknown } }).special.product,
    ).toBeNull();
  });

  it("buildOpsSpecialResumeState re-projects { ctx, special } from a fresh product read", async () => {
    await withFrozenClock(async () => {
      const state = buildOpsSpecialResumeState(specialProduct, {
        staffId: "staff_9",
        tenantId: "ibatexas",
      }) as { ctx: { staffId: string }; special: { product: unknown; todayYmd: string } };
      expect(state.ctx.staffId).toBe("staff_9");
      expect(state.special.product).toEqual(specialProduct);
      expect(state.special.todayYmd).toBe("2026-07-04");
    });
    // A vanished product ⇒ product null ⇒ product_not_found on resume.
    const gone = buildOpsSpecialResumeState(null, {
      staffId: "staff_9",
      tenantId: "ibatexas",
    }) as { special: { product: unknown } };
    expect(gone.special.product).toBeNull();
  });
});
