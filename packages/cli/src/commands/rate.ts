// ibx rate — Rate-limit management for WhatsApp, LLM token budget, and API limits.
// Flush and inspect rate-limit keys so you can unblock during development/testing.

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import {
  rk,
  getRedis,
  closeRedis,
  flushExactKey,
  flushGlobPattern,
  printFlushSummary,
  scanKeysForPattern,
  type RedisClient,
} from "../lib/redis.js"

// ── Constants ───────────────────────────────────────────────────────────────

const WA_RATE_LIMIT = 20       // msgs/min per phone
const TOKEN_BUDGET = Number.parseInt(process.env.AGENT_SESSION_TOKEN_BUDGET || "100000", 10)
const CUSTOMER_CREATE_LIMIT = 100
const ANALYTICS_LIMIT = 100

// ── Flush helpers ───────────────────────────────────────────────────────────

interface FlushPattern {
  label: string
  pattern: string
}

function buildFlushPatterns(
  identifier: string | undefined,
  opts: { wa?: boolean; tokens?: boolean },
): FlushPattern[] {
  // Specific identifier → exact keys only
  if (identifier) {
    const patterns: FlushPattern[] = []
    if (!opts.tokens) {
      patterns.push({ label: "wa:rate", pattern: rk(`wa:rate:${identifier}`) })
    }
    if (!opts.wa) {
      patterns.push({ label: "llm:tokens", pattern: rk(`llm:tokens:${identifier}`) })
    }
    return patterns
  }

  // Flag-filtered or all
  if (opts.wa) {
    return [{ label: "wa:rate", pattern: rk("wa:rate:*") }]
  }
  if (opts.tokens) {
    return [{ label: "llm:tokens", pattern: rk("llm:tokens:*") }]
  }

  // All rate-limit keys
  return [
    { label: "wa:rate", pattern: rk("wa:rate:*") },
    { label: "llm:tokens", pattern: rk("llm:tokens:*") },
    { label: "customer:create", pattern: rk("ratelimit:customer:create") },
    { label: "analytics:rate", pattern: rk("analytics:rate:*") },
  ]
}

// ── Status helpers ──────────────────────────────────────────────────────────

function extractId(key: string): string {
  const parts = key.split(":")
  return parts[parts.length - 1]
}

async function showWaRateStatus(redis: RedisClient, identifier?: string): Promise<void> {
  const pattern = identifier ? rk(`wa:rate:${identifier}`) : rk("wa:rate:*")
  const keys = identifier
    ? (await redis.exists(rk(`wa:rate:${identifier}`))) ? [rk(`wa:rate:${identifier}`)] : []
    : await scanKeysForPattern(redis, pattern)

  console.log(chalk.bold("\n  WhatsApp messages"))

  if (keys.length === 0) {
    console.log(chalk.gray("  No active keys"))
    return
  }

  for (const key of keys) {
    const count = await redis.get(key)
    const ttl = await redis.ttl(key)
    const id = extractId(key)
    const num = Number.parseInt(count ?? "0", 10)
    const blocked = num > WA_RATE_LIMIT
    const icon = blocked ? chalk.red("✗") : chalk.green("·")
    const ttlSuffix = ttl > 0 ? chalk.gray(` (${ttl}s)`) : ""
    console.log(`  ${icon} ${chalk.cyan(id)}  msgs: ${count ?? "0"}/${WA_RATE_LIMIT}${ttlSuffix}`)
  }
}

