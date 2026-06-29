// BullMQ job management — inspect and replay failed background jobs.
//
// ibx jobs list [queue]            — list failed jobs (default queue: stripe-webhook)
// ibx jobs inspect <queue> <id>    — show a failed job's event payload + failure reason
// ibx jobs replay <queue> [id]     — retry one failed job, or --all of them (--dry-run)
//
// WHY: the stripe-webhook queue retains failed jobs (removeOnFail:{count:500}), so a
// paid PIX order whose finalization failed — e.g. the Medusa `expand`→`fields` 400 that
// stranded IBX-0002 — can be REPLAYED once the fix is deployed and the api restarted.
// `job.retry()` just moves the job back to `waiting`; the api worker (which must be
// running the fixed code) reprocesses it. Watch it land with:
//   ibx logs --component job:stripe-webhook -f
//
// Connection MUST match apps/api/src/jobs/queue.ts: REDIS_URL + BullMQ prefix "ibx".

import type { Command } from "commander"
import type { Queue, Job } from "bullmq"
import chalk from "chalk"
import ora from "ora"

const DEFAULT_QUEUE = "stripe-webhook"
const BULLMQ_PREFIX = "ibx" // must equal PREFIX in apps/api/src/jobs/queue.ts

/** Shape of the stripe-webhook job payload (best-effort — other queues differ). */
interface StripeJobData {
  event?: { id?: string; type?: string }
}

async function openQueue(name: string): Promise<Queue> {
  const { Queue } = await import("bullmq")
  const url = process.env.REDIS_URL
  if (!url) throw new Error("REDIS_URL env var required (the same one the api uses)")
  return new Queue(name, { connection: { url }, prefix: BULLMQ_PREFIX })
}

function firstLine(reason?: string, max = 90): string {
  if (!reason) return ""
  const line = reason.split("\n")[0]
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function describe(job: Job): { id: string; type: string; eventId: string } {
  const data = job.data as StripeJobData
  return {
    id: job.id ?? "?",
    type: data?.event?.type ?? job.name,
    eventId: data?.event?.id ?? job.id ?? "?",
  }
}

/** Replay a single job. Returns true only when the job was actually retried. */
async function replayJob(job: Job, dry: boolean): Promise<boolean> {
  const { id, type } = describe(job)
  if (dry) {
    console.log(chalk.dim(`  would replay ${id} (${type}, attempts ${job.attemptsMade})`))
    return false
  }
  // Only failed jobs can be retried; skip anything mid-flight.
  const state = await job.getState()
  if (state !== "failed") {
    console.log(chalk.yellow(`  skip ${id} — state is ${state}, not failed`))
    return false
  }
  await job.retry() // failed → waiting; the api worker reprocesses it
  console.log(chalk.green(`  ✓ replayed ${id} (${type})`))
  return true
}

export function registerJobsCommands(group: Command): void {
  group.description("Background jobs — inspect and replay failed BullMQ jobs")

  // ── jobs list [queue] ───────────────────────────────────────────────────────
  group
    .command("list [queue]")
    .description(`List failed jobs in a queue (default: ${DEFAULT_QUEUE})`)
    .option("-n, --count <n>", "Max jobs to show", "50")
    .action(async (queue: string | undefined, opts: { count: string }) => {
      const name = queue ?? DEFAULT_QUEUE
      const limit = Number.parseInt(opts.count, 10) || 50
      const spinner = ora(`Reading failed jobs in ${name}…`).start()
      let q: Queue | undefined
      try {
        q = await openQueue(name)
        const counts = await q.getJobCounts("failed", "active", "waiting", "delayed")
        const failed = await q.getFailed(0, limit - 1)
        spinner.stop()

        if (failed.length === 0) {
          console.log(chalk.green(`✓ No failed jobs in ${name}`))
          console.log(chalk.dim(`  active ${counts.active} · waiting ${counts.waiting} · delayed ${counts.delayed}`))
          return
        }

        console.log(chalk.yellow(`${counts.failed} failed job(s) in ${name}:\n`))
        for (const job of failed) {
          const { id, type, eventId } = describe(job)
          console.log(`  ${chalk.bold(id.padEnd(30))} ${chalk.cyan((type ?? "").padEnd(28))} ${chalk.dim("attempts")} ${chalk.red(String(job.attemptsMade))}`)
          console.log(`    ${chalk.dim(eventId)}  ${chalk.gray(firstLine(job.failedReason))}`)
        }
        console.log(chalk.dim(`\nReplay one:  ibx jobs replay ${name} <id>   ·   all:  ibx jobs replay ${name} --all`))
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        if (q) await q.close()
      }
    })

  // ── jobs inspect <queue> <jobId> ──────────────────────────────────────────────
  group
    .command("inspect <queue> <jobId>")
    .description("Show a failed job's event payload + full failure reason")
    .action(async (queue: string, jobId: string) => {
      const spinner = ora(`Loading ${jobId}…`).start()
      let q: Queue | undefined
      try {
        q = await openQueue(queue)
        const job = await q.getJob(jobId)
        spinner.stop()
        if (!job) {
          console.log(chalk.yellow(`Job ${jobId} not found in ${queue}`))
          process.exitCode = 1
          return
        }
        const state = await job.getState()
        const { id, type, eventId } = describe(job)
        const jobHeader = chalk.bold(`Job ${id}`)
        const stateLabel = chalk.dim(`(${state})`)
        console.log(`${jobHeader} ${stateLabel}`)
        console.log(`  name          ${job.name}`)
        console.log(`  event.type    ${type}`)
        console.log(`  event.id      ${eventId}`)
        console.log(`  attemptsMade  ${chalk.red(String(job.attemptsMade))}`)
        if (job.failedReason) {
          console.log(chalk.red(`  failedReason:`))
          console.log(chalk.gray(`    ${job.failedReason.replaceAll("\n", "\n    ")}`))
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        if (q) await q.close()
      }
    })

  // ── jobs replay <queue> [jobId] ───────────────────────────────────────────────
  group
    .command("replay <queue> [jobId]")
    .description("Retry a failed job (or --all failed jobs in the queue)")
    .option("--all", "Replay every failed job in the queue")
    .option("--dry-run", "List what would be replayed without retrying")
    .action(async (queue: string, jobId: string | undefined, opts: { all?: boolean; dryRun?: boolean }) => {
      if (!jobId && !opts.all) {
        console.error(chalk.red("Provide a <jobId> or pass --all"))
        process.exitCode = 1
        return
      }
      const dry = opts.dryRun ?? false
      const spinner = ora(`${dry ? "[DRY RUN] " : ""}Reading failed jobs in ${queue}…`).start()
      let q: Queue | undefined
      try {
        q = await openQueue(queue)
        const targets = (jobId ? [await q.getJob(jobId)] : await q.getFailed(0, 999)).filter(
          (j): j is Job => Boolean(j),
        )
        spinner.stop()

        if (targets.length === 0) {
          console.log(chalk.green(jobId ? `Job ${jobId} not found in ${queue}` : `✓ No failed jobs in ${queue}`))
          return
        }

        let replayed = 0
        for (const job of targets) {
          if (await replayJob(job, dry)) replayed++
        }

        if (dry) {
          console.log(chalk.blue(`[DRY RUN] ${targets.length} job(s) would be replayed`))
        } else {
          console.log(
            chalk.green(`\nReplayed ${replayed} job(s).`) +
              chalk.dim(` The api worker will process them — watch:  ibx logs --component job:stripe-webhook -f`),
          )
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed: ${(err as Error).message}`))
        process.exitCode = 1
      } finally {
        if (q) await q.close()
      }
    })
}
