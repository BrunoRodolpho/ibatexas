// Authed bridge helpers — shared by the RCA + Prompts clients. Reuses the
// SAME dev-only bearer config as the QA-control run bridge (qaControl.ts):
// VITE_QA_CONTROL_BASE / VITE_QA_CONTROL_TOKEN. When unset, bridgeConfig() is
// null and the RCA/Prompts sections render a "not configured" hint — the viewer
// stays a pure read-only artifact browser exactly as before.

import { qaConfig, type QaConfig } from "./qaControl"

export type { QaConfig }
export const bridgeConfig = qaConfig

function authedFetch(cfg: QaConfig, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${cfg.base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(init?.headers ?? {}) },
  })
}

export async function authedGetJson<T>(cfg: QaConfig, path: string): Promise<T> {
  const res = await authedFetch(cfg, path)
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return (await res.json()) as T
}

export async function authedSendJson<T>(
  cfg: QaConfig,
  method: "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await authedFetch(cfg, path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "Content-Type": "application/json" },
  })
  if (!res.ok) {
    let detail = ""
    try {
      detail = JSON.stringify(await res.json())
    } catch {
      /* body not json */
    }
    throw new Error(`${method} ${path} → ${res.status}${detail ? ` ${detail}` : ""}`)
  }
  return (await res.json()) as T
}
