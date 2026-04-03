// schedule_follow_up tool
// Schedules a follow-up reminder for a customer by adding an entry to the
// Redis sorted set `follow-up:scheduled` with the fire timestamp as score.
// The follow-up poller reads this set every 15 minutes and publishes follow-up.due events.

import type { AgentContext } from "@ibatexas/types";
import { getRedisClient } from "../redis/client.js";
import { rk } from "../redis/key.js";

export interface ScheduleFollowUpInput {
  delayHours: number;
  reason: string;
}

export async function scheduleFollowUp(
  input: ScheduleFollowUpInput,
  ctx: AgentContext,
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

  const redis = await getRedisClient();
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
