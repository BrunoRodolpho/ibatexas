// graphs/export.ts — the engine behind `ibx graph export` (T2-4).
//
// Regenerates the four DERIVED graphs into the canonical committed dir
// (`packages/journeys/graphs/` — recorded decision, next to governance/),
// or — in `check` mode — regenerates IN MEMORY and byte-diffs against the
// committed artifacts: any divergence (drift) or missing file makes the
// report not-ok, which the thin CLI maps to a nonzero exit. That is the
// regenerate-and-diff CI gate (.github/workflows/graphs-gate.yml): a pack /
// registry / generator change without `ibx graph export` regeneration
// fails the PR.
//
// Inputs per graph:
//   capability — the live composition (build-time imports; no files);
//   journeys   — the Journey Registry (schema loader);
//   run        — checked-in sanitized fixtures (fixtures/run-trace.jsonl +
//                fixtures/run-decisions.json); a developer can point the
//                generator at any live runs/<runId>/trace.jsonl via
//                overrides, but `check` always uses the fixtures;
//   impact     — the committed window fixture (fixtures/impact-window.json,
//                captured from the test stack via --capture-impact).

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadJourneys } from "../schema/index.js"
import { serializeGraph, GRAPH_NAMES, type GraphName } from "./contract.js"
import { buildCapabilityGraph } from "./capability-graph.js"
import { buildJourneyGraph } from "./journey-graph.js"
import {
  buildRunGraph,
  parseTraceJsonl,
  RunDecisionsFileSchema,
} from "./run-graph.js"
import {
  buildImpactGraph,
  ImpactWindowFileSchema,
  type ImpactWindowFile,
} from "./impact-graph.js"

// ── Canonical locations ──────────────────────────────────────────────────────

/**
 * The committed graphs dir (recorded decision: `packages/journeys/graphs/`).
 * Resolved relative to this module so it works from src/ and dist/ alike
 * (same idiom as DEFAULT_JOURNEYS_DIR / DEFAULT_COVERAGE_WAIVERS_PATH).
 */
export const DEFAULT_GRAPHS_DIR = fileURLToPath(
  new URL("../../graphs/", import.meta.url),
)

/** Committed artifact filename per graph. */
export const GRAPH_FILES: Readonly<Record<GraphName, string>> = {
  capability: "capability.json",
  journeys: "journeys.json",
  run: "run-fixture.json",
  impact: "impact.json",
}

/** Checked-in generator inputs (relative to the graphs dir). */
export const RUN_TRACE_FIXTURE = "fixtures/run-trace.jsonl"
export const RUN_DECISIONS_FIXTURE = "fixtures/run-decisions.json"
export const IMPACT_WINDOW_FIXTURE = "fixtures/impact-window.json"

export class GraphExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GraphExportError"
  }
}

// ── Report shapes (the --json contract) ──────────────────────────────────────

export type GraphExportStatus = "written" | "clean" | "drift" | "missing"

export interface GraphExportEntry {
  graph: GraphName
  /** Path of the committed artifact (relative to graphsDir). */
  file: string
  status: GraphExportStatus
  nodes: number
  edges: number
}

