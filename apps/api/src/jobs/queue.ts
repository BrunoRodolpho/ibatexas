// Shared BullMQ connection + queue/worker factory for background jobs.
//
// All 5 jobs use the same Redis connection (REDIS_URL) and this module
// provides a single place to configure connection options, default job
// settings, and graceful shutdown.

import { Queue, Worker, type Job, type ConnectionOptions, type WorkerOptions } from "bullmq";

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
  return new Worker(name, processor, {
    connection: getConnection(),
    prefix: PREFIX,
    concurrency: 1,
    ...opts,
  });
}

export type { Job };
