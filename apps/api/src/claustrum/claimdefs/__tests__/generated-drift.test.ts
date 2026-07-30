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
import { validateClaimDefinition, validateClaimDefinitions } from "@adjudicate/core";
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

/**
 * THE CLOSURE CLUSTER of a unit: the unit itself plus every unit its closure row REQUIRES,
 * plus every unit whose closure row requires IT. DERIVED from the compiled closures — never
 * hand-listed — so a new `.claim.ts` inherits its clustering by existing, exactly as the
 * round-trip below inherits its case by being in `UNITS`.
 *
 * WHY THE ROUND-TRIP IS CLUSTER-SCOPED AND NOT UNIT-SCOPED (R2-S6). Through R2-S5 every
 * unit's closure required ONLY its own type, so a single-type universe (`registryEnum:
 * [type]`) was a well-formed world to validate it in. The cart pair breaks that: the
 * `CART_CONTENTS_Q` row is SHARED — CART_CONTENTS declares it naming BOTH types, CART_EMPTY
 * declares no row at all (see `../cart-contents.claim.ts`) — and a single-type universe is
 * then ill-formed in BOTH directions, measured against the real validator:
 *
 *   - CART_CONTENTS alone → `DECOMPOSITION_UNREACHABLE`, reverse direction ("closure
 *     CART_CONTENTS_Q references type CART_EMPTY which has no registered ClaimDefinition").
 *   - CART_EMPTY alone → `DECOMPOSITION_UNREACHABLE`, forward direction ("Triad-scoped type
 *     CART_EMPTY appears in no REQUIRED_CLAIM_CLOSURE value").
 *
 * The cluster is the smallest well-formed world for a shared row, and scoping to it does NOT
 * relax the check — `registryEnum` stays restricted to the cluster's own types, so a closure
 * naming anything outside the cluster still fails the reverse direction. All nine
 * pre-R2-S6 units are SINGLETON clusters, so their assertion is character-for-character the
 * one they had before.
 *
 * AND THE CLUSTERING IS ITSELF THE PAIR-AGREEMENT CHECK: because membership is DERIVED from
 * `requires`, a row that stops naming its twin DISSOLVES the cluster, the twin is validated
 * as a singleton, and the forward direction fails. That is the revert-to-red this slice
 * proves rather than asserts.
 */
function closureCluster(unit: (typeof UNITS)[number]): readonly (typeof UNITS)[number][] {
  const types = new Set<string>([unit.artifacts.type]);
  for (const t of unit.artifacts.closure?.requires ?? []) types.add(t);
  for (const other of UNITS) {
    if ((other.artifacts.closure?.requires ?? []).includes(unit.artifacts.type)) {
      types.add(other.artifacts.type);
    }
  }
  return UNITS.filter((u) => types.has(u.artifacts.type));
}

