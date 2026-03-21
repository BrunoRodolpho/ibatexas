// ibx matrix — combinatorial state testing.
// Generates 2^N state combinations, verifies UI expectations for each.

import type { Command } from "commander"
import chalk from "chalk"
import { runMatrix, generateAllStates, generateCornerStates } from "../lib/matrix.js"
import { saveSnapshots, verifySnapshots, printVerifyResults } from "../lib/snapshot.js"
import { MATRIX_DEFINITIONS, MATRIX_NAMES } from "../matrices/index.js"

export function registerMatrixCommands(group: Command): void {
  group.description("Matrix — combinatorial state testing (2^N states, snapshots, corners)")

  // ─── matrix list ──────────────────────────────────────────────────────
  group
    .command("list")
    .description("List all matrix definitions with variable/state counts")
    .action(async () => {
      console.log(chalk.bold("\n  Available Matrices\n"))

      for (const name of MATRIX_NAMES) {
        const def = MATRIX_DEFINITIONS[name]
        const states = 1 << def.variables.length
        console.log(`  ${chalk.cyan(name.padEnd(16))} ${def.description}`)
        const varStatesSummary = chalk.dim(`${def.variables.length} variables → ${states} states`)
        console.log(`  ${"".padEnd(16)} ${varStatesSummary}`)

        for (const v of def.variables) {
          const varDetail = chalk.dim(`• ${v.name}: ${v.description}`)
          console.log(`  ${"".padEnd(18)} ${varDetail}`)
        }
        console.log()
      }
    })

  // ─── matrix <name> ────────────────────────────────────────────────────
  group
    .command("run <name>", { isDefault: true })
    .description("Run a matrix — all states, --state, --corners, or --random")
    .option("--state <n>", "Run a specific state by index", parseIntOption)
    .option("--random", "Run a random state")
    .option("--corners", "Run corner cases: all-OFF, all-ON, each single-ON")
    .option("--parallel <n>", "Run N states concurrently (future)", parseIntOption)
    .option("--snapshot", "Save results as snapshots after running")
    .option("--verify", "Verify results against saved snapshots")
    .option("--force", "Override scenario lock")
    .action(async (name: string, opts: {
      state?: number
      random?: boolean
      corners?: boolean
      parallel?: number
      snapshot?: boolean
      verify?: boolean
      force?: boolean
    }) => {
      const def = MATRIX_DEFINITIONS[name]
      if (!def) {
        console.error(chalk.red(`\n  Unknown matrix: "${name}". Available: ${MATRIX_NAMES.join(", ")}\n`))
        process.exitCode = 1
        return
      }

      // Run the matrix
      const result = await runMatrix(def, {
        state: opts.state,
        random: opts.random,
        corners: opts.corners,
        parallel: opts.parallel,
        snapshot: opts.snapshot,
        verify: opts.verify,
        force: opts.force,
      })

      // Snapshot mode — save results after running
      if (opts.snapshot && result.results.length > 0) {
        const count = await saveSnapshots(def.name, result.results)
        console.log(chalk.green(`  📸 Saved ${count} snapshot(s) for "${def.name}"\n`))
      }

      // Verify mode — compare against saved snapshots
      if (opts.verify && result.results.length > 0) {
        const verification = await verifySnapshots(def.name, result.results)
        printVerifyResults(verification)
        if (verification.drifted > 0) {
          process.exitCode = 1
        }
      }

      if (!result.ok) process.exitCode = 1
    })

  // ─── matrix <name> states ─────────────────────────────────────────────
  group
    .command("states <name>")
    .description("List all states for a matrix (index, active variables)")
    .option("--corners", "Show only corner case states")
    .action(async (name: string, opts: { corners?: boolean }) => {
      const def = MATRIX_DEFINITIONS[name]
      if (!def) {
        console.error(chalk.red(`\n  Unknown matrix: "${name}". Available: ${MATRIX_NAMES.join(", ")}\n`))
        process.exitCode = 1
        return
      }

      const states = opts.corners
        ? generateCornerStates(def.variables)
        : generateAllStates(def.variables)

      const n = def.variables.length
      const header = `  ${"#".padStart(4)}  ${"Binary".padEnd(n + 2)}  Active Variables`
      console.log(chalk.bold(`\n  ${def.name}: ${states.length} state(s)\n`))
      console.log(chalk.bold(header))
      console.log(`  ${"─".repeat(4 + 2 + n + 2 + 2 + 30)}`)

      for (const state of states) {
        const binaryStr = state.stateIndex.toString(2).padStart(n, "0")
        const activeStr = state.activeVars.length > 0
          ? state.activeVars.join(", ")
          : chalk.dim("(all OFF)")
        console.log(`  ${chalk.cyan(String(state.stateIndex).padStart(4))}  ${binaryStr.padEnd(n + 2)}  ${activeStr}`)
      }
      console.log()
    })
}

// ── Helper ───────────────────────────────────────────────────────────────────

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) throw new Error(`Expected a number, got "${value}"`)
  return parsed
}
