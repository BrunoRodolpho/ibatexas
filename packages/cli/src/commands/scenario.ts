// ibx scenario — YAML-driven state testing.
// Loads scenario files from packages/cli/scenarios/*.yml

import type { Command } from "commander"
import chalk from "chalk"
import { runScenario, discoverScenarios } from "../lib/scenario-engine.js"

export function registerScenarioCommands(group: Command): void {
  group.description("Scenario — YAML-driven state testing (load, execute, verify)")

  // ─── scenario list ──────────────────────────────────────────────────────
  group
    .command("list")
    .description("Discover all YAML scenario files, grouped by category")
    .action(async () => {
      const scenarios = await discoverScenarios()

      if (scenarios.length === 0) {
        console.log(chalk.yellow("\n  No scenario files found in packages/cli/scenarios/\n"))
        return
      }

      // Group by category
      const groups = new Map<string, typeof scenarios>()
      for (const s of scenarios) {
        const cat = s.scenario.category ?? "ui"
        const list = groups.get(cat) ?? []
        list.push(s)
        groups.set(cat, list)
      }

      console.log(chalk.bold("\n  Available Scenarios\n"))

      for (const [category, items] of groups) {
        console.log(chalk.bold(`  ${category.toUpperCase()}`))
        for (const item of items) {
          const time = item.scenario.estimatedTime ? chalk.dim(` (~${item.scenario.estimatedTime}s)`) : ""
          const deps = item.scenario.depends?.length ? chalk.dim(` [depends: ${item.scenario.depends.join(", ")}]`) : ""
          console.log(`    ${chalk.cyan(item.name.padEnd(24))} ${item.scenario.description}${time}${deps}`)
        }
        console.log()
      }
    })

  // ─── scenario <name> ────────────────────────────────────────────────────
  group
    .command("run <name>", { isDefault: true })
    .description("Run a scenario by name or file path")
    .option("--dry-run", "Preview steps without executing")
    .option("--verify-only", "Only run verify checks")
    .option("--skip <patterns>", "Skip tasks matching pattern(s), comma-separated")
    .option("--no-cache", "Skip step cache")
    .option("--force", "Override scenario lock")
    .option("--file <path>", "Load from a custom YAML file path")
    .action(async (name: string, opts: {
      dryRun?: boolean
      verifyOnly?: boolean
      skip?: string
      cache?: boolean
      force?: boolean
      file?: string
    }) => {
      const success = await runScenario(name, {
        dryRun: opts.dryRun,
        verifyOnly: opts.verifyOnly,
        skip: opts.skip?.split(","),
        noCache: opts.cache === false,
        force: opts.force,
        file: opts.file,
      })

      if (!success) process.exitCode = 1
    })
}