// Every compiled unit — not just the first one migrated — must round-trip through the
// v1 fail-closed validator, and each must reject its OWN generated mutations. Driven off
// `UNITS` so a new `.claim.ts` inherits the proof by existing; the per-type expectations
// below are derived from the compiled artifacts, so no case is hand-transcribed.
describe.each(UNITS.map((u) => [u.artifacts.type, u] as const))(
  "claimdef compiler — the compiled %s round-trips through the v1 validator",
  (type, unit) => {
    const out = unit.artifacts;

    it("the compiled definition + its generated cross-tables VALIDATE", () => {
      const cluster = closureCluster(unit);
      const r = validateClaimDefinitions(
        Object.fromEntries(cluster.map((u) => [u.artifacts.type, u.artifacts.definition])),
        {
          templates: Object.fromEntries(
            cluster.map((u) => [u.artifacts.type, u.artifacts.renderTemplate]),
          ),
          // A type with no §O#15 span contributes NO closure row (STORE_HOURS, and R2-S6's
          // CART_EMPTY): `triadScoped: false` is what makes that sound for STORE_HOURS —
          // INV-4 imposes a closure obligation on Triad-scoped types only — while CART_EMPTY
          // IS Triad-scoped and has its obligation discharged by its cluster partner's
          // SHARED row, which is the whole point of validating the cluster together.
          closures: Object.fromEntries(
            cluster
              .filter((u) => u.artifacts.closure !== undefined)
              .map((u) => [u.artifacts.closure!.spanClass, u.artifacts.closure!.requires]),
          ),
          registryEnum: cluster.map((u) => u.artifacts.type),
        },
      );
      expect(r).toEqual({ ok: true });
      // The cluster is the SMALLEST well-formed world, not a convenient superset: for every
      // unit whose closure requires only itself (all nine pre-R2-S6 units) it is still the
      // singleton, so this generalization cannot have quietly widened their universe.
      const selfOnly =
        out.closure === undefined || out.closure.requires.every((t) => t === type);
      const referencedByOther = UNITS.some(
        (u) =>
          u.artifacts.type !== type &&
          (u.artifacts.closure?.requires ?? []).includes(type),
      );
      if (selfOnly && !referencedByOther) expect(cluster).toHaveLength(1);
    });

    it("each generated mutation fixture is REJECTED with its matching invariant code", () => {
      expect(out.fixtures.mutations.length).toBeGreaterThanOrEqual(4);
      for (const m of out.fixtures.mutations) {
        const r = validateClaimDefinition(m.def);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe(m.code);
      }
    });
  },
);

// ── THE SHARED-ROW CLUSTER, asserted directly (R2-S6) ────────────────────────────────
//
// The round-trip above proves the cluster VALIDATES; these two prove the cluster is the
// SHAPE the design claims — that exactly one source declares the row, that the other
// declares none, and that the pair is genuinely non-singleton. Without them a future edit
// could satisfy the round-trip by giving each twin its own row (the shape rejected in
// `../cart-contents.claim.ts`'s header) and nothing would notice.
describe("claimdef compiler — the CART pair's SHARED closure row (R2-S6)", () => {
  const unitFor = (type: string) => UNITS.find((u) => u.artifacts.type === type)!;

  it("CART_CONTENTS owns the row and names BOTH members; CART_EMPTY declares none", () => {
    const contents = unitFor("CART_CONTENTS").artifacts;
    const empty = unitFor("CART_EMPTY").artifacts;
    expect(contents.closure?.spanClass).toBe("CART_CONTENTS_Q");
    expect(contents.closure?.requires).toEqual(["CART_CONTENTS", "CART_EMPTY"]);
    expect(empty.closure).toBeUndefined();
    // The twin's INV-4 obligation is REAL (it is Triad-scoped), which is what the owner's
    // row discharges — if this were false the agreement check would be vacuous.
    expect(empty.definition.triadScoped).toBe(true);
    // Exactly ONE row for the two types across the whole generated corpus — no second
    // source declares CART_CONTENTS_Q.
    expect(
      UNITS.filter((u) => u.artifacts.closure?.spanClass === "CART_CONTENTS_Q"),
    ).toHaveLength(1);
  });

  it("the pair is the ONLY non-singleton cluster, and it contains exactly the two types", () => {
    const clusters = UNITS.map((u) => closureCluster(u).map((c) => c.artifacts.type));
    const nonSingleton = clusters.filter((c) => c.length > 1);
    expect(nonSingleton).toEqual([
      ["CART_CONTENTS", "CART_EMPTY"],
      ["CART_CONTENTS", "CART_EMPTY"],
    ]);
    // …and it is symmetric: reached identically from either member (the twin has no row of
    // its own, so its cluster is found through the REVERSE direction of the derivation).
    expect(closureCluster(unitFor("CART_EMPTY")).map((u) => u.artifacts.type)).toEqual([
      "CART_CONTENTS",
      "CART_EMPTY",
    ]);
  });
});
