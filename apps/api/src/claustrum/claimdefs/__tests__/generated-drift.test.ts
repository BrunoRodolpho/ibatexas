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
import {
  CLAIM_DEFINITIONS,
  CLAIM_DEFINITION_CONTEXT,
} from "../../claim-definition-registry.js";
import { CLAIM_REGISTRY } from "../../claim-registry.js";
import { PRESENCE_COMPLEMENT_PAIRS } from "../../required-claim-decomposer.js";
import { EXCLUDED_BY_DESIGN, emitGeneratedDoc, emitGeneratedModule, UNITS } from "../generate.js";

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
      // R2-S9 — the arity is DERIVED, not a floor. This assertion used to read
      // `toBeGreaterThanOrEqual(4)`, which was true of every unit through R2-S8 because all
      // fourteen carried a valueBinding, a falsifier stance AND a render template. The
      // degenerate MENU_ITEM_ALLERGENS unit carries NONE of the three and generates exactly
      // TWO fixtures, so the floor was not merely too tight for it — it was the wrong SHAPE
      // of assertion: a hardcoded number cannot say which invariants a def is even capable
      // of exercising. The compiler emits one mutation per APPLICABLE invariant
      // (`toFixtures`), so the count is a function of the def, and computing it here is
      // strictly tighter for all 22 units — a unit that silently LOST its falsifier stance
      // would have kept passing `>= 4` while its FALSIFIER_INCOMPLETE proof quietly stopped
      // being generated.
      const expected =
        // INV-6 (empty requiredEvidence) + INV-5 (provenance stripped off the head row):
        // always applicable, since requiredEvidence is a non-empty tuple by construction.
        2 +
        // INV-7 — only a def that BINDS a value can have that binding un-gated.
        (out.definition.valueBinding === undefined ? 0 : 1) +
        // INV-2 — only a def claiming falsifier-completeness can claim it while enumerating
        // none.
        (out.definition.falsifierComplete === true ? 1 : 0) +
        // INV-1 — only a def whose template carries a PROPOSITION slot has a projection to
        // drop.
        (out.definition.renderTemplate !== undefined &&
        (out.definition.valueProjections?.length ?? 0) > 0
          ? 1
          : 0);
      expect(out.fixtures.mutations).toHaveLength(expected);
      // …and the codes are the applicable SET, not merely the right count.
      expect(new Set(out.fixtures.mutations.map((m) => m.code)).size).toBe(expected);
      for (const m of out.fixtures.mutations) {
        const r = validateClaimDefinition(m.def);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe(m.code);
      }
    });
  },
);

// ── THE SHARED-ROW CLUSTER, asserted directly (R2-S6, generalized by R2-S9) ──────────
//
// The round-trip above proves each cluster VALIDATES; these prove the cluster is the SHAPE
// the design claims — that exactly one source declares the row, that the twin declares
// none, and that the pair is genuinely non-singleton. Without them a future edit could
// satisfy the round-trip by giving each twin its own row (the shape rejected in
// `../cart-contents.claim.ts`'s header) and nothing would notice.
//
// R2-S9 — quantified over PRESENCE_COMPLEMENT_PAIRS rather than naming the cart pair, so a
// future pair inherits the check by registering there. The `unitFor` lookups are what tie
// each registered pair back to a compiled source.
const unitFor = (type: string) => UNITS.find((u) => u.artifacts.type === type);

/** The registered pairs BOTH of whose members compile from a source (all four, today). */
const COMPILED_PAIRS = PRESENCE_COMPLEMENT_PAIRS.filter(
  ([a, b]) => unitFor(a) !== undefined && unitFor(b) !== undefined,
);

describe.each(COMPILED_PAIRS)(
  "claimdef compiler — the %s / %s SHARED closure row",
  (positive, negative) => {
    it("the POSITIVE member owns the row and names BOTH; the twin declares none", () => {
      const owner = unitFor(positive)!.artifacts;
      const twin = unitFor(negative)!.artifacts;
      expect(owner.closure).toBeDefined();
      expect(owner.closure!.requires).toEqual([positive, negative]);
      expect(twin.closure).toBeUndefined();
      // Exactly ONE row for the two types across the whole generated corpus — no second
      // source declares the same span class.
      expect(
        UNITS.filter((u) => u.artifacts.closure?.spanClass === owner.closure!.spanClass),
      ).toHaveLength(1);
    });

    it("the cluster is exactly the two types, reached identically from EITHER member", () => {
      // The twin has no row of its own, so its cluster is found through the REVERSE
      // direction of the derivation — which is what makes the clustering itself an
      // agreement check: a `requires` that stopped naming the twin DISSOLVES the cluster.
      expect(closureCluster(unitFor(positive)!).map((u) => u.artifacts.type)).toEqual([
        positive,
        negative,
      ]);
      expect(closureCluster(unitFor(negative)!).map((u) => u.artifacts.type)).toEqual([
        positive,
        negative,
      ]);
    });
  },
);

