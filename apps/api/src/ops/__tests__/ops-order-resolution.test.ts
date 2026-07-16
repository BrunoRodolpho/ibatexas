// ops-order-resolution — deterministic order REFERENCE→id resolution (BKL-089,
// orders scope). The reads are INJECTED as fakes, so these tests pin the STRICT
// policy independent of the real domain reads:
//   - a numeric reference (optionally #-prefixed) resolves by displayId ONLY, on
//     an EXACTLY-ONE match (0 ⇒ none, >1 ⇒ ambiguous — never a guess);
//   - a name reference matches ONLY recent ACTIVE (non-terminal) orders, exact
//     then unique token-subset, on exactly one match;
//   - a terminal order is NEVER matched by name;
//   - a read throw is fail-closed to none; normalization is diacritic/case/
//     whitespace-insensitive.

import { describe, expect, it, vi } from "vitest";
import {
  normalizeOrderRef,
  parseDisplayIdRef,
  resolveMostRecentActiveOrder,
  resolveOrderByReference,
  type OrderCandidate,
  type OrderReferenceReads,
} from "../ops-order-resolution.js";

function order(over: Partial<OrderCandidate> = {}): OrderCandidate {
  return {
    id: "order_1",
    displayId: 4242,
    customerName: "Maria Silva",
    fulfillmentStatus: "preparing",
    customerId: "cust_1",
    paymentMethod: "pix",
    paymentStatus: "confirmed",
    totalInCentavos: 5000,
    ...over,
  };
}

/** Build injected reads from fixed candidate sets (the module owns the matching). */
function reads(opts: {
  byDisplayId?: OrderCandidate[];
  recentActive?: OrderCandidate[];
}): OrderReferenceReads & {
  findByDisplayId: ReturnType<typeof vi.fn>;
  listRecentActive: ReturnType<typeof vi.fn>;
} {
  return {
    findByDisplayId: vi.fn(async (_id: number) => opts.byDisplayId ?? []),
    listRecentActive: vi.fn(async () => opts.recentActive ?? []),
  };
}

describe("normalizeOrderRef", () => {
  it("lowercases, strips diacritics, collapses+trims whitespace", () => {
    expect(normalizeOrderRef("  José   Antônio ")).toBe("jose antonio");
    expect(normalizeOrderRef("MARIA")).toBe("maria");
  });
  it("empty / whitespace-only normalizes to the empty string", () => {
    expect(normalizeOrderRef("   ")).toBe("");
    expect(normalizeOrderRef("")).toBe("");
  });
});

describe("parseDisplayIdRef", () => {
  it("parses plain digits", () => {
    expect(parseDisplayIdRef("4242")).toBe(4242);
  });
  it("strips a leading # and surrounding whitespace", () => {
    expect(parseDisplayIdRef(" #4242 ")).toBe(4242);
  });
  it("parses a leading-zero form to its numeric value", () => {
    expect(parseDisplayIdRef("04242")).toBe(4242);
  });
  it("rejects a non-numeric reference (a name)", () => {
    expect(parseDisplayIdRef("Maria")).toBeNull();
    expect(parseDisplayIdRef("pedido 4242")).toBeNull();
    expect(parseDisplayIdRef("42a")).toBeNull();
  });
  it("rejects zero, negatives, and out-of-int4-range numbers", () => {
    expect(parseDisplayIdRef("0")).toBeNull();
    expect(parseDisplayIdRef("-5")).toBeNull();
    expect(parseDisplayIdRef("9999999999")).toBeNull();
  });
});

