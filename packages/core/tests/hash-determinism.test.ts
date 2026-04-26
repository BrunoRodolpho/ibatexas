import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalJson, sha256Canonical } from "../src/hash.js";
import { buildEnvelope } from "../src/envelope.js";

describe("canonicalJson", () => {
  it("produces identical output regardless of key order", () => {
    const a = { kind: "x", payload: { a: 1, b: 2 }, taint: "SYSTEM" };
    const b = { taint: "SYSTEM", payload: { b: 2, a: 1 }, kind: "x" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("omits undefined fields", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(
      canonicalJson({ a: 1 }),
    );
  });

  it("preserves array order", () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("is deterministic on arbitrary JSON-safe objects", () => {
    fc.assert(
      fc.property(fc.object({ maxDepth: 3 }), (obj) => {
        expect(canonicalJson(obj)).toBe(canonicalJson(obj));
      }),
    );
  });
});

describe("sha256Canonical", () => {
  it("returns a 64-char hex digest", () => {
    const h = sha256Canonical({ kind: "x", payload: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable under key reordering", () => {
    expect(
      sha256Canonical({ a: 1, b: { c: 2, d: 3 } }),
    ).toBe(sha256Canonical({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it("differs when payload differs", () => {
    expect(sha256Canonical({ a: 1 })).not.toBe(sha256Canonical({ a: 2 }));
  });
});

describe("buildEnvelope — intentHash determinism", () => {
  it("produces the same hash for identical inputs with the same createdAt", () => {
    const a = buildEnvelope({
      kind: "order.tool.propose",
      payload: { toolName: "add_item", input: { sku: "XYZ" } },
      actor: { principal: "llm", sessionId: "s-1" },
      taint: "UNTRUSTED",
      createdAt: "2026-04-23T12:00:00.000Z",
    });
    const b = buildEnvelope({
      kind: "order.tool.propose",
      payload: { toolName: "add_item", input: { sku: "XYZ" } },
      actor: { principal: "llm", sessionId: "s-1" },
      taint: "UNTRUSTED",
      createdAt: "2026-04-23T12:00:00.000Z",
    });
    expect(a.intentHash).toBe(b.intentHash);
  });

  it("hash is insensitive to payload key reorder", () => {
    const a = buildEnvelope({
      kind: "order.tool.propose",
      payload: { toolName: "add_item", input: { sku: "XYZ", qty: 2 } },
      actor: { principal: "llm", sessionId: "s-1" },
      taint: "UNTRUSTED",
      createdAt: "2026-04-23T12:00:00.000Z",
    });
    const b = buildEnvelope({
      kind: "order.tool.propose",
      payload: { input: { qty: 2, sku: "XYZ" }, toolName: "add_item" },
      actor: { principal: "llm", sessionId: "s-1" },
      taint: "UNTRUSTED",
      createdAt: "2026-04-23T12:00:00.000Z",
    });
    expect(a.intentHash).toBe(b.intentHash);
  });

  it("hash changes when payload changes", () => {
    const a = buildEnvelope({
      kind: "order.tool.propose",
      payload: { toolName: "add_item", input: { sku: "A" } },
      actor: { principal: "llm", sessionId: "s-1" },
      taint: "UNTRUSTED",
      createdAt: "2026-04-23T12:00:00.000Z",
    });
    const b = buildEnvelope({
      kind: "order.tool.propose",
      payload: { toolName: "add_item", input: { sku: "B" } },
      actor: { principal: "llm", sessionId: "s-1" },
      taint: "UNTRUSTED",
      createdAt: "2026-04-23T12:00:00.000Z",
    });
    expect(a.intentHash).not.toBe(b.intentHash);
  });
});