describe("claimdef compiler — presence-complement pairs: cluster census + row agreement", () => {
  it("the non-singleton clusters are EXACTLY the registered presence-complement pairs", () => {
    const clusters = UNITS.map((u) => closureCluster(u).map((c) => c.artifacts.type));
    const nonSingleton = clusters.filter((c) => c.length > 1);
    // Each pair appears TWICE (once per member), in UNITS order.
    expect(nonSingleton).toEqual(
      UNITS.flatMap((u) => {
        const pair = COMPILED_PAIRS.find(([a, b]) =>
          [a, b].includes(u.artifacts.type as never),
        );
        return pair === undefined ? [] : [[pair[0], pair[1]]];
      }),
    );
    expect(nonSingleton).toHaveLength(COMPILED_PAIRS.length * 2);
  });

  // ── THE AGREEMENT PIN THAT STANDS IN FOR A DEAD INV-4 (R2-S9) ─────────────────────
  //
  // R2-S6 could let the generic INV-4 enforce the cart pair's shared-row agreement
  // fail-closed. That does NOT generalize, and the measurement is in the sibling test
  // below: INV-4's forward direction obliges TRIAD-SCOPED types only, and the three pairs
  // R2-S9 adopted are all PUBLIC. So the agreement is asserted HERE, explicitly and
  // derived from the pair table, and it is honestly weaker than a boot-time refusal.
  //
  // WHAT IT PROTECTS. `classifyOnlyRequiredTypes` IS this closure-derived required set, so
  // a row that stopped naming its twin would silently stop producing the negative/
  // complementary branch on the deterministic path — the LE2-002 defect one seam over,
  // and invisible to every renderer-level test exactly as LE2-002 was.
  it("EVERY closure row naming one pair member names BOTH (the LE2-002 shape, structurally)", () => {
    const rows = Object.entries(CLAIM_DEFINITION_CONTEXT.closures ?? {});
    // The quantification is REAL only if some row actually names a pair member.
    let checked = 0;
    for (const [span, types] of rows) {
      for (const [a, b] of PRESENCE_COMPLEMENT_PAIRS) {
        const namesA = types.includes(a);
        const namesB = types.includes(b);
        if (!namesA && !namesB) continue;
        checked++;
        expect({ span, a, namesA, b, namesB }).toEqual({
          span,
          a,
          namesA: true,
          b,
          namesB: true,
        });
      }
    }
    expect(checked).toBe(PRESENCE_COMPLEMENT_PAIRS.length);
  });

  // The MEASUREMENT the headers cite, pinned so it cannot silently become false in either
  // direction. It asserts a WEAKNESS on purpose: if a future change makes INV-4 live for
  // these pairs (by marking them Triad-scoped, say), this goes red and the three source
  // headers plus the note above must be corrected rather than left claiming a gap that
  // closed.
  it("INV-4 catches a de-synced CART row and CANNOT catch the three PUBLIC pairs' (measured)", () => {
    const desync = (span: string, keep: string) =>
      validateClaimDefinitions(CLAIM_DEFINITIONS, {
        ...CLAIM_DEFINITION_CONTEXT,
        closures: { ...CLAIM_DEFINITION_CONTEXT.closures, [span]: [keep] },
      });

    // CONTROL — the real registry validates, or every treatment below is meaningless.
    expect(validateClaimDefinitions(CLAIM_DEFINITIONS, CLAIM_DEFINITION_CONTEXT)).toEqual({
      ok: true,
    });

    for (const [a, b] of PRESENCE_COMPLEMENT_PAIRS) {
      const span = unitFor(a)!.artifacts.closure!.spanClass;
      const bothTriad =
        CLAIM_DEFINITIONS[a].triadScoped === true && CLAIM_DEFINITIONS[b].triadScoped === true;
      const r = desync(span, a);
      if (bothTriad) {
        // The cart pair: the forward direction has an obligation to fail on.
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.code).toBe("DECOMPOSITION_UNREACHABLE");
          expect(r.reason).toContain(b);
        }
      } else {
        // The three PUBLIC pairs: nothing to fail on. This is the gap the explicit pin
        // above exists for.
        expect({ pair: `${a}/${b}`, result: r }).toEqual({
          pair: `${a}/${b}`,
          result: { ok: true },
        });
      }
    }
    // Both branches must be EXERCISED, or the contrast proves nothing.
    const triadPairs = PRESENCE_COMPLEMENT_PAIRS.filter(
      ([a, b]) =>
        CLAIM_DEFINITIONS[a].triadScoped === true && CLAIM_DEFINITIONS[b].triadScoped === true,
    );
    expect(triadPairs).toHaveLength(1);
    expect(PRESENCE_COMPLEMENT_PAIRS.length - triadPairs.length).toBe(3);
  });
});

