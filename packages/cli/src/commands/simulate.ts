// ibx simulate — data simulation commands.
// Generates realistic commerce behavior using seeded PRNG.
// Deterministic: same seed → same output.

import type { Command } from "commander"
import chalk from "chalk"
import { runSimulation, rebuildAfterSimulation } from "../lib/simulator.js"
import { PROFILE_NAMES, SCALE_NAMES, SCALE_PRESETS } from "../lib/profiles.js"
import { guardDestructive } from "../lib/pipeline.js"

export function registerSimulateCommands(group: Command): void {
  group.description("Simulate — generate realistic commerce data (orders, reviews, customers)")

  // ─── simulate full ────────────────────────────────────────────────────
  group
    .command("full", { isDefault: true })
    .description("Full simulation — customers, orders, reviews, then rebuild intelligence")
    .option("--customers <n>", "Number of customers", parseIntOption, 40)
    .option("--days <n>", "Number of days to simulate", parseIntOption, 30)
    .option("--per-day <n>", "Orders per day", parseIntOption, 15)
    .option("--seed <n>", "PRNG seed for deterministic output", parseIntOption, 42)
    .option("--scale <preset>", `Scale preset: ${SCALE_NAMES.join(", ")}`)
    .option("--no-rebuild", "Skip intelligence rebuild after simulation")
    .action(async (opts: {
      customers: number
      days: number
      perDay: number
      seed: number
      scale?: string
      rebuild?: boolean
    }) => {
      guardDestructive("simulate full")

      if (opts.scale && !SCALE_PRESETS[opts.scale]) {
        console.error(chalk.red(`\n  Unknown scale preset: "${opts.scale}". Available: ${SCALE_NAMES.join(", ")}\n`))
        process.exitCode = 1
        return
      }

      const result = await runSimulation({
        customers: opts.customers,
        days: opts.days,
        ordersPerDay: opts.perDay,
        seed: opts.seed,
        scale: opts.scale,
      })

      if (opts.rebuild !== false) {
        await rebuildAfterSimulation()
      }

      console.log(chalk.green(`  ✅  Simulation complete (${(result.durationMs / 1000).toFixed(1)}s)\n`))
    })

  // ─── simulate orders ──────────────────────────────────────────────────
  group
    .command("orders")
    .description("Generate only order history (no reviews, no intel rebuild)")
    .option("--customers <n>", "Number of customers", parseIntOption, 40)
    .option("--days <n>", "Days to simulate", parseIntOption, 30)
    .option("--per-day <n>", "Orders per day", parseIntOption, 15)
    .option("--seed <n>", "PRNG seed", parseIntOption, 42)
    .action(async (opts: {
      customers: number
      days: number
      perDay: number
      seed: number
    }) => {
      guardDestructive("simulate orders")

      await runSimulation({
        customers: opts.customers,
        days: opts.days,
        ordersPerDay: opts.perDay,
        seed: opts.seed,
        reviews: { probability: 0, ratingAvg: 4.3 },
      })
    })

  // ─── simulate profiles ────────────────────────────────────────────────
  group
    .command("profiles")
    .description("List available behavior profiles")
    .action(async () => {
      const { PROFILES } = await import("../lib/profiles.js")

      console.log(chalk.bold("\n  Behavior Profiles\n"))

      for (const name of PROFILE_NAMES) {
        const p = PROFILES[name]
        console.log(chalk.bold(`  ${p.name} (${name})`))
        console.log(chalk.dim(`    ${p.description}`))
        console.log(chalk.dim(`    Categories: ${p.preferredCategories.join(", ")}`))
        console.log(chalk.dim(`    Products:   ${p.preferredProducts.slice(0, 3).join(", ")}${p.preferredProducts.length > 3 ? "…" : ""}`))
        console.log(chalk.dim(`    Basket:     ~${p.avgItemsPerOrder} items, ~R$${(p.avgOrderValue / 100).toFixed(0)}`))
        console.log(chalk.dim(`    Frequency:  every ${p.frequencyDays} days`))
        console.log(chalk.dim(`    Reviews:    ${(p.reviewProbability * 100).toFixed(0)}% chance, avg ${p.ratingAvg}★`))
        console.log()
      }

      console.log(chalk.bold("  Scale Presets\n"))
      for (const name of SCALE_NAMES) {
        const s = SCALE_PRESETS[name]
        console.log(`    ${chalk.cyan(name.padEnd(10))} ${s.customers} customers, ${s.ordersPerDay} orders/day, ${s.days} days`)
      }
      console.log()
    })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) throw new Error(`Expected a number, got "${value}"`)
  return parsed
}