async function showTokenBudgetStatus(redis: RedisClient, identifier?: string): Promise<void> {
  const pattern = identifier ? rk(`llm:tokens:${identifier}`) : rk("llm:tokens:*")
  const keys = identifier
    ? (await redis.exists(rk(`llm:tokens:${identifier}`))) ? [rk(`llm:tokens:${identifier}`)] : []
    : await scanKeysForPattern(redis, pattern)

  console.log(chalk.bold("\n  LLM token budget"))

  if (keys.length === 0) {
    console.log(chalk.gray("  No active keys"))
    return
  }

  for (const key of keys) {
    const count = await redis.get(key)
    const ttl = await redis.ttl(key)
    const id = extractId(key)
    const num = Number.parseInt(count ?? "0", 10)
    const blocked = num >= TOKEN_BUDGET
    const icon = blocked ? chalk.red("✗") : chalk.green("·")
    const ttlSuffix = ttl > 0 ? chalk.gray(` (${ttl}s)`) : ""
    console.log(`  ${icon} ${chalk.cyan(id)}  tokens: ${count ?? "0"}/${TOKEN_BUDGET}${ttlSuffix}`)
  }
}

async function showOtherStatus(redis: RedisClient): Promise<void> {
  // Customer create
  const createKey = rk("ratelimit:customer:create")
  const createCount = await redis.get(createKey)
  const createTtl = await redis.ttl(createKey)
  if (createCount) {
    const ttlSuffix = createTtl > 0 ? chalk.gray(` (${createTtl}s)`) : ""
    console.log(chalk.bold("\n  Customer create"))
    console.log(`  · ${createCount}/${CUSTOMER_CREATE_LIMIT}${ttlSuffix}`)
  }

  // Analytics
  const analyticsKeys = await scanKeysForPattern(redis, rk("analytics:rate:*"))
  console.log(chalk.bold("\n  Analytics"))
  if (analyticsKeys.length === 0) {
    console.log(chalk.gray("  No active keys"))
  } else {
    for (const key of analyticsKeys) {
      const count = await redis.get(key)
      const ttl = await redis.ttl(key)
      const id = extractId(key)
      const ttlSuffix = ttl > 0 ? chalk.gray(` (${ttl}s)`) : ""
      console.log(`  · ${chalk.cyan(id)}  events: ${count ?? "0"}/${ANALYTICS_LIMIT}${ttlSuffix}`)
    }
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

export function registerRateCommands(group: Command): void {
  group.description("Rate limits — message, token, and API rate-limit management")

  // ─── rate flush ──────────────────────────────────────────────────────────
  group
    .command("flush [identifier]")
    .description("Delete rate-limit keys (--wa, --tokens, --dry-run)")
    .option("--dry-run", "Show what would be deleted without deleting")
    .option("--wa", "Flush only WhatsApp message rate-limit keys")
    .option("--tokens", "Flush only LLM token budget keys")
    .action(async (identifier: string | undefined, opts: { dryRun?: boolean; wa?: boolean; tokens?: boolean }) => {
      const spinner = ora("Connecting to Redis…").start()

      try {
        const redis = await getRedis()
        const patterns = buildFlushPatterns(identifier, { wa: opts.wa, tokens: opts.tokens })
        spinner.stop()

        let totalDeleted = 0
        for (const { label, pattern } of patterns) {
          if (identifier && !pattern.includes("*")) {
            totalDeleted += await flushExactKey(redis, label, pattern, !!opts.dryRun)
          } else {
            totalDeleted += await flushGlobPattern(redis, label, pattern, !!opts.dryRun)
          }
        }

        printFlushSummary(totalDeleted, !!opts.dryRun)
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${err}`))
        process.exit(1)
      } finally {
        await closeRedis()
      }
    })

  // ─── rate status ─────────────────────────────────────────────────────────
  group
    .command("status [identifier]")
    .description("Show active rate-limit counters and TTLs")
    .action(async (identifier: string | undefined) => {
      const spinner = ora("Connecting to Redis…").start()

      try {
        const redis = await getRedis()
        spinner.stop()

        console.log(chalk.bold("\n  Rate-limit keys"))

        await showWaRateStatus(redis, identifier)
        await showTokenBudgetStatus(redis, identifier)
        if (!identifier) {
          await showOtherStatus(redis)
        }
        console.log()
      } catch (err) {
        console.error(chalk.red(`\n  Failed: ${err}\n`))
        process.exit(1)
      } finally {
        await closeRedis()
      }
    })
}
