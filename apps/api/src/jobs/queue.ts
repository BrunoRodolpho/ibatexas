// Shared BullMQ connection + queue/worker factory for background jobs.
//
// All 5 jobs use the same Redis connection (REDIS_URL) and this module
// provides a single place to configure connection options, default job
// settings, and graceful shutdown.

import { Queue, Worker, type Job, type ConnectionOptions, type WorkerOptions } from "bullmq";
import * as Sentry from "@sentry/node";
import logger from "../lib/logger.js";

function getConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL env var required for BullMQ");
  return { url };
}

const PREFIX = "ibx"; // BullMQ key prefix to namespace Redis keys

/**
 * Fail closed on a deps bag that is not one.
 *
 * **F-32** in `apps/api/src/__tests__/helpers/redis-double-census.md`. Any
 * future R5 slice that gives a BullMQ processor a deps bag inherits this
 * hazard — it is a property of BullMQ's calling convention, not of any one job.
 *
 * Lives here because the hazard is BullMQ's, not any one job's. `createWorker`
 * types its processor as `(job) => Promise<void>`, but BullMQ CALLS it as
 * `(job, token)` with a lock-token STRING. A processor that also takes an
 * options bag in its second positional slot — the R5 client-seam shape — will
 * therefore receive that token as its `deps` if it is registered BARE.
 *
 * `("tok").redis` is `undefined`, so the failure is SILENT: the module falls
 * back to the singleton and nothing observable changes, right up until someone
 * destructures `deps` or makes a client required. This turns the silent version
 * into a loud one, so the one-argument wrapper each registration site uses is
 * ENFORCED rather than remembered.
 *
 * Note for anyone tempted to pin this with `processor.length`: a parameter with
 * a DEFAULT does not count toward `Function.length`, so `(job, deps = {})` has
 * length 1 and an arity assertion is vacuous. It was written that way first and
 * passed against the bare registration. This guard is the non-vacuous form.
 */
export function assertDepsBag(command: string, deps: unknown): void {
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
    throw new TypeError(
      `[${command}] deps must be an options object, got ${typeof deps} — ` +
        `a BullMQ processor must be registered behind a one-argument wrapper so ` +
        `its lock token cannot land in the deps slot`,
    );
  }
}

/**
 * Create a BullMQ Queue for scheduling repeatable/delayed jobs.
 */
export function createQueue(name: string): Queue {
  return new Queue(name, {
    connection: getConnection(),
    prefix: PREFIX,
    defaultJobOptions: {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });
}

/**
 * Create a BullMQ Worker to process jobs from a queue.
 *
 * By default, concurrency is 1 to preserve the same single-threaded
 * semantics as the old setInterval jobs (no overlap).
 */
export function createWorker(
  name: string,
  processor: (job: Job) => Promise<void>,
  opts?: Partial<WorkerOptions>,
): Worker {
  const worker = new Worker(name, processor, {
    connection: getConnection(),
    prefix: PREFIX,
    concurrency: 1,
    ...opts,
  });

  // A BullMQ Worker is an EventEmitter; an UNHANDLED "error" (emitted on
  // connection-level failures such as a transient Redis hiccup) is rethrown
  // by Node and would be caught by the process-level uncaughtException handler
  // in index.ts, which calls process.exit(1). A background worker losing its
  // Redis connection must NOT take down the HTTP server, so we attach a
  // default handler that logs + reports to Sentry and NEVER rethrows.
  // Callers may add their own additional "error"/"failed" listeners on top.
  worker.on("error", (err) => {
    logger.error({ err, job: name }, "[worker.error] BullMQ worker connection error");
    Sentry.withScope((scope) => {
      scope.setTag("job", name);
      scope.setTag("source", "background-job");
      Sentry.captureException(err);
    });
  });

  return worker;
}

export type { Job };
