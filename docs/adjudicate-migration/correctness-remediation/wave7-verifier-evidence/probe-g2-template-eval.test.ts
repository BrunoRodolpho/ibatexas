import { describe, it, expect } from "vitest";

const PATTERN = /medusaStore\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"`](POST|PUT|DELETE|PATCH)['"`]/g;

describe("PROBE G2 — backtick + alt-quote variants", () => {
  it("backtick template - detected", () => {
    const src = `await medusaStore("/x", { method: \`POST\` })`;
    expect(PATTERN.test(src)).toBe(true);
    PATTERN.lastIndex = 0;
  });

  it("backtick with interpolation expression on method - NOT detected (interpolation not in pattern)", () => {
    const src = `await medusaStore("/x", { method: \`PO\${"ST"}\` })`;
    expect(PATTERN.test(src)).toBe(false);
    PATTERN.lastIndex = 0;
  });

  it("unicode-quote left double quotation mark - NOT detected", () => {
    // U+201C and U+201D — visually look like ASCII quotes, not in char class
    const src = `await medusaStore("/x", { method: “POST” })`;
    expect(PATTERN.test(src)).toBe(false);
    PATTERN.lastIndex = 0;
  });

  it("string concatenation method - NOT detected", () => {
    const src = `await medusaStore("/x", { method: "PO" + "ST" })`;
    expect(PATTERN.test(src)).toBe(false);
    PATTERN.lastIndex = 0;
  });

  it("variable-bound options - NOT detected (documented gap)", () => {
    const src = `const opts = { method: "POST" }; await medusaStore("/x", opts)`;
    expect(PATTERN.test(src)).toBe(false);
    PATTERN.lastIndex = 0;
  });
});
