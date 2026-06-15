// graphs/ barrel — the four derived graphs + the export/check engine (T2-4).
//
// ONE shared graph JSON contract (contract.ts) for capability / journeys /
// run / impact; committed artifacts live in `packages/journeys/graphs/`
// (README there documents the contract for the T2-5 viewer); `ibx graph
// export [--check]` is the thin CLI over `exportGraphs`.

export {
  GRAPH_NAMES,
  finalizeGraph,
  serializeGraph,
  GraphContractError,
  type GraphName,
  type GraphNode,
  type GraphEdge,
  type GraphDocument,
} from "./contract.js"

export {
  buildCapabilityGraph,
  CAPABILITY_PERSONA_CONTEXTS,
} from "./capability-graph.js"

export { buildJourneyGraph } from "./journey-graph.js"

export {
  buildRunGraph,
  parseTraceJsonl,
  RunDecisionsFileSchema,
  RunTraceParseError,
  type RunDecisionsFile,
  type RunTraceEvent,
} from "./run-graph.js"

export {
  buildImpactGraph,
  fetchImpactWindow,
  ImpactWindowFileSchema,
  ImpactWindowError,
  AGENT_SESSION_ID_PREFIX,
  IMPACT_WINDOW_SQL,
  IMPACT_EXCLUDED_SQL,
  type ImpactWindowFile,
  type ImpactQueryable,
} from "./impact-graph.js"

export {
  exportGraphs,
  writeImpactWindowFixture,
  DEFAULT_GRAPHS_DIR,
  GRAPH_FILES,
  RUN_TRACE_FIXTURE,
  RUN_DECISIONS_FIXTURE,
  IMPACT_WINDOW_FIXTURE,
  GraphExportError,
  type ExportGraphsOptions,
  type GraphExportEntry,
  type GraphExportReport,
  type GraphExportStatus,
} from "./export.js"
