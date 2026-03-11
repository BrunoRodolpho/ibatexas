// Reusable task pipeline for composite CLI commands.
// Supports per-step timing, --from/--skip, dry-run, and environment guards.

import chalk from "chalk"
import ora from "ora"

// ── Types ────────────────────────────────────────────────────────────────────

export interface PipelineTask {
  name: string
  label: string
  run: () => Promise<void>
  dependsOn?: string[]
}

export interface PipelineOptions {
  from?: string
  skip?: string[]
  dryRun?: boolean
}

export interface PipelineStepResult {
  name: string
  label: string
  durationMs: number
  status: "ok" | "skipped" | "failed"
  error?: string
}

export interface PipelineResult {
  steps: PipelineStepResult[]
  totalMs: number
  ok: boolean
}

// ── Environment guard ────────────────────────────────────────────────────────

export function guardDestructive(commandName: string): void {
  const env = process.env.NODE_ENV ?? process.env.APP_ENV
  if (env === "production") {
    console.error(
      chalk.red(`\n  ❌  "${commandName}" blocked in production environment\n`)
    )
    process.exit(1)
  }
}

// ── Pipeline runner ──────────────────────────────────────────────────────────

export async function runPipeline(
  tasks: PipelineTask[],
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const results: PipelineStepResult[] = []
  const pipelineStart = Date.now()

  // Resolve --from: find the starting index
  let startIdx = 0
  if (opts.from) {
    const idx = tasks.findIndex((t) => t.name === opts.from)
    if (idx === -1) {
      const available = tasks.map((t) => t.name).join(", ")
      console.error(
        chalk.red(`\n  Unknown task "${opts.from}". Available: ${available}\n`)
      )
      process.exit(1)
    }
    startIdx = idx
  }

  // Resolve --skip patterns
  const skipPatterns = opts.skip ?? []
  const shouldSkip = (name: string): boolean =>
    skipPatterns.some((p) => name.includes(p))

  // Dry-run: just print what would execute
  if (opts.dryRun) {
    console.log(chalk.bold("\n  Pipeline (dry run):\n"))
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]
      const skipped = i < startIdx || shouldSkip(task.name)
      const marker = skipped
        ? chalk.gray("  skip")
        : chalk.green("  run ")
      console.log(`  ${marker}  ${i + 1}. ${task.label}`)
    }
    console.log()
    return { steps: [], totalMs: 0, ok: true }
  }

  // Header
  const activeCount = tasks.filter(
    (_, i) => i >= startIdx && !shouldSkip(tasks[i].name)
  ).length
  console.log(
    chalk.bold(`\n  Pipeline: ${activeCount} task(s)\n`)
  )

  // Execute tasks
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]

    // Skip tasks before --from
    if (i < startIdx) {
      results.push({
        name: task.name,
        label: task.label,
        durationMs: 0,
        status: "skipped",
      })
      continue
    }

    // Skip tasks matching --skip pattern
    if (shouldSkip(task.name)) {
      console.log(
        chalk.gray(`  ○ ${task.label} ${"·".repeat(Math.max(2, 48 - task.label.length))} skipped`)
      )
      results.push({
        name: task.name,
        label: task.label,
        durationMs: 0,
        status: "skipped",
      })
      continue
    }

    // Run the task with timing
    const spinner = ora({ text: task.label, prefixText: "  " }).start()
    const stepStart = Date.now()

    try {
      await task.run()
      const elapsed = Date.now() - stepStart
      const timeStr = formatDuration(elapsed)
      const dots = "·".repeat(Math.max(2, 48 - task.label.length - timeStr.length))
      spinner.stopAndPersist({
        symbol: chalk.green("  ●"),
        text: `${task.label} ${chalk.gray(dots)} ${chalk.cyan(timeStr)}`,
      })
      results.push({
        name: task.name,
        label: task.label,
        durationMs: elapsed,
        status: "ok",
      })
    } catch (err) {
      const elapsed = Date.now() - stepStart
      const msg = (err as Error).message
      spinner.stopAndPersist({
        symbol: chalk.red("  ✖"),
        text: `${task.label} ${chalk.red("— FAILED")}`,
      })
      console.error(chalk.red(`\n    ${msg}\n`))

      results.push({
        name: task.name,
        label: task.label,
        durationMs: elapsed,
        status: "failed",
        error: msg,
      })

      // Print summary of what completed before failure
      printSummary(results, Date.now() - pipelineStart, false)
      return { steps: results, totalMs: Date.now() - pipelineStart, ok: false }
    }
  }

  // Success summary
  printSummary(results, Date.now() - pipelineStart, true)
  return { steps: results, totalMs: Date.now() - pipelineStart, ok: true }
}

// ── Summary printer ──────────────────────────────────────────────────────────

function printSummary(
  results: PipelineStepResult[],
  totalMs: number,
  ok: boolean,
): void {
  const completed = results.filter((r) => r.status === "ok").length
  const skipped = results.filter((r) => r.status === "skipped").length
  const failed = results.filter((r) => r.status === "failed").length
  const totalStr = formatDuration(totalMs)

  console.log()
  if (ok) {
    console.log(
      chalk.green(`  ✅  Pipeline complete: ${completed} task(s) in ${totalStr}`) +
      (skipped > 0 ? chalk.gray(` (${skipped} skipped)`) : "")
    )
  } else {
    console.log(
      chalk.red(`  ❌  Pipeline failed at step ${completed + skipped + 1}`) +
      chalk.gray(` — ${completed} completed, ${failed} failed in ${totalStr}`)
    )
  }
  console.log()
}

// ── Formatting ───────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `${mins}m ${rem.toFixed(0)}s`
}
