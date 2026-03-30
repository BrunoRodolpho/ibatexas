// ibx stripe — Stripe sandbox setup, webhook forwarding, and payment testing.
//
// Wraps the Stripe CLI for local webhook forwarding (like ibx tunnel wraps ngrok)
// and provides Redis idempotency key management (like ibx auth manages OTP keys).

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { execa } from "execa"
import {
  rk,
  getRedis,
  closeRedis,
  flushExactKey,
  flushGlobPattern,
  printFlushSummary,
  scanKeysForPattern,
} from "../lib/redis.js"

const API_PORT = 3001
const WEBHOOK_PATH = "/api/webhooks/stripe"

// ── Status ──────────────────────────────────────────────────────────────────

async function checkStripeCli(): Promise<boolean> {
  try {
    await execa("stripe", ["--version"])
    return true
  } catch {
    return false
  }
}

function validateKey(name: string, value: string | undefined, prefix: string): { ok: boolean; detail: string } {
  if (!value || value.trim() === "") {
    return { ok: false, detail: "not set" }
  }
  if (!value.startsWith(prefix)) {
    return { ok: false, detail: `invalid prefix (expected ${prefix}...)` }
  }
  return { ok: true, detail: `${value.slice(0, prefix.length + 8)}...` }
}

// ── Flush helpers ───────────────────────────────────────────────────────────

function buildFlushPatterns(eventId: string | undefined): { label: string; pattern: string }[] {
  if (eventId) {
    return [{ label: "webhook idempotency", pattern: rk(`webhook:processed:${eventId}`) }]
  }
  return [{ label: "webhook idempotency", pattern: rk("webhook:processed:*") }]
}

// ── Commands ────────────────────────────────────────────────────────────────

export function registerStripeCommands(group: Command): void {
  group.description("Stripe — payments and webhook testing")

  // ─── stripe status ──────────────────────────────────────────────────────
  group
    .command("status")
    .description("Validate Stripe env keys and check CLI installation")
    .action(async () => {
      console.log(chalk.bold("\n  Stripe status\n"))

      const secretKey = validateKey("STRIPE_SECRET_KEY", process.env.STRIPE_SECRET_KEY, "sk_")
      const webhookSecret = validateKey("STRIPE_WEBHOOK_SECRET", process.env.STRIPE_WEBHOOK_SECRET, "whsec_")
      const cliInstalled = await checkStripeCli()

      const icon = (ok: boolean) => ok ? chalk.green("✓") : chalk.red("✗")

      console.log(`  ${icon(secretKey.ok)} STRIPE_SECRET_KEY        ${chalk.gray(secretKey.detail)}`)
      console.log(`  ${icon(webhookSecret.ok)} STRIPE_WEBHOOK_SECRET   ${chalk.gray(webhookSecret.detail)}`)
      console.log(`  ${icon(cliInstalled)} Stripe CLI               ${chalk.gray(cliInstalled ? "installed" : "not found — brew install stripe/stripe-cli/stripe")}`)

      // Check for test vs live mode
      const key = process.env.STRIPE_SECRET_KEY
      if (key && key.startsWith("sk_test_")) {
        console.log(`\n  ${chalk.yellow("⚠")} Using ${chalk.yellow("test")} mode keys (sandbox)`)
      } else if (key && key.startsWith("sk_live_")) {
        console.log(`\n  ${chalk.red("⚠")} Using ${chalk.red("live")} mode keys — be careful!`)
      }

      // Redis idempotency key count
      try {
        const redis = await getRedis()
        const keys = await scanKeysForPattern(redis, rk("webhook:processed:*"))
        console.log(`\n  ${chalk.gray(`Webhook idempotency keys in Redis: ${keys.length}`)}`)
        await closeRedis()
      } catch {
        // Redis not available — skip silently
      }

      console.log()

      if (!secretKey.ok || !webhookSecret.ok || !cliInstalled) {
        process.exit(1)
      }
    })

  // ─── stripe listen ──────────────────────────────────────────────────────
  group
    .command("listen")
    .description("Forward Stripe webhooks to local API (port 3001)")
    .option("-p, --port <port>", "API port", String(API_PORT))
    .action(async (opts: { port: string }) => {
      const port = Number.parseInt(opts.port, 10)
      const forwardUrl = `localhost:${port}${WEBHOOK_PATH}`

      console.log(chalk.cyan(`\n  Starting Stripe webhook forwarding to ${forwardUrl}...\n`))

      const stripe = execa("stripe", ["listen", "--forward-to", forwardUrl], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
      })

      // Pipe output to console
      stripe.stdout?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim()
        if (line) console.log(`  ${line}`)
      })

      stripe.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim()
        if (line) console.log(`  ${chalk.gray(line)}`)
      })

      // Handle stripe CLI not found
      stripe.catch((err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          console.error(chalk.red("\n  Stripe CLI not found.\n"))
          console.error(chalk.yellow("  To install:\n"))
          console.error(chalk.cyan("    brew install stripe/stripe-cli/stripe"))
          console.error(chalk.cyan("    stripe login\n"))
          process.exit(1)
        }
      })

      console.log(chalk.gray("  Tip: Copy the whsec_... signing secret to .env as STRIPE_WEBHOOK_SECRET"))
      console.log(chalk.gray("  Press Ctrl+C to stop.\n"))

      process.on("SIGINT", () => {
        stripe.kill()
        console.log(chalk.gray("\n  Webhook forwarding stopped.\n"))
        process.exit(0)
      })

      try {
        await stripe
      } catch {
        // Normal exit on kill
      }
    })

  // ─── stripe trigger ─────────────────────────────────────────────────────
  group
    .command("trigger [event]")
    .description("Fire a test webhook event (default: payment_intent.succeeded)")
    .action(async (event?: string) => {
      const eventType = event ?? "payment_intent.succeeded"

      console.log(chalk.cyan(`\n  Triggering ${chalk.bold(eventType)}...\n`))

      try {
        await execa("stripe", ["trigger", eventType], { stdio: "inherit" })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          console.error(chalk.red("\n  Stripe CLI not found. Install with: brew install stripe/stripe-cli/stripe\n"))
          process.exit(1)
        }
        process.exit(1)
      }
    })

  // ─── stripe flush ───────────────────────────────────────────────────────
  group
    .command("flush [event_id]")
    .description("Clear webhook idempotency keys from Redis (all or by event ID)")
    .option("--dry-run", "Show what would be deleted without deleting")
    .action(async (eventId: string | undefined, opts: { dryRun?: boolean }) => {
      const spinner = ora("Connecting to Redis…").start()

      try {
        const redis = await getRedis()
        const patterns = buildFlushPatterns(eventId)
        spinner.stop()

        let totalDeleted = 0
        for (const { label, pattern } of patterns) {
          if (eventId && !pattern.includes("*")) {
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
}
