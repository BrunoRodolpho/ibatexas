"use client"

import { apiFetch, apiStream } from "@/lib/api"
import { useChatStore } from './chat.store'
import { useSessionStore } from '@/domains/session'

// ── Stream chunk types ──────────────────────────────────────────────────

type StreamChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

function isStreamChunk(value: unknown): value is StreamChunk {
  if (typeof value !== 'object' || value === null) return false
  if (!('type' in value)) return false
  const { type } = value
  return type === 'text_delta' || type === 'error' || type === 'done'
}

// ── Helpers ─────────────────────────────────────────────────────────────

let msgCounter = 0

function buildUserMessage(content: string) {
  return {
    id: `msg_${Date.now()}_${++msgCounter}_user`,
    role: 'user' as const,
    content,
    timestamp: new Date(),
  }
}

function buildAssistantPlaceholder() {
  return {
    id: `msg_${Date.now()}_${++msgCounter}_assistant`,
    role: 'assistant' as const,
    content: '',
    timestamp: new Date(),
  }
}

// ── Chat Hook ───────────────────────────────────────────────────────────

export function useChat() {
  const addMessage = useChatStore((s) => s.addMessage)
  const updateLastMessage = useChatStore((s) => s.updateLastMessage)
  const setLoading = useChatStore((s) => s.setLoading)
  const setError = useChatStore((s) => s.setError)
  const setSessionSecret = useChatStore((s) => s.setSessionSecret)
  const setSessionToken = useChatStore((s) => s.setSessionToken)
  const sessionId = useSessionStore((s) => s.sessionId)

  const sendMessage = async (content: string) => {
    if (!sessionId) {
      setError("Sessão não inicializada")
      return
    }

    addMessage(buildUserMessage(content))
    setLoading(true)
    setError(undefined)

    try {
      // Build ownership headers from previously stored secrets/tokens
      const { sessionSecret, sessionToken } = useChatStore.getState()
      const headers: Record<string, string> = {}
      if (sessionSecret) headers["x-session-secret"] = sessionSecret
      if (sessionToken) headers["x-session-token"] = sessionToken

      const res = await apiFetch<{ messageId: string; sessionSecret?: string; sessionToken?: string }>(
        "/api/chat/messages",
        {
          method: "POST",
          body: JSON.stringify({ sessionId, message: content, channel: "web" }),
          headers,
        },
      )

      // Persist ownership credentials for subsequent requests
      if (res.sessionSecret) setSessionSecret(res.sessionSecret)
      if (res.sessionToken) setSessionToken(res.sessionToken)

      addMessage(buildAssistantPlaceholder())

      await apiStream(`/api/chat/stream/${sessionId}`, (raw: unknown) => {
        if (!isStreamChunk(raw)) return
        switch (raw.type) {
          case 'text_delta':  updateLastMessage(raw.delta); break
          case 'error':       setError(raw.message);        break
          case 'done':        setLoading(false);             break
        }
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Erro desconhecido"
      setError(errorMsg)
      setLoading(false)
    }
  }

  return { sendMessage }
}
