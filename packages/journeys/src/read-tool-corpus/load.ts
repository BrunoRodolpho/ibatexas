// read-tool-corpus/load.ts — FE-T13: load + validate every
// packages/journeys/read-tool-corpus/*.yaml file. Mirrors
// ../extraction/load.ts's shape for the sibling corpus format (schema.ts).

import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { validateReadToolCorpus, type ReadToolCorpusFile } from "./schema.js"

/** The read-tool-corpus YAML home (binding contract pin):
 *  `packages/journeys/read-tool-corpus/*.yaml`. Resolved relative to this
 *  module so it works from both `src/` (vitest) and `dist/` (built package) —
 *  mirrors `../extraction/load.ts`'s `DEFAULT_EXTRACTION_CORPUS_DIR`. */
export const DEFAULT_READ_TOOL_CORPUS_DIR = fileURLToPath(
  new URL("../../read-tool-corpus/", import.meta.url),
)

export class ReadToolCorpusLoadError extends Error {
  constructor(
    public readonly file: string,
    public readonly errors: readonly string[],
  ) {
    super(`[read-tool-corpus] ${file}: ${errors.join("; ")}`)
    this.name = "ReadToolCorpusLoadError"
  }
}

/** Load + validate every `*.yaml` in `dir` (default:
 *  packages/journeys/read-tool-corpus/). Throws
 *  {@link ReadToolCorpusLoadError} on the FIRST malformed file — an
 *  authoring typo is a bug to fix, not something to skip silently (mirrors
 *  ../extraction/load.ts's posture). */
export async function loadReadToolCorpus(
  dir: string = DEFAULT_READ_TOOL_CORPUS_DIR,
): Promise<ReadToolCorpusFile[]> {
  const entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml")).sort()
  const files: ReadToolCorpusFile[] = []
  for (const entry of entries) {
    const raw = await fs.readFile(path.join(dir, entry), "utf8")
    const parsed: unknown = parseYaml(raw)
    const result = validateReadToolCorpus(parsed)
    if (!result.ok) throw new ReadToolCorpusLoadError(entry, result.errors)
    files.push(result.file)
  }
  return files
}
