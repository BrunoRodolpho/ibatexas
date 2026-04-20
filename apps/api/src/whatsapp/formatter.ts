// Agent response formatter for WhatsApp.
//
// Collects all text_delta chunks from the agent into a full response,
// then provides metadata for logging and analytics.

import type { StreamChunk } from "@ibatexas/types";

export interface AgentWhatsAppResponse {
  text: string;
  toolsUsed: string[];
  inputTokens?: number;
  outputTokens?: number;
  pixData?: { pixCopyPaste?: string; pixQrCode?: string; pixExpiresAt?: string; orderId?: string };
  statusMessages?: string[];
}

// ── Emoji enforcement ─────────────────────────────────────────────────────────

// Unicode emoji regex — covers common emoji ranges (emoticons, symbols, flags)
// eslint-disable-next-line no-misleading-character-class -- intentional combined Unicode ranges for emoji matching
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

/**
 * Enforce max 1 emoji per message for WhatsApp.
 * Keeps the FIRST emoji found and strips all subsequent ones.
 * Cleans up any resulting double-spaces.
 */
function limitEmojis(text: string, max = 1): string {
  let count = 0;
  return text
    .replace(EMOJI_RE, (match) => {
      count++;
      return count <= max ? match : "";
    })
    .replace(/ {2,}/g, " ");
}

// Timeout for agent response collection
const COLLECT_TIMEOUT_MS = 60_000;

/**
 * Consume the full agent async generator and collect the response.
 * This is the non-streaming equivalent of the SSE flow in chat.ts.
 *
 * Enforces a 60-second timeout so a hung LLM provider cannot block processing
 * indefinitely (the agent lock heartbeat would keep the lock alive).
 */
export async function collectAgentResponse(
  generator: AsyncGenerator<StreamChunk>,
  timeoutMs: number = COLLECT_TIMEOUT_MS,
): Promise<AgentWhatsAppResponse> {
  const textParts: string[] = [];
  const toolsUsed: string[] = [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let pixData: AgentWhatsAppResponse["pixData"];
  let statusMessages: string[] | undefined;

  // AbortSignal-based timeout guard: break out after 60s if the LLM provider hangs
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    for await (const chunk of generator) {
      if (ac.signal.aborted) {
        throw new Error("Tempo limite atingido ao aguardar resposta do agente");
      }
      switch (chunk.type) {
        case "text_delta":
          textParts.push(chunk.delta);
          break;
        case "tool_start":
          toolsUsed.push(chunk.toolName);
          break;
        case "pix_data":
          pixData = {
            pixCopyPaste: chunk.pixCopyPaste,
            pixQrCode: chunk.pixQrCode,
            pixExpiresAt: chunk.pixExpiresAt,
            orderId: chunk.orderId,
          };
          break;
        case "done":
          inputTokens = chunk.inputTokens;
          outputTokens = chunk.outputTokens;
          break;
        case "status":
          statusMessages ??= [];
          statusMessages.push(chunk.message);
          break;
        case "error":
          throw new Error(chunk.message);
      }
    }
  } finally {
    clearTimeout(timer);
  }

  // If we exited the loop because of abort but no chunk triggered the check,
  // still throw to surface the timeout.
  if (ac.signal.aborted && textParts.length === 0) {
    throw new Error("Tempo limite atingido ao aguardar resposta do agente");
  }

  return {
    text: limitEmojis(textParts.join("")),
    toolsUsed,
    inputTokens,
    outputTokens,
    pixData,
    statusMessages,
  };
}
