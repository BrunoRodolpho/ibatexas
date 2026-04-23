#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { config as loadEnv } from "dotenv"
import { Command, Help } from "commander"
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
import { registerRateCommands } from "./commands/rate.js"
import { registerBootstrapCommands } from "./commands/bootstrap.js"
import { registerDepsCommands } from "./commands/deps.js"
import { registerInfraCommands } from "./commands/infra.js"
import { registerStripeCommands } from "./commands/stripe.js"
import { registerChatCommands } from "./commands/chat.js"
import { registerDlqCommands } from "./commands/dlq.js"
import { registerOrdersCommands } from "./commands/orders.js"

// ── Load .env files ──────────────────────────────────────────────────────────
// Env precedence: shell > root .env > cli .env. dotenv semantics: each
// loadEnv() only fills in variables that aren't already set, so the shell
// always wins — critical for prod overrides like
// `DATABASE_URL=... ibx auth create-staff` pointing at Supabase instead of
// the local docker-compose URL in .env.
// index.ts lives at packages/cli/src/ → parent is packages/cli/
// dist/index.js lives at packages/cli/dist/ → parent is packages/cli/
// Use realpathSync to resolve npm link symlinks — otherwise ROOT points to
// /opt/homebrew/lib/node_modules instead of the monorepo root.
const __filename = fs.realpathSync(fileURLToPath(import.meta.url))
const CLI_DIR = path.resolve(path.dirname(__filename), "..")
const ROOT = path.resolve(CLI_DIR, "../../")
loadEnv({ path: path.join(ROOT, ".env"), override: false })
loadEnv({ path: path.join(CLI_DIR, ".env"), override: false })

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
        { usage: "dev [services...]",         desc: "Start dev stack in TUI — 4 core services by default, 'all' includes tunnel + stripe" },
        { usage: "dev start [services...]",   desc: "Explicit start alias (--with-tunnel, --with-stripe, --no-tui)" },
        { usage: "dev stop [service]",        desc: "Stop service(s) — omit to stop all + Docker (-f to force-kill ports)" },
        { usage: "dev restart [service]",     desc: "Restart service(s) in-place" },
        { usage: "dev build [filter]",        desc: "Build packages" },
        { usage: "dev test [filter]",         desc: "Run tests" },
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
        { usage: "auth create-admin",      desc: "Create Medusa admin user (from .env or --email/--password)" },
        { usage: "auth create-staff",     desc: "Register staff member for admin login (--phone, --name, --role)" },
      ],
    },
    {
      title: "Rate Limits",
      commands: [
        { usage: "rate flush [id]",        desc: "Delete rate-limit keys (--wa, --tokens, --dry-run)" },
        { usage: "rate status [id]",       desc: "Show active rate-limit counters and TTLs" },
      ],
    },
    {
      title: "Chat",
      commands: [
        { usage: "chat list",              desc: "List active Redis sessions" },
        { usage: "chat dump <sessionId>",  desc: "Pretty-print conversation (--source, --json)" },
        { usage: "chat clean [sessionId]", desc: "Delete conversation data (--dry-run)" },
        { usage: "chat scenarios",         desc: "Run E2E conversation test scenarios (--filter, --list)" },
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
      title: "Infrastructure",
      commands: [
        { usage: "infra init",       desc: "Create S3 state bucket + DynamoDB lock table (idempotent)" },
        { usage: "infra plan",       desc: "Run terraform plan (with state safety check)" },
        { usage: "infra apply",      desc: "Run terraform apply and display key outputs" },
        { usage: "infra secrets",    desc: "Populate Secrets Manager entries (interactive, --from-env for CI, --only to filter)" },
        { usage: "infra secrets:export", desc: "Export MANUAL_SECRETS from .env to infra/secrets.env" },
        { usage: "infra secrets:push",   desc: "Push infra/secrets.env to AWS Secrets Manager" },
        { usage: "infra github",     desc: "Set GitHub repo secrets for CI/CD (detects repo)" },
        { usage: "infra status",     desc: "Deployment health dashboard (--json)" },
        { usage: "infra checklist",  desc: "Full deployment checklist with completion status" },
        { usage: "infra explain",    desc: "Diagnose why a deploy is failing (follows dependency chain)" },
        { usage: "infra destroy",    desc: "⚠  Destroy all AWS infrastructure (requires confirmation)" },
        { usage: "infra logs [svc]", desc: "Tail ECS CloudWatch logs" },
        { usage: "infra deploy",     desc: "Push to dev/main + health check (--watch, --timeout)" },
        { usage: "infra doctor",     desc: "Deep infrastructure diagnostics" },
      ],
    },
    {
      title: "Payments",
      commands: [
        { usage: "stripe status",          desc: "Validate Stripe keys + check CLI installation" },
        { usage: "stripe listen",          desc: "Forward Stripe webhooks to local API (port 3001)" },
        { usage: "stripe trigger [event]", desc: "Fire a test webhook event (default: payment_intent.succeeded)" },
        { usage: "stripe complete",        desc: "Force-complete orphaned PIX/card carts (--cart <id> | --all) — dev rescue" },
        { usage: "stripe flush [id]",      desc: "Clear webhook idempotency keys (--dry-run)" },
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
    formatHelp: (cmd: Command, helper: Help): string => {
      // Only use the custom grouped layout for the root command;
      // subcommands (db, dev, svc…) get Commander's default help.
      if (cmd.parent) {
        return Help.prototype.formatHelp.call(helper, cmd, helper)
      }
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
  { name: "rate",     register: registerRateCommands, description: "Rate limits — message, token, and API rate-limit management" },
  { name: "chat",     register: registerChatCommands, description: "Chat — conversation management and testing" },
  { name: "deps",     register: registerDepsCommands },
  { name: "infra",    register: registerInfraCommands, description: "Infrastructure — deployment and AWS" },
  { name: "stripe",  register: registerStripeCommands, description: "Stripe — payments and webhook testing" },
  { name: "dlq",     register: registerDlqCommands,     description: "Dead Letter Queue — inspect, replay, and purge failed events" },
  { name: "orders",  register: registerOrdersCommands,  description: "Orders — projection management and debugging" },
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
