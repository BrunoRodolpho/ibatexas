import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { execa } from "execa"
import path from "node:path"
import { ROOT } from "../utils/root.js"
import { diagnoseDockerFailure } from "../lib/docker.js"

// ── Helpers ───────────────────────────────────────────────────────────────────

function step(n: number, total: number, msg: string) {
  console.log(chalk.bold(`\n[${n}/${total}] ${msg}`))
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

interface BootstrapOpts {
  skipDocker?: boolean
  skipSeed?: boolean
}

async function runBootstrap(opts: BootstrapOpts) {
  const TOTAL = opts.skipSeed ? 4 : 6
  console.log(chalk.bold.blue("\n  🚀  IbateXas Bootstrap\n"))

  let stepNum = 0

  // ── [1] Docker ────────────────────────────────────────────────────────────
  if (!opts.skipDocker) {
    step(++stepNum, TOTAL, "Starting Docker containers…")
    const spinner = ora({ text: "docker compose up -d --wait", indent: 4 }).start()
    try {
      await execa("docker", ["compose", "up", "-d", "--wait"], { cwd: ROOT })
      spinner.succeed(chalk.green("Docker services healthy"))
    } catch {
      spinner.fail(chalk.red("Docker failed to start"))
      const diagnostic = await diagnoseDockerFailure()
      if (diagnostic) {
        console.error("")
        console.error(diagnostic)
        console.error("")
      }
      process.exit(1)
    }
  } else {
    step(++stepNum, TOTAL, "Skipping Docker (--skip-docker)")
    console.log(chalk.gray("    Assuming containers are already running"))
  }

  // ── [2] Medusa migrations ─────────────────────────────────────────────────
  step(++stepNum, TOTAL, "Running Medusa migrations…")
  const medusaSpinner = ora({ text: "medusa db:migrate", indent: 4 }).start()
  try {
    await execa("pnpm", ["--filter", "@ibatexas/commerce", "db:migrate"], {
      cwd: ROOT,
    })
    medusaSpinner.succeed(chalk.green("Medusa migrations complete"))
  } catch (err) {
    medusaSpinner.fail(chalk.red("Medusa migrations failed"))
    console.error(chalk.gray(`    ${String(err)}`))
    process.exit(1)
  }

  // ── [3] Domain (Prisma) migrations ────────────────────────────────────────
  step(++stepNum, TOTAL, "Running domain migrations…")
  const prismaSpinner = ora({ text: "prisma db push", indent: 4 }).start()
  try {
    await execa("pnpm", ["--filter", "@ibatexas/domain", "db:push"], {
      cwd: ROOT,
    })
    prismaSpinner.succeed(chalk.green("Domain migrations complete"))
  } catch (err) {
    prismaSpinner.fail(chalk.red("Domain migrations failed"))
    console.error(chalk.gray(`    ${String(err)}`))
    process.exit(1)
  }

  // ── [4] Medusa admin user ─────────────────────────────────────────────────
  step(++stepNum, TOTAL, "Creating Medusa admin user…")
  const adminEmail = process.env.MEDUSA_ADMIN_EMAIL
  const adminPassword = process.env.MEDUSA_ADMIN_PASSWORD
  if (!adminEmail || !adminPassword) {
    console.log(chalk.yellow("    Skipped — MEDUSA_ADMIN_EMAIL or MEDUSA_ADMIN_PASSWORD not set in .env"))
  } else {
    const adminSpinner = ora({ text: `user: ${adminEmail}`, indent: 4 }).start()
    try {
      await execa(
        "npx",
        ["medusa", "user", "--email", adminEmail, "--password", adminPassword],
        { cwd: path.join(ROOT, "apps/commerce") },
      )
      adminSpinner.succeed(chalk.green(`Admin user created (${adminEmail})`))
    } catch {
      // User may already exist — that's fine
      adminSpinner.warn(chalk.yellow(`Admin user may already exist (${adminEmail})`))
    }
  }

  // ── [5] Seed data ─────────────────────────────────────────────────────────
  if (!opts.skipSeed) {
    step(++stepNum, TOTAL, "Seeding data…")

    const seeds = [
      { label: "domain tables (Table + TimeSlot)", filter: "@ibatexas/domain", script: "db:seed:tables" },
      { label: "delivery (zones + addresses)", filter: "@ibatexas/domain", script: "db:seed:delivery" },
    ]

    for (const seed of seeds) {
      const spinner = ora({ text: seed.label, indent: 4 }).start()
      try {
        await execa("pnpm", ["--filter", seed.filter, seed.script], {
          cwd: ROOT,
        })
        spinner.succeed(chalk.green(seed.label))
      } catch {
        spinner.warn(chalk.yellow(`${seed.label} — failed (non-fatal)`))
      }
    }

    // ── [6] Verify ────────────────────────────────────────────────────────
    step(++stepNum, TOTAL, "Verifying infrastructure…")
    try {
      await execa("node", [
        path.join(ROOT, "packages/cli/dist/index.js"),
        "svc", "health",
      ], { cwd: ROOT, stdio: "inherit" })
    } catch {
      console.log(chalk.yellow("    Health check had issues — review output above"))
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log("")
  console.log(chalk.green.bold("  ✅  Bootstrap complete!"))
  console.log("")
  console.log(chalk.white("  Next steps:"))
  console.log(chalk.cyan("    ibx dev start             # start all services"))
  console.log(chalk.cyan("    ibx db seed               # seed Medusa products (requires Medusa running)"))
  console.log(chalk.cyan("    ibx db seed:homepage       # seed customers + reviews (requires Medusa running)"))
  console.log(chalk.cyan("    ibx db reindex             # index products into Typesense"))
  console.log("")
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerBootstrapCommands(program: Command) {
  program
    .command("bootstrap")
    .description("One-shot setup: Docker → migrations → admin user → seeds → verify")
    .option("--skip-docker", "Skip Docker startup (assume containers already running)")
    .option("--skip-seed", "Only run migrations, skip all seeds")
    .action(runBootstrap)
}
