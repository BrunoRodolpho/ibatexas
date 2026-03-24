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
import { registerIntelligenceCommands } from "./commands/intelligence.js"
import { registerTestCommands } from "./commands/test.js"
import { registerTagCommands }  from "./commands/tag.js"
import { registerScenarioCommands } from "./commands/scenario.js"
import { registerDebugCommands } from "./commands/debug.js"
import { registerInspectCommands } from "./commands/inspect.js"
import { registerDoctorCommands } from "./commands/doctor.js"
import { registerMatrixCommands } from "./commands/matrix.js"
import { registerSimulateCommands } from "./commands/simulate.js"
import { registerTunnelCommands } from "./commands/tunnel.js"
import { registerAuthCommands } from "./commands/auth.js"
import { registerBootstrapCommands } from "./commands/bootstrap.js"
import { registerDepsCommands } from "./commands/deps.js"

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
      title: "Setup",
      commands: [
        { usage: "bootstrap",               desc: "One-shot setup — Docker + migrations + seeds + verify (--skip-docker, --skip-seed)" },
      ],
    },
    {
      title: "SDLC",
      commands: [
        { usage: "dev [service]",          desc: "Start dev environment — commerce (default) | api | web | admin | all" },
        { usage: "dev start [service]",    desc: "Explicit start alias (use --no-docker to skip containers)" },
        { usage: "dev stop [service]",     desc: "Stop service(s) — omit to stop all + docker compose stop (-f to force-kill ports)" },
        { usage: "dev restart [service]",  desc: "Kill + respawn service(s) without touching Docker" },
        { usage: "dev build [filter]",     desc: "Build packages" },
        { usage: "dev test [filter]",      desc: "Run tests" },
      ],
    },
    {
      title: "Services",
      commands: [
        { usage: "svc health [service]", desc: "Check health — all or postgres | redis | typesense | nats" },
        { usage: "svc status",           desc: "Show running services with addresses and data status" },
        { usage: "svc logs [service]",   desc: "Tail Docker compose logs — all or a specific service" },
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
        { usage: "db migrate",        desc: "Run Medusa migrations" },
        { usage: "db migrate:domain", desc: "Run Prisma (domain) migrations" },
        { usage: "db seed",           desc: "Seed the product catalog" },
        { usage: "db seed:domain",    desc: "Seed domain tables (Table, TimeSlot)" },
        { usage: "db seed:homepage",  desc: "Seed customers + reviews for homepage" },
        { usage: "db seed:delivery", desc: "Seed delivery zones, addresses + preferences" },
        { usage: "db seed:orders",   desc: "Seed order history + reservations (Medusa required)" },
        { usage: "db reindex",        desc: "Fetch products from Medusa → index into Typesense (--fresh to recreate)" },
        { usage: "db clean",          desc: "⚠  Delete all domain data (--all for Medusa + Typesense too)" },
        { usage: "db reset",          desc: "⚠  Drop, migrate, and reseed" },
        { usage: "db status",         desc: "Migration status for Medusa + Prisma schemas" },
      ],
    },
    {
      title: "Testing",
      commands: [
        { usage: "test seed",               desc: "Full seed pipeline — products → reindex → domain → reviews → intel" },
        { usage: "test seed --from=<task>",  desc: "Start from a specific task (skip earlier ones)" },
        { usage: "test seed --skip=<pat>",   desc: "Skip tasks matching pattern(s), comma-separated" },
        { usage: "test integration",         desc: "Seed for UI ↔ API testing (skips if products exist)" },
        { usage: "test e2e [--force]",       desc: "⚠  Full clean + reseed (destructive)" },
        { usage: "test e2e-run [filter]",    desc: "Run Playwright E2E tests (--headed, --ui)" },
        { usage: "test status",              desc: "Dashboard — what's seeded and ready for each section" },
      ],
    },
    {
      title: "Tags",
      commands: [
        { usage: "tag add <handle> <tag>",   desc: "Add a tag to a product (triggers reindex + cache flush)" },
        { usage: "tag remove <handle> <tag>",desc: "Remove a tag from a product" },
        { usage: "tag list [handle]",        desc: "List tags — for a product or all products with tags" },
      ],
    },
    {
      title: "Intelligence",
      commands: [
        { usage: "intel copurchase-reset",    desc: "Delete all co-purchase Redis sorted sets" },
        { usage: "intel copurchase-rebuild",  desc: "Rebuild co-purchase sets from order history (--reset)" },
        { usage: "intel global-score-rebuild",desc: "Rebuild global popularity scores (--reset)" },
        { usage: "intel scores-inspect [id]", desc: "Inspect co-purchase or global scores" },
        { usage: "intel cache-stats",          desc: "Redis memory usage for intelligence keys" },
      ],
    },
    {
      title: "Scenario",
      commands: [
        { usage: "scenario list",           desc: "Discover YAML scenario files" },
        { usage: "scenario run <name>",     desc: "Run a scenario (--dry-run, --verify-only, --force)" },
      ],
    },
    {
      title: "Matrix",
      commands: [
        { usage: "matrix list",              desc: "List matrices with variable/state counts" },
        { usage: "matrix run <name>",        desc: "Run a matrix (--state, --corners, --random)" },
        { usage: "matrix states <name>",     desc: "List all states for a matrix (--corners)" },
        { usage: "matrix run <name> --snapshot", desc: "Save results as snapshots" },
        { usage: "matrix run <name> --verify",   desc: "Verify against saved snapshots" },
      ],
    },
    {
      title: "Simulate",
      commands: [
        { usage: "simulate full",             desc: "Full simulation — customers + orders + reviews + rebuild" },
        { usage: "simulate full --scale=medium", desc: "Use scale preset (small, medium, large)" },
        { usage: "simulate orders",           desc: "Generate only order history (no reviews)" },
        { usage: "simulate profiles",         desc: "List behavior profiles and scale presets" },
      ],
    },
    {
      title: "Inspect & Debug",
      commands: [
        { usage: "inspect",                 desc: "System state dashboard" },
        { usage: "inspect product <handle>",desc: "Product deep-dive (tags, orders, scores)" },
        { usage: "inspect page <page>",     desc: "UI section state (homepage, search)" },
        { usage: "inspect integrity",       desc: "Cross-system consistency check" },
        { usage: "debug redis [pattern]",   desc: "Redis key inspection (--ttl)" },
        { usage: "debug typesense [query]", desc: "Typesense inspection (--schema, --id)" },
        { usage: "debug profile <id>",      desc: "Customer profile dump" },
        { usage: "doctor",                  desc: "Full system diagnostics (--fix, --ci)" },
      ],
    },
    {
      title: "Auth",
      commands: [
        { usage: "auth flush [hash]",      desc: "Delete OTP rate-limit & fail keys (all or by phone hash)" },
        { usage: "auth status [hash]",     desc: "Show current OTP rate-limit and fail counters" },
      ],
    },
    {
      title: "Network",
      commands: [
        { usage: "tunnel [-p port]",     desc: "Expose local API via ngrok for WhatsApp webhook testing" },
      ],
    },
    {
      title: "Dependencies",
      commands: [
        { usage: "deps audit",       desc: "Detect unused, non-deterministic, or drifted overrides" },
        { usage: "deps drift",       desc: "Check for undocumented override changes vs main" },
        { usage: "deps radar",       desc: "Check upstream packages for override removal opportunities" },
        { usage: "deps check",       desc: "Full dependency health check (audit + drift + radar)" },
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

// ── Register grouped commands ────────────────────────────────────────────────

const groupedCommands: { name: string; register: (cmd: Command) => void; description?: string }[] = [
  { name: "dev",      register: registerDevCommands },
  { name: "svc",      register: registerSvcCommands,      description: "Services — infrastructure and app health" },
  { name: "api",      register: registerApiCommands,      description: "API — catalog and service queries" },
  { name: "test",     register: registerTestCommands },
  { name: "tag",      register: registerTagCommands },
  { name: "scenario", register: registerScenarioCommands },
  { name: "debug",    register: registerDebugCommands },
  { name: "inspect",  register: registerInspectCommands },
  { name: "matrix",   register: registerMatrixCommands },
  { name: "simulate", register: registerSimulateCommands },
  { name: "doctor",   register: registerDoctorCommands },
  { name: "auth",     register: registerAuthCommands },
  { name: "deps",     register: registerDepsCommands },
]

for (const { name, register, description } of groupedCommands) {
  const group = new Command(name)
  if (description) group.description(description)
  register(group)
  program.addCommand(group)
}

// ── Register root-level commands (no subgroup) ──────────────────────────────
const rootRegistrations = [registerBootstrapCommands, registerDbCommands, registerEnvCommands, registerGitCommands, registerIntelligenceCommands, registerTunnelCommands]
for (const register of rootRegistrations) {
  register(program)
}

program.parse()