describe("resolveOrderByReference — displayId (numeric)", () => {
  it("all-digits '4242' → unique displayId match resolves via displayId", async () => {
    const r = reads({ byDisplayId: [order({ id: "order_42", displayId: 4242 })] });
    const out = await resolveOrderByReference("4242", r);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") {
      expect(out.via).toBe("displayId");
      expect(out.order.id).toBe("order_42");
    }
    expect(r.findByDisplayId).toHaveBeenCalledWith(4242);
    expect(r.listRecentActive).not.toHaveBeenCalled(); // numeric ⇒ displayId-only
  });

  it("'#4242' (hash-prefixed) resolves the same way", async () => {
    const r = reads({ byDisplayId: [order({ id: "order_42", displayId: 4242 })] });
    const out = await resolveOrderByReference("#4242", r);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.order.id).toBe("order_42");
  });

  it("displayId with NO match ⇒ none (never falls through to name)", async () => {
    const r = reads({ byDisplayId: [], recentActive: [order()] });
    const out = await resolveOrderByReference("4242", r);
    expect(out).toEqual({ kind: "none", via: "displayId" });
    expect(r.listRecentActive).not.toHaveBeenCalled();
  });

  it("displayId with MULTIPLE matches ⇒ ambiguous (never a guess)", async () => {
    const r = reads({
      byDisplayId: [
        order({ id: "order_a", displayId: 4242 }),
        order({ id: "order_b", displayId: 4242 }),
      ],
    });
    const out = await resolveOrderByReference("4242", r);
    expect(out.kind).toBe("ambiguous");
    if (out.kind === "ambiguous") {
      expect(out.via).toBe("displayId");
      expect(out.candidates.map((c) => c.id).sort()).toEqual(["order_a", "order_b"]);
    }
  });

  it("a candidate whose displayId does not equal the parsed number is discarded", async () => {
    // Defensive: the read is expected to filter by displayId, but the module
    // re-checks so a loose fake / stray row cannot resolve the wrong order.
    const r = reads({ byDisplayId: [order({ id: "order_x", displayId: 9999 })] });
    const out = await resolveOrderByReference("4242", r);
    expect(out).toEqual({ kind: "none", via: "displayId" });
  });
});

describe("resolveOrderByReference — customer name (secondary)", () => {
  it("unique ACTIVE exact-name match resolves via customer_name", async () => {
    const r = reads({
      recentActive: [
        order({ id: "order_m", customerName: "Maria", fulfillmentStatus: "preparing" }),
        order({ id: "order_j", customerName: "João", fulfillmentStatus: "confirmed" }),
      ],
    });
    const out = await resolveOrderByReference("maria", r);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") {
      expect(out.via).toBe("customer_name");
      expect(out.order.id).toBe("order_m");
    }
  });

  it("first-name reference resolves a full stored name via token-subset ('maria' → 'Maria Silva')", async () => {
    const r = reads({
      recentActive: [order({ id: "order_ms", customerName: "Maria Silva" })],
    });
    const out = await resolveOrderByReference("Maria", r);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.order.id).toBe("order_ms");
  });

  it("token-subset never matches a mere substring ('ana' does NOT resolve 'Joana')", async () => {
    const r = reads({ recentActive: [order({ id: "order_jo", customerName: "Joana" })] });
    const out = await resolveOrderByReference("ana", r);
    expect(out).toEqual({ kind: "none", via: "customer_name" });
  });

  it("MULTIPLE active name matches ⇒ ambiguous (never a guess)", async () => {
    const r = reads({
      recentActive: [
        order({ id: "order_1", customerName: "Maria Silva" }),
        order({ id: "order_2", customerName: "Maria Souza" }),
      ],
    });
    const out = await resolveOrderByReference("maria", r);
    expect(out.kind).toBe("ambiguous");
    if (out.kind === "ambiguous") {
      expect(out.via).toBe("customer_name");
      expect(out.candidates.map((c) => c.id).sort()).toEqual(["order_1", "order_2"]);
    }
  });

  it("a TERMINAL order is NEVER matched by name (excluded even if uniquely named)", async () => {
    const r = reads({
      recentActive: [
        order({ id: "order_done", customerName: "Maria", fulfillmentStatus: "delivered" }),
        order({ id: "order_cxl", customerName: "Maria", fulfillmentStatus: "canceled" }),
      ],
    });
    const out = await resolveOrderByReference("maria", r);
    expect(out).toEqual({ kind: "none", via: "customer_name" });
  });

  it("exact active match wins over an active + a terminal namesake", async () => {
    const r = reads({
      recentActive: [
        order({ id: "order_active", customerName: "Maria", fulfillmentStatus: "ready" }),
        order({ id: "order_done", customerName: "Maria", fulfillmentStatus: "delivered" }),
      ],
    });
    const out = await resolveOrderByReference("maria", r);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.order.id).toBe("order_active");
  });

  it("name matching is diacritic/case-insensitive", async () => {
    const r = reads({ recentActive: [order({ id: "order_j", customerName: "José" })] });
    const out = await resolveOrderByReference("JOSE", r);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.order.id).toBe("order_j");
  });

  it("no active order matches ⇒ none", async () => {
    const r = reads({ recentActive: [order({ customerName: "Carlos" })] });
    const out = await resolveOrderByReference("Maria", r);
    expect(out).toEqual({ kind: "none", via: "customer_name" });
  });

  it("a candidate with an unknown/null status is treated as NOT active", async () => {
    const r = reads({
      recentActive: [
        order({ id: "order_weird", customerName: "Maria", fulfillmentStatus: null }),
      ],
    });
    const out = await resolveOrderByReference("maria", r);
    expect(out).toEqual({ kind: "none", via: "customer_name" });
  });
});

