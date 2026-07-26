// LE2-006 — standing conformance guard: PLANNER COMPLETION TEXT HAS NO CARRIER
// TO A CUSTOMER-VISIBLE REPLY.
//
// # Why this test exists
//
// Wire constraint V1 (LE2-006) stopped sending `response_format: json_object`
// on tool-bearing planner bodies. Under V0 the planner's text channel, on a
// no-action turn, emitted a fabricated capability-shaped JSON blob; under V1 it
// emits ordinary pt-BR prose. That is an improvement in the trace and in the
// planner's own pass-2 re-prompt — but it was only SAFE to adopt because
// planner text cannot reach a customer at all, in either regime.
//
// The gate-1 leak-path audit
// (scratch/language-engine-2/results/06-gate1-leak-path-audit-2026-07-25.md,
// 14 paths, verdict REFUTED) established that the guarantee is STRUCTURAL, not
// incidental — it rests on three contract facts, any ONE of which is sufficient:
//
//   1. `Plan` has NO text carrier. `rationale` is the only free-text field and
//      it is documented trace-only ("NEVER user-facing"). The planner physically
//      cannot hand prose to the loop.
//   2. `TurnOutcome` has NO planner field. Memory cannot persist planner text
//      even by mistake, so the cross-turn path is closed at the type level too.
//   3. The customer-facing sentence is authored by a DIFFERENT model call — the
//      responder's own TOOL-LESS synthesis completion, seeded from `cognition` +
//      `userText`. The two completions never meet, which is precisely why a
//      constraint on TOOL-BEARING bodies cannot move customer prose.
//
// The audit's §7 closes with the seam to watch: the guarantee is lost if, and
// only if, someone (a) adds a text-bearing field to `Plan`, (b) makes the
// responder read `plan.rationale`, or (c) adds a planner-text field to
// `TurnOutcome`. This suite is that watch, asserted statically so a regression
// fails loudly in CI rather than being re-litigated by hand.
//
// Idiom: the `apps/api/src/__tests__/bypass-detection/*-conformance.test.ts`
// family — static scan + a smoke test proving the scan found something + NEGATIVE
// tests proving the detector actually detects. A structural gate that cannot fail
// is worse than no gate, so each assertion below is paired with a synthetic
// violation that must trip it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ── Sources under guard ─────────────────────────────────────────────────────

/** The responder — the only component that authors a customer sentence. */
const RESPONDER_PATH = fileURLToPath(new URL("../ibatexas-responder.ts", import.meta.url));

/** `@claustrum/core`'s FROZEN port contracts, as resolved for apps/api. */
const PLANNER_DTS_PATH = fileURLToPath(
  new URL("../../../node_modules/@claustrum/core/dist/ports/planner.d.ts", import.meta.url),
);
const MEMORY_DTS_PATH = fileURLToPath(
  new URL("../../../node_modules/@claustrum/core/dist/ports/memory.d.ts", import.meta.url),
);

function readSource(path: string): string {
  const src = readFileSync(path, "utf8");
  if (src.trim().length === 0) throw new Error(`empty source: ${path}`);
  return src;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Strip line + block comments, preserving newlines. Mirrors the T1/T2/T7
 *  conformance helper — a field named in prose must never satisfy a check. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1] ?? "";
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < src.length) {
        if (src[i] === "*" && src[i + 1] === "/") {
          out += "  ";
          i += 2;
          break;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The body of `interface <name> { … }`, brace-balanced, comments stripped. */
export function interfaceBody(src: string, name: string): string {
  const stripped = stripComments(src);
  const header = new RegExp(`\\binterface\\s+${name}\\s*(?:extends[^{]*)?\\{`).exec(stripped);
  if (header === null) throw new Error(`interface ${name} not found`);
  const open = header.index + header[0].length - 1;
  let depth = 0;
  for (let i = open; i < stripped.length; i++) {
    const c = stripped[i]!;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return stripped.slice(open + 1, i);
    }
  }
  throw new Error(`interface ${name} has no closing brace`);
}

export interface DeclaredField {
  readonly name: string;
  readonly optional: boolean;
  /** The type text, inner whitespace collapsed. */
  readonly type: string;
}

/**
 * Top-level fields of an interface body. Depth-aware: a `;` nested inside an
 * inline object/array/generic type (e.g. `ReadonlyArray<{ name: string; … }>`)
 * does NOT terminate a field.
 */
export function declaredFields(body: string): DeclaredField[] {
  const fields: DeclaredField[] = [];
  const head = /(?:^|[;\n])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\??)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(body)) !== null) {
    let depth = 0;
    let end = body.length;
    for (let i = head.lastIndex; i < body.length; i++) {
      const c = body[i]!;
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") depth--;
      else if ((c === ";" || c === "\n") && depth === 0) {
        end = i;
        break;
      }
    }
    fields.push({
      name: m[1]!,
      optional: m[2] === "?",
      type: body.slice(head.lastIndex, end).replace(/\s+/g, " ").trim(),
    });
    // Resume AFTER this field's whole type, so heads nested inside an inline
    // object type are never mistaken for top-level fields.
    head.lastIndex = Math.max(head.lastIndex, end);
  }
  return fields;
}

