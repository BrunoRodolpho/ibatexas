// Agent types — AgentContext, AgentMessage, StreamChunk

import type { Channel, UserType } from "./product.types.js"

export interface AgentContext {
  channel: Channel
  sessionId: string
  customerId?: string
  userType: UserType
}

export type AgentMessage = {
  role: "user" | "assistant" | "system"
  content: string
}

export type StreamChunk =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; toolUseId: string }
  | { type: "tool_result"; toolName: string; toolUseId: string; success: boolean }
  | { type: "done"; inputTokens?: number; outputTokens?: number }
  | { type: "error"; message: string }
