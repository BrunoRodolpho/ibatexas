// ops-product-resolution — deterministic product NAME→id resolution (BKL-089).
//
// The catalog read is INJECTED as a fake `listProducts`, so these tests pin the
// STRICT matching policy independent of the real Medusa admin read:
//   exact > unique-substring > (0 | >1 ⇒ no resolution), diacritic/case/
//   whitespace-insensitive, and fail-closed on a lookup throw.

import { describe, expect, it, vi } from "vitest";
import {
  normalizeProductRef,
  resolveProductByName,
  type ProductCandidate,
} from "../ops-product-resolution.js";

function candidate(
  id: string,
  title: string,
  status = "published",
): ProductCandidate {
  return { id, title, status };
}

/** A fake catalog read that ignores the query and returns a fixed candidate set
 *  (the module owns the deterministic matching; the read is just the source). */
function fixedList(candidates: ProductCandidate[]) {
  return vi.fn(async (_query: string) => candidates);
}

describe("normalizeProductRef", () => {
  it("lowercases, strips diacritics, and collapses+trims whitespace", () => {
    expect(normalizeProductRef("  Açaí ")).toBe("acai");
    expect(normalizeProductRef("PICANHA")).toBe("picanha");
    expect(normalizeProductRef("Costela   Bovina")).toBe("costela bovina");
    expect(normalizeProductRef("Pão de Alho")).toBe("pao de alho");
  });

  it("empty / whitespace-only normalizes to the empty string", () => {
    expect(normalizeProductRef("   ")).toBe("");
    expect(normalizeProductRef("")).toBe("");
  });
});

describe("resolveProductByName — exact match", () => {
  it("EXACT normalized-title match wins", async () => {
    const list = fixedList([
      candidate("prod_1", "Picanha"),
      candidate("prod_2", "Costela"),
    ]);
    const out = await resolveProductByName("picanha", list);
    expect(out).toEqual({ kind: "resolved", product: candidate("prod_1", "Picanha") });
  });

  it("exact match is case- and diacritic-insensitive", async () => {
    const list = fixedList([candidate("prod_9", "Açaí 500ml")]);
    // "ACAI 500ML" normalizes to "acai 500ml" === normalized title.
    const out = await resolveProductByName("ACAI 500ml", list);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.product.id).toBe("prod_9");
  });

  it("exact match beats a broader substring candidate", async () => {
    // "Picanha" exact-matches; "Picanha Fatiada" only substring-matches — the
    // exact winner is chosen without ever considering the substring pass.
    const list = fixedList([
      candidate("prod_1", "Picanha"),
      candidate("prod_2", "Picanha Fatiada"),
    ]);
    const out = await resolveProductByName("picanha", list);
    expect(out).toEqual({ kind: "resolved", product: candidate("prod_1", "Picanha") });
  });

  it("DUPLICATE exact titles ⇒ ambiguous (never a guess)", async () => {
    const list = fixedList([
      candidate("prod_1", "Picanha"),
      candidate("prod_2", "picanha"),
    ]);
    const out = await resolveProductByName("PICANHA", list);
    expect(out.kind).toBe("ambiguous");
    if (out.kind === "ambiguous") {
      expect(out.candidates.map((c) => c.id).sort()).toEqual(["prod_1", "prod_2"]);
    }
  });
});

describe("resolveProductByName — substring match", () => {
  it("a single unique substring match wins (query ⊂ title)", async () => {
    const list = fixedList([
      candidate("prod_1", "Picanha Fatiada 500g"),
      candidate("prod_2", "Costela Bovina"),
    ]);
    const out = await resolveProductByName("picanha", list);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.product.id).toBe("prod_1");
  });

  it("bidirectional: a title that is a substring of the query resolves", async () => {
    const list = fixedList([candidate("prod_1", "Picanha")]);
    const out = await resolveProductByName("picanha fatiada premium", list);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.product.id).toBe("prod_1");
  });

  it(">1 substring matches ⇒ ambiguous with the candidate set", async () => {
    const list = fixedList([
      candidate("prod_1", "Coca-Cola Lata"),
      candidate("prod_2", "Coca-Cola Zero"),
    ]);
    const out = await resolveProductByName("coca-cola", list);
    expect(out.kind).toBe("ambiguous");
    if (out.kind === "ambiguous") {
      expect(out.candidates.map((c) => c.id).sort()).toEqual(["prod_1", "prod_2"]);
    }
  });

  it("0 matches ⇒ none", async () => {
    const list = fixedList([
      candidate("prod_1", "Picanha"),
      candidate("prod_2", "Costela"),
    ]);
    const out = await resolveProductByName("brisket", list);
    expect(out).toEqual({ kind: "none" });
  });
});

describe("resolveProductByName — fail-closed / guards", () => {
  it("empty query ⇒ none WITHOUT calling the read", async () => {
    const list = fixedList([candidate("prod_1", "Picanha")]);
    const out = await resolveProductByName("   ", list);
    expect(out).toEqual({ kind: "none" });
    expect(list).not.toHaveBeenCalled();
  });

  it("a lookup THROW is fail-closed to none (never propagated)", async () => {
    const list = vi.fn(async (_q: string) => {
      throw new Error("medusa down");
    });
    const out = await resolveProductByName("picanha", list);
    expect(out).toEqual({ kind: "none" });
  });

  it("malformed candidates (missing id) are ignored", async () => {
    const list = fixedList([
      { id: "", title: "Picanha", status: "published" },
      candidate("prod_2", "Picanha"),
    ]);
    const out = await resolveProductByName("picanha", list);
    // Only the well-formed candidate survives ⇒ a unique exact match.
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.product.id).toBe("prod_2");
  });

  it("a candidate whose title normalizes to empty never substring-matches", async () => {
    const list = fixedList([
      candidate("prod_blank", "   "),
      candidate("prod_2", "Costela Bovina"),
    ]);
    // Without the empty-title guard, "" would substring-match every query.
    const out = await resolveProductByName("costela", list);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.product.id).toBe("prod_2");
  });

  it("preserves the resolved product's status for the state projection", async () => {
    const list = fixedList([candidate("prod_1", "Picanha", "draft")]);
    const out = await resolveProductByName("picanha", list);
    expect(out.kind).toBe("resolved");
    if (out.kind === "resolved") expect(out.product.status).toBe("draft");
  });
});
