import chalk from "chalk"
import { execa } from "execa"
import { ROOT } from "../utils/root.js"

interface ContainerDiag {
  name: string
  state: string
  exitCode: number
}

/**
 * Inspect Docker containers after a `docker compose up` failure and return
 * a human-readable diagnostic string.  Returns `null` when nothing useful
 * can be determined.
 */
export async function diagnoseDockerFailure(): Promise<string | null> {
  // 1. Check if Docker daemon is reachable at all
  try {
    await execa("docker", ["info"], { timeout: 5_000 })
  } catch {
    return [
      chalk.red("    Docker daemon is not running."),
      chalk.yellow("    → Open Docker Desktop and try again."),
    ].join("\n")
  }

  // 2. Find which containers exited with errors
  let containers: ContainerDiag[]
  try {
    const { stdout } = await execa("docker", [
      "compose", "ps", "-a", "--format", "json",
    ], { cwd: ROOT })
    // docker compose ps --format json outputs one JSON object per line
    containers = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const c = JSON.parse(line)
        return {
          name: c.Name ?? c.Service ?? "unknown",
          state: (c.State ?? "").toLowerCase(),
          exitCode: Number(c.ExitCode ?? 0),
        }
      })
  } catch {
    return null // can't diagnose further
  }

  const failed = containers.filter(
    (c) => c.state === "exited" && c.exitCode !== 0,
  )
  if (failed.length === 0) return null

  const lines: string[] = []

  for (const c of failed) {
    lines.push(
      chalk.red(`    Container ${chalk.bold(c.name)} exited with code ${c.exitCode}`),
    )

    // Fetch last few log lines for a targeted message
    let logs = ""
    try {
      const result = await execa("docker", ["logs", "--tail", "20", c.name])
      logs = (result.stdout + "\n" + result.stderr).toLowerCase()
    } catch {
      /* ignore */
    }

    // ── Pattern: Postgres version mismatch ─────────────────────────────
    const pgVersionRe =
      /initialized by postgresql version (\d+).*not compatible.*version (\d+)/i
    const pgMatch = pgVersionRe.exec(logs)
    if (pgMatch) {
      const [, oldVer, newVer] = pgMatch
      lines.push("")
      lines.push(
        chalk.yellow(
          `    Data volume was created with PostgreSQL ${oldVer} but the container now runs PostgreSQL ${newVer}.`,
        ),
      )
      lines.push(
        chalk.yellow(
          "    PostgreSQL does not support in-place major version upgrades.",
        ),
      )
      lines.push("")
      lines.push(chalk.white("    To fix (destroys local data — you'll need to re-bootstrap):"))
      lines.push(chalk.cyan("      docker compose down -v          # removes volumes"))
      lines.push(chalk.cyan("      ibx bootstrap                   # fresh setup"))
      continue
    }

    // ── Pattern: Port already in use ───────────────────────────────────
    if (logs.includes("address already in use") || logs.includes("port is already allocated")) {
      lines.push("")
      lines.push(chalk.yellow("    A port required by this container is already in use."))
      lines.push(chalk.white("    Check for conflicting processes:"))
      lines.push(chalk.cyan(`      lsof -i -P | grep LISTEN | grep -i ${c.name.replace(/^ibatexas-/, "")}`))
      continue
    }

    // ── Pattern: Permission / disk errors ──────────────────────────────
    if (logs.includes("permission denied") || logs.includes("no space left on device")) {
      lines.push("")
      lines.push(
        chalk.yellow(
          logs.includes("permission denied")
            ? "    Permission denied on the data volume."
            : "    No disk space left for the container.",
        ),
      )
      lines.push(chalk.white("    Try cleaning up Docker resources:"))
      lines.push(chalk.cyan("      docker system prune -f"))
      continue
    }

    // ── Fallback: show last meaningful log lines ───────────────────────
    try {
      const { stdout, stderr } = await execa("docker", [
        "logs", "--tail", "5", c.name,
      ])
      const tail = (stdout || stderr).trim()
      if (tail) {
        lines.push(chalk.gray("    Last logs:"))
        for (const l of tail.split("\n").slice(0, 5)) {
          lines.push(chalk.gray(`      ${l}`))
        }
      }
    } catch {
      /* ignore */
    }
  }

  return lines.length > 0 ? lines.join("\n") : null
}
