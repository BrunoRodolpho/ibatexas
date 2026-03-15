import type { Command } from "commander"
import chalk from "chalk"
import { execa } from "execa"

export function registerGitCommands(program: Command) {
  const git = program.command("git").description("Git helpers for the monorepo")

  git
    .command("status")
    .description("Show branch, changes, and unpushed commits at a glance")
    .action(async () => {
      // Current branch + upstream
      const { stdout: branch } = await execa("git", [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ])

      let upstream = ""
      try {
        const { stdout } = await execa("git", [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{u}",
        ])
        upstream = stdout.trim()
      } catch {
        upstream = chalk.gray("(no upstream)")
      }

      // Ahead / behind
      let ahead = 0
      let behind = 0
      if (upstream && !upstream.includes("no upstream")) {
        try {
          const { stdout } = await execa("git", [
            "rev-list",
            "--left-right",
            "--count",
            `${upstream}...HEAD`,
          ])
          const parts = stdout.trim().split(/\s+/)
          behind = Number(parts[0] ?? 0)
          ahead = Number(parts[1] ?? 0)
        } catch {
          // ignore
        }
      }

      // File counts
      const { stdout: shortStatus } = await execa("git", [
        "status",
        "--short",
      ])

      const lines = shortStatus.trim().split("\n").filter(Boolean)
      const staged = lines.filter((l) => l[0] !== " " && l[0] !== "?").length
      const unstaged = lines.filter((l) => l[1] === "M" || l[1] === "D").length
      const untracked = lines.filter((l) => l.startsWith("??")).length

      console.log(chalk.bold("\n  Git status\n"))
      console.log(
        `  Branch    ${chalk.cyan(branch.trim())} ${upstream ? chalk.gray(`→ ${upstream}`) : ""}`
      )

      if (upstream && !upstream.includes("no upstream")) {
        const aheadStr =
          ahead > 0 ? chalk.green(`↑ ${ahead} ahead`) : chalk.gray("↑ 0 ahead")
        const behindStr =
          behind > 0 ? chalk.yellow(`↓ ${behind} behind`) : chalk.gray("↓ 0 behind")
        console.log(`  Remote    ${aheadStr}  ${behindStr}`)
      }

      console.log(
        `  Changes   ${staged > 0 ? chalk.green(`${staged} staged`) : chalk.gray("0 staged")}  ` +
          `${unstaged > 0 ? chalk.yellow(`${unstaged} unstaged`) : chalk.gray("0 unstaged")}  ` +
          `${untracked > 0 ? chalk.gray(`${untracked} untracked`) : chalk.gray("0 untracked")}`
      )

      if (lines.length > 0) {
        console.log()
        for (const line of lines.slice(0, 20)) {
          console.log(`  ${chalk.gray(line)}`)
        }
        if (lines.length > 20) {
          console.log(chalk.gray(`  … and ${lines.length - 20} more`))
        }
      }

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
          '"\(.number)|\(.url)|\(.title)"',
        ])
        const [num, url] = prOut.trim().split("|")
        prLine = `\n  ${chalk.bold("PR")}        ${chalk.cyan(`#${num}`)} ${chalk.gray(url)}`
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