export interface GraphExportReport {
  ok: boolean
  mode: "write" | "check"
  graphsDir: string
  graphs: GraphExportEntry[]
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface ExportGraphsOptions {
  /** Graphs dir override (default: the committed packages/journeys/graphs/). */
  graphsDir?: string
  /** Restrict to a subset of graphs (default: all four). */
  only?: ReadonlyArray<GraphName>
  /** Check mode: regenerate in memory + diff against committed (never writes). */
  check?: boolean
  /** Journey Registry dir override (tests). */
  journeysDir?: string
  /** Run-graph input overrides (developer use; refused in check mode). */
  runTracePath?: string
  runDecisionsPath?: string
}

// ── Generation ───────────────────────────────────────────────────────────────

async function readJsonFile(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (err) {
    throw new GraphExportError(`cannot read ${path}: ${(err as Error).message}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new GraphExportError(`${path} is not valid JSON`)
  }
}

async function generateGraph(
  name: GraphName,
  opts: {
    graphsDir: string
    journeysDir?: string
    runTracePath?: string
    runDecisionsPath?: string
  },
): Promise<string> {
  switch (name) {
    case "capability":
      return serializeGraph(buildCapabilityGraph())
    case "journeys": {
      const journeys = await loadJourneys(opts.journeysDir)
      return serializeGraph(buildJourneyGraph(journeys))
    }
    case "run": {
      const tracePath = opts.runTracePath ?? join(opts.graphsDir, RUN_TRACE_FIXTURE)
      const decisionsPath =
        opts.runDecisionsPath ?? join(opts.graphsDir, RUN_DECISIONS_FIXTURE)
      let traceText: string
      try {
        traceText = await readFile(tracePath, "utf8")
      } catch (err) {
        throw new GraphExportError(
          `cannot read run trace ${tracePath}: ${(err as Error).message}`,
        )
      }
      const decisionsRaw = await readJsonFile(decisionsPath)
      const decisions = RunDecisionsFileSchema.safeParse(decisionsRaw)
      if (!decisions.success) {
        throw new GraphExportError(
          `${decisionsPath} does not match RunDecisionsFileSchema: ` +
            decisions.error.issues.map((i) => i.path.join(".") || "<root>").join(", "),
        )
      }
      return serializeGraph(
        buildRunGraph({ events: parseTraceJsonl(traceText), decisions: decisions.data }),
      )
    }
    case "impact": {
      const windowPath = join(opts.graphsDir, IMPACT_WINDOW_FIXTURE)
      const windowRaw = await readJsonFile(windowPath)
      const window = ImpactWindowFileSchema.safeParse(windowRaw)
      if (!window.success) {
        throw new GraphExportError(
          `${windowPath} does not match ImpactWindowFileSchema: ` +
            window.error.issues.map((i) => i.path.join(".") || "<root>").join(", "),
        )
      }
      return serializeGraph(buildImpactGraph(window.data))
    }
  }
}

function countOf(serialized: string, key: "nodes" | "edges"): number {
  const doc = JSON.parse(serialized) as { nodes: unknown[]; edges: unknown[] }
  return doc[key].length
}

/** Resolve the graph subset to (re)generate, validating each requested name. */
function resolveGraphNames(
  only: ReadonlyArray<GraphName> | undefined,
): ReadonlyArray<GraphName> {
  const names: ReadonlyArray<GraphName> =
    only !== undefined && only.length > 0 ? only : GRAPH_NAMES
  for (const name of names) {
    if (!GRAPH_NAMES.includes(name)) {
      throw new GraphExportError(
        `unknown graph "${name}" (known: ${GRAPH_NAMES.join(", ")})`,
      )
    }
  }
  return names
}

/** Build the per-graph generator opts, carrying only the overrides that are set. */
function buildGenerateOpts(
  graphsDir: string,
  options: ExportGraphsOptions,
): {
  graphsDir: string
  journeysDir?: string
  runTracePath?: string
  runDecisionsPath?: string
} {
  const opts: {
    graphsDir: string
    journeysDir?: string
    runTracePath?: string
    runDecisionsPath?: string
  } = { graphsDir }
  if (options.journeysDir !== undefined) opts.journeysDir = options.journeysDir
  if (options.runTracePath !== undefined) opts.runTracePath = options.runTracePath
  if (options.runDecisionsPath !== undefined) {
    opts.runDecisionsPath = options.runDecisionsPath
  }
  return opts
}

/**
 * Check-mode status for one graph: byte-diff the freshly serialized graph
 * against the committed artifact. A missing file is `missing`; an exact
 * match is `clean`; anything else is `drift`.
 */
async function diffCommittedGraph(
  path: string,
  serialized: string,
): Promise<GraphExportStatus> {
  let committed: string | null
  try {
    committed = await readFile(path, "utf8")
  } catch {
    committed = null
  }
  if (committed === null) return "missing"
  if (committed === serialized) return "clean"
  return "drift"
}

/**
 * Regenerate the four graphs (write mode) or regenerate-and-diff against
 * the committed artifacts (check mode). Check mode NEVER writes; a drifted
 * or missing artifact makes `report.ok` false. Generator/input failures
 * throw `GraphExportError` — an unreadable input must never read as clean.
 */
export async function exportGraphs(
  options: ExportGraphsOptions = {},
): Promise<GraphExportReport> {
  const check = options.check === true
  const graphsDir = options.graphsDir ?? DEFAULT_GRAPHS_DIR
  const names = resolveGraphNames(options.only)
  if (check && (options.runTracePath !== undefined || options.runDecisionsPath !== undefined)) {
    throw new GraphExportError(
      "check mode always diffs the COMMITTED fixtures — run-graph input overrides are refused",
    )
  }

  const entries: GraphExportEntry[] = []
  for (const name of names) {
    const serialized = await generateGraph(name, buildGenerateOpts(graphsDir, options))
    const file = GRAPH_FILES[name]
    const path = join(graphsDir, file)

    let status: GraphExportStatus
    if (check) {
      status = await diffCommittedGraph(path, serialized)
    } else {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, serialized)
      status = "written"
    }

    entries.push({
      graph: name,
      file,
      status,
      nodes: countOf(serialized, "nodes"),
      edges: countOf(serialized, "edges"),
    })
  }

  return {
    ok: entries.every((e) => e.status === "written" || e.status === "clean"),
    mode: check ? "check" : "write",
    graphsDir,
    graphs: entries,
  }
}

// ── Impact-window capture (live/seeded audit DB → committed fixture) ─────────

/**
 * Write a freshly aggregated impact window into the committed fixture
 * (`fixtures/impact-window.json`). Caller supplies the aggregation result
 * (see `fetchImpactWindow`); a subsequent `exportGraphs()` regenerates
 * `impact.json` from it. Returns the fixture path.
 */
export async function writeImpactWindowFixture(
  window: ImpactWindowFile,
  graphsDir: string = DEFAULT_GRAPHS_DIR,
): Promise<string> {
  const parsed = ImpactWindowFileSchema.safeParse(window)
  if (!parsed.success) {
    throw new GraphExportError("refusing to write an invalid impact-window fixture")
  }
  const path = join(graphsDir, IMPACT_WINDOW_FIXTURE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(parsed.data, null, 2)}\n`)
  return path
}
