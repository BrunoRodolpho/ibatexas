// extraction/eval-intake.ts — LE2-05: the harness's INTAKE half. Reads the
// pinned, committed inputs off disk and turns them into the two things
// `eval-score.ts` consumes: eval CASES (authored expectations) and the
// ParsedEnvelope index (captured artifacts, keyed by normalized utterance).
//
// The only I/O in the harness, and it is all local files — the harness never
// opens a socket. Everything is sorted by filename / declared order, so the
// intake is byte-deterministic (LE2-05's determinism AC).
//
// Mirrors `load.ts`'s contract exactly (named error codes, an
// `*LoadError` carrying the offending file, sorted-by-filename iteration) —
// a distinct loader because the artifacts are distinct schemas.

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYamlDocument } from "yaml"

import type { ExtractionCorpusFile } from "./schema.js"
import {
  EVAL_REFUSAL_CAPABILITY,
  validateEvalFixture,
  validateRefusalCorpus,
  type EvalFixtureFile,
  type EvalSchemaError,
  type RefusalCorpusFile,
} from "./eval-schema.js"
import {
  envelopeFromAuditGold,
  envelopeFromWire,
  normalizeUtterance,
  type EvalCase,
  type EvalParseCase,
  type EvalRefusalCase,
  type ParsedEnvelope,
} from "./eval-score.js"

/**
 * The eval-harness asset home (binding contract pin):
 * `packages/journeys/extraction-eval/`. Resolved relative to this module so
 * it works from both `src/` (vitest) and `dist/` (built package).
 */
export const DEFAULT_EVAL_ASSET_DIR = fileURLToPath(
  new URL("../../extraction-eval/", import.meta.url),
)

/** `packages/journeys/extraction-eval/fixtures/*.json` — the pinned artifacts. */
export const DEFAULT_EVAL_FIXTURES_DIR = join(DEFAULT_EVAL_ASSET_DIR, "fixtures")

/** `packages/journeys/extraction-eval/refusal-corpus.yaml` — the ∅-class cases. */
export const DEFAULT_REFUSAL_CORPUS_PATH = join(DEFAULT_EVAL_ASSET_DIR, "refusal-corpus.yaml")

export class ExtractionEvalLoadError extends Error {
  constructor(
    /** The file (or dir) that failed. */
    public readonly file: string,
    message: string,
    /** Named schema errors when the failure is a validation failure. */
    public readonly errors: readonly EvalSchemaError[] = [],
  ) {
    super(`${file}: ${message}`)
    this.name = "ExtractionEvalLoadError"
  }
}

function summarize(errors: readonly EvalSchemaError[]): string {
  return errors.map((e) => `${e.code} at ${e.path || "<root>"}`).join("; ")
}

// ── Artifact fixtures ───────────────────────────────────────────────────────

export interface LoadedEvalFixture {
  /** The fixture's filename (sorted iteration order + error attribution). */
  file: string
  fixture: EvalFixtureFile
}

/** Parse + validate a single fixture document. Throws `ExtractionEvalLoadError`. */
export function parseEvalFixtureJson(text: string, sourceFile: string): EvalFixtureFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new ExtractionEvalLoadError(sourceFile, `json_parse_error: ${(err as Error).message}`)
  }
  const result = validateEvalFixture(data)
  if (!result.ok) {
    throw new ExtractionEvalLoadError(
      sourceFile,
      `schema validation failed: ${summarize(result.errors)}`,
      result.errors,
    )
  }
  return result.file
}

/**
 * Load every `*.json` in `dir`, sorted by filename. A MISSING directory is
 * not an error — it yields zero fixtures, and every case then reports
 * `unscoreable: no_artifact`. That is the honest degenerate state of a
 * harness whose evidence has not been exported yet; it must never look like
 * a clean run, and (because unscoreable is never passing) it never does.
 */
export async function loadEvalFixtures(
  dir: string = DEFAULT_EVAL_FIXTURES_DIR,
): Promise<LoadedEvalFixture[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new ExtractionEvalLoadError(dir, `fixtures dir unreadable: ${(err as Error).message}`)
  }

  const files = entries.filter((f) => f.endsWith(".json")).sort((a, b) => a.localeCompare(b))
  const loaded: LoadedEvalFixture[] = []
  const seenIds = new Map<string, string>()
  for (const file of files) {
    const fixture = parseEvalFixtureJson(await readFile(join(dir, file), "utf8"), file)
    const duplicate = seenIds.get(fixture.id)
    if (duplicate !== undefined) {
      throw new ExtractionEvalLoadError(
        file,
        `duplicate_fixture_id: id "${fixture.id}" already declared in ${duplicate}`,
      )
    }
    seenIds.set(fixture.id, file)
    loaded.push({ file, fixture })
  }
  return loaded
}

// ── Refusal corpus ──────────────────────────────────────────────────────────

