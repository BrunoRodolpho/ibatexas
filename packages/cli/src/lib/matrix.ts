// lib/matrix.ts — State Matrix Engine.
// Generates 2^N state combinations from binary variables,
// applies each state, and verifies UI expectations.
//
// Flow: lock → base setup → for each state: clean → apply → verify → next → unlock

import chalk from "chalk"
import ora from "ora"

import { runPipeline, type PipelineTask } from "./pipeline.js"
import { StepRegistry, type StepName } from "./steps.js"
import { acquireScenarioLock } from "./lock.js"
import { closeRedis } from "./redis.js"

// ── Types ────────────────────────────────────────────────────────────────────

export interface StateVariable {
  name: string
  description: string
  apply: () => Promise<void>
  remove: () => Promise<void>
}

export interface MatrixExpectation {
  /** Name of the UI section or check being verified. */
  section: string
  /** Variable names — ALL must be ON for this section to be expected visible. */
  requires: string[]
  severity: "error" | "warning"
  check: () => Promise<{ ok: boolean; detail: string }>
}

export interface MatrixDefinition {
  name: string
  description: string
  category: "ui" | "intel"
  baseSetup: StepName[]
  variables: StateVariable[]
  expectations: MatrixExpectation[]
}

export interface StateCombination {
  stateIndex: number
  /** Variables that are ON in this state. */
  activeVars: string[]
  /** Variables that are OFF in this state. */
  inactiveVars: string[]
}

export interface MatrixStateResult {
  stateIndex: number
  activeVars: string[]
  checks: {
    section: string
    expected: "visible" | "hidden"
    actual: "pass" | "fail"
    detail: string
  }[]
  ok: boolean
}

export interface MatrixRunResult {
  matrix: string
  totalStates: number
  statesRun: number
  results: MatrixStateResult[]
  ok: boolean
  durationMs: number
}

export interface MatrixRunOptions {
  /** Run a specific state by index. */
  state?: number
  /** Run a random state. */
  random?: boolean
  /** Run corner cases only: all-OFF, all-ON, and each single-ON. */
  corners?: boolean
  /** Number of parallel workers (default: 1 — sequential). */
  parallel?: number
  /** Save snapshots after running. */
  snapshot?: boolean
  /** Verify against saved snapshots. */
  verify?: boolean
  /** Override scenario lock. */
  force?: boolean
}

// ── Combination generation ──────────────────────────────────────────────────

/**
 * Generate all 2^N state combinations.
 */
export function generateAllStates(variables: StateVariable[]): StateCombination[] {
  const n = variables.length
  const totalStates = 1 << n // 2^N
  const combinations: StateCombination[] = []

  for (let i = 0; i < totalStates; i++) {
    const activeVars: string[] = []
    const inactiveVars: string[] = []
    for (let bit = 0; bit < n; bit++) {
      if (i & (1 << bit)) {
        activeVars.push(variables[bit].name)
      } else {
        inactiveVars.push(variables[bit].name)
      }
    }
    combinations.push({ stateIndex: i, activeVars, inactiveVars })
  }

  return combinations
}

/**
 * Generate corner case states: all-OFF (0), all-ON (2^N-1),
 * and each single-ON state.
 */
export function generateCornerStates(variables: StateVariable[]): StateCombination[] {
  const all = generateAllStates(variables)
  const n = variables.length
  const indices = new Set<number>()

  // All OFF (state 0)
  indices.add(0)

  // All ON (state 2^N - 1)
  indices.add((1 << n) - 1)

  // Each single-ON state
  for (let bit = 0; bit < n; bit++) {
    indices.add(1 << bit)
  }

  return all.filter((s) => indices.has(s.stateIndex))
}

/**
 * Pick a random state.
 */
export function generateRandomState(variables: StateVariable[]): StateCombination[] {
  const all = generateAllStates(variables)
  const idx = Math.floor(Math.random() * all.length)
  return [all[idx]]
}

// ── State application ───────────────────────────────────────────────────────

/**
 * Apply a specific state combination:
 * 1. remove() ALL variables (clean slate)
 * 2. apply() only the active variables
 */
async function applyState(
  variables: StateVariable[],
  state: StateCombination,
): Promise<void> {
  // Clean: remove all
  for (const v of variables) {
    await v.remove()
  }

  // Apply: turn on active variables
  for (const v of variables) {
    if (state.activeVars.includes(v.name)) {
      await v.apply()
    }
  }
}

// ── Expectation evaluation ──────────────────────────────────────────────────

/**
 * For each expectation, determine whether it should be visible or hidden
 * based on the active variables, then run the check.
 */
async function evaluateExpectations(
  expectations: MatrixExpectation[],
  state: StateCombination,
): Promise<MatrixStateResult> {
  const checks: MatrixStateResult["checks"] = []
  let allOk = true

  for (const exp of expectations) {
    const allRequirementsMet = exp.requires.every((req) =>
      state.activeVars.includes(req),
    )
    const expected = allRequirementsMet ? "visible" : "hidden"

    try {
      const result = await exp.check()
      // If expected visible → check should pass (ok=true)
      // If expected hidden → check should fail (ok=false)
      const matches = expected === "visible" ? result.ok : !result.ok
      const actual: "pass" | "fail" = matches ? "pass" : "fail"

      if (actual === "fail") allOk = false

      checks.push({
        section: exp.section,
        expected,
        actual,
        detail: result.detail,
      })
    } catch (err) {
      allOk = false
      checks.push({
        section: exp.section,
        expected,
        actual: "fail",
        detail: `Error: ${(err as Error).message}`,
      })
    }
  }

  return {
    stateIndex: state.stateIndex,
    activeVars: state.activeVars,
    checks,
    ok: allOk,
  }
}

