import type { Command } from "commander"
import chalk from "chalk"
import { execa } from "execa"

async function getUpstream(): Promise<string> {
  try {
    const { stdout } = await execa("git", [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ])
    return stdout.trim()
  } catch {
    return chalk.gray("(no upstream)")
  }
}

async function getAheadBehind(upstream: string): Promise<{ ahead: number; behind: number }> {
  try {
    const { stdout } = await execa("git", [
      "rev-list",
      "--left-right",
      "--count",
      `${upstream}...HEAD`,
    ])
    const parts = stdout.trim().split(/\s+/)
    return { behind: Number(parts[0] ?? 0), ahead: Number(parts[1] ?? 0) }
  } catch {
    return { ahead: 0, behind: 0 }
  }
}

function parseStatusCounts(shortStatus: string): { lines: string[]; staged: number; unstaged: number; untracked: number } {
  const lines = shortStatus.trim().split("\n").filter(Boolean)
  return {
    lines,
    staged: lines.filter((l) => !l.startsWith(" ") && !l.startsWith("?")).length,
    unstaged: lines.filter((l) => l[1] === "M" || l[1] === "D").length,
    untracked: lines.filter((l) => l.startsWith("??")).length,
  }
}

function printChanges(lines: string[]): void {
  if (lines.length === 0) return
  console.log()
  for (const line of lines.slice(0, 20)) {
    console.log(`  ${chalk.gray(line)}`)
  }
  if (lines.length > 20) {
    console.log(chalk.gray(`  … and ${lines.length - 20} more`))
  }
}

export function registerGitCommands(program: Command) {
  const git = program.command("git").description("Git helpers for the monorepo")

  git
    .command("status")
    .description("Show branch, changes, and unpushed commits at a glance")
    .action(async () => {
      const { stdout: branch } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"])
      const upstream = await getUpstream()
      const hasUpstream = upstream !== "" && !upstream.includes("no upstream")

      const { ahead, behind } = hasUpstream ? await getAheadBehind(upstream) : { ahead: 0, behind: 0 }

      const { stdout: shortStatus } = await execa("git", ["status", "--short"])
      const { lines, staged, unstaged, untracked } = parseStatusCounts(shortStatus)

      console.log(chalk.bold("\n  Git status\n"))
      const upstreamLabel = upstream ? chalk.gray(`→ ${upstream}`) : ""
      console.log(`  Branch    ${chalk.cyan(branch.trim())} ${upstreamLabel}`)

      if (hasUpstream) {
        const aheadStr = ahead > 0 ? chalk.green(`↑ ${ahead} ahead`) : chalk.gray("↑ 0 ahead")
        const behindStr = behind > 0 ? chalk.yellow(`↓ ${behind} behind`) : chalk.gray("↓ 0 behind")
        console.log(`  Remote    ${aheadStr}  ${behindStr}`)
      }

      const stagedLabel = staged > 0 ? chalk.green(`${staged} staged`) : chalk.gray("0 staged")
      const unstagedLabel = unstaged > 0 ? chalk.yellow(`${unstaged} unstaged`) : chalk.gray("0 unstaged")
      const untrackedLabel = untracked > 0 ? chalk.gray(`${untracked} untracked`) : chalk.gray("0 untracked")
      console.log(`  Changes   ${stagedLabel}  ${unstagedLabel}  ${untrackedLabel}`)

      printChanges(lines)
      console.log()
    })

  git
    .command("log")
    .description("Pretty-print recent commits")
    .option("-n, --number <n>", "Number of commits to show", "10")
    .action(async (opts: { number: string }) => {
      const n = Number.parseInt(opts.number, 10)

      const { stdout } = await execa("git", [
        "log",
        `--max-count=${n}`,
        "--pretty=format:%h|%an|%ar|%s",
      ])

      // Try to get PR link from gh CLI
      let prLine = ""
      try {
        const { stdout: prOut } = await execa("gh", [
          "pr",
          "view",
          "--json",
          "number,url,title",
          "--jq",
          '"\\(.number)|\\(.url)|\\(.title)"',
        ])
        const [num, url] = prOut.trim().split("|")
        const prNum = chalk.cyan(`#${num}`)
        prLine = `\n  ${chalk.bold("PR")}        ${prNum} ${chalk.gray(url)}`
      } catch {
        // gh CLI not available or no PR
      }

      const { stdout: branch } = await execa("git", [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ])

      console.log(
        chalk.bold(`\n  Git log — ${chalk.cyan(branch.trim())} (last ${n} commits)`) +
          prLine +
          "\n"
      )

      const lines = stdout.trim().split("\n").filter(Boolean)
      for (const line of lines) {
        const [sha, author, date, ...msgParts] = line.split("|")
        const msg = msgParts.join("|")
        console.log(
          `  ${chalk.yellow(sha)}  ${chalk.gray((date ?? "").padEnd(15))}  ${(msg ?? "").padEnd(60)}  ${chalk.gray(author)}`
        )
      }

      console.log()
    })
}