/** Parse + validate the refusal corpus YAML. Throws `ExtractionEvalLoadError`. */
export function parseRefusalCorpusYaml(text: string, sourceFile: string): RefusalCorpusFile {
  let data: unknown
  try {
    data = parseYamlDocument(text)
  } catch (err) {
    throw new ExtractionEvalLoadError(sourceFile, `yaml_parse_error: ${(err as Error).message}`)
  }
  const result = validateRefusalCorpus(data)
  if (!result.ok) {
    throw new ExtractionEvalLoadError(
      sourceFile,
      `schema validation failed: ${summarize(result.errors)}`,
      result.errors,
    )
  }
  return result.file
}

/** Load the committed refusal corpus. A MISSING file yields zero ∅-class cases. */
export async function loadRefusalCorpus(
  path: string = DEFAULT_REFUSAL_CORPUS_PATH,
): Promise<RefusalCorpusFile | null> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new ExtractionEvalLoadError(path, `refusal corpus unreadable: ${(err as Error).message}`)
  }
  return parseRefusalCorpusYaml(text, path)
}

// ── Cases + artifact index ──────────────────────────────────────────────────

/**
 * Project the 308 authored extraction-corpus cases into eval PARSE cases —
 * a pure re-keying, zero corpus edits: the same `capability`, `id`,
 * `utterance` and `expectPayload` the live meter already drives.
 */
export function evalCasesFromCorpus(
  corpus: readonly ExtractionCorpusFile[],
): EvalParseCase[] {
  return corpus.flatMap((file) =>
    file.cases.map((kase) => ({
      kind: "parse" as const,
      capability: file.capability,
      caseId: kase.id,
      utterance: kase.utterance,
      expectPayload: kase.expectPayload,
    })),
  )
}

/** Project the authored refusal corpus into eval ∅-class cases. */
export function evalCasesFromRefusalCorpus(file: RefusalCorpusFile | null): EvalRefusalCase[] {
  if (file === null) return []
  return file.cases.map((kase) => ({
    kind: "refusal" as const,
    capability: EVAL_REFUSAL_CAPABILITY,
    caseId: kase.id,
    utterance: kase.utterance,
  }))
}

/** One indexed artifact — the envelope plus the fixture attribution. */
export interface IndexedEnvelope {
  envelope: ParsedEnvelope
  /** The normalized utterance it was captured for (the join key). */
  key: string
}

/**
 * Reduce every loaded fixture to `ParsedEnvelope`s in a stable order: files
 * sorted by name (the loader's contract), artifacts in their declared order.
 */
export function envelopesFromFixtures(
  fixtures: readonly LoadedEvalFixture[],
): IndexedEnvelope[] {
  const out: IndexedEnvelope[] = []
  for (const { fixture } of fixtures) {
    // Discriminate ONCE, outside the artifact loop — each arm's `artifacts`
    // is then narrowed to its own artifact shape.
    if (fixture.source === "audit-gold") {
      for (const artifact of fixture.artifacts) {
        out.push({
          envelope: envelopeFromAuditGold(artifact, fixture.id),
          key: normalizeUtterance(artifact.utterance),
        })
      }
    } else {
      for (const artifact of fixture.artifacts) {
        out.push({
          envelope: envelopeFromWire(artifact, fixture.id),
          key: normalizeUtterance(artifact.utterance),
        })
      }
    }
  }
  return out
}

/** Group indexed envelopes by their normalized utterance (the join key). */
export function indexEnvelopesByUtterance(
  indexed: readonly IndexedEnvelope[],
): Map<string, ParsedEnvelope[]> {
  const byUtterance = new Map<string, ParsedEnvelope[]>()
  for (const { envelope, key } of indexed) {
    const bucket = byUtterance.get(key)
    if (bucket === undefined) byUtterance.set(key, [envelope])
    else bucket.push(envelope)
  }
  return byUtterance
}

export interface EvalIntake {
  cases: EvalCase[]
  envelopesByUtterance: Map<string, ParsedEnvelope[]>
  fixtures: LoadedEvalFixture[]
  indexed: IndexedEnvelope[]
}

export interface BuildEvalIntakeOptions {
  corpusDir?: string
  fixturesDir?: string
  refusalCorpusPath?: string
}

/**
 * Load every pinned input and assemble the intake. Cases are emitted in a
 * STABLE order: corpus cases first (corpus files are already loaded sorted by
 * filename, cases in declared order), then the ∅-class cases in declared
 * order — so the report's case list is byte-identical run to run.
 */
export async function buildEvalIntake(
  options: BuildEvalIntakeOptions = {},
): Promise<EvalIntake> {
  const { loadExtractionCorpus } = await import("./load.js")
  const corpus = await loadExtractionCorpus(options.corpusDir)
  const refusal = await loadRefusalCorpus(options.refusalCorpusPath)
  const fixtures = await loadEvalFixtures(options.fixturesDir)
  const indexed = envelopesFromFixtures(fixtures)

  return {
    cases: [...evalCasesFromCorpus(corpus), ...evalCasesFromRefusalCorpus(refusal)],
    envelopesByUtterance: indexEnvelopesByUtterance(indexed),
    fixtures,
    indexed,
  }
}
