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
}

/**
 * Consume the full agent async generator and collect the response.
 * This is the non-streaming equivalent of the SSE flow in chat.ts.
 */
export async function collectAgentResponse(
  generator: AsyncGenerator<StreamChunk>,
): Promise<AgentWhatsAppResponse> {
  const textParts: string[] = [];
  const toolsUsed: string[] = [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for await (const chunk of generator) {
    switch (chunk.type) {
      case "text_delta":
        textParts.push(chunk.delta);
        break;
      case "tool_start":
        toolsUsed.push(chunk.toolName);
        break;
      case "done":
        inputTokens = chunk.inputTokens;
        outputTokens = chunk.outputTokens;
        break;
      case "error":
        throw new Error(chunk.message);
    }
  }

  return {
    text: textParts.join(""),
    toolsUsed,
    inputTokens,
    outputTokens,
  };
}
