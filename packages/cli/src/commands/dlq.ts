// DLQ management commands
//
// ibx dlq list                — show DLQ sizes for all known events
// ibx dlq replay <event>      — re-publish events from DLQ back to NATS
// ibx dlq peek <event>        — show the most recent DLQ entries without consuming
// ibx dlq purge <event>       — delete all entries for an event (destructive)
//
// ── W6-9 (P2-A) — dynamic event discovery ────────────────────────────────
//
// Pre-W6 the `ibx dlq list` command hardcoded 5 event names; new DLQ
// subjects added by audit-consumer (`audit.intent.decision.v1`) and
// defer-resolver (`intent.defer.resume`) — both per Task 19 + Task 03
// follow-up — were invisible to the operator dashboard.
//
// We now SCAN `{prefix}:dlq:*` keys at runtime so every DLQ subject is
// discovered automatically. The hardcoded list survives as a fallback
// hint when SCAN is empty (helpful in dev where no real DLQs exist).

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"

/**
 * Fallback hint list for empty environments. The real source-of-truth
 * is the Redis SCAN below — adding a new subject here is a docs hint,
 * not a security gate. Audit-consumer (`audit.intent.decision.v1`),
 * defer-resolver (`intent.defer.resume`), and the defer-timeout
 * sweeper (`intent.defer.timeout`) are included so an operator running
 * `ibx dlq list` on a fresh-install sees the complete potential set.
 */
const KNOWN_DLQ_EVENT_HINTS = [
  "order.status_changed",
  "order.placed",
  "notification.send",
  "support.handoff_requested",
  "conversation.message.appended",
  "audit.intent.decision.v1",
  "intent.defer.resume",
  "intent.defer.timeout",
  "payment.status_changed",
]

async function getRedisAndRk() {
  const { getRedisClient, rk } = await import("@ibatexas/tools")
  const redis = await getRedisClient()
  return { redis, rk }
}

/**
 * Discover DLQ event names by SCANning `{prefix}:dlq:*` keys in Redis.
 * Returns the event names (the bit AFTER the `dlq:` segment). Falls
 * back to the static hint list when SCAN yields zero keys — useful in
 * dev environments where no DLQs have been populated yet.
 */
async function discoverDlqEvents(
  redis: { scanIterator: (opts: { MATCH: string; COUNT: number }) => AsyncIterable<string> },
  rk: (key: string) => string,
): Promise<string[]> {
  const prefix = rk("dlq:")
  const found = new Set<string>()
  try {
    for await (const key of redis.scanIterator({
      MATCH: `${prefix}*`,
      COUNT: 100,
    })) {
      // The key shape is `{rk-prefix}:dlq:{eventName}` — strip the
      // prefix to recover the eventName.
      const idx = key.indexOf(":dlq:")
      if (idx >= 0) {
        const event = key.slice(idx + ":dlq:".length)
        if (event.length > 0) found.add(event)
      }
    }
  } catch {
    // SCAN unsupported on the client (some adapters expose lower-case
    // `scanIterator` only). Fall through to the hint list.
  }
  return found.size > 0
    ? Array.from(found).sort((a, b) => a.localeCompare(b))
    : KNOWN_DLQ_EVENT_HINTS.slice()
}

/**
 * Replay a single DLQ entry. Parses the raw JSON, strips DLQ metadata,
 * then either prints it (dry run) or re-publishes it to NATS. Returns the
 * tally contribution `{ replayed, failed }` so the caller can accumulate
 * without branching. JSON-parse / publish failures are caught and counted
 * as `failed` (matching the pre-refactor per-entry try/catch).
 */
async function replayDlqEntry(
  raw: string,
  index: number,
  dryRun: boolean,
  event: string,
  publishNatsEvent: (event: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<{ replayed: number; failed: number }> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // Strip DLQ metadata before re-publishing
    const { _failedAt, _error, ...payload } = parsed

    if (dryRun) {
      console.log(chalk.dim(`  [${index + 1}] would replay: ${JSON.stringify(payload).slice(0, 120)}…`))
    } else {
      await publishNatsEvent(event, payload)
    }
    return { replayed: 1, failed: 0 }
  } catch (err) {
    console.error(chalk.red(`  Entry ${index + 1} failed: ${(err as Error).message}`))
    return { replayed: 0, failed: 1 }
  }
}

/**
 * Drain up to `limit` entries from the DLQ list and replay each one.
 * In dry-run mode entries are read by index (newest-relative, non-consuming);
 * otherwise they are RPOP-ed (oldest first, consuming). Stops early when the
 * list is exhausted. Returns the aggregate `{ replayed, failed }` tally.
 */
async function replayDlqEntries(
  redis: {
    lIndex: (key: string, index: number) => Promise<string | null>
    rPop: (key: string) => Promise<string | null>
  },
  key: string,
  event: string,
  limit: number,
  dryRun: boolean,
  publishNatsEvent: (event: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<{ replayed: number; failed: number }> {
  let replayed = 0
  let failed = 0

  for (let i = 0; i < limit; i++) {
    // RPOP consumes from the tail (oldest first)
    const raw = dryRun ? await redis.lIndex(key, -(i + 1)) : await redis.rPop(key)
    if (!raw) break

    const outcome = await replayDlqEntry(raw, i, dryRun, event, publishNatsEvent)
    replayed += outcome.replayed
    failed += outcome.failed
  }

  return { replayed, failed }
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
        // W6-9: dynamic discovery via SCAN — closes audit/06 P2-A
        // "DLQ CLI omits audit.intent.decision.v1 and intent.defer.resume".
        const events = await discoverDlqEvents(
          redis as Parameters<typeof discoverDlqEvents>[0],
          rk,
        )
        let total = 0
        const rows: { event: string; count: number }[] = []

        for (const event of events) {
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
      const count = Number.parseInt(opts.count, 10) || 5
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
            console.log(chalk.gray(`  payload:   ${JSON.stringify(rest, null, 2).replaceAll("\n", "\n             ")}`))
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
      const maxCount = Number.parseInt(opts.count, 10) || 0
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

        const { replayed, failed } = await replayDlqEntries(
          redis,
          key,
          event,
          limit,
          dryRun,
          publishNatsEvent,
        )

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
