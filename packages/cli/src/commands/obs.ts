// ibx obs — observability: watch decisions live, trace one turn end-to-end.
//
// Ergonomic views over the same VictoriaLogs stream `ibx logs` queries. The log
// `intentHash` joins 1:1 to the durable intent_audit row; `correlationId` (the
// conductor turnId) groups one turn's lines.

import type { Command } from "commander"
import chalk from "chalk"
import { queryLogs, tailLogs, renderLogLine, unreachableHint, VICTORIALOGS_URL } from "../lib/logs-query.js"

const DECISION_QUERY = "(event:=decision OR event:=refusal)"

export function registerObsCommands(obs: Command): void {
  obs.description("Observability — watch kernel decisions and per-turn traces")

  // ─── ibx obs decisions ─────────────────────────────────────────────────────
  obs
    .command("decisions")
    .description("Watch kernel decisions + refusals (live with -f)")
    .option("--since <dur>", "time window for the one-shot view: 5m, 2h (default 1h)")
    .option("-n, --limit <n>", "max lines (default 100)", (v) => Number.parseInt(v, 10), 100)
    .option("-f, --follow", "live tail (Ctrl-C to stop)")
    .action(async (opts: { since?: string; limit: number; follow?: boolean }) => {
      const since = opts.since && /^\d+[smhd]$/.test(opts.since) ? opts.since : "1h"
      const query = `_time:${since} ${DECISION_QUERY}`
      if (opts.follow) {
        console.log(chalk.dim(`  watching decisions — ${VICTORIALOGS_URL}\n`))
        const controller = new AbortController()
        const stop = (): void => controller.abort()
        process.on("SIGINT", stop)
        try {
          await tailLogs(`${DECISION_QUERY}`, (e) => console.log(renderLogLine(e)), controller.signal)
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
          console.log(chalk.dim("  no decisions in window — drive a turn, or widen --since"))
          return
        }
        for (const e of entries) console.log(renderLogLine(e))
        console.log(chalk.dim(`\n  ${entries.length} decisions · last ${since}`))
      } catch (err) {
        console.error(unreachableHint(err))
        process.exitCode = 1
      }
    })

  // ─── ibx obs turn <turnId> ──────────────────────────────────────────────────
  obs
    .command("turn <turnId>")
    .description("Show one turn's full trace by correlationId")
    .option("--since <dur>", "how far back to look (default 1d)")
    .action(async (turnId: string, opts: { since?: string }) => {
      const since = opts.since && /^\d+[smhd]$/.test(opts.since) ? opts.since : "1d"
      const query = `_time:${since} correlationId:=${JSON.stringify(turnId)}`
      try {
        const entries = await queryLogs(query, 1000)
        if (entries.length === 0) {
          console.log(chalk.dim(`  no lines for turn ${turnId} in the last ${since}`))
          return
        }
        console.log(chalk.bold(`\n  Turn ${chalk.cyan(turnId)} — ${entries.length} lines\n`))
        for (const e of entries) console.log(renderLogLine(e))
      } catch (err) {
        console.error(unreachableHint(err))
        process.exitCode = 1
      }
    })
}
