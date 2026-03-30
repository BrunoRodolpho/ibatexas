// ibx chat — conversation session management and scenario test runner.
// list: active Redis sessions; dump: pretty-print transcript;
// clean: delete Redis + Postgres conversation data; scenarios: run E2E tests.

import path from "node:path"
import fs from "node:fs"
import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { execa } from "execa"
import { ROOT } from "../utils/root.js"
import {
  rk,
  getRedis,
  closeRedis,
  scanKeysForPattern,
  flushExactKey,
  type RedisClient,
} from "../lib/redis.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTtl(ttlSeconds: number): string {
  if (ttlSeconds < 0) return "no expiry"
  const h = Math.floor(ttlSeconds / 3600)
  const m = Math.floor((ttlSeconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function extractSessionId(key: string): string {
  // key looks like: {APP_ENV}:session:{sessionId}
  // split on "session:" and take everything after
  const idx = key.indexOf("session:")
  if (idx === -1) return key
  return key.slice(idx + "session:".length)
}

// ── chat list ─────────────────────────────────────────────────────────────────

async function runList(opts: { limit: number }): Promise<void> {
  const spinner = ora("Scanning Redis for active sessions…").start()

  try {
    const redis = await getRedis()
    const sessionKeys = await scanKeysForPattern(redis, rk("session:*"))
    spinner.stop()

    if (sessionKeys.length === 0) {
      console.log(chalk.gray("\n  No active sessions found.\n"))
      return
    }

    const limited = sessionKeys.slice(0, opts.limit)

    // Gather data for each session
    interface SessionRow {
      sessionId: string
      messages: number
      ttl: number
      channel: string
    }

    const rows: SessionRow[] = []
    for (const key of limited) {
      const sessionId = extractSessionId(key)
      const [messages, ttl] = await Promise.all([
        redis.lLen(key),
        redis.ttl(key),
      ])

      // Best-effort: look for a wa:machine:{sessionId} key to determine channel
      const machineKey = rk(`wa:machine:${sessionId}`)
      const machineExists = await redis.exists(machineKey)
      const channel = machineExists ? "whatsapp" : "web"

      rows.push({ sessionId, messages, ttl, channel })
    }

    // Header
    const idWidth = 36
    const msgWidth = 10
    const ttlWidth = 10
    const chWidth = 10

    console.log()
    console.log(
      chalk.bold(
        `  ${"Session ID".padEnd(idWidth)}  ${"Messages".padEnd(msgWidth)}  ${"TTL".padEnd(ttlWidth)}  ${"Channel".padEnd(chWidth)}`
      )
    )
    console.log(chalk.gray(`  ${"-".repeat(idWidth + msgWidth + ttlWidth + chWidth + 6)}`))

    for (const row of rows) {
      const ttlStr = formatTtl(row.ttl)
      console.log(
        `  ${chalk.cyan(row.sessionId.padEnd(idWidth))}  ${String(row.messages).padEnd(msgWidth)}  ${ttlStr.padEnd(ttlWidth)}  ${row.channel}`
      )
    }

    if (sessionKeys.length > opts.limit) {
      console.log(chalk.gray(`\n  Showing ${opts.limit} of ${sessionKeys.length} sessions. Use --limit to see more.\n`))
    } else {
      console.log()
    }
  } catch (err) {
    spinner.fail(chalk.red(`Failed: ${err}`))
    process.exit(1)
  } finally {
    await closeRedis()
  }
}

// ── chat dump ────────────────────────────────────────────────────────────────

interface RawMessage {
  role?: string
  content?: string
  sentAt?: string | Date
  metadata?: unknown
}

function formatMessage(idx: number, msg: RawMessage): void {
  const role = msg.role ?? "unknown"
  const content = msg.content ?? ""

  if (role === "user") {
    console.log(chalk.cyan(`\n  [${idx}] Cliente:`))
    console.log(chalk.cyan(`  ${content}`))
  } else if (role === "assistant") {
    console.log(chalk.green(`\n  [${idx}] Bot:`))
    console.log(chalk.green(`  ${content}`))
  } else {
    console.log(chalk.gray(`\n  [${idx}] Sistema:`))
    console.log(chalk.gray(`  ${content}`))
  }
}

async function runDump(
  sessionId: string,
  opts: { source: string; json: boolean }
): Promise<void> {
  const spinner = ora(`Loading transcript for session ${sessionId}…`).start()

  try {
    if (opts.source === "postgres") {
      // Postgres source — requires domain package
      let svc: {
        findBySessionId(id: string): Promise<{ id: string } | null>
        getTranscript(id: string): Promise<Array<{ role: string; content: string; sentAt: Date; metadata: unknown }>>
      }
      try {
        const { createConversationService } = await import("@ibatexas/domain")
        svc = createConversationService()
      } catch {
        spinner.fail(chalk.red("Domain package not available. Use --source redis instead."))
        process.exit(1)
      }

      const conversation = await svc.findBySessionId(sessionId)
      if (!conversation) {
        spinner.fail(chalk.yellow(`No Postgres conversation found for session: ${sessionId}`))
        process.exit(1)
      }

      const messages = await svc.getTranscript(conversation.id)
      spinner.stop()

      if (opts.json) {
        console.log(JSON.stringify(messages, null, 2))
        return
      }

      if (messages.length === 0) {
        console.log(chalk.gray("\n  No messages in this conversation.\n"))
        return
      }

      console.log(chalk.bold(`\n  Transcript for session ${chalk.cyan(sessionId)} (Postgres)\n`))
      messages.forEach((msg, i) => formatMessage(i + 1, msg))
      console.log()
      return
    }

    // Default: Redis source
    const redis = await getRedis()
    const sessionKey = rk(`session:${sessionId}`)
    const rawMessages = await redis.lRange(sessionKey, 0, -1)
    spinner.stop()

    if (rawMessages.length === 0) {
      console.log(chalk.yellow(`\n  No Redis session found for: ${sessionId}\n`))
      return
    }

    const parsed: RawMessage[] = rawMessages.map((raw) => {
      try {
        return JSON.parse(raw) as RawMessage
      } catch {
        return { role: "unknown", content: raw }
      }
    })

    if (opts.json) {
      console.log(JSON.stringify(parsed, null, 2))
      return
    }

    console.log(chalk.bold(`\n  Transcript for session ${chalk.cyan(sessionId)} (Redis)\n`))
    parsed.forEach((msg, i) => formatMessage(i + 1, msg))
    console.log()
  } catch (err) {
    spinner.fail(chalk.red(`Failed: ${err}`))
    process.exit(1)
  } finally {
    await closeRedis()
  }
}

// ── chat clean ───────────────────────────────────────────────────────────────

async function deleteSpecificSession(
  redis: RedisClient,
  sessionId: string,
  dryRun: boolean
): Promise<{ redisDeleted: number }> {
  let redisDeleted = 0
  const sessionKey = rk(`session:${sessionId}`)
  const machineKey = rk(`wa:machine:${sessionId}`)

  redisDeleted += await flushExactKey(redis, "session", sessionKey, dryRun)
  redisDeleted += await flushExactKey(redis, "wa:machine", machineKey, dryRun)

  return { redisDeleted }
}

async function deleteAllSessions(
  redis: RedisClient,
  dryRun: boolean
): Promise<{ redisDeleted: number }> {
  const sessionKeys = await scanKeysForPattern(redis, rk("session:*"))
  const machineKeys = await scanKeysForPattern(redis, rk("wa:machine:*"))
  const allKeys = [...sessionKeys, ...machineKeys]

  if (dryRun) {
    console.log(chalk.yellow(`  [dry-run] would delete ${allKeys.length} Redis key(s) (${sessionKeys.length} sessions, ${machineKeys.length} machine states)`))
    return { redisDeleted: allKeys.length }
  }

  if (allKeys.length > 0) {
    await redis.del(allKeys)
    console.log(chalk.green(`  Deleted ${allKeys.length} Redis key(s) (${sessionKeys.length} sessions, ${machineKeys.length} machine states)`))
  } else {
    console.log(chalk.gray("  No Redis session keys found"))
  }

  return { redisDeleted: allKeys.length }
}

async function runClean(
  sessionId: string | undefined,
  opts: { dryRun: boolean }
): Promise<void> {
  const spinner = ora("Connecting to Redis…").start()

  try {
    const redis = await getRedis()
    spinner.stop()

    let redisDeleted = 0
    let pgDeleted = 0

    if (sessionId) {
      // Specific session
      console.log(chalk.bold(`\n  Cleaning session: ${chalk.cyan(sessionId)}\n`))
      const result = await deleteSpecificSession(redis, sessionId, opts.dryRun)
      redisDeleted = result.redisDeleted

      // Postgres
      try {
        const { createConversationService } = await import("@ibatexas/domain")
        const svc = createConversationService()
        if (opts.dryRun) {
          const conversation = await svc.findBySessionId(sessionId)
          pgDeleted = conversation ? 1 : 0
          if (pgDeleted > 0) {
            console.log(chalk.yellow(`  [dry-run] would delete 1 Postgres conversation`))
          } else {
            console.log(chalk.gray("  No Postgres conversation found for this session"))
          }
        } else {
          const deleted = await svc.deleteBySessionId(sessionId)
          pgDeleted = deleted ? 1 : 0
          if (pgDeleted > 0) {
            console.log(chalk.green("  Deleted 1 Postgres conversation"))
          } else {
            console.log(chalk.gray("  No Postgres conversation found for this session"))
          }
        }
      } catch {
        console.log(chalk.yellow("  Postgres clean skipped (domain package unavailable)"))
      }
    } else {
      // All sessions
      console.log(chalk.bold("\n  Cleaning ALL conversation data\n"))
      const result = await deleteAllSessions(redis, opts.dryRun)
      redisDeleted = result.redisDeleted

      // Postgres
      try {
        const { createConversationService } = await import("@ibatexas/domain")
        const svc = createConversationService()
        if (opts.dryRun) {
          const active = await svc.listActive(10000)
          pgDeleted = active.length
          if (pgDeleted > 0) {
            console.log(chalk.yellow(`  [dry-run] would delete ${pgDeleted} Postgres conversation(s)`))
          } else {
            console.log(chalk.gray("  No Postgres conversations found"))
          }
        } else {
          pgDeleted = await svc.deleteAll()
          if (pgDeleted > 0) {
            console.log(chalk.green(`  Deleted ${pgDeleted} Postgres conversation(s)`))
          } else {
            console.log(chalk.gray("  No Postgres conversations found"))
          }
        }
      } catch {
        console.log(chalk.yellow("  Postgres clean skipped (domain package unavailable)"))
      }
    }

    // Summary
    console.log()
    if (opts.dryRun) {
      console.log(chalk.yellow(`  [dry-run] Would delete ${redisDeleted} Redis key(s) + ${pgDeleted} Postgres conversation(s). Run without --dry-run to apply.\n`))
    } else {
      console.log(chalk.green(`  Deleted ${redisDeleted} Redis key(s) + ${pgDeleted} Postgres conversation(s).\n`))
    }
  } catch (err) {
    spinner.fail(chalk.red(`Failed: ${err}`))
    process.exit(1)
  } finally {
    await closeRedis()
  }
}

// ── chat scenarios ────────────────────────────────────────────────────────────

const SCENARIOS_FIXTURES_DIR = path.join(ROOT, "packages/llm-provider/src/__tests__/scenarios/fixtures")
const SCENARIO_TEST_FILE = "packages/llm-provider/src/__tests__/scenarios/scenario-runner.test.ts"

async function runScenarios(opts: { list: boolean; filter?: string }): Promise<void> {
  if (opts.list) {
    try {
      const files = fs.readdirSync(SCENARIOS_FIXTURES_DIR).filter((f) => f.endsWith(".json")).sort()
      if (files.length === 0) {
        console.log(chalk.gray("\n  No scenario fixtures found.\n"))
        return
      }
      console.log(chalk.bold("\n  Available scenario fixtures:\n"))
      for (const file of files) {
        const fullPath = path.join(SCENARIOS_FIXTURES_DIR, file)
        try {
          const content = fs.readFileSync(fullPath, "utf8")
          const fixture = JSON.parse(content) as { name?: string; description?: string }
          const name = fixture.name ?? file
          const desc = fixture.description ?? ""
          console.log(`  ${chalk.cyan(file.replace(".json", "").padEnd(40))}  ${chalk.gray(name)}`)
          if (desc) console.log(`  ${"".padEnd(40)}  ${chalk.gray(desc)}`)
        } catch {
          console.log(`  ${chalk.cyan(file)}`)
        }
      }
      console.log()
    } catch {
      console.log(chalk.yellow(`\n  Fixtures directory not found: ${SCENARIOS_FIXTURES_DIR}\n`))
    }
    return
  }

  const args = ["vitest", "run", SCENARIO_TEST_FILE]
  if (opts.filter) {
    args.push("--reporter=verbose", `-t`, opts.filter)
  }

  console.log(chalk.bold("\n  Running conversation scenario tests…\n"))
  console.log(chalk.gray(`  $ pnpm ${args.join(" ")}\n`))

  try {
    await execa("pnpm", args, { cwd: ROOT, stdio: "inherit" })
  } catch {
    // execa throws on non-zero exit — test failures are expected output
    process.exit(1)
  }
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerChatCommands(group: Command): void {
  group.description("Chat — conversation management and testing")

  // ─── chat list ───────────────────────────────────────────────────────────
  group
    .command("list")
    .description("List active Redis conversation sessions")
    .option("--limit <n>", "Maximum number of sessions to show", (v) => Number.parseInt(v, 10), 20)
    .action(async (opts: { limit: number }) => {
      await runList(opts)
    })

  // ─── chat dump ───────────────────────────────────────────────────────────
  group
    .command("dump <sessionId>")
    .description("Pretty-print a conversation transcript")
    .option("--source <source>", "Source: redis (default) or postgres", "redis")
    .option("--json", "Output raw JSON array (for piping)")
    .action(async (sessionId: string, opts: { source: string; json: boolean }) => {
      await runDump(sessionId, opts)
    })

  // ─── chat clean ──────────────────────────────────────────────────────────
  group
    .command("clean [sessionId]")
    .description("Delete conversation data from Redis and Postgres")
    .option("--dry-run", "Count what would be deleted without actually deleting")
    .action(async (sessionId: string | undefined, opts: { dryRun: boolean }) => {
      await runClean(sessionId, opts)
    })

  // ─── chat scenarios ──────────────────────────────────────────────────────
  group
    .command("scenarios")
    .description("Run E2E conversation scenario tests")
    .option("--list", "List available scenario fixtures")
    .option("--filter <pattern>", "Filter tests by name pattern")
    .action(async (opts: { list: boolean; filter?: string }) => {
      await runScenarios(opts)
    })
}