// ── Main engine ──────────────────────────────────────────────────────────────

export async function runMatrix(
  definition: MatrixDefinition,
  opts: MatrixRunOptions = {},
): Promise<MatrixRunResult> {
  const start = Date.now()

  console.log(chalk.bold(`\n  Matrix: ${definition.name}`))
  console.log(chalk.dim(`  ${definition.description}`))
  console.log(chalk.dim(`  Variables: ${definition.variables.length} → ${1 << definition.variables.length} states`))
  console.log()

  // 1. Acquire lock
  let releaseLock: (() => Promise<void>) | undefined
  try {
    releaseLock = await acquireScenarioLock(`matrix:${definition.name}`, { force: opts.force })
  } catch (err) {
    console.error(chalk.red(`  ${(err as Error).message}`))
    return {
      matrix: definition.name,
      totalStates: 1 << definition.variables.length,
      statesRun: 0,
      results: [],
      ok: false,
      durationMs: Date.now() - start,
    }
  }

  try {
    // 2. Base setup
    if (definition.baseSetup.length > 0) {
      console.log(chalk.bold("  Base Setup"))
      const tasks: PipelineTask[] = definition.baseSetup.map((name) => ({
        name,
        label: StepRegistry[name].label,
        run: StepRegistry[name].run,
      }))
      const result = await runPipeline(tasks)
      if (!result.ok) {
        return {
          matrix: definition.name,
          totalStates: 1 << definition.variables.length,
          statesRun: 0,
          results: [],
          ok: false,
          durationMs: Date.now() - start,
        }
      }
      console.log()
    }

    // 3. Select states to run
    let states: StateCombination[]
    if (opts.state !== undefined) {
      const all = generateAllStates(definition.variables)
      const found = all.find((s) => s.stateIndex === opts.state)
      if (!found) {
        console.error(chalk.red(`  State ${opts.state} not found (max: ${all.length - 1})`))
        return {
          matrix: definition.name,
          totalStates: all.length,
          statesRun: 0,
          results: [],
          ok: false,
          durationMs: Date.now() - start,
        }
      }
      states = [found]
    } else if (opts.random) {
      states = generateRandomState(definition.variables)
    } else if (opts.corners) {
      states = generateCornerStates(definition.variables)
    } else {
      states = generateAllStates(definition.variables)
    }

    console.log(chalk.bold(`  Running ${states.length} state(s)\n`))

    // 4. Execute states (sequential for now — parallel in future)
    const results: MatrixStateResult[] = []

    for (const state of states) {
      const binaryStr = state.stateIndex.toString(2).padStart(definition.variables.length, "0")
      const activeStr = state.activeVars.length > 0
        ? state.activeVars.join(", ")
        : chalk.dim("(all OFF)")

      const spinner = ora(`  State ${state.stateIndex} [${binaryStr}]: ${activeStr}`).start()

      try {
        // Apply state
        await applyState(definition.variables, state)

        // Evaluate expectations
        const result = await evaluateExpectations(definition.expectations, state)
        results.push(result)

        if (result.ok) {
          spinner.succeed(chalk.green(`  State ${state.stateIndex} [${binaryStr}]: ${activeStr} — PASS`))
        } else {
          spinner.fail(chalk.red(`  State ${state.stateIndex} [${binaryStr}]: ${activeStr} — FAIL`))
          // Print failing checks
          for (const check of result.checks.filter((c) => c.actual === "fail")) {
            console.log(chalk.red(`      ✖ ${check.section}: expected ${check.expected}, ${check.detail}`))
          }
        }
      } catch (err) {
        spinner.fail(chalk.red(`  State ${state.stateIndex} [${binaryStr}]: ERROR — ${(err as Error).message}`))
        results.push({
          stateIndex: state.stateIndex,
          activeVars: state.activeVars,
          checks: [],
          ok: false,
        })
      }
    }

    // 5. Summary
    const passed = results.filter((r) => r.ok).length
    const failed = results.filter((r) => !r.ok).length
    const totalDuration = Date.now() - start

    console.log()
    if (failed === 0) {
      console.log(chalk.green(`  ✅  Matrix "${definition.name}": ${passed}/${results.length} states passed (${(totalDuration / 1000).toFixed(1)}s)\n`))
    } else {
      console.log(chalk.red(`  ❌  Matrix "${definition.name}": ${failed}/${results.length} states failed (${(totalDuration / 1000).toFixed(1)}s)\n`))
    }

    return {
      matrix: definition.name,
      totalStates: 1 << definition.variables.length,
      statesRun: results.length,
      results,
      ok: failed === 0,
      durationMs: totalDuration,
    }
  } finally {
    // 6. Unlock
    if (releaseLock) {
      await releaseLock()
    }

    // Disconnect
    try { await closeRedis() } catch { /* best effort */ }
    try {
      const { prisma } = await import("@ibatexas/domain")
      await prisma.$disconnect()
    } catch { /* best effort */ }
  }
}

// ── List helper ──────────────────────────────────────────────────────────────

export function listStates(definition: MatrixDefinition): StateCombination[] {
  return generateAllStates(definition.variables)
}
