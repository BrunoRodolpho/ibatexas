// ibx auth — OTP/auth debugging utilities.
// Flush rate-limit and brute-force keys so you can retry during development.

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"

import { rk, getRedis, closeRedis, scanDelete } from "../lib/redis.js"

// ── Types ───────────────────────────────────────────────────────────────────

type RedisClient = Awaited<ReturnType<typeof getRedis>>

interface FlushPattern {
  label: string
  pattern: string
}

// ── Flush helpers ───────────────────────────────────────────────────────────

function buildFlushPatterns(phoneHash: string | undefined): FlushPattern[] {
  if (phoneHash) {
    return [
      { label: "rate-limit", pattern: rk(`otp:rate:${phoneHash}`) },
      { label: "fail-count", pattern: rk(`otp:fail:${phoneHash}`) },
    ]
  }
  return [
    { label: "rate-limit", pattern: rk("otp:rate:*") },
    { label: "fail-count", pattern: rk("otp:fail:*") },
  ]
}

async function flushExactKey(redis: RedisClient, label: string, pattern: string, dryRun: boolean): Promise<number> {
  const exists = await redis.exists(pattern)
  if (!exists) {
    console.log(chalk.gray(`  · ${label}: not set`))
    return 0
  }
  if (dryRun) {
    console.log(chalk.yellow(`  [dry-run] would delete ${label}: ${pattern}`))
  } else {
    await redis.del(pattern)
    console.log(chalk.green(`  ✓ deleted ${label}: ${pattern}`))
  }
  return 1
}

async function flushGlobPattern(redis: RedisClient, label: string, pattern: string, dryRun: boolean): Promise<number> {
  if (dryRun) {
    let cursor = 0
    let count = 0
    do {
      const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 })
      cursor = result.cursor
      count += result.keys.length
    } while (cursor !== 0)
    if (count > 0) {
      console.log(chalk.yellow(`  [dry-run] would delete ${count} ${label} key(s): ${pattern}`))
    } else {
      console.log(chalk.gray(`  · no ${label} keys found`))
    }
    return count
  }

  const deleted = await scanDelete(redis, pattern)
  if (deleted > 0) {
    console.log(chalk.green(`  ✓ deleted ${deleted} ${label} key(s)`))
  } else {
    console.log(chalk.gray(`  · no ${label} keys found`))
  }
  return deleted
}

function printFlushSummary(totalDeleted: number, dryRun: boolean): void {
  console.log()
  if (totalDeleted === 0) {
    console.log(chalk.gray("  Nothing to flush — all clear.\n"))
  } else if (dryRun) {
    console.log(chalk.yellow(`  [dry-run] ${totalDeleted} key(s) would be deleted. Run without --dry-run to apply.\n`))
  } else {
    console.log(chalk.green(`  ✓ Flushed ${totalDeleted} key(s). You can retry OTP now.\n`))
  }
}

// ── Status helpers ──────────────────────────────────────────────────────────

async function showStatusForHash(redis: RedisClient, phoneHash: string): Promise<void> {
  const rateKey = rk(`otp:rate:${phoneHash}`)
  const failKey = rk(`otp:fail:${phoneHash}`)

  const rateCount = await redis.get(rateKey)
  const failCount = await redis.get(failKey)
  const rateTtl = await redis.ttl(rateKey)
  const failTtl = await redis.ttl(failKey)

  console.log(chalk.bold(`\n  OTP status for ${chalk.cyan(phoneHash)}\n`))
  console.log(`  Send attempts:   ${rateCount ?? "0"}/3${rateTtl > 0 ? chalk.gray(` (resets in ${rateTtl}s)`) : ""}`)
  console.log(`  Failed verifies: ${failCount ?? "0"}/5${failTtl > 0 ? chalk.gray(` (resets in ${failTtl}s)`) : ""}`)
  console.log()
}

async function scanKeysForPattern(redis: RedisClient, pattern: string): Promise<string[]> {
  let cursor = 0
  const keys: string[] = []
  do {
    const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 })
    cursor = result.cursor
    keys.push(...result.keys)
  } while (cursor !== 0)
  return keys
}

function collectUniqueHashes(keys: string[]): Set<string> {
  const hashes = new Set<string>()
  for (const k of keys) {
    const hash = k.split(":").pop()
    if (hash) hashes.add(hash)
  }
  return hashes
}

async function renderHashStatus(redis: RedisClient, hash: string): Promise<void> {
  const rateCount = await redis.get(rk(`otp:rate:${hash}`))
  const failCount = await redis.get(rk(`otp:fail:${hash}`))
  const rateTtl = await redis.ttl(rk(`otp:rate:${hash}`))
  const failTtl = await redis.ttl(rk(`otp:fail:${hash}`))

  const parts: string[] = []
  if (rateCount) parts.push(`sends: ${rateCount}/3${rateTtl > 0 ? ` (${rateTtl}s)` : ""}`)
  if (failCount) parts.push(`fails: ${failCount}/5${failTtl > 0 ? ` (${failTtl}s)` : ""}`)

  const blocked = (Number.parseInt(rateCount ?? "0", 10) > 3) || (Number.parseInt(failCount ?? "0", 10) >= 5)
  const icon = blocked ? chalk.red("✗") : chalk.green("·")

  console.log(`  ${icon} ${chalk.cyan(hash)}  ${parts.join("  ")}`)
}

async function showStatusAll(redis: RedisClient): Promise<void> {
  const rateKeys = await scanKeysForPattern(redis, rk("otp:rate:*"))
  const failKeys = await scanKeysForPattern(redis, rk("otp:fail:*"))

  console.log(chalk.bold(`\n  OTP auth keys\n`))

  if (rateKeys.length === 0 && failKeys.length === 0) {
    console.log(chalk.gray("  No active rate-limit or fail keys.\n"))
    return
  }

  const hashes = collectUniqueHashes([...rateKeys, ...failKeys])

  for (const hash of hashes) {
    await renderHashStatus(redis, hash)
  }
  console.log()
}

// ── Commands ─────────────────────────────────────────────────────────────────

export function registerAuthCommands(group: Command): void {
  group.description("Auth — OTP rate-limit and brute-force key management")

  // ─── auth flush ──────────────────────────────────────────────────────────
  group
    .command("flush [phone_hash]")
    .description("Delete OTP rate-limit and brute-force keys (all or for a specific phone hash)")
    .option("--dry-run", "Show what would be deleted without deleting")
    .action(async (phoneHash: string | undefined, opts: { dryRun?: boolean }) => {
      const spinner = ora("Connecting to Redis…").start()

      try {
        const redis = await getRedis()
        const patterns = buildFlushPatterns(phoneHash)
        spinner.stop()

        let totalDeleted = 0
        for (const { label, pattern } of patterns) {
          if (phoneHash && !pattern.includes("*")) {
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

  // ─── auth status ─────────────────────────────────────────────────────────
  group
    .command("status [phone_hash]")
    .description("Show current OTP rate-limit and fail counters")
    .action(async (phoneHash: string | undefined) => {
      const spinner = ora("Connecting to Redis…").start()

      try {
        const redis = await getRedis()
        spinner.stop()

        if (phoneHash) {
          await showStatusForHash(redis, phoneHash)
        } else {
          await showStatusAll(redis)
        }
      } catch (err) {
        console.error(chalk.red(`\n  Failed: ${err}\n`))
        process.exit(1)
      } finally {
        await closeRedis()
      }
    })
}
