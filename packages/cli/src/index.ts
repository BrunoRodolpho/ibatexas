#!/usr/bin/env node

import path from "node:path"
import { fileURLToPath } from "node:url"
import { config as loadEnv } from "dotenv"
import { Command, type Help } from "commander"
import { registerSvcCommands }  from "./commands/svc.js"
import { registerDevCommands }  from "./commands/dev.js"
import { registerApiCommands }  from "./commands/api.js"
import { registerDbCommands }   from "./commands/db.js"
import { registerEnvCommands }  from "./commands/env.js"
import { registerGitCommands }  from "./commands/git.js"

// ── Load .env files ──────────────────────────────────────────────────────────
// Load CLI-specific config first, then root config (root config takes priority)
// index.ts lives at packages/cli/src/ → parent is packages/cli/
// dist/index.js lives at packages/cli/dist/ → parent is packages/cli/
const __filename = fileURLToPath(import.meta.url)
const CLI_DIR = path.resolve(path.dirname(__filename), "..")
const ROOT = path.resolve(CLI_DIR, "../../")
loadEnv({ path: path.join(CLI_DIR, ".env"), override: false })
loadEnv({ path: path.join(ROOT, ".env"), override: true })

// ── Custom help formatter ─────────────────────────────────────────────────────

interface GroupSection {
  title: string
  commands: { usage: string; desc: string }[]
}

function buildHelpText(): string {
  const groups: GroupSection[] = [
    {
      title: "SDLC",
      commands: [
        { usage: "dev [service]",     desc: "Start dev environment — commerce (default) | api | web | all" },
        { usage: "dev stop",          desc: "Stop all Docker containers" },
        { usage: "dev build [filter]", desc: "Build packages" },
        { usage: "dev test [filter]", desc: "Run tests" },
      ],
    },
    {
      title: "Services",
      commands: [
        { usage: "svc health [service]", desc: "Check health — all or a specific service" },
        { usage: "svc status",           desc: "Show running services with addresses" },
      ],
    },
    {
      title: "API",
      commands: [
        { usage: "api products list", desc: "List products from the catalog" },
        { usage: "api products add",  desc: "Add a product interactively" },
      ],
    },
    {
      title: "Data",
      commands: [
        { usage: "db migrate", desc: "Run Medusa migrations" },
        { usage: "db seed",    desc: "Seed the product catalog" },
        { usage: "db reset",   desc: "⚠  Drop, migrate, and reseed" },
      ],
    },
    {
      title: "Config",
      commands: [
        { usage: "env check [--step n]", desc: "Validate required environment variables" },
        { usage: "env show [--reveal]",  desc: "Display environment variables" },
        { usage: "env gen [bytes]",      desc: "Generate a cryptographic secret" },
      ],
    },
    {
      title: "VCS",
      commands: [
        { usage: "git status", desc: "Branch and file change summary" },
        { usage: "git log",    desc: "Recent commits with PR links" },
      ],
    },
  ]

  const usageWidth = 28
  const lines: string[] = []

  for (const group of groups) {
    lines.push(`  \x1b[1m${group.title}\x1b[0m`)
    for (const cmd of group.commands) {
      const padded = cmd.usage.padEnd(usageWidth)
      lines.push(`    \x1b[36m${padded}\x1b[0m  \x1b[90m${cmd.desc}\x1b[0m`)
    }
    lines.push("")
  }

  lines.push(`  \x1b[90mRun ibx <command> --help for details\x1b[0m`)

  return lines.join("\n")
}

// ── Program ───────────────────────────────────────────────────────────────────

const program = new Command()

program
  .name("ibx")
  .description("IbateXas developer CLI")
  .version("0.0.1")
  .configureHelp({
    formatHelp: (_cmd: Command, _helper: Help): string => {
      return [
        "",
        `  \x1b[1mibx\x1b[0m v0.0.1 — IbateXas developer CLI`,
        "",
        `  \x1b[90mUsage:\x1b[0m  ibx <command> [options]`,
        "",
        buildHelpText(),
        "",
      ].join("\n")
    },
  })

// ── SDLC: ibx dev … ──────────────────────────────────────────────────────────
const devGroup = new Command("dev")
registerDevCommands(devGroup)
program.addCommand(devGroup)

// ── Services: ibx svc … ──────────────────────────────────────────────────────
const svcGroup = new Command("svc").description("Services — infrastructure and app health")
registerSvcCommands(svcGroup)
program.addCommand(svcGroup)

// ── API: ibx api … ───────────────────────────────────────────────────────────
const apiGroup = new Command("api").description("API — catalog and service queries")
registerApiCommands(apiGroup)
program.addCommand(apiGroup)

// ── Data ──────────────────────────────────────────────────────────────────────
registerDbCommands(program)

// ── Config ────────────────────────────────────────────────────────────────────
registerEnvCommands(program)

// ── VCS ───────────────────────────────────────────────────────────────────────
registerGitCommands(program)

program.parse()
