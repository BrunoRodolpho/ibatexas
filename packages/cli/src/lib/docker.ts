import chalk from "chalk"
import { execa } from "execa"
import { ROOT } from "../utils/root.js"

interface ContainerDiag {
  name: string
  state: string
  exitCode: number
}

// Bounded lazy quantifiers keep the match confined to a single line (`.`
// excludes newlines) and run in linear time: capping each gap at 200 chars
// avoids the super-linear backtracking of unbounded `.*?` while still
// spanning the short text in a real Postgres version-mismatch error.
const PG_VERSION_RE =
  /initialized by postgresql version (\d+).{0,200}?not compatible.{0,200}?version (\d+)/i

/**
 * Inspect Docker containers after a `docker compose up` failure and return
 * a human-readable diagnostic string.  Returns `null` when nothing useful
 * can be determined.
 */
export async function diagnoseDockerFailure(): Promise<string | null> {
  // 1. Check if Docker daemon is reachable at all
  if (!(await isDockerDaemonReachable())) {
    return [
      chalk.red("    Docker daemon is not running."),
      chalk.yellow("    → Open Docker Desktop and try again."),
    ].join("\n")
  }

  // 2. Find which containers exited with errors
  const failed = await listFailedContainers()
  if (failed === null) return null // can't diagnose further
  if (failed.length === 0) return null

  const lines: string[] = []
  for (const c of failed) {
    lines.push(...await diagnoseFailedContainer(c))
  }

  return lines.length > 0 ? lines.join("\n") : null
}

async function isDockerDaemonReachable(): Promise<boolean> {
  try {
    await execa("docker", ["info"], { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

function parseContainerLine(line: string): ContainerDiag {
  const c = JSON.parse(line)
  return {
    name: c.Name ?? c.Service ?? "unknown",
    state: (c.State ?? "").toLowerCase(),
    exitCode: Number(c.ExitCode ?? 0),
  }
}

/**
 * Returns the list of containers that exited with a non-zero code, or `null`
 * when the container list could not be determined.
 */
async function listFailedContainers(): Promise<ContainerDiag[] | null> {
  try {
    const { stdout } = await execa("docker", [
      "compose", "ps", "-a", "--format", "json",
    ], { cwd: ROOT })
    // docker compose ps --format json outputs one JSON object per line
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(parseContainerLine)
      .filter((c) => c.state === "exited" && c.exitCode !== 0)
  } catch {
    return null // can't diagnose further
  }
}

async function diagnoseFailedContainer(c: ContainerDiag): Promise<string[]> {
  const lines: string[] = [
    chalk.red(`    Container ${chalk.bold(c.name)} exited with code ${c.exitCode}`),
  ]

  // Fetch last few log lines for a targeted message
  let logs = ""
  try {
    const result = await execa("docker", ["logs", "--tail", "20", c.name])
    logs = (result.stdout + "\n" + result.stderr).toLowerCase()
  } catch {
    /* ignore */
  }

  const matched =
    pgVersionMismatchHint(logs) ??
    portInUseHint(logs, c.name) ??
    permissionOrDiskHint(logs)

  if (matched) {
    lines.push(...matched)
    return lines
  }

  // ── Fallback: show last meaningful log lines ───────────────────────
  lines.push(...await fallbackLogTail(c.name))
  return lines
}

// ── Pattern: Postgres version mismatch ─────────────────────────────
function pgVersionMismatchHint(logs: string): string[] | null {
  const pgMatch = PG_VERSION_RE.exec(logs)
  if (!pgMatch) return null
  const [, oldVer, newVer] = pgMatch
  return [
    "",
    chalk.yellow(
      `    Data volume was created with PostgreSQL ${oldVer} but the container now runs PostgreSQL ${newVer}.`,
    ),
    chalk.yellow(
      "    PostgreSQL does not support in-place major version upgrades.",
    ),
    "",
    // BKL-284: non-destructive path FIRST. The old hint led with a bare
    // `docker compose down -v`, which is both a container REMOVER (a restart
    // policy cannot survive it) and a volume DESTROYER — and `down -v` with no
    // -f applies to the whole core file, so it wipes redis/typesense/nats data
    // too, not just the postgres volume the diagnostic is about.
    chalk.white("    Preferred — keep your data (pin the image back to the old major):"),
    chalk.cyan(`      # set the postgres image back to pgvector/pgvector:pg${oldVer} in docker-compose.yml`),
    chalk.cyan("      docker compose up -d postgres"),
    chalk.cyan(`      # then dump with pg_dump and restore into pg${newVer}`),
    "",
    chalk.red("    Last resort — PERMANENTLY DELETES ALL LOCAL DATA:"),
    chalk.red("    `down -v` destroys the postgres, redis, typesense AND nats"),
    chalk.red("    volumes. Every local order, seed and conversation is gone and"),
    chalk.red("    is NOT recoverable. Only run this on a throwaway local stack."),
    chalk.cyan("      docker compose down -v          # removes containers + ALL volumes"),
    chalk.cyan("      ibx bootstrap                   # fresh setup, re-seeds from scratch"),
  ]
}

// ── Pattern: Port already in use ───────────────────────────────────
function portInUseHint(logs: string, name: string): string[] | null {
  if (!logs.includes("address already in use") && !logs.includes("port is already allocated")) {
    return null
  }
  const target = name.replace(/^ibatexas-/, "")
  return [
    "",
    chalk.yellow("    A port required by this container is already in use."),
    chalk.white("    Check for conflicting processes:"),
    chalk.cyan(`      lsof -i -P | grep LISTEN | grep -i ${target}`),
  ]
}

// ── Pattern: Permission / disk errors ──────────────────────────────
function permissionOrDiskHint(logs: string): string[] | null {
  const permissionDenied = logs.includes("permission denied")
  if (!permissionDenied && !logs.includes("no space left on device")) {
    return null
  }
  const reason = permissionDenied
    ? "    Permission denied on the data volume."
    : "    No disk space left for the container."
  return [
    "",
    chalk.yellow(reason),
    // BKL-284: `docker system prune -f` REMOVES EVERY STOPPED CONTAINER. After
    // an `ibx dev stop` (which runs `docker compose stop`, leaving the core four
    // Exited) this hint deletes postgres/redis/typesense/nats outright — a
    // restart policy cannot save a container that no longer exists. That is one
    // of the two candidate mechanisms for the 2026-07-27 vanish incident, so the
    // narrow reclaims are listed first and the broad one carries its blast radius.
    chalk.white("    Try the narrow reclaims first (these touch no containers):"),
    chalk.cyan("      docker image prune -f           # dangling images only"),
    chalk.cyan("      docker builder prune -f         # build cache only"),
    "",
    chalk.yellow("    Broader — REMOVES ALL STOPPED CONTAINERS:"),
    chalk.yellow("    If the ibatexas stack is merely stopped (e.g. you ran `ibx dev"),
    chalk.yellow("    stop`), this DELETES postgres/redis/typesense/nats. Named volumes"),
    chalk.yellow("    survive, so recreate them with `ibx dev` (or `docker compose up -d`)."),
    chalk.cyan("      docker system prune -f"),
  ]
}

async function fallbackLogTail(name: string): Promise<string[]> {
  try {
    const { stdout, stderr } = await execa("docker", [
      "logs", "--tail", "5", name,
    ])
    const tail = (stdout || stderr).trim()
    if (!tail) return []
    return [
      chalk.gray("    Last logs:"),
      ...tail.split("\n").slice(0, 5).map((l) => chalk.gray(`      ${l}`)),
    ]
  } catch {
    return []
  }
}
