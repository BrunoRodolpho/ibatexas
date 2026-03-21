// ibx deps — dependency lifecycle management.
// Audit overrides, detect drift, and check for upstream upgrade opportunities.

import type { Command } from "commander"
import chalk from "chalk"
import { execa, type Result } from "execa"
import { ROOT } from "../utils/root.js"

async function runScript(
  script: string,
  label: string,
): Promise<{ ok: boolean }> {
  console.log(chalk.bold(`\n  ${label}\n`))

  try {
    await execa("pnpm", ["tsx", `scripts/${script}`], {
      cwd: ROOT,
      stdio: "inherit",
    })
    return { ok: true }
  } catch (err) {
    const exitCode = (err as Result)?.exitCode ?? 1
    if (exitCode !== 0) {
      return { ok: false }
    }
    console.error(chalk.red(`  Failed to run ${script}: ${err}`))
    return { ok: false }
  }
}

export function registerDepsCommands(group: Command): void {
  group.description("Deps — override audit, drift detection, upgrade radar")

  // ─── deps audit ─────────────────────────────────────────────────────────
  group
    .command("audit")
    .description("Detect unused, non-deterministic, or drifted overrides")
    .action(async () => {
      const { ok } = await runScript("audit-overrides.ts", "Override Audit")
      if (!ok) process.exit(1)
    })

  // ─── deps drift ─────────────────────────────────────────────────────────
  group
    .command("drift")
    .description("Check for undocumented override changes vs main")
    .action(async () => {
      const { ok } = await runScript(
        "check-overrides-change.ts",
        "Override Drift Check",
      )
      if (!ok) process.exit(1)
    })

  // ─── deps radar ─────────────────────────────────────────────────────────
  group
    .command("radar")
    .description("Check upstream packages for override removal opportunities")
    .action(async () => {
      await runScript("upgrade-radar.ts", "Upgrade Radar")
    })

  // ─── deps check ─────────────────────────────────────────────────────────
  group
    .command("check")
    .description("Full dependency health check (audit + drift + radar)")
    .action(async () => {
      let failures = 0

      const audit = await runScript("audit-overrides.ts", "1/3  Override Audit")
      if (!audit.ok) failures++

      const drift = await runScript(
        "check-overrides-change.ts",
        "2/3  Override Drift Check",
      )
      if (!drift.ok) failures++

      await runScript("upgrade-radar.ts", "3/3  Upgrade Radar")

      console.log()
      if (failures > 0) {
        console.log(
          chalk.red(`  ${failures} check(s) failed. See output above.\n`),
        )
        process.exit(1)
      } else {
        console.log(chalk.green("  All dependency checks passed.\n"))
      }
    })
}
