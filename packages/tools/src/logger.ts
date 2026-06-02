// Structured logging port for @ibatexas/tools.
//
// Tools execute inside the api process (kernel EXECUTE → onExecute → tool) but
// cannot import the api's pino logger — that would be a package → app reverse
// dependency. Mirroring the kernel's MetricsSink seam, tools define a minimal
// StructuredLogger port with a safe console default; the api's startup root
// injects its pino logger via setToolsLogger() so tool diagnostics flow through
// the same structured, VictoriaLogs-bound stream as the rest of the system
// (cycle-36 L5 sweep).
//
// No pino dependency here, so the browser-imported `@ibatexas/tools/api`
// subpath (base-url.ts) stays free of Node-only logging code.
//
// Correlation: AgentContext carries only `sessionId` (a PII proxy the api
// metrics-sink hashes before egress) — there is no non-PII per-turn handle in
// scope here, so tool logs are tagged by `component` and structured fields and
// deliberately omit raw session/customer ids (no PII into the log store). Per-
// turn correlation would require threading the request logger through
// AgentContext — documented as a future enhancement.

export interface StructuredLogger {
  debug(obj: Record<string, unknown>, msg?: string): void
  info(obj: Record<string, unknown>, msg?: string): void
  warn(obj: Record<string, unknown>, msg?: string): void
  error(obj: Record<string, unknown>, msg?: string): void
}

/** A component-scoped logger handed to each tool module. */
export interface ComponentLogger {
  debug(obj: Record<string, unknown>, msg?: string): void
  info(obj: Record<string, unknown>, msg?: string): void
  warn(obj: Record<string, unknown>, msg?: string): void
  error(obj: Record<string, unknown>, msg?: string): void
}

// Default sink: structured JSON on the lint-allowed console channels (warn/error)
// plus stdout for debug/info. Used only until the api injects pino (e.g. a tool
// run from the CLI or a unit test); the `level` field always carries the true
// level. Spy-compatible: warn/error still go through console.warn/console.error.
function consoleLogger(): StructuredLogger {
  const line = (level: string, obj: Record<string, unknown>, msg?: string): string =>
    JSON.stringify({ level, ...obj, ...(msg ? { msg } : {}) })
  return {
    debug: (obj, msg) => process.stdout.write(line("debug", obj, msg) + "\n"),
    info: (obj, msg) => process.stdout.write(line("info", obj, msg) + "\n"),
    warn: (obj, msg) => console.warn(line("warn", obj, msg)),
    error: (obj, msg) => console.error(line("error", obj, msg)),
  }
}

let _root: StructuredLogger = consoleLogger()

/**
 * Inject the process structured logger. Called once at API startup. The api
 * passes its pino logger so tool diagnostics ship to VictoriaLogs.
 */
export function setToolsLogger(logger: StructuredLogger): void {
  _root = logger
}

/**
 * Get a component-scoped logger. `component` is merged into every line (read
 * against the *current* injected root each call, so a module-level
 * `const log = toolLog("tools:cart")` always reflects the injected logger).
 */
export function toolLog(component: string): ComponentLogger {
  return {
    debug: (obj = {}, msg) => _root.debug({ component, ...obj }, msg),
    info: (obj = {}, msg) => _root.info({ component, ...obj }, msg),
    warn: (obj = {}, msg) => _root.warn({ component, ...obj }, msg),
    error: (obj = {}, msg) => _root.error({ component, ...obj }, msg),
  }
}
