// handoff_to_human tool
// Publishes a NATS event to request human agent handoff,
// then returns a success response with estimated wait time.

import { publishNatsEvent } from "@ibatexas/nats-client";
import type { HandoffToHumanInput, HandoffToHumanOutput } from "@ibatexas/types";
import { HandoffToHumanInputSchema } from "@ibatexas/types";

export async function handoffToHuman(input: HandoffToHumanInput): Promise<HandoffToHumanOutput> {
  await publishNatsEvent("support.handoff_requested", {
    sessionId: input.sessionId,
    reason: input.reason,
  });

  return {
    success: true,
    estimatedWaitMinutes: 5,
    message: "Um atendente foi notificado e entrará em contato em breve.",
  };
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const HandoffToHumanTool = {
  name: "handoff_to_human",
  description:
    "Transfere o atendimento para um atendente humano via WhatsApp",
  inputSchema: HandoffToHumanInputSchema,
} as const;
