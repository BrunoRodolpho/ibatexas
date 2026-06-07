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
