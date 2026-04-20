// DLQ management commands
//
// ibx dlq list                — show DLQ sizes for all known events
// ibx dlq replay <event>      — re-publish events from DLQ back to NATS
// ibx dlq peek <event>        — show the most recent DLQ entries without consuming
// ibx dlq purge <event>       — delete all entries for an event (destructive)

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"

const DLQ_EVENTS = [
  "order.status_changed",
  "order.placed",
  "notification.send",
  "support.handoff_requested",
  "conversation.message.appended",
]

async function getRedisAndRk() {
  const { getRedisClient, rk } = await import("@ibatexas/tools")
  const redis = await getRedisClient()
  return { redis, rk }
}

export function registerDlqCommands(group: Command): void {
  group.description("Dead Letter Queue — inspect, replay, and purge failed events")

  // ── dlq list ──────────────────────────────────────────────────────────────
  group
    .command("list")
    .description("Show DLQ sizes for all known events")
    .action(async () => {
      const spinner = ora("Scanning DLQ keys…").start()
      try {
        const { redis, rk } = await getRedisAndRk()
        let total = 0
        const rows: { event: string; count: number }[] = []

        for (const event of DLQ_EVENTS) {
          const len = await redis.lLen(rk(`dlq:${event}`))
          if (len > 0) {
            rows.push({ event, count: len })
            total += len
          }
        }

        spinner.stop()

        if (total === 0) {
          console.log(chalk.green("✓ All DLQs empty"))
          return
        }

        console.log(chalk.yellow(`${total} total DLQ entries:\n`))
        for (const row of rows) {
          console.log(`  ${chalk.bold(row.event.padEnd(36))} ${chalk.red(String(row.count))}`)
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })

  // ── dlq peek <event> ──────────────────────────────────────────────────────
  group
    .command("peek <event>")
    .description("Show the most recent DLQ entries without consuming them")
    .option("-n, --count <n>", "Number of entries to show", "5")
    .action(async (event: string, opts: { count: string }) => {
      const count = parseInt(opts.count, 10) || 5
      const spinner = ora(`Reading DLQ for ${event}…`).start()
      try {
        const { redis, rk } = await getRedisAndRk()
        const key = rk(`dlq:${event}`)
        const entries = await redis.lRange(key, 0, count - 1)
        spinner.stop()

        if (entries.length === 0) {
          console.log(chalk.green(`✓ DLQ for ${event} is empty`))
          return
        }

        console.log(chalk.bold(`${entries.length} entries from dlq:${event}:\n`))
        for (const entry of entries) {
          try {
            const parsed = JSON.parse(entry)
            console.log(chalk.dim("─".repeat(60)))
            console.log(chalk.yellow(`  _failedAt: ${parsed._failedAt ?? "unknown"}`))
            console.log(chalk.red(`  _error:    ${parsed._error ?? "unknown"}`))
            const { _failedAt, _error, ...rest } = parsed
            console.log(chalk.gray(`  payload:   ${JSON.stringify(rest, null, 2).split("\n").join("\n             ")}`))
          } catch {
            console.log(chalk.gray(`  (raw) ${entry}`))
          }
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })

  // ── dlq replay <event> ────────────────────────────────────────────────────
  group
    .command("replay <event>")
    .description("Re-publish events from DLQ back to NATS")
    .option("-n, --count <n>", "Max entries to replay (default: all)", "0")
    .option("--dry-run", "Print entries without republishing")
    .action(async (event: string, opts: { count: string; dryRun?: boolean }) => {
      const maxCount = parseInt(opts.count, 10) || 0
      const dryRun = opts.dryRun ?? false
      const spinner = ora(`${dryRun ? "[DRY RUN] " : ""}Reading DLQ for ${event}…`).start()

      try {
        const { redis, rk } = await getRedisAndRk()
        const { publishNatsEvent } = await import("@ibatexas/nats-client")
        const key = rk(`dlq:${event}`)
        const total = await redis.lLen(key)

        if (total === 0) {
          spinner.succeed(chalk.green(`DLQ for ${event} is empty — nothing to replay`))
          return
        }

        const limit = maxCount > 0 ? Math.min(maxCount, total) : total
        spinner.text = `${dryRun ? "[DRY RUN] " : ""}Replaying ${limit} of ${total} entries…`

        let replayed = 0
        let failed = 0

        for (let i = 0; i < limit; i++) {
          // RPOP consumes from the tail (oldest first)
          const raw = dryRun ? await redis.lIndex(key, -(i + 1)) : await redis.rPop(key)
          if (!raw) break

          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>
            // Strip DLQ metadata before re-publishing
            const { _failedAt, _error, ...payload } = parsed

            if (dryRun) {
              console.log(chalk.dim(`  [${i + 1}] would replay: ${JSON.stringify(payload).slice(0, 120)}…`))
            } else {
              await publishNatsEvent(event, payload)
            }
            replayed++
          } catch (err) {
            failed++
            console.error(chalk.red(`  Entry ${i + 1} failed: ${(err as Error).message}`))
          }
        }

        if (dryRun) {
          spinner.succeed(chalk.blue(`[DRY RUN] Would replay ${replayed} entries from ${event}`))
        } else {
          const msg = failed > 0
            ? chalk.yellow(`Replayed ${replayed}, failed ${failed} from ${event}`)
            : chalk.green(`Replayed ${replayed} entries from ${event}`)
          spinner.succeed(msg)
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      }
    })

  // ── dlq purge <event> ─────────────────────────────────────────────────────
  group
    .command("purge <event>")
    .description("Delete all DLQ entries for an event (destructive)")
    .action(async (event: string) => {
      const { confirm } = await import("@inquirer/prompts")
      const { redis, rk } = await getRedisAndRk()
      const key = rk(`dlq:${event}`)
      const len = await redis.lLen(key)

      if (len === 0) {
        console.log(chalk.green(`✓ DLQ for ${event} is already empty`))
        return
      }

      const yes = await confirm({
        message: `Delete ${len} entries from dlq:${event}?`,
        default: false,
      })

      if (!yes) {
        console.log(chalk.gray("Aborted."))
        return
      }

      await redis.del(key)
      console.log(chalk.green(`✓ Purged ${len} entries from dlq:${event}`))
    })
}
