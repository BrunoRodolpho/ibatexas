// ibx auth — OTP/auth debugging utilities + Medusa admin user management.
// Flush rate-limit and brute-force keys so you can retry during development.

import path from "node:path"
import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { execa } from "execa"
import { ROOT } from "../utils/root.js"
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

// ── Flush helpers ───────────────────────────────────────────────────────────

interface FlushPattern {
  label: string
  pattern: string
}

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

// ── Status helpers ──────────────────────────────────────────────────────────

async function showStatusForHash(redis: RedisClient, phoneHash: string): Promise<void> {
  const rateKey = rk(`otp:rate:${phoneHash}`)
  const failKey = rk(`otp:fail:${phoneHash}`)

  const rateCount = await redis.get(rateKey)
  const failCount = await redis.get(failKey)
  const rateTtl = await redis.ttl(rateKey)
  const failTtl = await redis.ttl(failKey)

  console.log(chalk.bold(`\n  OTP status for ${chalk.cyan(phoneHash)}\n`))
  const rateReset = rateTtl > 0 ? chalk.gray(` (resets in ${rateTtl}s)`) : ""
  const failReset = failTtl > 0 ? chalk.gray(` (resets in ${failTtl}s)`) : ""
  console.log(`  Send attempts:   ${rateCount ?? "0"}/3${rateReset}`)
  console.log(`  Failed verifies: ${failCount ?? "0"}/5${failReset}`)
  console.log()
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
  const rateTtlSuffix = rateTtl > 0 ? ` (${rateTtl}s)` : ""
  const failTtlSuffix = failTtl > 0 ? ` (${failTtl}s)` : ""
  if (rateCount) parts.push(`sends: ${rateCount}/3${rateTtlSuffix}`)
  if (failCount) parts.push(`fails: ${failCount}/5${failTtlSuffix}`)

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
  group.description("Auth — OTP rate-limit, brute-force keys, and admin user management")

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

  // ─── auth create-staff ──────────────────────────────────────────────────
  group
    .command("create-staff")
    .description("Register a staff member for admin panel login")
    .requiredOption("--phone <phone>", "Phone in E.164 format (e.g. +5511999999999 or +15125551234)")
    .requiredOption("--name <name>", "Staff member name")
    .option("--role <role>", "OWNER | MANAGER | ATTENDANT", "OWNER")
    .action(async (opts: { phone: string; name: string; role: string }) => {
      const { phone, name, role } = opts
      const validRoles = ["OWNER", "MANAGER", "ATTENDANT"]

      if (!phone.startsWith("+") || phone.replace(/\D/g, "").length < 10) {
        console.error(chalk.red("\n  Invalid phone. Use E.164 format: +5511999999999 or +15125551234\n"))
        process.exit(1)
      }

      const upperRole = role.toUpperCase()
      if (!validRoles.includes(upperRole)) {
        console.error(chalk.red(`\n  Invalid role: ${role}. Must be one of: ${validRoles.join(", ")}\n`))
        process.exit(1)
      }

      const spinner = ora({ text: `Creating staff: ${name} (${phone})`, indent: 2 }).start()

      try {
        const { prisma } = await import("@ibatexas/domain")

        const existing = await prisma.staff.findUnique({ where: { phone } })
        if (existing) {
          spinner.warn(chalk.yellow(`Staff already exists: ${existing.name} (${existing.role})`))
          if (!existing.active) {
            await prisma.staff.update({ where: { phone }, data: { active: true } })
            console.log(chalk.green("  Reactivated.\n"))
          } else {
            console.log(chalk.gray("  No changes needed.\n"))
          }
          return
        }

        await prisma.staff.create({
          data: { phone, name, role: upperRole as "OWNER" | "MANAGER" | "ATTENDANT" },
        })

        spinner.succeed(chalk.green(`Staff created: ${name} (${upperRole})`))
        console.log(chalk.gray(`\n  Phone: ${phone}`))
        console.log(chalk.gray(`  They can now log in at http://localhost:3002/admin\n`))
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${err}`))
        process.exit(1)
      }
    })

  // ─── auth create-admin ──────────────────────────────────────────────────
  group
    .command("create-admin")
    .description("Create a Medusa admin user (from .env or --email/--password)")
    .option("--email <email>", "Admin email (overrides MEDUSA_ADMIN_EMAIL)")
    .option("--password <password>", "Admin password (overrides MEDUSA_ADMIN_PASSWORD)")
    .action(async (opts: { email?: string; password?: string }) => {
      const email = opts.email ?? process.env.MEDUSA_ADMIN_EMAIL
      const password = opts.password ?? process.env.MEDUSA_ADMIN_PASSWORD

      if (!email || !password) {
        console.error(chalk.red("\n  Missing credentials.\n"))
        console.error(chalk.gray("  Set MEDUSA_ADMIN_EMAIL and MEDUSA_ADMIN_PASSWORD in .env"))
        console.error(chalk.gray("  Or pass --email and --password flags.\n"))
        process.exit(1)
      }

      const spinner = ora({ text: `Creating admin user: ${email}`, indent: 2 }).start()

      try {
        await execa(
          "npx",
          ["medusa", "user", "--email", email, "--password", password],
          { cwd: path.join(ROOT, "apps/commerce") },
        )
        spinner.succeed(chalk.green(`Admin user created (${email})`))
        console.log(chalk.gray(`\n  Login at http://localhost:9000/app\n`))
      } catch {
        spinner.warn(chalk.yellow(`Admin user may already exist (${email})`))
        console.log(chalk.gray(`\n  Try logging in at http://localhost:9000/app\n`))
      }
    })
}