describe("resolveOrderByReference — fail-closed / guards", () => {
  it("empty reference ⇒ none WITHOUT calling any read", async () => {
    const r = reads({ byDisplayId: [order()], recentActive: [order()] });
    const out = await resolveOrderByReference("   ", r);
    expect(out).toEqual({ kind: "none", via: null });
    expect(r.findByDisplayId).not.toHaveBeenCalled();
    expect(r.listRecentActive).not.toHaveBeenCalled();
  });

  it("a displayId read THROW is fail-closed to none (never propagated)", async () => {
    const r: OrderReferenceReads = {
      findByDisplayId: vi.fn(async () => {
        throw new Error("db down");
      }),
      listRecentActive: vi.fn(async () => []),
    };
    const out = await resolveOrderByReference("4242", r);
    expect(out).toEqual({ kind: "none", via: "displayId" });
  });

  it("a recent-active read THROW is fail-closed to none", async () => {
    const r: OrderReferenceReads = {
      findByDisplayId: vi.fn(async () => []),
      listRecentActive: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    const out = await resolveOrderByReference("Maria", r);
    expect(out).toEqual({ kind: "none", via: "customer_name" });
  });

  it("malformed candidates (missing id) are ignored on the displayId path", async () => {
    const r = reads({
      byDisplayId: [
        { ...order({ displayId: 4242 }), id: "" },
        order({ id: "order_ok", displayId: 4242 }),
      ],
    });
    const out = await resolveOrderByReference("4242", r);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.order.id).toBe("order_ok");
  });
});

// ── FE-T05 — "meu último pedido" / "the last order" auto-resolution ────────

describe("resolveMostRecentActiveOrder", () => {
  it("resolves the FIRST active candidate (the read is recency-DESC-ordered)", async () => {
    const r = reads({
      recentActive: [
        order({ id: "order_newest", displayId: 4300, fulfillmentStatus: "preparing" }),
        order({ id: "order_older", displayId: 4200, fulfillmentStatus: "confirmed" }),
      ],
    });
    const out = await resolveMostRecentActiveOrder(r);
    expect(out).toEqual({ kind: "resolved", order: expect.objectContaining({ id: "order_newest" }) });
  });

  it("skips a TERMINAL order at the front — the first ACTIVE one wins", async () => {
    const r = reads({
      recentActive: [
        order({ id: "order_delivered", displayId: 4300, fulfillmentStatus: "delivered" }),
        order({ id: "order_active", displayId: 4200, fulfillmentStatus: "preparing" }),
      ],
    });
    const out = await resolveMostRecentActiveOrder(r);
    expect(out).toEqual({ kind: "resolved", order: expect.objectContaining({ id: "order_active" }) });
  });

  it("no active order at all ⇒ none (fail-closed, never guessed)", async () => {
    const r = reads({ recentActive: [order({ fulfillmentStatus: "delivered" })] });
    const out = await resolveMostRecentActiveOrder(r);
    expect(out).toEqual({ kind: "none" });
  });

  it("an empty recent-orders window ⇒ none", async () => {
    const r = reads({ recentActive: [] });
    const out = await resolveMostRecentActiveOrder(r);
    expect(out).toEqual({ kind: "none" });
  });

  it("a read THROW is fail-closed to none (never propagated)", async () => {
    const r: OrderReferenceReads = {
      findByDisplayId: vi.fn(async () => []),
      listRecentActive: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    const out = await resolveMostRecentActiveOrder(r);
    expect(out).toEqual({ kind: "none" });
  });
});
