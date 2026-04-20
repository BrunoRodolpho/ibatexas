// Hesitation nudge — sends a reinforcement message to new customers
// who haven't replied within ~45s of receiving the first contact message.
//
// Flow:
// 1. whatsapp-webhook schedules a delayed BullMQ job (45s) after first_contact
// 2. When job fires, check if customer has replied (Redis key cleared)
// 3. If no reply → send nudge mentioning R$15 credit
// 4. If replied → skip (no-op)

import { getRedisClient, rk } from "@ibatexas/tools";
import type { Queue, Worker } from "bullmq";
import { sendText } from "../whatsapp/client.js";
import { createQueue, createWorker, type Job } from "./queue.js";

const NUDGE_DELAY_MS = Number.parseInt(
  process.env.HESITATION_NUDGE_DELAY_MS || "45000",
  10,
);

export interface NudgeJobData {
  phone: string;
  phoneHash: string;
  customerId: string;
}

export function buildHesitationNudgeMessage(): string {
  return "A propósito, no primeiro pedido você tem R$15 de crédito. Dá pra incluir um acompanhamento de graça praticamente — quer ver?";
}

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  queue ??= createQueue("hesitation-nudge");
  return queue;
}

/** BullMQ processor — checks if customer replied, sends nudge if not. */
async function processNudge(job: Job<NudgeJobData>): Promise<void> {
  const { phone, phoneHash } = job.data;
  const redis = await getRedisClient();

  // Check if customer replied (webhook handler sets this key on any reply)
  const repliedKey = rk(`wa:nudge:replied:${phoneHash}`);
  const replied = await redis.get(repliedKey);
  if (replied) {
    // Customer already replied — skip nudge
    await redis.del(repliedKey);
    return;
  }

  await sendText(`whatsapp:${phone}`, buildHesitationNudgeMessage());
}

/** Schedule a nudge for a new customer (called from whatsapp-webhook). */
export async function scheduleHesitationNudge(
  data: NudgeJobData,
): Promise<void> {
  const q = getQueue();
  await q.add("nudge", data, {
    delay: NUDGE_DELAY_MS,
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/** Mark that customer replied (cancels pending nudge). */
export async function markCustomerReplied(phoneHash: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.set(rk(`wa:nudge:replied:${phoneHash}`), "1", { EX: 120 });
}

export function startHesitationNudgeWorker(): void {
  if (worker) return;
  worker = createWorker("hesitation-nudge", processNudge);
}

export async function stopHesitationNudgeWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
