// Wave 6 Red-Team — Target 8 (NEW-P0-X9 multi-line bypass detection)
//
// Finding: the FORBIDDEN_MEDUSA_MULTILINE regex requires `method` value
// to be surrounded by single OR double quotes (`['"]`). A developer
// writing `method: \`POST\`` (template literal / backtick) bypasses the
// scanner — the build passes, the bypass ships.
//
// Severity: P1 — the bypass scan is a CI gate; this hole means future
// regressions can slip past with a trivial encoding change. Production
// impact depends on whether someone notices the unusual `method: \`POST\``
// shape in code review.
//
// Reproduction: feed source containing `method: \`POST\`` through the
// SAME regex used by the bypass-detection test and observe zero matches.

import { describe, it, expect } from "vitest";

// Direct copy of FORBIDDEN_MEDUSA_MULTILINE from
// apps/api/src/__tests__/bypass-detection/bypass-detection.test.ts:171-176
const FORBIDDEN_MEDUSA_MULTILINE = [
  /medusaStore\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/g,
  /medusaAdmin\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/g,
  /medusaStoreFetch\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/g,
  /medusaAdminFetch\s*\([^()]*?\{[^{}]*?\bmethod\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/g,
] as const;

function anyMatches(src: string): boolean {
  for (const pattern of FORBIDDEN_MEDUSA_MULTILINE) {
    const fresh = new RegExp(pattern.source, pattern.flags);
    if (fresh.test(src)) return true;
  }
  return false;
}

describe("RED-TEAM Target 8 — template-literal bypass of medusa scanner", () => {
  it("EXPLOIT: backtick-quoted method='POST' is NOT detected by the regex", () => {
    const exploitSource = `
      await medusaStore("/store/carts", {
        method: \`POST\`,
        body: JSON.stringify(cartBody),
      });
    `;
    // The scanner sees no bypass — REGRESSION CAN SHIP.
    expect(anyMatches(exploitSource)).toBe(false);
  });

  it("EXPLOIT: backtick-quoted method='DELETE' is NOT detected", () => {
    const exploitSource = `
      await medusaStore(\`/store/carts/\${id}\`, {
        method: \`DELETE\`,
      });
    `;
    expect(anyMatches(exploitSource)).toBe(false);
  });

  it("EXPLOIT: medusaAdmin with backtick method also bypasses", () => {
    const exploitSource = `
      const data = await medusaAdmin("/admin/products", {
        method: \`POST\`,
        body: payload,
      });
    `;
    expect(anyMatches(exploitSource)).toBe(false);
  });

  it("CONTRAST: double-quoted method='POST' IS detected", () => {
    const baselineSource = `
      await medusaStore("/store/carts", {
        method: "POST",
      });
    `;
    expect(anyMatches(baselineSource)).toBe(true);
  });

  it("CONTRAST: single-quoted method='POST' IS detected", () => {
    const baselineSource = `
      await medusaStore("/store/carts", {
        method: 'POST',
      });
    `;
    expect(anyMatches(baselineSource)).toBe(true);
  });

  // ── Additional hardening checks ──────────────────────────────────

  it("LIMITATION: variable-bound options also bypass (documented in code)", () => {
    // The scanner's code comment acknowledges this gap, but we pin it.
    const exploitSource = `
      const opts = { method: "POST", body: "x" };
      await medusaStore("/store/carts", opts);
    `;
    expect(anyMatches(exploitSource)).toBe(false);
  });
});

// ── Recommendation ──────────────────────────────────────────────────
//
// Two-line fix: widen the character class from `['"]` to `['"\`]` in
// all 4 patterns in bypass-detection.test.ts:172-175. Or, better, move
// to AST-based scanning (typescript-eslint custom rule) — which the
// existing comment already lists as the Q2 backlog item. Until then,
// a one-character widening closes this specific exploit.
