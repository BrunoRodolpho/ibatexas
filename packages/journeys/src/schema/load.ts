// schema/load.ts — YAML loader for the Journey Registry.
//
// Reads `packages/journeys/journeys/*.yaml` (one journey per file), parses,
// validates against `JourneyFileSchema`, and returns typed `Journey[]`.
// Failures are thrown as `JourneyLoadError` naming the offending file and
// carrying the named schema errors (consumed by `ibx journey lint`, T1a-2).

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYamlDocument } from "yaml"

import {
  validateJourney,
  type Journey,
  type JourneySchemaError,
} from "./journey.js"

/**
 * The journey YAML home (binding contract pin):
 * `packages/journeys/journeys/*.yaml`. Resolved relative to this module so
 * it works from both `src/` (vitest) and `dist/` (built package).
 */
export const DEFAULT_JOURNEYS_DIR = fileURLToPath(new URL("../../journeys/", import.meta.url))

export class JourneyLoadError extends Error {
  constructor(
    /** The file (or dir) that failed, relative or absolute. */
    public readonly file: string,
    message: string,
    /** Named schema errors when the failure is a validation failure. */
    public readonly errors: readonly JourneySchemaError[] = [],
  ) {
    super(`${file}: ${message}`)
    this.name = "JourneyLoadError"
  }
}

/** Parse + validate a single YAML document. Throws `JourneyLoadError`. */
export function parseJourneyYaml(text: string, sourceFile: string): Journey {
  let data: unknown
  try {
    data = parseYamlDocument(text)
  } catch (err) {
    throw new JourneyLoadError(sourceFile, `yaml_parse_error: ${(err as Error).message}`)
  }

  const result = validateJourney(data)
  if (!result.ok) {
    const summary = result.errors
      .map((e) => `${e.code} at ${e.path || "<root>"}`)
      .join("; ")
    throw new JourneyLoadError(sourceFile, `schema validation failed: ${summary}`, result.errors)
  }
  return result.journey
}

/**
 * Load every `*.yaml`/`*.yml` in `dir` (default: the registry home),
 * sorted by filename for determinism. Enforces unique journey ids.
 */
export async function loadJourneys(dir: string = DEFAULT_JOURNEYS_DIR): Promise<Journey[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    throw new JourneyLoadError(dir, `journeys dir unreadable: ${(err as Error).message}`)
  }

  const files = entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort((a, b) => a.localeCompare(b))

  const journeys: Journey[] = []
  const seen = new Map<string, string>() // journey id → filename
  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8")
    const journey = parseJourneyYaml(text, file)
    const dup = seen.get(journey.id)
    if (dup !== undefined) {
      throw new JourneyLoadError(file, `duplicate_journey_id: ${journey.id} already defined in ${dup}`)
    }
    seen.set(journey.id, file)
    journeys.push(journey)
  }
  return journeys
}