/** A field whose type is bare `string` — i.e. a free-text carrier. */
export function isFreeTextField(field: DeclaredField): boolean {
  return /^string(\s*\|\s*undefined)?$/.test(field.type);
}

/** Every `plan.<field>` / `<x>.plan.<field>` property read in a source file. */
export function planPropertyReads(src: string): string[] {
  const stripped = stripComments(src);
  return [...stripped.matchAll(/\bplan\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!);
}

/** Destructured plan reads — `const { rationale } = input.plan`. */
export function planDestructuredReads(src: string): string[] {
  const stripped = stripComments(src);
  const out: string[] = [];
  for (const m of stripped.matchAll(/\{([^{}]*)\}\s*=\s*[\w.$]*\bplan\b/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.split(":")[0]!.trim().replace(/^\.\.\./, "");
      if (name.length > 0) out.push(name);
    }
  }
  return out;
}

// ── Fact 1 — `Plan` has no text carrier ─────────────────────────────────────

describe("LE2-006 gate-1 · fact 1 — `Plan` exposes no text carrier but trace-only `rationale`", () => {
  const body = interfaceBody(readSource(PLANNER_DTS_PATH), "Plan");
  const fields = declaredFields(body);

  it("scan parsed a non-trivial `Plan` declaration (anti-vacuity smoke)", () => {
    // If `@claustrum/core` moves the file or renames the interface, every
    // assertion below would pass over an empty field list. Fail here instead.
    expect(fields.length).toBeGreaterThanOrEqual(5);
    expect(fields.map((f) => f.name)).toContain("envelopes");
  });

  it("pins the exact `Plan` field set — a new field is a reviewable event", () => {
    // Audit §7 seam (a): adding a text-bearing field to `Plan` is the ONLY way
    // the planner could hand prose to the loop. Pinned as an exact set so any
    // addition — text-bearing or not — has to come through this test.
    expect(fields.map((f) => f.name).sort()).toEqual([
      "capabilities",
      "envelopes",
      "rationale",
      "readToolCalls",
      "usage",
    ]);
  });

  it("`rationale` is the ONLY free-text field, and it is optional", () => {
    expect(fields.filter(isFreeTextField).map((f) => f.name)).toEqual(["rationale"]);
    expect(fields.find((f) => f.name === "rationale")?.optional).toBe(true);
  });

  it("`rationale` is documented trace-only in the contract itself", () => {
    // The prose is load-bearing: it is what tells an adopter the field is not a
    // reply carrier. Read from the UNSTRIPPED source on purpose.
    expect(readSource(PLANNER_DTS_PATH)).toMatch(/rationale for the trace\. NEVER user-facing/i);
  });

  it("negative — a synthetic `Plan` carrying a draft string IS flagged", () => {
    const synthetic = `export interface Plan {
      readonly envelopes: ReadonlyArray<IntentEnvelope>;
      readonly rationale?: string;
      readonly draft: string;
    }`;
    const synthFields = declaredFields(interfaceBody(synthetic, "Plan"));
    expect(synthFields.filter(isFreeTextField).map((f) => f.name)).toEqual(["rationale", "draft"]);
  });

  it("negative — the field parser is depth-aware (a nested `;` is not a field break)", () => {
    const synthetic = `export interface Plan {
      readonly readToolCalls?: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
      readonly rationale?: string;
    }`;
    expect(declaredFields(interfaceBody(synthetic, "Plan")).map((f) => f.name)).toEqual([
      "readToolCalls",
      "rationale",
    ]);
  });
});

// ── Fact 2 — `TurnOutcome` records no planner field ─────────────────────────

describe("LE2-006 gate-1 · fact 2 — `TurnOutcome` records no planner field", () => {
  const fields = declaredFields(interfaceBody(readSource(MEMORY_DTS_PATH), "TurnOutcome"));

  it("scan parsed a non-trivial `TurnOutcome` declaration (anti-vacuity smoke)", () => {
    expect(fields.length).toBeGreaterThanOrEqual(6);
    expect(fields.map((f) => f.name)).toContain("responseText");
  });

  it("pins the exact `TurnOutcome` field set — audit §7 seam (c)", () => {
    expect(fields.map((f) => f.name).sort()).toEqual([
      "at",
      "conversationId",
      "decisionKind",
      "intentHash",
      "perception",
      "responseText",
      "turnId",
      "userText",
    ]);
  });

  it("pins which fields are bare strings — ids, plus exactly two recorded texts", () => {
    // The only free-form content memory can persist is the customer's own words
    // (`userText`) and the POST-firewall reply (`responseText`); every other
    // string here is an identifier or a timestamp. A `plannerText` /
    // `completion` / `draft` field would open the cross-turn path.
    expect(fields.filter(isFreeTextField).map((f) => f.name).sort()).toEqual([
      "at",
      "conversationId",
      "decisionKind",
      "intentHash",
      "responseText",
      "turnId",
      "userText",
    ]);
  });

  it("no field name references the planner or a raw completion", () => {
    const offenders = fields.filter((f) => /plan|rationale|completion|draft/i.test(f.name));
    expect(offenders.map((f) => f.name)).toEqual([]);
  });

  it("negative — a synthetic `TurnOutcome` with a planner field IS flagged", () => {
    const synthetic = `export interface TurnOutcome {
      readonly turnId: string;
      readonly plannerText?: string;
    }`;
    const synthFields = declaredFields(interfaceBody(synthetic, "TurnOutcome"));
    expect(synthFields.filter((f) => /plan/i.test(f.name)).map((f) => f.name)).toEqual([
      "plannerText",
    ]);
  });
});

// ── Fact 3 — the responder never reads plan text, and authors from its own
//    TOOL-LESS completion ─────────────────────────────────────────────────────

describe("LE2-006 gate-1 · fact 3 — the responder never references plan text", () => {
  const responder = readSource(RESPONDER_PATH);
  const reads = planPropertyReads(responder);

  it("scan found the responder's real plan reads (anti-vacuity smoke)", () => {
    // The audit inventoried exactly three: `envelopes[0]`, `envelopes.length`,
    // and `capabilities ?? envelopes.map(kind)`. If this drops to zero the
    // scanner broke or the file moved — either way the guard below is vacuous.
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(reads).toContain("envelopes");
  });

  it("reads ONLY non-text plan fields — never `rationale` (audit §7 seam (b))", () => {
    // `envelopes` yields kernel envelopes (kind enums + adjudicated payloads);
    // `capabilities` yields capability-id enum strings. Neither is free text.
    expect([...new Set(reads)].sort()).toEqual(["capabilities", "envelopes"]);
    expect(reads).not.toContain("rationale");
  });

  it("never destructures a text field off the plan", () => {
    expect(planDestructuredReads(responder).filter((n) => n === "rationale")).toEqual([]);
  });

  it("the customer sentence comes from a TOOL-LESS completion — the wire constraint cannot reach it", () => {
    // This is the fact that makes LE2-006 safe by construction: the relay only
    // ever constrained TOOL-BEARING bodies (see `toOllamaWireBody`), and the
    // responder's synthesis call carries no `tools` at all. Were a tool ever
    // added here, the responder's prose would enter the constrained regime and
    // the LE2-006 evidence would no longer describe it.
    const stripped = stripComments(responder);
    expect(stripped).toMatch(/deps\.model\.complete\(\{/);
    expect(stripped).not.toMatch(/\btools\s*:/);
  });

  it("negative — a synthetic responder reading plan.rationale IS flagged", () => {
    const synthetic = `const text = input.plan.rationale ?? "";`;
    expect(planPropertyReads(synthetic)).toEqual(["rationale"]);
  });

  it("negative — a synthetic destructure of plan.rationale IS flagged", () => {
    const synthetic = `const { rationale } = input.plan;`;
    expect(planDestructuredReads(synthetic)).toEqual(["rationale"]);
  });

  it("negative — the tools detector trips on a synthetic tool-bearing call", () => {
    const synthetic = `deps.model.complete({ model, messages, tools: [EXPRESS_INTENT] })`;
    expect(stripComments(synthetic)).toMatch(/\btools\s*:/);
  });
});