// ── THE CENSUS (R2-S9, the terminal claim of the adoption arc) ───────────────────────
//
// Every registry type is either GENERATED from a `.claim.ts` source or EXCLUDED BY DESIGN
// with a recorded ruling. Pinned so a future type ADDITION must declare itself as one or
// the other: added to CLAIM_REGISTRY without a source and without an exclusion, it lands
// in neither set and the partition assertion goes red naming it.
describe("claimdef compiler — the CENSUS: 22 generated + 1 documented exclusion = 23", () => {
  it("the generated set and the exclusion set PARTITION the registry, with no overlap", () => {
    const generated = UNITS.map((u) => u.artifacts.type).sort();
    const excluded = [...EXCLUDED_BY_DESIGN].sort();
    expect([...generated, ...excluded].sort()).toEqual([...CLAIM_REGISTRY].sort());
    expect(generated.filter((t) => excluded.includes(t as never))).toEqual([]);
    expect(generated).toHaveLength(22);
    expect(excluded).toEqual(["PURCHASE_COMPLETED"]);
    expect(CLAIM_REGISTRY).toHaveLength(23);
  });

  it("the ONE exclusion is the registry's ONLY action_claim — the property the ruling rests on", () => {
    // The ruling is "no compiler shape for its render posture", and the posture is a
    // consequence of the KIND: an action claim renders through the responder's
    // SUCCESS_CLAIM_CLASSES path, not the read-template grammar the compiler's `render`
    // block models. If a second action_claim is ever registered, this fails and the ruling
    // must be re-argued for it rather than silently inherited.
    for (const t of EXCLUDED_BY_DESIGN) {
      expect(CLAIM_DEFINITIONS[t].kind).toBe("action_claim");
    }
    expect(
      CLAIM_REGISTRY.filter((t) => CLAIM_DEFINITIONS[t].kind === "action_claim"),
    ).toEqual([...EXCLUDED_BY_DESIGN]);
    // …and every GENERATED type is a read_claim, which is what makes the partition a
    // statement about postures rather than a coincidence of today's roster.
    for (const u of UNITS) expect(u.artifacts.definition.kind).toBe("read_claim");
  });

  it("every generated type's boot definition MATCHES its freshly-compiled one", () => {
    // Quantified over UNITS, so a type nobody remembered to add to a per-type table is
    // still covered — which is the only reason this exists beside the reference-identity
    // table in `../../__tests__/claim-definition-registry.test.ts`.
    //
    // WHAT IT CAN AND CANNOT SEE, stated because the difference is the whole point of that
    // sibling table. This compares the boot object against a FRESH in-memory compile of the
    // source, so the two can never be reference-identical (the boot object is the
    // re-serialized `*.generated.ts` module; this one is the compiler's own output), and
    // deep equality is the strongest statement available here. It therefore catches a
    // SHAPE divergence — but NOT a silent fallback to `buildClaimDefinition`, which by
    // design produces the same shape. Reference identity is the only guard that sees that,
    // and it is asserted per type in the sibling suite.
    for (const u of UNITS) {
      const type = u.artifacts.type as keyof typeof CLAIM_DEFINITIONS;
      expect(CLAIM_DEFINITIONS[type]).toEqual(u.artifacts.definition);
    }
  });
});
