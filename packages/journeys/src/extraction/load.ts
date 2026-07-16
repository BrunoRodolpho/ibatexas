// extraction/load.ts — YAML loader for the extraction corpus (FE-T06, FE-2.1).
//
// Reads `packages/journeys/extraction-corpus/*.yaml` (one capability per
// file), parses, validates against `ExtractionCorpusFileSchema`, and returns
// typed `ExtractionCorpusFile[]`. Mirrors `schema/load.ts`'s contract
// (JourneyLoadError-shaped errors, sorted-by-filename determinism, duplicate
// detection) — a distinct loader because the artifact is a distinct schema
// (see schema.ts's header).

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYamlDocument } from "yaml"

import {
  validateExtractionCorpus,
  type ExtractionCorpusFile,
  type ExtractionSchemaError,
} from "./schema.js"

/**
 * The extraction-corpus YAML home (binding contract pin):
 * `packages/journeys/extraction-corpus/*.yaml`. Resolved relative to this
 * module so it works from both `src/` (vitest) and `dist/` (built package).
 */
export const DEFAULT_EXTRACTION_CORPUS_DIR = fileURLToPath(
  new URL("../../extraction-corpus/", import.meta.url),
)

export class ExtractionCorpusLoadError extends Error {
  constructor(
    /** The file (or dir) that failed, relative or absolute. */
    public readonly file: string,
    message: string,
    /** Named schema errors when the failure is a validation failure. */
    public readonly errors: readonly ExtractionSchemaError[] = [],
  ) {
    super(`${file}: ${message}`)
    this.name = "ExtractionCorpusLoadError"
  }
}

/** Parse + validate a single YAML document. Throws `ExtractionCorpusLoadError`. */
export function parseExtractionCorpusYaml(text: string, sourceFile: string): ExtractionCorpusFile {
  let data: unknown
  try {
    data = parseYamlDocument(text)
  } catch (err) {
    throw new ExtractionCorpusLoadError(sourceFile, `yaml_parse_error: ${(err as Error).message}`)
  }

  const result = validateExtractionCorpus(data)
  if (!result.ok) {
    const summary = result.errors
      .map((e) => `${e.code} at ${e.path || "<root>"}`)
      .join("; ")
    throw new ExtractionCorpusLoadError(sourceFile, `schema validation failed: ${summary}`, result.errors)
  }
  return result.file
}

/**
 * Load every `*.yaml`/`*.yml` in `dir` (default: the registry home), sorted
 * by filename for determinism. Enforces unique capability per file (a
 * rollout slice authoring a second file for the same capability is almost
 * certainly a mistake — merge into the existing file instead).
 */
export async function loadExtractionCorpus(
  dir: string = DEFAULT_EXTRACTION_CORPUS_DIR,
): Promise<ExtractionCorpusFile[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    throw new ExtractionCorpusLoadError(dir, `corpus dir unreadable: ${(err as Error).message}`)
  }

  const files = entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort((a, b) => a.localeCompare(b))

  const corpus: ExtractionCorpusFile[] = []
  const seen = new Map<string, string>() // capability -> filename
  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8")
    const parsed = parseExtractionCorpusYaml(text, file)
    const dup = seen.get(parsed.capability)
    if (dup !== undefined) {
      throw new ExtractionCorpusLoadError(
        file,
        `duplicate_capability: capability "${parsed.capability}" already defined in ${dup}`,
      )
    }
    seen.set(parsed.capability, file)
    corpus.push(parsed)
  }
  return corpus
}
