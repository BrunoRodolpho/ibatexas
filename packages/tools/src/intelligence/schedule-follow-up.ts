// schedule_follow_up tool
// Schedules a follow-up reminder for a customer by adding an entry to the
// Redis sorted set `follow-up:scheduled` with the fire timestamp as score.
// The follow-up poller reads this set every 15 minutes and publishes follow-up.due events.

import type { AgentContext } from "@ibatexas/types";
import { getRedisClient, type RedisClientType } from "../redis/client.js";
import { rk } from "../redis/key.js";

// ── The Redis client seam (F-35) ─────────────────────────────────────────────

/**
 * The Redis-shaped client this module schedules through.
 *
 * FAIL-CLOSED PICK ANALYSIS (the program's rule — issued ∪ optionally-consumed
 * ∪ handed-to), measured by reading every line of this file:
 *   • ISSUED here: `zAdd`, once. That single call is this module's ENTIRE Redis
 *     surface; there is no read, no TTL, no cleanup path.
 *   • HANDED TO downstream: nothing. The client is never passed to a callee, so
 *     no helper can issue a command this Pick does not name. In particular
 *     nothing here reaches an eval-class helper (`atomicIncr` and friends), so
 *     this file is NOT Lua-gated and the in-memory adapter can serve it whole.
 *   • FEATURE DETECTION: none — no `typeof client.X === "function"` probe, which
 *     is what makes a throw-on-access Proxy client safe here (F-22).
 * So {issued} ∪ {handed-to} = `{"zAdd"}`.
 *
 * Typed as `Pick<RedisClientType, …>` on purpose: the call site keeps node-redis'
 * exact argument types, so a mis-shaped `{score, value}` member still fails
 * `tsc`. A test double casts to this type at its own boundary (see
 * `src/testing/in-memory-redis.ts`) rather than this module loosening its types.
 */
export type FollowUpScheduleClient = Pick<RedisClientType, "zAdd">;

/**
 * Options accepted by {@link scheduleFollowUp}.
 *
 * This seam exists because the CONSUMER of the zset written below —
 * `apps/api/src/jobs/follow-up-poller.ts`' `processFollowUps` — lives in another
 * workspace, and until this bag existed nothing could drive both ends of the
 * queue against one keyspace. The producer resolved its client through the
 * RELATIVE import above, which an apps/api `vi.mock("@ibatexas/tools")` (a mock
 * of the package SPECIFIER) cannot reach, so producer/consumer KEY AGREEMENT
 * rode on two independent assertions of the same literal instead of a driven
 * path. See `apps/api/src/__tests__/jobs/follow-up-producer-consumer-parity.test.ts`.
 */
export interface ScheduleFollowUpOptions {
  /**
   * Redis-shaped client the follow-up queue is written through. Defaults to the
   * package singleton (`getRedisClient()`), resolved lazily at the SAME point in
   * the function it always was — AFTER the auth guard, immediately before the
   * write. Deliberately NOT hoisted to the top of the function: hoisting would
   * resolve a client on the unauthenticated arm, which reaches Redis never,
   * turning a Redis outage into a throw on a path that today answers fine.
   */
  readonly client?: FollowUpScheduleClient;
}

export interface ScheduleFollowUpInput {
  delayHours: number;
  reason: string;
}

export async function scheduleFollowUp(
  input: ScheduleFollowUpInput,
  ctx: AgentContext,
  options?: ScheduleFollowUpOptions,
): Promise<{ success: boolean; message: string }> {
  if (!ctx.customerId) {
    return { success: false, message: "Autenticação necessária para agendar lembrete." };
  }

  const hours = Math.min(72, Math.max(1, input.delayHours));
  const score = Date.now() + hours * 3_600_000;
  const value = JSON.stringify({
    customerId: ctx.customerId,
    reason: input.reason,
    scheduledAt: new Date(score).toISOString(),
  });

  const redis: FollowUpScheduleClient = options?.client ?? (await getRedisClient());
  await redis.zAdd(rk("follow-up:scheduled"), { score, value });

  return { success: true, message: `Lembrete agendado para ${hours}h.` };
}

export const ScheduleFollowUpTool = {
  name: "schedule_follow_up",
  description: "Agenda um lembrete para entrar em contato com o cliente depois. Use quando o cliente diz 'vou pensar' ou similar.",
  inputSchema: {
    type: "object",
    properties: {
      delayHours: { type: "number", description: "Horas até o lembrete (min 1, max 72)", minimum: 1, maximum: 72 },
      reason: { type: "string", description: "Motivo: 'thinking', 'cart_save', 'price_concern'" },
    },
    required: ["delayHours", "reason"],
  },
} as const;
