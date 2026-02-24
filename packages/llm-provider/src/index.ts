// @ibatexas/llm-provider
// Core agent loop and streaming utilities.

export { runAgent } from "./agent.js"
export { SYSTEM_PROMPT } from "./system-prompt.js"
export { TOOL_DEFINITIONS, executeTool } from "./tool-registry.js"

// Re-export agent types for consumers
export type { AgentContext, AgentMessage, StreamChunk } from "@ibatexas/types"
