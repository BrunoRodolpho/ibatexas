// Structured logging port for @ibatexas/nats-client.
//
// nats-client lives in packages/ and cannot import the api's pino logger — that
// would be a package → app reverse dependency, the same boundary that already
// gates setOutboxWriter / setDlqHandler. So it defines a minimal StructuredLogger
// port with a safe console default; the api's startup root injects its pino
// logger via setNatsLogger() so NATS diagnostics flow through the same
// structured, VictoriaLogs-bound stream as the rest of the system (cycle-36 L5
// sweep). Until injected (CLI/test use), the default emits structured JSON on
// the lint-allowed console channels so nothing goes dark.

export interface StructuredLogger {
  info(obj: Record<string, unknown>, msg?: string): void
  warn(obj: Record<string, unknown>, msg?: string): void
  error(obj: Record<string, unknown>, msg?: string): void
  child(bindings: Record<string, unknown>): StructuredLogger
}

// Default sink: structured JSON via console.warn/console.error (the channels the
// eslint config allows). Used only until the api injects pino; the `level` field
// carries the true level even though info routes to the warn channel here.
function consoleLogger(bindings: Record<string, unknown> = {}): StructuredLogger {
  const line = (level: string, obj: Record<string, unknown>, msg?: string): string =>
    JSON.stringify({ level, ...bindings, ...obj, ...(msg ? { msg } : {}) })
  return {
    info: (obj, msg) => console.warn(line("info", obj, msg)),
    warn: (obj, msg) => console.warn(line("warn", obj, msg)),
    error: (obj, msg) => console.error(line("error", obj, msg)),
    child: (b) => consoleLogger({ ...bindings, ...b }),
  }
}

let _logger: StructuredLogger = consoleLogger({ component: "nats-client" })

/**
 * Inject a structured logger. Called once at API startup (mirrors
 * setOutboxWriter / setDlqHandler). The api passes its pino logger so NATS
 * connection-lifecycle, outbox, and subscriber-error diagnostics ship to
 * VictoriaLogs with `component: "nats-client"`.
 */
export function setNatsLogger(logger: StructuredLogger): void {
  _logger = typeof logger.child === "function"
    ? logger.child({ component: "nats-client" })
    : logger
}

/** The active structured logger (component-bound). */
export function natsLog(): StructuredLogger {
  return _logger
}
