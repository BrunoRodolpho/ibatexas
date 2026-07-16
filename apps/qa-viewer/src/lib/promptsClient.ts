// Prompts client — navigate + edit every ibatexas prompt via apps/api's
// dev-only /internal/qa/prompts/* routes. Same bearer bridge as the RCA client.
// Ids contain "/" and are placed directly in the path (wildcard route).

import { authedGetJson, authedSendJson, bridgeConfig, type QaConfig } from "./bridge"

export type PromptStage = "planner" | "claims" | "responder" | "ops" | "capability"

export interface PromptSummary {
  id: string
  name: string
  stage: PromptStage
  kind: string
  path: string
  editable: boolean
  hasOverride: boolean
}

export interface PromptDetail extends PromptSummary {
  source: string
  effective: string
}

export const promptsConfigured = (): QaConfig | null => bridgeConfig()

export const fetchPrompts = (cfg: QaConfig): Promise<PromptSummary[]> =>
  authedGetJson<{ prompts: PromptSummary[] }>(cfg, "/internal/qa/prompts").then((r) => r.prompts)

export const fetchPrompt = (cfg: QaConfig, id: string): Promise<PromptDetail> =>
  authedGetJson<{ prompt: PromptDetail }>(cfg, `/internal/qa/prompts/${id}`).then((r) => r.prompt)

export const savePrompt = (cfg: QaConfig, id: string, text: string): Promise<{ ok: boolean }> =>
  authedSendJson<{ ok: boolean }>(cfg, "PUT", `/internal/qa/prompts/${id}`, { text })

export const revertPrompt = (cfg: QaConfig, id: string): Promise<{ ok: boolean }> =>
  authedSendJson<{ ok: boolean }>(cfg, "DELETE", `/internal/qa/prompts/${id}`)
