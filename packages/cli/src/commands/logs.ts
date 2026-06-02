// ibx logs — query or tail the structured app logs from VictoriaLogs.
//
// The everyday troubleshooting front-end to the same pino stream the api ships
// to VictoriaLogs (Layer 3). Filter by component, level, turn (correlationId),
// event, or intentHash; --follow for a live tail.

import type { Command } from "commander"
import chalk from "chalk"
import {
  buildLogsQL,
  queryLogs,
  tailLogs,
  renderLogLine,
  unreachableHint,
  VICTORIALOGS_URL,
  type LogFilters,
} from "../lib/logs-query.js"

interface LogsOpts {
  level?: string
  turn?: string
  decisions?: boolean
  event?: string
  hash?: string
  since?: string
  limit: number
  follow?: boolean
  query?: string
}

function filtersFrom(component: string | undefined, opts: LogsOpts): LogFilters {
  return {
    component,
    level: opts.level,
    turn: opts.turn,
    // --decisions is sugar for event:decision
    event: opts.decisions ? "decision" : opts.event,
    intentHash: opts.hash,
    since: opts.since,
    raw: opts.query,
  }
}

export function registerLogsCommands(logs: Command): void {
  logs
    .description("Query/tail the structured app logs (VictoriaLogs)")
    .argument("[component]", "component: kernel | conductor | route | subscriber | job | audit-sink | startup")
    .option("--level <level>", "minimum level: trace|debug|info|warn|error|fatal")
    .option("--turn <id>", "filter to one turn (correlationId == conductor turnId)")
    .option("--decisions", "only kernel decision events (event:decision)")
    .option("--event <name>", "filter by event: decision|refusal|turn|ledger|sink_failure|…")
    .option("--hash <intentHash>", "filter by intentHash (joins to the intent_audit row)")
    .option("--since <dur>", "time window: 5m, 2h, 1d (default 1h)")
    .option("-n, --limit <n>", "max lines (default 200)", (v) => Number.parseInt(v, 10), 200)
    .option("-f, --follow", "live tail (Ctrl-C to stop)")
    .option("--query <logsql>", "raw LogsQL, ANDed with the filters above")
    .action(async (component: string | undefined, opts: LogsOpts) => {
      const query = buildLogsQL(filtersFrom(component, opts))

      if (opts.follow) {
        console.log(chalk.dim(`  tailing ${VICTORIALOGS_URL} — ${query}\n`))
        const controller = new AbortController()
        const stop = (): void => controller.abort()
        process.on("SIGINT", stop)
        try {
          await tailLogs(query, (e) => console.log(renderLogLine(e)), controller.signal)
        } catch (err) {
          if (!controller.signal.aborted) {
            console.error(unreachableHint(err))
            process.exitCode = 1
          }
        } finally {
          process.off("SIGINT", stop)
        }
        return
      }

      try {
        const entries = await queryLogs(query, opts.limit)
        if (entries.length === 0) {
          console.log(chalk.dim(`  no logs match — ${query}`))
          return
        }
        for (const e of entries) console.log(renderLogLine(e))
        console.log(chalk.dim(`\n  ${entries.length} lines · ${query}`))
      } catch (err) {
        console.error(unreachableHint(err))
        process.exitCode = 1
      }
    })
}
