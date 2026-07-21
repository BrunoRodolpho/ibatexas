// read-tool-corpus/ barrel — the FE-T13 read-tool extraction-corpus infra.
// Deliberately minimal vs. ../extraction/index.js's barrel: no
// accuracy/runner/cli exports yet (this corpus is authored but not wired to
// a live-drive runner — see any packages/journeys/read-tool-corpus/*.yaml
// file's header for the full rationale and the FE-T13 coverage report for
// the disposition).

export {
  ReadToolCorpusCaseSchema,
  ReadToolCorpusFileSchema,
  validateReadToolCorpus,
  type ReadToolCorpusCase,
  type ReadToolCorpusFile,
} from "./schema.js"

export {
  DEFAULT_READ_TOOL_CORPUS_DIR,
  ReadToolCorpusLoadError,
  loadReadToolCorpus,
} from "./load.js"

// FE-D22 — the pure scoring adapter + the SEPARATE read-tools baseline/waivers paths.
export {
  DEFAULT_READ_TOOL_ACCURACY_BASELINE_PATH,
  DEFAULT_READ_TOOL_ACCURACY_WAIVERS_PATH,
  deepEqualArgs,
  scoreReadToolCase,
  type EmittedReadToolCall,
} from "./score.js"
