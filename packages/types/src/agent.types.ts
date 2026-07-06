// Agent types — AgentContext, AgentMessage, StreamChunk, NonRetryableError

import type { RenderedReply } from "@adjudicate/core"
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
  hints?: string[]
}

export type AgentMessage = {
  role: "user" | "assistant" | "system"
  content: string
}

export type StreamChunk =
  // EGRESS BRAND (Plan 1 / Theorem E-1): the customer-prose-bearing variant
  // carries a runtime-non-forgeable `RenderedReply` minted by the closed set in
  // `@adjudicate/core`. Control/status frames below stay plain strings — they
  // are not model-authored customer sentences. The string is extracted only at
  // the SSE serialization boundary via `unwrapRendered` (see streaming/emitter).
  | { type: "text_delta"; delta: RenderedReply }
  | { type: "tool_start"; toolName: string; toolUseId: string }
  | { type: "tool_result"; toolName: string; toolUseId: string; success: boolean }
  | { type: "pix_data"; pixCopyPaste?: string; pixQrCode?: string; pixExpiresAt?: string; orderId?: string }
  | { type: "done"; inputTokens?: number; outputTokens?: number }
  | { type: "error"; message: string }
  | { type: "status"; message: string }
  | { type: "kernel_done"; stateValue: string; context: Record<string, unknown> }
