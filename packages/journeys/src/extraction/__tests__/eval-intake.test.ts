// extraction/__tests__/eval-intake.test.ts — LE2-05: the intake half
// (schemas, loaders, the case↔artifact join) plus the COMMITTED assets and
// the determinism AC.

import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  EVAL_REFUSAL_CAPABILITY,
  EVAL_REFUSAL_CAPABILITY_IS_WAIVABLE,
  validateEvalFixture,
  validateRefusalCorpus,
} from "../eval-schema.js"
import {
  DEFAULT_EVAL_FIXTURES_DIR,
  DEFAULT_REFUSAL_CORPUS_PATH,
  ExtractionEvalLoadError,
  buildEvalIntake,
  envelopesFromFixtures,
  evalCasesFromCorpus,
  evalCasesFromRefusalCorpus,
  indexEnvelopesByUtterance,
  loadEvalFixtures,
  loadRefusalCorpus,
  parseEvalFixtureJson,
  parseRefusalCorpusYaml,
} from "../eval-intake.js"
import { runExtractionEvalCli, DEFAULT_EVAL_BASELINE_PATH } from "../eval-cli.js"
import { ExtractionCorpusLoadError } from "./../load.js"

// ── Schemas ─────────────────────────────────────────────────────────────────

describe("eval fixture schema", () => {
  const wire = {
    formatVersion: 1,
    source: "wire",
    id: "fx",
    note: "n",
    synthetic: false,
    artifacts: [{ utterance: "Oi", completion: "{}" }],
  }

  it("accepts a well-formed wire fixture", () => {
    expect(validateEvalFixture(wire).ok).toBe(true)
  })

  it("rejects a wire artifact carrying neither a completion nor a tool call", () => {
    const result = validateEvalFixture({ ...wire, artifacts: [{ utterance: "Oi" }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("empty_wire_artifact")
  })

  it("rejects an unknown source (the union is closed)", () => {
    expect(validateEvalFixture({ ...wire, source: "guesswork" }).ok).toBe(false)
  })

  it("rejects an unknown top-level key (strict)", () => {
    expect(validateEvalFixture({ ...wire, extra: 1 }).ok).toBe(false)
  })
})

describe("refusal corpus schema", () => {
  it("accepts the sound-abstain shape and rejects a non-null expectCapability", () => {
    expect(
      validateRefusalCorpus({ source: "s", cases: [{ id: "a", utterance: "Oi", expectCapability: null }] }).ok,
    ).toBe(true)
    expect(
      validateRefusalCorpus({ source: "s", cases: [{ id: "a", utterance: "Oi", expectCapability: "x" }] }).ok,
    ).toBe(false)
  })

  it("names a duplicate case id", () => {
    const result = validateRefusalCorpus({
      source: "s",
      cases: [
        { id: "a", utterance: "Oi", expectCapability: null },
        { id: "a", utterance: "Olá", expectCapability: null },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("duplicate_case_id")
  })

  it("the ∅-class report key stays WAIVABLE by the ordinary waivers machinery", () => {
    expect(EVAL_REFUSAL_CAPABILITY_IS_WAIVABLE).toBe(true)
    expect(EVAL_REFUSAL_CAPABILITY).toBe("eval.refusal")
  })
})

// ── Loaders ─────────────────────────────────────────────────────────────────

describe("loaders", () => {
  it("throws a named error on malformed JSON / YAML", () => {
    expect(() => parseEvalFixtureJson("{oops", "f.json")).toThrow(ExtractionEvalLoadError)
    expect(() => parseRefusalCorpusYaml("a:\n  - [", "f.yaml")).toThrow(ExtractionEvalLoadError)
  })

  it("surfaces a bad CORPUS as its own named error (the offline replay's only other failure mode)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ibx-eval-corpus-"))
    try {
      await writeFile(join(dir, "broken.yaml"), "capability: NOT A KIND\n")
      await expect(runExtractionEvalCli({ corpusDir: dir })).rejects.toBeInstanceOf(
        ExtractionCorpusLoadError,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("treats a MISSING fixtures dir / refusal corpus as empty, never as a crash", async () => {
    const missing = join(tmpdir(), "ibx-eval-does-not-exist-42")
    await expect(loadEvalFixtures(missing)).resolves.toEqual([])
    await expect(loadRefusalCorpus(join(missing, "refusal-corpus.yaml"))).resolves.toBeNull()
  })

  it("refuses two fixture files declaring the same id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ibx-eval-"))
    try {
      const body = {
        formatVersion: 1,
        source: "wire",
        id: "same",
        note: "n",
        synthetic: true,
        artifacts: [{ utterance: "Oi", completion: "{}" }],
      }
      await writeFile(join(dir, "a.json"), JSON.stringify(body))
      await writeFile(join(dir, "b.json"), JSON.stringify(body))
      await expect(loadEvalFixtures(dir)).rejects.toThrow(/duplicate_fixture_id/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("loads fixture files sorted by filename (deterministic artifact order)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ibx-eval-"))
    try {
      const mk = (id: string, utterance: string): string =>
        JSON.stringify({
          formatVersion: 1,
          source: "wire",
          id,
          note: "n",
          synthetic: true,
          artifacts: [{ utterance, completion: "{}" }],
        })
      await writeFile(join(dir, "z.json"), mk("z", "zeta"))
      await writeFile(join(dir, "a.json"), mk("a", "alfa"))
      const loaded = await loadEvalFixtures(dir)
      expect(loaded.map((l) => l.file)).toEqual(["a.json", "z.json"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── The case ↔ artifact join ────────────────────────────────────────────────

describe("case ↔ artifact join", () => {
  it("projects corpus cases unmodified and refusal cases onto the ∅ key", () => {
    const parse = evalCasesFromCorpus([
      {
        capability: "order.cancel",
        source: "s",
        plane: "customer",
        cases: [{ id: "a", utterance: "cancela", expectPayload: { extractionIR: { payload: {} } } }],
      },
    ])
    expect(parse).toEqual([
      {
        kind: "parse",
        capability: "order.cancel",
        caseId: "a",
        utterance: "cancela",
        expectPayload: { extractionIR: { payload: {} } },
      },
    ])
    expect(
      evalCasesFromRefusalCorpus({ source: "s", cases: [{ id: "g", utterance: "Oi", expectCapability: null }] }),
    ).toEqual([{ kind: "refusal", capability: EVAL_REFUSAL_CAPABILITY, caseId: "g", utterance: "Oi" }])
    expect(evalCasesFromRefusalCorpus(null)).toEqual([])
  })

  it("joins on the NORMALIZED utterance, so padding/casing never loses evidence", () => {
    const indexed = envelopesFromFixtures([
      {
        file: "f.json",
        fixture: {
          formatVersion: 1,
          source: "wire",
          id: "f",
          note: "n",
          synthetic: true,
          artifacts: [{ utterance: "  CANCELA   Meu Pedido ", completion: "{}" }],
        },
      },
    ])
    expect([...indexEnvelopesByUtterance(indexed).keys()]).toEqual(["cancela meu pedido"])
  })

  it("groups several captures of the SAME utterance into one bucket", () => {
    const artifact = { utterance: "Oi", completion: "{}" }
    const indexed = envelopesFromFixtures([
      {
        file: "f.json",
        fixture: {
          formatVersion: 1,
          source: "wire",
          id: "f",
          note: "n",
          synthetic: true,
          artifacts: [artifact, artifact],
        },
      },
    ])
    expect(indexEnvelopesByUtterance(indexed).get("oi")).toHaveLength(2)
  })
})

// ── The COMMITTED assets + the determinism AC ───────────────────────────────

describe("the committed eval-harness assets", () => {
  it("every committed fixture in extraction-eval/fixtures/ loads and validates", async () => {
    const fixtures = await loadEvalFixtures(DEFAULT_EVAL_FIXTURES_DIR)
    expect(fixtures.length).toBeGreaterThan(0)
    for (const { fixture } of fixtures) expect(fixture.artifacts.length).toBeGreaterThan(0)
  })

  it("the committed refusal corpus loads and every case asserts the ∅ class", async () => {
    const corpus = await loadRefusalCorpus(DEFAULT_REFUSAL_CORPUS_PATH)
    expect(corpus).not.toBeNull()
    for (const kase of corpus?.cases ?? []) expect(kase.expectCapability).toBeNull()
  })

  it("the committed baseline claims only cases the harness currently reports passing", async () => {
    const { readFile } = await import("node:fs/promises")
    const baseline = JSON.parse(await readFile(DEFAULT_EVAL_BASELINE_PATH, "utf8")) as {
      passing: string[]
    }
    const { report } = await runExtractionEvalCli({})
    const passing = new Set(
      report.accuracy.cases.filter((c) => c.state === "passing").map((c) => c.key),
    )
    expect(baseline.passing.filter((k) => !passing.has(k))).toEqual([])
  })

  it("the committed waivers file is valid — a run over the real assets reports no problem", async () => {
    const { report } = await runExtractionEvalCli({})
    expect(report.accuracy.problems).toEqual([])
    expect(report.ok).toBe(true)
  })

  it("DETERMINISM AC: two runs over the same pinned inputs are byte-identical", async () => {
    const first = await runExtractionEvalCli({})
    const second = await runExtractionEvalCli({})
    expect(JSON.stringify(second.report)).toBe(JSON.stringify(first.report))
  })

  it("a case with no pinned artifact is UNSCOREABLE — counted, never silently skipped", async () => {
    const { report } = await runExtractionEvalCli({})
    expect(report.unscoreable.total).toBe(report.totals.unscoreable)
    expect(report.totals.cases).toBe(
      report.totals.passing + report.totals.failing + report.totals.unscoreable,
    )
    expect(report.unscoreable.total).toBeGreaterThan(0)
  })

  it("scores against BOTH artifact sources", async () => {
    const { report } = await runExtractionEvalCli({})
    for (const source of report.sources) expect(source.artifacts).toBeGreaterThan(0)
  })

  it("an empty fixtures dir degrades to all-unscoreable — never to a clean-looking pass", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ibx-eval-empty-"))
    try {
      await mkdir(join(dir, "fixtures"), { recursive: true })
      const { report } = await runExtractionEvalCli({ fixturesDir: join(dir, "fixtures") })
      expect(report.totals.passing).toBe(0)
      expect(report.totals.scoreable).toBe(0)
      expect(report.totals.unscoreable).toBe(report.totals.cases)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("buildEvalIntake assembles corpus cases first, then the ∅ class, in a stable order", async () => {
    const a = await buildEvalIntake({})
    const b = await buildEvalIntake({})
    expect(a.cases.map((c) => `${c.capability}:${c.caseId}`)).toEqual(
      b.cases.map((c) => `${c.capability}:${c.caseId}`),
    )
    expect(a.cases.at(-1)?.capability).toBe(EVAL_REFUSAL_CAPABILITY)
  })
})
