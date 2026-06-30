/**
 * GENERATED-ARTIFACT DRIFT GUARD (inv.18 v2 / constraint 5). The generated files
 * (`*.generated.ts` / `*.generated.md`) are MACHINE-EMITTED from the `.claim.ts`
 * source by the claimdef-compiler and must NEVER be hand-edited. This guard re-runs
 * the generator IN MEMORY and asserts the on-disk artifacts are byte-identical — so a
 * stale or hand-edited generated file FAILS THE BUILD (fail-closed), exactly the
 * `satisfies`-exhaustiveness / `_AssertEqual` build-time guard idiom this codebase
 * already uses. It also pins that the COMPILED artifacts round-trip back through the
 * v1 fail-closed validator (the def + cross-tables validate; each generated mutation
 * fixture rejects with its matching code).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compileClaimDefinition,
  validateClaimDefinition,
  validateClaimDefinitions,
} from "@adjudicate/core";
import { STORE_OPEN_NOW_SOURCE } from "../store-open-now.claim.js";
import { emitGeneratedDoc, emitGeneratedModule, UNITS } from "../generate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..");

describe("claimdef generated artifacts — drift guard (fail-closed)", () => {
  for (const unit of UNITS) {
    it(`${unit.slug}.generated.ts is in sync with its source (no drift)`, () => {
      const onDisk = readFileSync(join(DIR, `${unit.slug}.generated.ts`), "utf8");
      expect(onDisk).toBe(`${emitGeneratedModule(unit)}\n`);
    });

    it(`${unit.slug}.generated.md is in sync with its source (no drift)`, () => {
      const onDisk = readFileSync(join(DIR, `${unit.slug}.generated.md`), "utf8");
      expect(onDisk).toBe(emitGeneratedDoc(unit));
    });
  }
});

describe("claimdef compiler — the compiled STORE_OPEN_NOW round-trips through the v1 validator", () => {
  const out = compileClaimDefinition(STORE_OPEN_NOW_SOURCE);

  it("the compiled definition + its generated cross-tables VALIDATE", () => {
    const r = validateClaimDefinitions(
      { STORE_OPEN_NOW: out.definition },
      {
        templates: { STORE_OPEN_NOW: out.renderTemplate },
        closures: { STORE_OPEN_NOW_Q: out.closure?.requires ?? [] },
        registryEnum: ["STORE_OPEN_NOW"],
      },
    );
    expect(r).toEqual({ ok: true });
  });

  it("each generated mutation fixture is REJECTED with its matching invariant code", () => {
    expect(out.fixtures.mutations.length).toBeGreaterThanOrEqual(4);
    for (const m of out.fixtures.mutations) {
      const r = validateClaimDefinition(m.def);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe(m.code);
    }
  });
});
