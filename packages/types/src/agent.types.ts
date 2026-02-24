// Agent types — AgentContext, AgentMessage, StreamChunk

import type { Channel } from "./product.types.js"

export interface AgentContext {
  channel: Channel
  sessionId: string
  customerId?: string
  userType: "guest" | "customer" | "staff"
}

export type AgentMessage = {
  role: "user" | "assistant"
  content: string
}

export type StreamChunk =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; toolUseId: string }
  | { type: "tool_result"; toolName: string; toolUseId: string; success: boolean }
  | { type: "done"; inputTokens?: number; outputTokens?: number }
  | { type: "error"; message: string }
