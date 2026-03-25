// Agent types — AgentContext, AgentMessage, StreamChunk, NonRetryableError

import type { Channel, UserType } from "./product.types.js"

/**
 * Throw this from a tool handler to skip retry and return the error to Claude immediately.
 * Use for auth failures and business-rule violations that will not resolve on retry.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NonRetryableError"
  }
}

export interface AgentContext {
  channel: Channel
  sessionId: string
  customerId?: string
  userType: UserType
  lastLocation?: { lat: number; lng: number }
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
