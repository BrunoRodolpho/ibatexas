// ibx obs — observability: watch decisions live, trace one turn end-to-end.
//
// Ergonomic views over the same VictoriaLogs stream `ibx logs` queries. The log
// `intentHash` joins 1:1 to the durable intent_audit row; `correlationId` (the
// conductor turnId) groups one turn's lines.

import type { Command } from "commander"
import chalk from "chalk"
import { queryLogs, tailLogs, renderLogLine, unreachableHint, VICTORIALOGS_URL } from "../lib/logs-query.js"

const DECISION_QUERY = "(event:=decision OR event:=refusal)"
const PAYMENT_COMPONENT = JSON.stringify("job:stripe-webhook")

// Funnel stages in order — drop-off between consecutive stages = orders that paid
// but didn't finalize (the exact failure that stranded IBX-0002).
const FUNNEL_STAGES: [event: string, label: string][] = [
  ["payment.received", "received"],
  ["order.completed", "order completed"],
  ["payment.captured", "captured"],
  ["payment.reconciled", "reconciled"],
]

// Shared live-tail loop: subscribe to `stream`, render each line, and stop
// cleanly on Ctrl-C. Aborted tails are silent; other failures surface a hint.
async function followLiveTail(stream: string, label: string): Promise<void> {
  console.log(chalk.dim(`  watching ${label} — ${VICTORIALOGS_URL}\n`))
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.on("SIGINT", stop)
  try {
    await tailLogs(stream, (e) => console.log(renderLogLine(e)), controller.signal)
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error(unreachableHint(err))
      process.exitCode = 1
    }
  } finally {
    process.off("SIGINT", stop)
  }
}

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

  // ─── ibx obs payments ───────────────────────────────────────────────────────
  obs
    .command("payments")
    .description("Recent checkout/payment webhook events (--pi to trace one end-to-end, -f to tail)")
    .option("--since <dur>", "time window: 5m, 2h (default 6h)")
    .option("--pi <id>", "trace one Stripe payment_intent (pi_…) across all stages")
    .option("-n, --limit <n>", "max lines (default 200)", (v) => Number.parseInt(v, 10), 200)
    .option("-f, --follow", "live tail (Ctrl-C to stop)")
    .action(async (opts: { since?: string; pi?: string; limit: number; follow?: boolean }) => {
      const since = opts.since && /^\d+[smhd]$/.test(opts.since) ? opts.since : "6h"
      const piFilter = opts.pi ? ` payment_intent_id:=${JSON.stringify(opts.pi)}` : ""
      const stream = `component:=${PAYMENT_COMPONENT}${piFilter}`
      if (opts.follow) {
        await followLiveTail(stream, "payments")
        return
      }
      try {
        const entries = await queryLogs(`_time:${since} ${stream}`, opts.limit)
        if (entries.length === 0) {
          const forPi = opts.pi ? ` for ${opts.pi}` : ""
          console.log(chalk.dim(`  no payment events in the last ${since}${forPi} — widen --since or drive a checkout`))
          return
        }
        if (opts.pi) console.log(chalk.bold(`\n  Payment ${chalk.cyan(opts.pi)} — ${entries.length} lines\n`))
        for (const e of entries) console.log(renderLogLine(e))
        const failed = entries.filter((e) => e.event === "job.failed").length
        console.log(
          chalk.dim(`\n  ${entries.length} lines · last ${since}`) +
            (failed > 0 ? chalk.red(`  ·  ${failed} failed — inspect: ibx jobs list stripe-webhook`) : ""),
        )
      } catch (err) {
        console.error(unreachableHint(err))
        process.exitCode = 1
      }
    })

  // ─── ibx obs funnel ─────────────────────────────────────────────────────────
  obs
    .command("funnel")
    .description("Checkout funnel — stage counts + drop-off (stranded orders)")
    .option("--since <dur>", "time window: 2h, 7d (default 24h)")
    .action(async (opts: { since?: string }) => {
      const since = opts.since && /^\d+[smhd]$/.test(opts.since) ? opts.since : "24h"
      // One LogsQL stats pipe → one row per event with its count.
      const query = `_time:${since} component:=${PAYMENT_COMPONENT} | stats by (event) count() hits`
      try {
        const rows = await queryLogs(query, 100)
        const counts = new Map<string, number>()
        for (const r of rows) {
          if (typeof r.event === "string") counts.set(r.event, Number(r.hits) || 0)
        }
        if (counts.size === 0) {
          console.log(chalk.dim(`  no payment events in the last ${since} — widen --since or drive a checkout`))
          return
        }

        console.log(chalk.bold(`\n  Checkout funnel · last ${since}\n`))
        let prev: number | undefined
        for (const [event, label] of FUNNEL_STAGES) {
          const n = counts.get(event) ?? 0
          const drop = prev !== undefined && prev > n ? prev - n : 0
          const dropStr = drop > 0 ? chalk.red(`   −${drop} dropped`) : ""
          console.log(`  ${chalk.cyan(label.padEnd(16))} ${chalk.bold(String(n).padStart(5))}${dropStr}`)
          prev = n
        }

        const dup = counts.get("payment.duplicate") ?? 0
        const failed = counts.get("job.failed") ?? 0
        console.log("")
        if (dup > 0) console.log(`  ${chalk.yellow("duplicate".padEnd(16))} ${chalk.bold(String(dup).padStart(5))}  ${chalk.dim("(idempotent no-op)")}`)
        console.log(`  ${chalk.red("job failed".padEnd(16))} ${chalk.bold(String(failed).padStart(5))}${failed > 0 ? chalk.dim("   replay: ibx jobs replay stripe-webhook --all") : ""}`)
      } catch (err) {
        console.error(unreachableHint(err))
        process.exitCode = 1
      }
    })
}
